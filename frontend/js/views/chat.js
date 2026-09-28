// Чат канала: лента с подгрузкой старых сообщений и переходом к нужному
// месту, правка и удаление, ответы, треды, реакции, упоминания, вложения,
// закреплённые, «печатает…» и «кто просмотрел». Один и тот же модуль
// работает для канала сообщества, личной переписки и треда (боковая
// панель). Экран (home.js) ведёт список каналов и сокет, а сюда передаёт
// события, относящиеся к открытому каналу.
import { api, uploadFile } from '../api.js';
import { store } from '../store.js';
import { el, formatTime, icon, initial } from '../dom.js';
import { renderRich, firstLink, safeHref } from '../rich-text.js';
import { avatarNode } from '../avatar.js';

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
const REPORT_REASONS = [['spam', 'Спам'], ['abuse', 'Оскорбления'], ['other', 'Другое']];
// Голосовое — не больше пяти минут: дальше это уже подкаст.
const MAX_VOICE_MS = 5 * 60 * 1000;
const POLL_MAX_OPTIONS = 10;

// Превью ссылок общие на все чаты вкладки: одна и та же ссылка в разных
// каналах не должна запрашиваться дважды.
const previewCache = new Map();

function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function votersWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'проголосовал';
  return 'проголосовали';
}

// Играет только одно голосовое за раз — как в мессенджерах.
let playingAudio = null;

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
//  tags      — теги сообщества: их тоже можно упомянуть («@Дизайнер»);
//  thread    — корневое сообщение, если это чат треда;
//  decorateAuthor — что показать рядом с именем автора (роль, теги);
//  onRead, onOpenThread, onAuthorClick, onTyping — связи с экраном.
export function createChat({
  community = null,
  permissions = [],
  decorateAuthor,
  members = [],
  tags = [],
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

  // Упоминания для подсветки в тексте: люди и теги.
  function mentionTokens(message) {
    return [
      ...(message.mentions ?? []).map((m) => ({
        token: `@${m.name}`,
        className: m.user_id === me ? 'mention mention-me' : 'mention',
      })),
      ...(message.tag_mentions ?? []).map((t) => ({
        token: `@${t.name}`,
        className: `mention mention-tag tag-${t.color}`,
      })),
    ];
  }

  function nameOf(userId) {
    if (userId === me) return 'Вы';
    return members.find((m) => m.id === userId)?.name ?? 'участник';
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

  // Голосовое: кнопка, полоса прогресса (по ней можно перемотать) и время.
  function voicePlayer(att) {
    const audio = el('audio', { preload: 'none', src: att.url });
    const known = att.duration_ms ? att.duration_ms / 1000 : 0;
    const playIcon = el('span', { class: 'voice-icon' }, [icon('play', 14)]);
    const fill = el('span', { class: 'voice-fill' });
    const bar = el('span', { class: 'voice-bar' }, [fill]);
    const time = el('span', { class: 'voice-time', text: formatClock(known) });
    // В записи из браузера длительность часто неизвестна (Infinity) —
    // тогда берём ту, что сохранили при отправке.
    const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : known);

    const button = el('button', { class: 'voice-play', type: 'button', 'aria-label': 'Слушать' }, [playIcon]);
    button.addEventListener('click', () => {
      if (audio.paused) {
        if (playingAudio && playingAudio !== audio) playingAudio.pause();
        playingAudio = audio;
        audio.play().catch(() => showError('Не удалось воспроизвести'));
      } else {
        audio.pause();
      }
    });
    audio.addEventListener('play', () => playIcon.replaceChildren(icon('pause', 14)));
    audio.addEventListener('pause', () => playIcon.replaceChildren(icon('play', 14)));
    audio.addEventListener('ended', () => {
      fill.style.width = '0%';
      time.textContent = formatClock(duration());
    });
    audio.addEventListener('timeupdate', () => {
      const total = duration();
      if (total) fill.style.width = `${Math.min(100, (audio.currentTime / total) * 100)}%`;
      time.textContent = `${formatClock(audio.currentTime)} / ${formatClock(total)}`;
    });
    bar.addEventListener('click', (event) => {
      const total = duration();
      if (!total) return;
      const rect = bar.getBoundingClientRect();
      audio.currentTime = ((event.clientX - rect.left) / rect.width) * total;
      if (audio.paused) button.click();
    });
    return el('div', { class: 'voice' }, [button, bar, time, audio]);
  }

  // Превью ссылки грузится, только когда сообщение попало на экран.
  const previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previewObserver.unobserve(entry.target);
      entry.target.load();
    }
  }, { root: feed, rootMargin: '200px' });

  function linkPreview(url) {
    const slot = el('div', { class: 'link-preview-slot' });
    slot.load = async () => {
      if (!previewCache.has(url)) {
        previewCache.set(url, api(`/link-preview?url=${encodeURIComponent(url)}`)
          .then((r) => r.preview)
          .catch(() => null));
      }
      const preview = await previewCache.get(url);
      const href = preview && safeHref(preview.url);
      if (!href) return slot.remove();
      const stick = pinned;
      slot.replaceWith(
        el('a', { class: 'link-preview', href, target: '_blank', rel: 'noopener noreferrer nofollow' }, [
          el('span', { class: 'link-preview-site', text: preview.site_name ?? '' }),
          el('span', { class: 'link-preview-title', text: preview.title }),
          preview.description && el('span', { class: 'link-preview-desc', text: preview.description }),
        ]),
      );
      if (stick) scrollToBottom();
    };
    previewObserver.observe(slot);
    return slot;
  }

  // Опрос: варианты с полосками, свой выбор отмечен галочкой. Опрос
  // открытый — по наведению видно, кто за что.
  function pollView(message) {
    const poll = message.poll;
    const mine = new Set(poll.options.filter((o) => o.voter_ids.includes(me)).map((o) => o.id));
    const canClose = !poll.closed && (message.user_id === me || canDeleteAny());
    return el('div', { class: `poll${poll.closed ? ' is-closed' : ''}` }, [
      el('p', { class: 'poll-question' }, [icon('poll', 14), poll.question]),
      el('p', { class: 'poll-kind', text: poll.multiple ? 'Можно выбрать несколько' : 'Один вариант' }),
      ...poll.options.map((option) => {
        const count = option.voter_ids.length;
        const percent = poll.voters ? Math.round((count / poll.voters) * 100) : 0;
        return el('button', {
          class: `poll-option${mine.has(option.id) ? ' is-mine' : ''}`,
          type: 'button',
          disabled: poll.closed ? 'true' : null,
          title: count ? option.voter_ids.map(nameOf).join(', ') : 'Пока никто',
          onclick: () => vote(message, option.id),
        }, [
          el('span', { class: 'poll-fill', style: `width: ${percent}%` }),
          el('span', { class: 'poll-check', text: mine.has(option.id) ? '✓' : '' }),
          el('span', { class: 'poll-text', text: option.text }),
          el('span', { class: 'poll-count', text: `${count} · ${percent}%` }),
        ]);
      }),
      el('div', { class: 'poll-foot' }, [
        el('span', { text: `${poll.voters} ${votersWord(poll.voters)}${poll.closed ? ' · опрос закрыт' : ''}` }),
        canClose && el('button', { class: 'poll-close', type: 'button', text: 'Закрыть опрос', onclick: () => closePoll(message) }),
      ]),
    ]);
  }

  async function vote(message, optionId) {
    const poll = message.poll;
    const mine = new Set(poll.options.filter((o) => o.voter_ids.includes(me)).map((o) => o.id));
    let next;
    if (poll.multiple) {
      if (mine.has(optionId)) mine.delete(optionId);
      else mine.add(optionId);
      next = [...mine];
    } else {
      // Повторное нажатие на свой вариант снимает голос.
      next = mine.has(optionId) ? [] : [optionId];
    }
    try {
      const result = await api(`/polls/${poll.id}/vote`, { method: 'PUT', body: { option_ids: next } });
      redraw(message.id, { poll: result.poll });
    } catch (err) {
      showError(err.message);
    }
  }

  async function closePoll(message) {
    try {
      const result = await api(`/polls/${message.poll.id}/close`, { method: 'POST' });
      redraw(message.id, { poll: result.poll });
    } catch (err) {
      showError(err.message);
    }
  }

  function attachmentView(att) {
    if (att.is_audio) return voicePlayer(att);
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
    if (own && !message.poll) bar.append(tool('Изменить', 'pencil', () => startEdit(message)));
    // Пожаловаться — на чужое сообщение в сообществе; в личке модерации нет.
    if (!own && channel?.type !== 'direct') {
      const reportButton = tool('Пожаловаться', 'flag', (event) => {
        event.stopPropagation();
        showReportForm(message, reportButton);
      });
      bar.append(reportButton);
    }
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
        body.append(el('div', { class: 'msg-text' }, renderRich(message.content, { mentions: mentionTokens(message) })));
        const link = firstLink(message.content);
        if (link) body.append(linkPreview(link));
      }
      if (message.poll) body.append(pollView(message));
      if (message.attachment) body.append(attachmentView(message.attachment));
      if (message.reactions?.length) body.append(reactionsRow(message));
    }
    if (!isThread && !message.thread_id && message.thread_count > 0) body.append(threadSummary(message));
    if (own && !message.deleted) body.append(receipt(message));

    return el('article', { class: classes.join(' '), 'data-id': message.id }, [
      avatarNode(message.author_name, message.author_avatar_url, 'msg-avatar'),
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
    // В канале «только для чтения» пишут старшие роли; остальным поле
    // ввода показываем выключенным, с объяснением.
    const canWrite = !next.read_only || permissions.includes('post_read_only');
    for (const control of [input, sendButton, attachButton, micButton, pollButton]) control.disabled = !canWrite;
    composer.classList.toggle('is-readonly', !canWrite);
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
      ?? (next.read_only && !permissions.includes('post_read_only')
        ? 'Канал объявлений — пишут только модераторы'
        : isThread ? 'Ответить в треде' : next.type === 'direct' ? 'Написать сообщение' : `Написать в #${next.name}`);

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
          body: { content, mentions: mentionsIn(content), tag_mentions: tagMentionsIn(content) },
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

  // Многострочное поле: Enter отправляет, Shift+Enter — новая строка.
  const input = el('textarea', {
    class: 'input composer-input',
    rows: '1',
    // Тот же предел, что и на сервере: лучше не дать набрать лишнее,
    // чем показать ошибку после отправки.
    maxlength: '2000',
    autocomplete: 'off',
    placeholder: 'Выберите канал',
    disabled: 'true',
    title: 'Enter — отправить, Shift+Enter — новая строка. **жирный**, *курсив*, ~~зачёркнутый~~, `код`',
  });
  const micButton = el(
    'button',
    { class: 'composer-icon', type: 'button', title: 'Записать голосовое', 'aria-label': 'Записать голосовое', disabled: 'true' },
    [icon('mic', 18)],
  );
  const pollButton = el(
    'button',
    { class: 'composer-icon', type: 'button', title: 'Создать опрос', 'aria-label': 'Создать опрос', disabled: 'true' },
    [icon('poll', 16)],
  );
  const recordTime = el('span', { class: 'record-time', text: '0:00' });
  const recordBar = el('div', { class: 'record-bar' }, [
    el('span', { class: 'record-dot' }),
    recordTime,
    el('span', { class: 'record-label', text: 'Идёт запись голосового' }),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Отмена', onclick: () => stopRecording(true) }),
    el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Отправить', onclick: () => stopRecording(false) }),
  ]);
  recordBar.hidden = true;
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

  function tagMentionsIn(text) {
    return tags.filter((t) => hasToken(text, `@${t.name}`)).map((t) => t.id);
  }

  // Поле растёт вместе с текстом, но не выше примерно восьми строк.
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  // Ctrl+B / Ctrl+I — обернуть выделенное в разметку.
  function wrapSelection(mark) {
    const { selectionStart: start, selectionEnd: end, value } = input;
    const selected = value.slice(start, end);
    input.value = value.slice(0, start) + mark + selected + mark + value.slice(end);
    input.setSelectionRange(start + mark.length, end + mark.length);
    autosize();
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

  // Подсказка упоминаний: после «@» показываем теги и участников, чьё
  // имя содержит набранное. Тег упоминает всех, у кого он есть.
  function updateSuggestions() {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(^|\s)@([^\s@]*)$/);
    if (!match) return hideSuggestions();
    const typed = match[2].toLowerCase();
    suggestions = [
      ...tags
        .filter((t) => t.name.toLowerCase().includes(typed))
        .map((t) => ({ name: t.name, tag: t })),
      ...members
        .filter((m) => m.id !== me && m.name.toLowerCase().includes(typed))
        .map((m) => ({ name: m.name, member: m })),
    ].slice(0, 8);
    if (suggestions.length === 0) return hideSuggestions();
    suggestIndex = Math.min(suggestIndex, suggestions.length - 1);
    suggestBox.replaceChildren(
      ...suggestions.map((s, i) =>
        el(
          'button',
          {
            class: `mention-option${i === suggestIndex ? ' is-active' : ''}`,
            type: 'button',
            role: 'option',
            // mousedown, а не click: иначе поле потеряет фокус раньше.
            onmousedown: (e) => (e.preventDefault(), chooseSuggestion(s)),
          },
          s.tag
            ? [
              el('span', { class: `reader-avatar mention-tag tag-${s.tag.color}`, text: '#' }),
              el('span', { text: s.name }),
              el('span', { class: 'mention-hint', text: `все с тегом · ${s.tag.member_count ?? ''}`.replace(/ · $/, '') }),
            ]
            : [
              avatarNode(s.name, s.member.avatar_url, 'reader-avatar'),
              el('span', { text: s.name }),
            ],
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
    autosize();
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
    // Enter — отправить, Shift+Enter — новая строка. Пока идёт набор
    // через IME (иероглифы, автозамена), Enter принадлежит ему.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'b' || event.key === 'и')) {
      event.preventDefault();
      wrapSelection('**');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'i' || event.key === 'ш')) {
      event.preventDefault();
      wrapSelection('*');
      return;
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

    const body = {
      channel_id: channel.id,
      content,
      mentions: mentionsIn(content),
      tag_mentions: tagMentionsIn(content),
    };
    if (replyTo) body.reply_to = replyTo.id;
    if (attachment) body.attachment_id = attachment.id;
    if (thread) body.thread_id = thread.id;
    const draft = { value: input.value, replyTo, attachment };

    input.value = '';
    autosize();
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

  // Отправка готового сообщения без текста: голосовое или опрос.
  async function postExtra(extra) {
    const body = { channel_id: channel.id, content: '', ...extra };
    if (thread) body.thread_id = thread.id;
    const { message } = await api('/messages', { method: 'POST', body });
    if (hasNewer) return open(channel);
    if (items.has(message.id)) redraw(message.id, message);
    else append(message);
    if (isThread) redrawThreadDivider();
  }

  // ===== голосовые =====

  let recorder = null;
  let recordChunks = [];
  let recordStart = 0;
  let recordTimer = null;
  let recordCancelled = false;

  function showRecording(on) {
    recordBar.hidden = !on;
    form.hidden = on;
  }

  async function startRecording() {
    if (!channel || recorder) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return showError('Этот браузер не умеет записывать звук');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return showError('Нет доступа к микрофону — разрешите его в настройках браузера');
    }
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
      .find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recordChunks = [];
    recordCancelled = false;
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size) recordChunks.push(e.data);
    });
    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recordTimer);
      const duration = Date.now() - recordStart;
      const type = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
      recorder = null;
      showRecording(false);
      // Случайное короткое нажатие — не сообщение.
      if (recordCancelled || duration < 500) return;
      await sendVoice(new Blob(recordChunks, { type }), type, duration);
    });
    recorder.start(250);
    recordStart = Date.now();
    recordTime.textContent = '0:00';
    showRecording(true);
    recordTimer = setInterval(() => {
      const elapsed = Date.now() - recordStart;
      recordTime.textContent = formatClock(elapsed / 1000);
      if (elapsed >= MAX_VOICE_MS) stopRecording(false);
    }, 250);
  }

  function stopRecording(cancel) {
    recordCancelled = cancel;
    if (recorder?.state === 'recording') recorder.stop();
  }

  async function sendVoice(blob, type, durationMs) {
    const ext = type === 'audio/mp4' ? 'm4a' : type.split('/')[1];
    uploading = true;
    sendButton.disabled = true;
    try {
      const { attachment: voice } = await uploadFile(
        `/attachments?channel_id=${channel.id}&filename=voice.${ext}&duration_ms=${Math.round(durationMs)}`,
        blob,
      );
      await postExtra({ attachment_id: voice.id });
    } catch (err) {
      showError(err.message);
    } finally {
      uploading = false;
      sendButton.disabled = false;
    }
  }

  // ===== опросы =====

  function showPollDialog() {
    if (!channel) return;
    const question = el('input', { class: 'input', type: 'text', maxlength: '200', placeholder: 'Например, когда созвонимся?' });
    const optionsBox = el('div', { class: 'poll-edit-options' });
    const multiple = el('input', { type: 'checkbox' });
    const error = el('p', { class: 'field-error' });
    const addButton = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ Вариант' });

    function addOption(value = '') {
      if (optionsBox.children.length >= POLL_MAX_OPTIONS) return;
      const field = el('input', { class: 'input', type: 'text', maxlength: '100', placeholder: `Вариант ${optionsBox.children.length + 1}`, value });
      const row = el('div', { class: 'poll-edit-row' }, [
        field,
        el('button', {
          class: 'composer-bar-close',
          type: 'button',
          text: '✕',
          title: 'Убрать вариант',
          onclick: () => {
            if (optionsBox.children.length > 2) row.remove();
            addButton.hidden = optionsBox.children.length >= POLL_MAX_OPTIONS;
          },
        }),
      ]);
      optionsBox.append(row);
      addButton.hidden = optionsBox.children.length >= POLL_MAX_OPTIONS;
      return field;
    }
    addOption();
    addOption();
    addButton.addEventListener('click', () => addOption()?.focus());

    async function create() {
      const options = [...optionsBox.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
      try {
        await postExtra({
          poll: { question: question.value.trim(), options, multiple: multiple.checked },
        });
        scrim.remove();
      } catch (err) {
        error.textContent = err.message;
      }
    }

    const scrim = el('div', { class: 'modal-scrim' }, [
      el('form', { class: 'modal', onsubmit: (e) => (e.preventDefault(), create()) }, [
        el('h2', { class: 'modal-title', text: 'Новый опрос' }),
        el('div', { class: 'field' }, [el('span', { class: 'field-label', text: 'Вопрос' }), question]),
        el('div', { class: 'field' }, [el('span', { class: 'field-label', text: 'Варианты' }), optionsBox, addButton]),
        el('label', { class: 'check' }, [multiple, el('span', { text: 'Можно выбрать несколько вариантов' })]),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', type: 'button', text: 'Отмена', onclick: () => scrim.remove() }),
          el('button', { class: 'btn btn-primary', type: 'submit', text: 'Создать опрос' }),
        ]),
        error,
      ]),
    ]);
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) scrim.remove();
    });
    document.getElementById('app').append(scrim);
    question.focus();
  }

  micButton.addEventListener('click', startRecording);
  pollButton.addEventListener('click', showPollDialog);

  // ===== жалобы =====

  function showReportForm(message, anchor) {
    let reason = null;
    const comment = el('input', { class: 'input', type: 'text', maxlength: '500', placeholder: 'Комментарий — по желанию' });
    const status = el('p', { class: 'report-status' });
    const reasons = el('div', { class: 'report-reasons' });
    reasons.replaceChildren(
      ...REPORT_REASONS.map(([id, label]) => el('button', {
        class: 'report-reason',
        type: 'button',
        text: label,
        onclick: (e) => {
          reason = id;
          reasons.querySelectorAll('.report-reason').forEach((b) => b.classList.toggle('is-active', b === e.currentTarget));
        },
      })),
    );
    const submit = el('button', {
      class: 'btn btn-primary btn-sm',
      type: 'button',
      text: 'Отправить модераторам',
      onclick: async () => {
        if (!reason) {
          status.textContent = 'Выберите причину';
          return;
        }
        submit.disabled = true;
        try {
          await api(`/messages/${message.id}/report`, { method: 'POST', body: { reason, comment: comment.value } });
          status.textContent = 'Жалоба отправлена. Спасибо!';
          setTimeout(closePopover, 1400);
        } catch (err) {
          submit.disabled = false;
          status.textContent = err.message;
        }
      },
    });
    showPopover(anchor, [el('p', { class: 'readers-title', text: 'Пожаловаться на сообщение' }), reasons, comment, submit, status]);
    openPopover.classList.add('popover-report');
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

  const form = el('form', { class: 'composer', onsubmit: (e) => (e.preventDefault(), send()) }, [
    attachButton,
    pollButton,
    fileInput,
    input,
    micButton,
    sendButton,
  ]);
  const composer = el('div', { class: 'composer-wrap' }, [
    suggestBox,
    replyBar,
    attachBar,
    form,
    recordBar,
    el('div', { class: 'composer-foot' }, [
      typingLine,
      composerError,
      el('span', { class: 'composer-hint', text: '**жирный** *курсив* `код` · Shift+Enter — новая строка' }),
    ]),
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

  function onPoll({ message_id: messageId, channel_id: channelId, poll }) {
    if (channelId !== channel?.id || !items.has(messageId)) return;
    redraw(messageId, { poll });
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
    onPoll,
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
