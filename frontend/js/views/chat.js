// Чат канала: лента с подгрузкой старых сообщений и переходом к нужному
// месту, правка и удаление, ответы, треды, реакции, упоминания, вложения,
// закреплённые, «печатает…» и «кто просмотрел». Один и тот же модуль
// работает для канала сообщества, личной переписки и треда (боковая
// панель). Экран (home.js) ведёт список каналов и сокет, а сюда передаёт
// события, относящиеся к открытому каналу.
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
// «Печатает…» гаснет, если человек замолчал.
const TYPING_SHOW_MS = 4500;
const TYPING_SEND_EVERY_MS = 2500;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export function formatFull(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

function repliesLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ответ`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ответа`;
  return `${n} ответов`;
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

// Параметры:
//  community — сообщество (null для личной переписки);
//  permissions — права в сообществе: удалять чужое, закреплять;
//  members   — кого можно упомянуть;
//  thread    — корневое сообщение, если это чат треда;
//  decorateAuthor — что показать рядом с именем автора (роль, теги);
//  onRead, onOpenThread, onAuthorClick, onTyping — связи с экраном.
export function createChat({
  community = null,
  permissions = [],
  decorateAuthor,
  members = [],
  thread = null,
  onRead,
  onOpenThread,
  onAuthorClick,
  onTyping,
}) {
  const me = store.user?.id;
  // В личке модерации нет: чужое сообщение не удалить никому.
  const canDeleteAny = () => channel?.type !== 'direct' && permissions.includes('delete_any_message');
  const isThread = Boolean(thread);

  let channel = null;
  let openToken = 0; // защищает от гонки при быстром переключении каналов
  let hasMore = false;
  let hasNewer = false;
  let loadingOlder = false;
  let loadingNewer = false;
  let oldestId = null;
  let newestId = null;
  let pinned = true; // лента прокручена к низу
  let readTimer = null;
  let replyTo = null;
  let attachment = null;
  let uploading = false;
  let suggestions = [];
  let suggestIndex = 0;
  let openPopover = null;
  let lastTypingSent = 0;
  const typers = new Map(); // user_id → { name, until }
  const items = new Map(); // id → { message, node, options }

  const canPin = () => channel?.type === 'direct' || permissions.includes('pin_messages');

  // ===== лента =====

  const title = el('span', { class: 'chat-title' });
  const subtitle = el('span', { class: 'chat-subtitle' });
  const topSlot = el('p', { class: 'feed-start' });
  const feed = el('div', { class: 'chat-feed', onscroll: onFeedScroll });
  const jumpButton = el('button', {
    class: 'jump-new',
    type: 'button',
    text: 'Новые сообщения ↓',
    onclick: () => (hasNewer ? open(channel) : scrollToBottom(true)),
  });
  jumpButton.hidden = true;
  // Лента становится ниже, когда над полем ввода появляется плашка ответа
  // или файла. Прижатая к низу лента остаётся прижатой.
  new ResizeObserver(() => {
    if (pinned && !hasNewer) feed.scrollTop = feed.scrollHeight;
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
    pinned = nearBottom() && !hasNewer;
    if (pinned) jumpButton.hidden = true;
    if (feed.scrollTop < 200) loadOlder();
    if (hasNewer && nearBottom()) loadNewer();
  }

  function drawTopSlot() {
    if (isThread) {
      topSlot.textContent = '';
      return;
    }
    if (hasMore) topSlot.textContent = loadingOlder ? 'Загружаем раньше…' : '';
    else if (channel?.type === 'direct') topSlot.textContent = 'Это начало переписки';
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

  function flash(node) {
    node.scrollIntoView({ block: 'center' });
    node.classList.add('is-flash');
    setTimeout(() => node.classList.remove('is-flash'), 1600);
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
          if (target) flash(target);
          else if (!isThread) open(channel, { aroundId: reply.id });
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
    const direct = channel?.type === 'direct';
    const label = count > 0 ? (direct ? 'Прочитано' : `Просмотрели: ${count}`) : 'Отправлено';
    const button = el(
      'button',
      { class: `msg-receipt${count > 0 ? ' is-read' : ''}`, type: 'button', title: 'Кто просмотрел' },
      [icon(count > 0 ? 'checks' : 'check', 14), el('span', { text: label })],
    );
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      showReaders(message, button);
    });
    return button;
  }

  function threadSummary(message) {
    return el(
      'button',
      { class: 'msg-thread', type: 'button', onclick: () => onOpenThread?.(message) },
      [
        icon('thread', 14),
        el('span', { class: 'msg-thread-count', text: repliesLabel(message.thread_count) }),
        message.thread_last_at &&
          el('span', { class: 'msg-thread-last', text: `последний в ${formatTime(message.thread_last_at)}` }),
      ],
    );
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
    if (!isThread && !message.thread_id && onOpenThread) {
      bar.append(tool('Обсудить в треде', 'thread', () => onOpenThread(message)));
    }
    if (!isThread && !message.thread_id && canPin()) {
      bar.append(tool(message.pinned ? 'Открепить' : 'Закрепить', 'pin', () => togglePin(message)));
    }
    if (own) bar.append(tool('Изменить', 'pencil', () => startEdit(message)));
    if (own || canDeleteAny()) {
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

  function build(message, { root = false } = {}) {
    const own = message.user_id === me;
    const mentioned = message.mentions?.some((m) => m.user_id === me);
    const classes = ['msg'];
    if (own) classes.push('msg-own');
    if (mentioned) classes.push('msg-mentioned');
    if (message.deleted) classes.push('msg-deleted');
    if (message.pinned) classes.push('msg-pinned');
    if (root) classes.push('msg-root');

    const author = own || !onAuthorClick
      ? el('span', { class: 'msg-author', text: message.author_name ?? '' })
      : el('button', {
        class: 'msg-author msg-author-link',
        type: 'button',
        title: 'Написать лично',
        text: message.author_name ?? '',
        onclick: () => onAuthorClick(message.user_id),
      });

    const body = el('div', { class: 'msg-body' }, [
      el('div', { class: 'msg-head' }, [
        author,
        ...(decorateAuthor?.(message.user_id) ?? []),
        el('span', { class: 'msg-time', text: formatTime(message.created_at), title: formatFull(message.created_at) }),
        message.edited_at && !message.deleted &&
          el('span', { class: 'msg-edited', text: 'изменено', title: formatFull(message.edited_at) }),
        message.pinned && el('span', { class: 'msg-pin-mark' }, [icon('pin', 12), 'закреплено']),
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
    }
    if (!isThread && !message.thread_id && message.thread_count > 0) body.append(threadSummary(message));
    if (own && !message.deleted) body.append(receipt(message));

    return el('article', { class: classes.join(' '), 'data-id': message.id }, [
      el('div', { class: 'msg-avatar', text: initial(message.author_name) }),
      body,
      !message.deleted && !root && toolbar(message, own),
    ]);
  }

  function put(message, options) {
    const node = build(message, options);
    items.set(message.id, { message, node, options });
    return node;
  }

  function redraw(id, patch) {
    const item = items.get(id);
    if (!item) return;
    // Сообщение могло стать выше (реакция, правка) — если лента была
    // внизу, пусть там и остаётся.
    const stick = pinned;
    item.message = { ...item.message, ...patch };
    const fresh = build(item.message, item.options);
    item.node.replaceWith(fresh);
    item.node = fresh;
    if (stick) scrollToBottom();
  }

  function append(message) {
    if (items.has(message.id)) return;
    feed.querySelector('.empty-quiet')?.remove();
    const wasPinned = pinned || nearBottom();
    feed.append(put(message));
    newestId = message.id;
    if (wasPinned || message.user_id === me) scrollToBottom();
    else jumpButton.hidden = false;
  }

  function resetFeed(next) {
    channel = next;
    hasMore = false;
    hasNewer = false;
    loadingOlder = false;
    loadingNewer = false;
    oldestId = null;
    newestId = null;
    items.clear();
    typers.clear();
    drawTyping();
    cancelReply();
    cancelEdit();
    closePopover();
    jumpButton.hidden = true;
    input.disabled = false;
    sendButton.disabled = false;
    attachButton.disabled = false;
    feed.replaceChildren(topSlot);
    topSlot.textContent = '';
  }

  // ===== загрузка =====

  // lastReadAt — где провести черту «Новые сообщения»; aroundId — к какому
  // сообщению перейти (из поиска, закреплённых или цитаты).
  async function open(next, { lastReadAt, aroundId, title: heading, placeholder } = {}) {
    const token = ++openToken;
    resetFeed(next);
    if (heading !== undefined) title.textContent = heading;
    else if (!isThread) title.textContent = next.type === 'direct' ? next.name : `# ${next.name}`;
    input.placeholder = placeholder
      ?? (isThread ? 'Ответить в треде' : next.type === 'direct' ? 'Написать сообщение' : `Написать в #${next.name}`);

    if (isThread) return openThread(token);

    const url = aroundId
      ? `/messages?channel_id=${next.id}&around=${aroundId}`
      : `/messages?channel_id=${next.id}&limit=${PAGE_SIZE}`;
    const { messages, has_more: more, has_newer: newer } = await api(url);
    if (token !== openToken) return;
    hasMore = more;
    hasNewer = Boolean(newer);
    oldestId = messages[0]?.id ?? null;
    newestId = messages.at(-1)?.id ?? null;
    drawTopSlot();

    if (messages.length === 0) {
      feed.append(el('p', {
        class: 'empty-quiet',
        text: next.type === 'direct' ? 'Начните переписку' : 'Пока ни одного сообщения — напишите первым',
      }));
    }
    // Черта «Новые сообщения» — перед первым непрочитанным чужим.
    let divider = null;
    for (const message of messages) {
      if (
        !aroundId && !divider && lastReadAt && message.user_id !== me &&
        Date.parse(message.created_at) > Date.parse(lastReadAt)
      ) {
        divider = el('div', { class: 'feed-divider' }, [el('span', { text: 'Новые сообщения' })]);
        feed.append(divider);
      }
      feed.append(put(message));
    }
    if (aroundId && items.has(aroundId)) {
      flash(items.get(aroundId).node);
      pinned = false;
      jumpButton.hidden = !hasNewer;
      if (hasNewer) jumpButton.textContent = 'К последним сообщениям ↓';
    } else if (divider) {
      divider.scrollIntoView({ block: 'center' });
      pinned = nearBottom();
    } else {
      scrollToBottom();
    }
    if (!hasNewer) jumpButton.textContent = 'Новые сообщения ↓';
    markRead();
    // История короче экрана — прокрутки нет, и подгрузка по скроллу не
    // сработает. Догружаем сразу.
    if (hasMore && feed.scrollHeight <= feed.clientHeight) loadOlder();
    input.focus();
  }

  async function openThread(token) {
    const { root, messages } = await api(`/messages?channel_id=${channel.id}&thread_id=${thread.id}`);
    if (token !== openToken) return;
    feed.append(
      put(root, { root: true }),
      el('div', { class: 'thread-divider', text: messages.length ? repliesLabel(messages.length) : 'Пока без ответов' }),
    );
    for (const message of messages) feed.append(put(message));
    newestId = messages.at(-1)?.id ?? null;
    scrollToBottom();
    markRead();
    input.focus();
  }

  function redrawThreadDivider() {
    const divider = feed.querySelector('.thread-divider');
    if (!divider) return;
    const count = [...items.values()].filter((i) => i.message.thread_id === thread.id && !i.message.deleted).length;
    divider.textContent = count ? repliesLabel(count) : 'Пока без ответов';
  }

  async function loadOlder() {
    if (isThread || !hasMore || loadingOlder || !channel || !oldestId) return;
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

  // После перехода к старому сообщению лента «оторвана» от конца:
  // прокрутка вниз догружает то, что было позже.
  async function loadNewer() {
    if (!hasNewer || loadingNewer || !channel || !newestId) return;
    const token = openToken;
    loadingNewer = true;
    try {
      const { messages, has_newer: newer } = await api(
        `/messages?channel_id=${channel.id}&limit=${PAGE_SIZE}&after=${newestId}`,
      );
      if (token !== openToken) return;
      for (const message of messages) {
        if (!items.has(message.id)) feed.append(put(message));
      }
      newestId = messages.at(-1)?.id ?? newestId;
      hasNewer = newer;
      if (!hasNewer) {
        jumpButton.hidden = true;
        jumpButton.textContent = 'Новые сообщения ↓';
        markRead();
      }
    } catch {
      /* попробуем при следующей прокрутке */
    } finally {
      if (token === openToken) loadingNewer = false;
    }
  }

  // Отметка прочтения уходит с небольшой задержкой: пачка сообщений подряд
  // даёт один запрос, а не десять. В фоновой вкладке и пока человек
  // листает старое, не отмечаем — он этого ещё не видел.
  function markRead() {
    if (!channel || document.hidden || hasNewer) return;
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

  async function togglePin(message) {
    try {
      const { message: updated } = await api(`/messages/${message.id}/pin`, {
        method: 'PUT',
        body: { pinned: !message.pinned },
      });
      redraw(message.id, { pinned: updated.pinned });
    } catch (err) {
      showError(err.message);
    }
  }

  async function remove(messageId) {
    try {
      await api(`/messages/${messageId}`, { method: 'DELETE' });
      onDeleted({ id: messageId, channel_id: channel?.id, thread_id: items.get(messageId)?.message.thread_id });
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
    placeholder: 'Выберите канал',
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
  const typingLine = el('p', { class: 'typing-line', 'aria-live': 'polite' });
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
      const result = await uploadFile(`/attachments?channel_id=${channel.id}&filename=${name}`, file);
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

  input.addEventListener('input', () => {
    updateSuggestions();
    // «Печатает…» отправляется не на каждую букву, а раз в пару секунд.
    if (channel && input.value.trim() && Date.now() - lastTypingSent > TYPING_SEND_EVERY_MS) {
      lastTypingSent = Date.now();
      onTyping?.({ channel_id: channel.id, thread_id: thread?.id ?? null });
    }
  });
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
      const mine = [...items.values()].reverse()
        .find((i) => i.message.user_id === me && !i.message.deleted && !i.options?.root);
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
    if (thread) body.thread_id = thread.id;
    const draft = { value: input.value, replyTo, attachment };

    input.value = '';
    lastTypingSent = 0;
    cancelReply();
    clearAttachment();
    showError('');
    try {
      const { message } = await api('/messages', { method: 'POST', body });
      // Написал, находясь в «старой» части ленты, — возвращаемся к концу.
      if (hasNewer) return open(channel);
      // Обычно сообщение приходит и по WebSocket; повтор отсекается по id.
      // Из ответа берём счётчик прочтений — в рассылке его нет.
      if (items.has(message.id)) redraw(message.id, message);
      else append(message);
      if (isThread) redrawThreadDivider();
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

  // ===== «печатает…» =====

  let typingTimer = null;

  function drawTyping() {
    const now = Date.now();
    for (const [id, t] of typers) if (t.until < now) typers.delete(id);
    const names = [...typers.values()].map((t) => t.name);
    if (names.length === 0) typingLine.textContent = '';
    else if (names.length === 1) typingLine.textContent = `${names[0]} печатает…`;
    else if (names.length === 2) typingLine.textContent = `${names[0]} и ${names[1]} печатают…`;
    else typingLine.textContent = 'Несколько человек печатают…';
    clearTimeout(typingTimer);
    if (typers.size) typingTimer = setTimeout(drawTyping, 1000);
  }

  function onTypingEvent({ channel_id: channelId, thread_id: threadId, user_id: userId, name }) {
    if (channelId !== channel?.id || userId === me) return;
    if ((threadId ?? null) !== (thread?.id ?? null)) return;
    typers.set(userId, { name, until: Date.now() + TYPING_SHOW_MS });
    drawTyping();
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
    el('div', { class: 'composer-foot' }, [typingLine, composerError]),
  ]);

  // ===== события из сокета =====

  function belongsHere(message) {
    if (message.channel_id !== channel?.id) return false;
    return isThread ? message.thread_id === thread.id : !message.thread_id;
  }

  function onMessage(message) {
    if (message.channel_id !== channel?.id) return;
    typers.delete(message.user_id);
    drawTyping();
    // Ответ в тред в общей ленте виден только счётчиком под корнем.
    if (!isThread && message.thread_id) {
      const root = items.get(message.thread_id);
      if (root && !(root.seenReplies ??= new Set()).has(message.id)) {
        root.seenReplies.add(message.id);
        redraw(message.thread_id, {
          thread_count: (root.message.thread_count ?? 0) + 1,
          thread_last_at: message.created_at,
        });
      }
      return;
    }
    if (!belongsHere(message) || items.has(message.id)) return;
    // Лента сейчас показывает старое место — новое не вклеиваем в середину,
    // а предлагаем перейти к концу.
    if (hasNewer) {
      jumpButton.hidden = false;
      jumpButton.textContent = 'Есть новые сообщения ↓';
      return;
    }
    append(message);
    if (isThread) redrawThreadDivider();
    if (message.user_id !== me) markRead();
  }

  function onUpdated(message) {
    if (message.channel_id !== channel?.id || !items.has(message.id)) return;
    if (editing?.id === message.id) return;
    const current = items.get(message.id).message;
    // В рассылке счётчика прочтений нет — свой оставляем как был.
    redraw(message.id, { ...message, read_count: current.read_count });
  }

  function onDeleted({ id, channel_id: channelId, thread_id: threadId }) {
    if (channelId !== channel?.id) return;
    // Удалили ответ в треде — в общей ленте уменьшаем счётчик под корнем.
    if (!isThread && threadId) {
      const root = items.get(threadId);
      if (root && !(root.deletedReplies ??= new Set()).has(id)) {
        root.deletedReplies.add(id);
        redraw(threadId, { thread_count: Math.max(0, (root.message.thread_count ?? 1) - 1) });
      }
      return;
    }
    if (!items.has(id) || items.get(id).message.deleted) return;
    if (editing?.id === id) editing = null;
    if (replyTo?.id === id) cancelReply();
    redraw(id, { deleted: true, content: '', attachment: null, reactions: [], mentions: [], pinned: false });
    // Ответы на удалённое тоже показывают, что его больше нет.
    for (const item of items.values()) {
      if (item.message.reply?.id === id) {
        redraw(item.message.id, { reply: { ...item.message.reply, deleted: true, snippet: '' } });
      }
    }
    if (isThread) redrawThreadDivider();
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

  const head = el('header', { class: 'chat-head' }, [
    el('div', { class: 'chat-heading' }, [title, subtitle]),
  ]);
  const node = el('main', { class: `chat${isThread ? ' chat-thread' : ''}` }, [
    head,
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

  // Роль или теги кого-то поменялись — перерисовываем подписи у всех
  // показанных сообщений.
  function redrawAll() {
    for (const id of items.keys()) redraw(id, {});
  }

  return {
    node,
    head,
    redrawAll,
    title,
    subtitle,
    open,
    markRead,
    onMessage,
    onUpdated,
    onDeleted,
    onReactions,
    onReadUpdate,
    onTypingEvent,
    focus: () => input.focus(),
    get channelId() {
      return channel?.id ?? null;
    },
  };
}
