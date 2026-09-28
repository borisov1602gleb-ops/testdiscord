// Чат текстового канала: лента с подгрузкой старых сообщений, правка и
// удаление своих, ответы, реакции, упоминания, вложения и отметки «кто
// просмотрел». Экран сообщества (home.js) ведёт список каналов и сокет,
// а сюда передаёт события, относящиеся к открытому каналу.
import { api, uploadFile } from '../api.js';
import { store } from '../store.js';
import { el, formatTime, icon, initial } from '../dom.js';

// Тот же набор, что на сервере: другие реакции он не примет.
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const PAGE_SIZE = 50;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'application/zip',
];
// Насколько близко к низу ленты считается «внизу»: тогда новые сообщения
// прокручивают ленту сами, а если человек читает старое — не мешают.
const BOTTOM_SLACK = 120;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function formatFull(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

// «@Имя» считается упоминанием, только если сразу за именем не идёт буква
// или цифра: иначе «@Ан» находился бы внутри «@Анна».
function hasToken(text, token) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at === -1) return false;
    const next = text[at + token.length];
    if (!next || !LETTER_OR_DIGIT.test(next)) return true;
    from = at + 1;
  }
}

export function createChat({ community, role, members, onRead }) {
  const me = store.user?.id;
  const isOwner = role === 'owner';

  let channel = null;
  let openToken = 0; // защищает от гонки при быстром переключении каналов
  let hasMore = false;
  let loadingOlder = false;
  let oldestId = null;
  let pinned = true; // лента прокручена к низу
  let readTimer = null;
  let replyTo = null;
  let attachment = null;
  let uploading = false;
  let suggestions = [];
  let suggestIndex = 0;
  let openPopover = null;
  const items = new Map(); // id → { message, node }

  // ===== лента =====

  const title = el('span', { class: 'chat-title' });
  const topSlot = el('p', { class: 'feed-start' });
  const feed = el('div', { class: 'chat-feed', onscroll: onFeedScroll });
  const jumpButton = el('button', {
    class: 'jump-new',
    type: 'button',
    text: 'Новые сообщения ↓',
    onclick: () => scrollToBottom(true),
  });
  jumpButton.hidden = true;
  // Лента становится ниже, когда над полем ввода появляется плашка ответа
  // или файла. Прижатая к низу лента остаётся прижатой.
  new ResizeObserver(() => {
    if (pinned) feed.scrollTop = feed.scrollHeight;
  }).observe(feed);

  function nearBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < BOTTOM_SLACK;
  }

  function scrollToBottom(smooth = false) {
    feed.scrollTo({ top: feed.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinned = true;
    jumpButton.hidden = true;
  }

  function onFeedScroll() {
    pinned = nearBottom();
    if (pinned) jumpButton.hidden = true;
    if (feed.scrollTop < 200) loadOlder();
  }

  function drawTopSlot() {
    if (hasMore) topSlot.textContent = loadingOlder ? 'Загружаем раньше…' : '';
    else topSlot.textContent = channel ? `Это начало канала #${channel.name}` : '';
  }

  function withMentions(text, mentions) {
    const tokens = (mentions ?? [])
      .map((m) => ({ token: `@${m.name}`, self: m.user_id === me }))
      .sort((a, b) => b.token.length - a.token.length);
    if (tokens.length === 0) return [text];

    const out = [];
    let plainFrom = 0;
    let pos = 0;
    while (pos < text.length) {
      const hit = text[pos] === '@' && tokens.find((t) => text.startsWith(t.token, pos));
      if (hit) {
        if (pos > plainFrom) out.push(text.slice(plainFrom, pos));
        out.push(el('span', { class: hit.self ? 'mention mention-me' : 'mention', text: hit.token }));
        pos += hit.token.length;
        plainFrom = pos;
      } else {
        pos += 1;
      }
    }
    if (plainFrom < text.length) out.push(text.slice(plainFrom));
    return out;
  }

  function replyQuote(reply) {
    return el(
      'button',
      {
        class: 'msg-reply',
        type: 'button',
        title: 'Показать исходное сообщение',
        onclick: () => {
          const target = items.get(reply.id)?.node;
          if (!target) return;
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('is-flash');
          setTimeout(() => target.classList.remove('is-flash'), 1200);
        },
      },
      [
        icon('reply', 12),
        el('span', { class: 'msg-reply-author', text: reply.author_name ?? '' }),
        el('span', {
          class: 'msg-reply-text',
          text: reply.deleted ? 'сообщение удалено' : reply.snippet || 'вложение',
        }),
      ],
    );
  }

  function attachmentView(att) {
    if (att.is_image) {
      const img = el('img', { class: 'msg-image', src: att.url, alt: att.filename, loading: 'lazy' });
      // Картинка догружается позже текста и сдвигает ленту: если человек
      // был внизу, возвращаем его вниз.
      img.addEventListener('load', () => {
        if (pinned) scrollToBottom();
      });
      return el('a', { class: 'msg-image-link', href: att.url, target: '_blank', rel: 'noopener' }, [img]);
    }
    return el('a', { class: 'msg-file', href: att.url, download: att.filename }, [
      icon('file', 18),
      el('span', { class: 'msg-file-name', text: att.filename }),
      el('span', { class: 'msg-file-size', text: formatSize(att.size_bytes) }),
    ]);
  }

  function reactionsRow(message) {
    return el(
      'div',
      { class: 'msg-reactions' },
      message.reactions.map((r) =>
        el('button', {
          class: `reaction${r.user_ids.includes(me) ? ' is-mine' : ''}`,
          type: 'button',
          title: r.user_ids.includes(me) ? 'Убрать реакцию' : 'Поставить такую же',
          text: `${r.emoji} ${r.count}`,
          onclick: () => toggleReaction(message.id, r.emoji),
        }),
      ),
    );
  }

  // Отметка под своим сообщением — как в Telegram: одна галочка —
  // отправлено, две — кто-то уже прочитал. По нажатию — список прочитавших.
  function receipt(message) {
    const count = message.read_count ?? 0;
    const button = el(
      'button',
      {
        class: `msg-receipt${count > 0 ? ' is-read' : ''}`,
        type: 'button',
        title: 'Кто просмотрел',
      },
      [
        icon(count > 0 ? 'checks' : 'check', 14),
        el('span', { text: count > 0 ? `Просмотрели: ${count}` : 'Отправлено' }),
      ],
    );
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      showReaders(message, button);
    });
    return button;
  }

  function tool(label, iconName, onclick, extraClass = '') {
    return el(
      'button',
      { class: `msg-tool${extraClass}`, type: 'button', title: label, 'aria-label': label, onclick },
      [icon(iconName, 15)],
    );
  }

  function toolbar(message, own) {
    const bar = el('div', { class: 'msg-tools' });
    const reactButton = tool('Реакция', 'smile', (event) => {
      event.stopPropagation();
      showReactionPicker(message, reactButton);
    });
    bar.append(tool('Ответить', 'reply', () => startReply(message)), reactButton);
    if (own) bar.append(tool('Изменить', 'pencil', () => startEdit(message)));
    if (own || isOwner) {
      // Удаление в два нажатия: первое спрашивает, второе удаляет.
      const del = tool('Удалить', 'trash', () => {
        if (!del.classList.contains('is-armed')) {
          del.classList.add('is-armed');
          del.title = 'Нажмите ещё раз, чтобы удалить';
          setTimeout(() => del.classList.remove('is-armed'), 3000);
          return;
        }
        remove(message.id);
      }, ' msg-tool-danger');
      bar.append(del);
    }
    return bar;
  }

  function build(message) {
    const own = message.user_id === me;
    const mentioned = message.mentions?.some((m) => m.user_id === me);
    const classes = ['msg'];
    if (own) classes.push('msg-own');
    if (mentioned) classes.push('msg-mentioned');
    if (message.deleted) classes.push('msg-deleted');

    const body = el('div', { class: 'msg-body' }, [
      el('div', { class: 'msg-head' }, [
        el('span', { class: 'msg-author', text: message.author_name ?? '' }),
        el('span', { class: 'msg-time', text: formatTime(message.created_at), title: formatFull(message.created_at) }),
        message.edited_at && !message.deleted &&
          el('span', { class: 'msg-edited', text: 'изменено', title: formatFull(message.edited_at) }),
      ]),
      message.reply && replyQuote(message.reply),
    ]);

    if (message.deleted) {
      body.append(el('p', { class: 'msg-text msg-gone', text: 'Сообщение удалено' }));
    } else {
      if (message.content) {
        body.append(el('p', { class: 'msg-text' }, withMentions(message.content, message.mentions)));
      }
      if (message.attachment) body.append(attachmentView(message.attachment));
      if (message.reactions?.length) body.append(reactionsRow(message));
      if (own) body.append(receipt(message));
    }

    return el('article', { class: classes.join(' '), 'data-id': message.id }, [
      el('div', { class: 'msg-avatar', text: initial(message.author_name) }),
      body,
      !message.deleted && toolbar(message, own),
    ]);
  }

  function put(message) {
    const node = build(message);
    items.set(message.id, { message, node });
    return node;
  }

  function redraw(id, patch) {
    const item = items.get(id);
    if (!item) return;
    // Сообщение могло стать выше (реакция, правка) — если лента была
    // внизу, пусть там и остаётся.
    const stick = pinned;
    item.message = { ...item.message, ...patch };
    const fresh = build(item.message);
    item.node.replaceWith(fresh);
    item.node = fresh;
    if (stick) scrollToBottom();
  }

  function append(message) {
    if (items.has(message.id)) return;
    feed.querySelector('.empty-quiet')?.remove();
    const wasPinned = pinned || nearBottom();
    feed.append(put(message));
    if (wasPinned || message.user_id === me) scrollToBottom();
    else jumpButton.hidden = false;
  }

  // ===== загрузка =====

  async function open(next, { lastReadAt } = {}) {
    const token = ++openToken;
    channel = next;
    hasMore = false;
    loadingOlder = false;
    oldestId = null;
    items.clear();
    cancelReply();
    cancelEdit();
    title.textContent = `# ${next.name}`;
    input.placeholder = `Написать в #${next.name}`;
    input.disabled = false;
    sendButton.disabled = false;
    attachButton.disabled = false;
    feed.replaceChildren(topSlot);
    topSlot.textContent = '';

    const { messages, has_more: more } = await api(
      `/messages?channel_id=${next.id}&limit=${PAGE_SIZE}`,
    );
    if (token !== openToken) return;
    hasMore = more;
    oldestId = messages[0]?.id ?? null;
    drawTopSlot();

    if (messages.length === 0) {
      feed.append(el('p', { class: 'empty-quiet', text: 'Пока ни одного сообщения — напишите первым' }));
    }
    // Черта «Новые сообщения» — перед первым непрочитанным чужим.
    let divider = null;
    for (const message of messages) {
      if (
        !divider && lastReadAt && message.user_id !== me &&
        Date.parse(message.created_at) > Date.parse(lastReadAt)
      ) {
        divider = el('div', { class: 'feed-divider' }, [el('span', { text: 'Новые сообщения' })]);
        feed.append(divider);
      }
      feed.append(put(message));
    }
    if (divider) {
      divider.scrollIntoView({ block: 'center' });
      pinned = nearBottom();
    } else {
      scrollToBottom();
    }
    markRead();
    // История короче экрана — прокрутки нет, и подгрузка по скроллу не
    // сработает. Догружаем сразу.
    if (hasMore && feed.scrollHeight <= feed.clientHeight) loadOlder();
    input.focus();
  }

  async function loadOlder() {
    if (!hasMore || loadingOlder || !channel || !oldestId) return;
    const token = openToken;
    loadingOlder = true;
    drawTopSlot();
    try {
      const { messages, has_more: more } = await api(
        `/messages?channel_id=${channel.id}&limit=${PAGE_SIZE}&before=${oldestId}`,
      );
      if (token !== openToken) return;
      // Старые сообщения вставляются сверху так, чтобы то, что человек
      // сейчас читает, не уехало с экрана.
      const before = feed.scrollHeight;
      const fragment = document.createDocumentFragment();
      for (const message of messages) {
        if (!items.has(message.id)) fragment.append(put(message));
      }
      topSlot.after(fragment);
      feed.scrollTop += feed.scrollHeight - before;
      hasMore = more;
      oldestId = messages[0]?.id ?? oldestId;
    } catch {
      /* не страшно: попробуем при следующей прокрутке */
    } finally {
      if (token === openToken) {
        loadingOlder = false;
        drawTopSlot();
      }
    }
  }

  // Отметка прочтения уходит с небольшой задержкой: пачка сообщений подряд
  // даёт один запрос, а не десять. В фоновой вкладке не отмечаем —
  // человек этого ещё не видел.
  function markRead() {
    if (!channel || document.hidden) return;
    const channelId = channel.id;
    onRead?.(channelId);
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      api(`/channels/${channelId}/read`, { method: 'POST' }).catch(() => {});
    }, 400);
  }

  // ===== действия с сообщениями =====

  async function toggleReaction(messageId, emoji) {
    closePopover();
    try {
      const { reactions } = await api(`/messages/${messageId}/reactions`, {
        method: 'PUT',
        body: { emoji },
      });
      redraw(messageId, { reactions });
    } catch (err) {
      showError(err.message);
    }
  }

  async function remove(messageId) {
    try {
      await api(`/messages/${messageId}`, { method: 'DELETE' });
      onDeleted({ id: messageId, channel_id: channel?.id });
    } catch (err) {
      showError(err.message);
    }
  }

  let editing = null; // { id, form }

  function cancelEdit() {
    if (!editing) return;
    const item = items.get(editing.id);
    editing = null;
    if (item) redraw(item.message.id, {});
  }

  function startEdit(message) {
    cancelEdit();
    const item = items.get(message.id);
    if (!item) return;
    const field = el('input', {
      class: 'input msg-edit-input',
      type: 'text',
      maxlength: '2000',
      value: message.content,
    });
    const error = el('p', { class: 'field-error' });

    async function save() {
      const content = field.value.trim();
      if (!content && !message.attachment) return;
      try {
        const { message: updated } = await api(`/messages/${message.id}`, {
          method: 'PATCH',
          body: { content, mentions: mentionsIn(content) },
        });
        editing = null;
        redraw(message.id, { ...updated, read_count: item.message.read_count });
      } catch (err) {
        error.textContent = err.message;
      }
    }

    const form = el('form', { class: 'msg-edit', onsubmit: (e) => (e.preventDefault(), save()) }, [
      field,
      el('div', { class: 'msg-edit-actions' }, [
        el('span', { class: 'msg-edit-hint', text: 'Enter — сохранить, Esc — отмена' }),
        el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Отмена', onclick: cancelEdit }),
        el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Сохранить' }),
      ]),
      error,
    ]);
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancelEdit();
    });

    const textNode = item.node.querySelector('.msg-text');
    if (textNode) textNode.replaceWith(form);
    else item.node.querySelector('.msg-head').after(form);
    item.node.classList.add('is-editing');
    editing = { id: message.id, form };
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }

  function closePopover() {
    openPopover?.remove();
    openPopover = null;
    document.removeEventListener('click', onOutsideClick);
  }

  function onOutsideClick(event) {
    if (openPopover && !openPopover.contains(event.target)) closePopover();
  }

  function showPopover(anchor, content) {
    closePopover();
    openPopover = el('div', { class: 'popover' }, content);
    anchor.closest('.msg').append(openPopover);
    setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
  }

  function showReactionPicker(message, anchor) {
    showPopover(anchor, [
      el(
        'div',
        { class: 'reaction-picker' },
        REACTIONS.map((emoji) =>
          el('button', {
            class: 'reaction-pick',
            type: 'button',
            text: emoji,
            onclick: () => toggleReaction(message.id, emoji),
          }),
        ),
      ),
    ]);
    openPopover.classList.add('popover-tools');
  }

  async function showReaders(message, anchor) {
    const list = el('div', { class: 'readers' }, [el('p', { class: 'readers-empty', text: 'Загружаем…' })]);
    showPopover(anchor, [el('p', { class: 'readers-title', text: 'Просмотрели' }), list]);
    openPopover.classList.add('popover-receipt');
    try {
      const { readers } = await api(`/messages/${message.id}/readers`);
      list.replaceChildren(
        ...(readers.length
          ? readers.map((r) =>
            el('div', { class: 'reader' }, [
              el('span', { class: 'reader-avatar', text: initial(r.name) }),
              el('span', { class: 'reader-name', text: r.name }),
            ]))
          : [el('p', { class: 'readers-empty', text: 'Пока никто' })]),
      );
    } catch (err) {
      list.replaceChildren(el('p', { class: 'readers-empty', text: err.message }));
    }
  }

  // ===== поле ввода =====

  const input = el('input', {
    class: 'input',
    type: 'text',
    // Тот же предел, что и на сервере: лучше не дать набрать лишнее,
    // чем показать ошибку после отправки.
    maxlength: '2000',
    autocomplete: 'off',
    placeholder: 'Нет текстового канала',
    disabled: 'true',
  });
  const fileInput = el('input', { type: 'file', accept: FILE_TYPES.join(','), class: 'visually-hidden' });
  const attachButton = el(
    'button',
    { class: 'composer-icon', type: 'button', title: 'Прикрепить файл', 'aria-label': 'Прикрепить файл', disabled: 'true' },
    [icon('clip', 18)],
  );
  const sendButton = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Отправить', disabled: 'true' });
  const suggestBox = el('div', { class: 'mention-list', role: 'listbox' });
  const replyBar = el('div', { class: 'composer-bar' });
  const attachBar = el('div', { class: 'composer-bar' });
  const composerError = el('p', { class: 'field-error composer-error' });
  suggestBox.hidden = true;
  replyBar.hidden = true;
  attachBar.hidden = true;

  function showError(text) {
    composerError.textContent = text;
    if (text) setTimeout(() => {
      if (composerError.textContent === text) composerError.textContent = '';
    }, 6000);
  }

  function mentionsIn(text) {
    return members
      .filter((m) => m.id !== me && hasToken(text, `@${m.name}`))
      .map((m) => m.id);
  }

  function startReply(message) {
    replyTo = message;
    replyBar.replaceChildren(
      icon('reply', 14),
      el('span', { class: 'composer-bar-text' }, [
        el('b', { text: `Ответ ${message.author_name}: ` }),
        message.content || (message.attachment ? message.attachment.filename : ''),
      ]),
      el('button', { class: 'composer-bar-close', type: 'button', text: '✕', title: 'Не отвечать', onclick: cancelReply }),
    );
    replyBar.hidden = false;
    input.focus();
  }

  function cancelReply() {
    replyTo = null;
    replyBar.hidden = true;
  }

  function clearAttachment() {
    attachment = null;
    attachBar.hidden = true;
    fileInput.value = '';
  }

  function drawAttachBar(text, withClose) {
    attachBar.replaceChildren(
      icon('clip', 14),
      el('span', { class: 'composer-bar-text', text }),
      withClose &&
        el('button', { class: 'composer-bar-close', type: 'button', text: '✕', title: 'Убрать файл', onclick: clearAttachment }),
    );
    attachBar.hidden = false;
  }

  async function pickFile(file) {
    if (!file || !channel) return;
    if (!FILE_TYPES.includes(file.type)) return showError('Подойдут картинки, PDF, текст и ZIP');
    if (file.size > MAX_FILE_BYTES) return showError('Файл больше 10 МБ');
    showError('');
    uploading = true;
    sendButton.disabled = true;
    drawAttachBar(`Загружаем ${file.name}…`, false);
    try {
      const name = encodeURIComponent(file.name || 'file');
      const result = await uploadFile(
        `/attachments?community_id=${community.id}&filename=${name}`,
        file,
      );
      attachment = result.attachment;
      drawAttachBar(`${attachment.filename} · ${formatSize(attachment.size_bytes)}`, true);
    } catch (err) {
      clearAttachment();
      showError(err.message);
    } finally {
      uploading = false;
      sendButton.disabled = false;
      input.focus();
    }
  }

  // Подсказка упоминаний: после «@» показываем участников, чьё имя
  // содержит набранное.
  function updateSuggestions() {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(^|\s)@([^\s@]*)$/);
    if (!match) return hideSuggestions();
    const typed = match[2].toLowerCase();
    suggestions = members
      .filter((m) => m.id !== me && m.name.toLowerCase().includes(typed))
      .slice(0, 6);
    if (suggestions.length === 0) return hideSuggestions();
    suggestIndex = Math.min(suggestIndex, suggestions.length - 1);
    suggestBox.replaceChildren(
      ...suggestions.map((m, i) =>
        el(
          'button',
          {
            class: `mention-option${i === suggestIndex ? ' is-active' : ''}`,
            type: 'button',
            role: 'option',
            // mousedown, а не click: иначе поле потеряет фокус раньше.
            onmousedown: (e) => (e.preventDefault(), chooseSuggestion(m)),
          },
          [el('span', { class: 'reader-avatar', text: initial(m.name) }), el('span', { text: m.name })],
        ),
      ),
    );
    suggestBox.hidden = false;
  }

  function hideSuggestions() {
    suggestions = [];
    suggestIndex = 0;
    suggestBox.hidden = true;
  }

  function chooseSuggestion(member) {
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret).replace(/@([^\s@]*)$/, `@${member.name} `);
    input.value = before + input.value.slice(caret);
    input.setSelectionRange(before.length, before.length);
    hideSuggestions();
    input.focus();
  }

  input.addEventListener('input', updateSuggestions);
  input.addEventListener('blur', () => setTimeout(hideSuggestions, 100));
  input.addEventListener('keydown', (event) => {
    if (!suggestBox.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        suggestIndex = (suggestIndex + step + suggestions.length) % suggestions.length;
        updateSuggestions();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        chooseSuggestion(suggestions[suggestIndex]);
        return;
      }
      if (event.key === 'Escape') return hideSuggestions();
    }
    if (event.key === 'Escape' && replyTo) cancelReply();
    // Стрелка вверх в пустом поле — правка своего последнего сообщения.
    if (event.key === 'ArrowUp' && !input.value) {
      const mine = [...items.values()].reverse().find((i) => i.message.user_id === me && !i.message.deleted);
      if (mine) {
        event.preventDefault();
        startEdit(mine.message);
      }
    }
  });
  input.addEventListener('paste', (event) => {
    const file = event.clipboardData?.files?.[0];
    if (file) {
      event.preventDefault();
      pickFile(file);
    }
  });
  attachButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));

  async function send() {
    if (!channel || uploading) return;
    const content = input.value.trim();
    if (!content && !attachment) return;

    const body = { channel_id: channel.id, content, mentions: mentionsIn(content) };
    if (replyTo) body.reply_to = replyTo.id;
    if (attachment) body.attachment_id = attachment.id;
    const draft = { value: input.value, replyTo, attachment };

    input.value = '';
    cancelReply();
    clearAttachment();
    showError('');
    try {
      const { message } = await api('/messages', { method: 'POST', body });
      // Обычно сообщение приходит и по WebSocket; повтор отсекается по id.
      // Из ответа берём счётчик прочтений — в рассылке его нет.
      if (items.has(message.id)) redraw(message.id, message);
      else append(message);
    } catch (err) {
      // Не теряем набранное: возвращаем текст, ответ и вложение.
      input.value = draft.value;
      if (draft.replyTo) startReply(draft.replyTo);
      if (draft.attachment) {
        attachment = draft.attachment;
        drawAttachBar(attachment.filename, true);
      }
      showError(err.message);
    }
  }

  // Файл можно просто перетащить в окно чата.
  function onDrop(event) {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    node.classList.remove('is-dropping');
    pickFile(file);
  }

  const composer = el('div', { class: 'composer-wrap' }, [
    suggestBox,
    replyBar,
    attachBar,
    el('form', { class: 'composer', onsubmit: (e) => (e.preventDefault(), send()) }, [
      attachButton,
      fileInput,
      input,
      sendButton,
    ]),
    composerError,
  ]);

  // ===== события из сокета =====

  function onMessage(message) {
    if (message.channel_id !== channel?.id) return;
    if (items.has(message.id)) return;
    append(message);
    if (message.user_id !== me) markRead();
  }

  function onUpdated(message) {
    if (message.channel_id !== channel?.id || !items.has(message.id)) return;
    if (editing?.id === message.id) return;
    const current = items.get(message.id).message;
    // В рассылке счётчика прочтений нет — свой оставляем как был.
    redraw(message.id, { ...message, read_count: current.read_count });
  }

  function onDeleted({ id, channel_id: channelId }) {
    if (channelId !== channel?.id || !items.has(id)) return;
    if (editing?.id === id) editing = null;
    if (replyTo?.id === id) cancelReply();
    redraw(id, { deleted: true, content: '', attachment: null, reactions: [], mentions: [] });
    // Ответы на удалённое тоже показывают, что его больше нет.
    for (const item of items.values()) {
      if (item.message.reply?.id === id) {
        redraw(item.message.id, { reply: { ...item.message.reply, deleted: true, snippet: '' } });
      }
    }
  }

  function onReactions({ id, channel_id: channelId, reactions }) {
    if (channelId !== channel?.id) return;
    redraw(id, { reactions });
  }

  // Кто-то дочитал канал: те свои сообщения, что попали между его прошлой
  // и новой отметкой, получают ещё одного прочитавшего.
  function onReadUpdate({ channel_id: channelId, user_id: userId, last_read_at: lastReadAt, previous }) {
    if (channelId !== channel?.id || userId === me) return;
    const upTo = Date.parse(lastReadAt);
    const from = previous ? Date.parse(previous) : -Infinity;
    for (const item of items.values()) {
      const { message } = item;
      if (message.user_id !== me || message.deleted) continue;
      const at = Date.parse(message.created_at);
      if (at > from && at <= upTo) {
        redraw(message.id, { read_count: (message.read_count ?? 0) + 1 });
      }
    }
  }

  const node = el('main', { class: 'chat' }, [
    el('header', { class: 'chat-head' }, [title]),
    el('div', { class: 'chat-feed-wrap' }, [feed, jumpButton]),
    composer,
  ]);
  node.addEventListener('dragover', (e) => {
    if (channel && e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      node.classList.add('is-dropping');
    }
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove('is-dropping');
  });
  node.addEventListener('drop', onDrop);

  return {
    node,
    head: node.querySelector('.chat-head'),
    title,
    open,
    markRead,
    onMessage,
    onUpdated,
    onDeleted,
    onReactions,
    onReadUpdate,
    get channelId() {
      return channel?.id ?? null;
    },
  };
}
