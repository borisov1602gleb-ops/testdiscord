// Главный экран: сообщества слева, каналы (или личные переписки) рядом,
// чат по центру и боковая панель справа — поиск, закреплённые, участники
// или тред. Отсюда же создаются сообщества и приглашения и происходит
// вход в голосовой канал.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon, initial, logo } from '../dom.js';
import { playChime } from '../settings.js';
import { navigate } from '../router.js';
import { createChat, formatFull } from './chat.js';

let socket = null;
let activeChats = [];

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  activeChats = [];
}

// Вернулся во вкладку — значит, увидел то, что пришло, пока его не было.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) activeChats.forEach((chat) => chat?.markRead());
});

function countLabel(n) {
  return n > 99 ? '99+' : String(n);
}

function avatar(name, online, className = 'person-avatar') {
  return el('span', { class: `${className}${online ? ' is-online' : ''}`, text: initial(name) });
}

// Подсветка найденного: запрос ищется без учёта регистра, а в разметку
// попадает только через textContent.
function highlight(text, query) {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const out = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) out.push(text.slice(from, at));
    out.push(el('mark', { text: text.slice(at, at + needle.length) }));
    from = at + needle.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

export function renderHome(communityId) {
  return renderWorkspace({ communityId });
}

export function renderDirect(conversationId) {
  return renderWorkspace({ direct: true, conversationId });
}

async function renderWorkspace({ communityId = null, direct = false, conversationId = null }) {
  mount(
    el('div', { class: 'empty' }, [el('p', { class: 'empty-quiet', text: 'Загружаем…' })]),
  );

  const [{ communities }, directData] = await Promise.all([api('/communities'), api('/direct')]);
  let conversations = directData.conversations;
  if (!direct) {
    if (!communityId && communities.length > 0) return navigate(`#/c/${communities[0].id}`);
    if (communities.length === 0) return renderEmptyState(conversations);
  }

  const me = store.user?.id;
  // Кто в сети: заполняется из списков и обновляется событиями presence.
  const presence = new Map();
  for (const c of conversations) presence.set(c.user.id, c.user.online);

  // Состояние режима сообщества.
  let community = null;
  let role = 'member';
  let members = [];
  let textChannels = [];
  let voiceChannels = [];
  let unread = new Map();
  let voice = {};
  if (!direct) {
    // role приходит из того же запроса: по нему решаем, показывать ли
    // владельцу аналитику и закрепление. Сервер всё равно проверяет сам.
    const data = await api(`/communities/${communityId}`);
    community = data.community;
    role = data.role;
    textChannels = data.channels.filter((c) => c.type === 'text');
    voiceChannels = data.channels.filter((c) => c.type === 'voice');
    const [membersData, unreadData, voiceData] = await Promise.all([
      api(`/communities/${communityId}/members`),
      api(`/communities/${communityId}/unread`),
      api(`/communities/${communityId}/voice`),
    ]);
    members = membersData.members;
    for (const m of members) presence.set(m.id, m.online);
    unread = new Map(unreadData.channels.map((c) => [c.channel_id, c]));
    voice = voiceData.channels;
  }

  // Себя считаем в сети всегда: своё же событие presence приходит раньше,
  // чем вкладка успевает подписаться на комнаты сообществ.
  presence.set(me, true);

  let activeChannel = null; // { id, name, type }
  let activeConversation = null;
  let threadChat = null;
  let threadRoot = null;
  let panelKind = null;

  const chat = createChat({
    community,
    role,
    members,
    onRead: clearUnread,
    onOpenThread: openThread,
    onAuthorClick: direct ? null : startDirect,
    onTyping: (payload) => socket?.emit('typing', payload),
  });
  activeChats = [chat];

  // ===== колонки =====

  const railList = el('div', { class: 'pane-list' });
  const secondList = el('div', { class: 'pane-list' });
  const panel = el('aside', { class: 'side-panel' });
  const headActions = el('div', { class: 'chat-actions' });
  chat.head.append(headActions);

  function drawRail() {
    const ownTotal = [...unread.values()].reduce((sum, c) => sum + c.unread, 0);
    const ownMentions = [...unread.values()].reduce((sum, c) => sum + c.mentions, 0);
    const dmTotal = conversations.reduce((sum, c) => sum + c.unread, 0);
    railList.replaceChildren(
      el(
        'button',
        {
          class: `rail-item rail-direct${direct ? ' is-active' : ''}${dmTotal ? ' has-unread' : ''}`,
          type: 'button',
          onclick: () => navigate('#/dm'),
        },
        [
          el('span', { class: 'rail-badge' }, [icon('chat', 16)]),
          el('span', { class: 'rail-name', text: 'Личные сообщения' }),
          dmTotal > 0 && el('span', { class: 'count-pill is-mention', text: countLabel(dmTotal) }),
        ],
      ),
      el('div', { class: 'rail-sep' }),
      ...communities.map((item) => {
        const current = item.id === community?.id;
        const total = current ? ownTotal : item.unread;
        const mentions = current ? ownMentions : item.mentions;
        return el(
          'button',
          {
            class: `rail-item${current ? ' is-active' : ''}${total ? ' has-unread' : ''}`,
            type: 'button',
            onclick: () => navigate(`#/c/${item.id}`),
          },
          [
            el('span', { class: 'rail-badge', text: initial(item.name) }),
            el('span', { class: 'rail-name', text: item.name }),
            total > 0 &&
              el('span', {
                class: `count-pill${mentions ? ' is-mention' : ''}`,
                text: mentions ? `@ ${countLabel(total)}` : countLabel(total),
              }),
          ],
        );
      }),
    );
  }

  function voicePeople(channelId) {
    const people = voice[channelId] ?? [];
    if (people.length === 0) return null;
    return el(
      'div',
      { class: 'voice-people' },
      people.map((p) =>
        el('div', { class: 'voice-person' }, [
          el('span', { class: 'voice-avatar', text: initial(p.name) }),
          el('span', { class: 'rail-name', text: p.user_id === me ? `${p.name} (вы)` : p.name }),
        ]),
      ),
    );
  }

  function drawChannels() {
    // replaceChildren, в отличие от el(), пустые значения не пропускает —
    // отфильтровываем их сами, иначе на экране появится «null».
    secondList.replaceChildren(...[
      el('div', { class: 'chan-group', text: 'Текстовые' }),
      ...textChannels.map((channel) => {
        const counts = unread.get(channel.id) ?? { unread: 0, mentions: 0 };
        const isActive = channel.id === activeChannel?.id;
        return el(
          'button',
          {
            class: `chan-item${isActive ? ' is-active' : ''}${counts.unread ? ' has-unread' : ''}`,
            type: 'button',
            onclick: () => openTextChannel(channel),
          },
          [
            el('span', { class: 'chan-hash', text: '#' }),
            el('span', { class: 'rail-name', text: channel.name }),
            counts.mentions > 0 && el('span', { class: 'count-pill is-mention', text: '@', title: 'Вас упомянули' }),
            counts.unread > 0 &&
              el('span', { class: 'count-pill', text: countLabel(counts.unread), title: 'Непрочитанные' }),
          ],
        );
      }),
      el('div', { class: 'chan-group', text: 'Голосовые' }),
      ...voiceChannels.flatMap((channel) => {
        const people = voice[channel.id] ?? [];
        return [
          el(
            'button',
            { class: 'chan-item', type: 'button', onclick: () => joinVoice(channel) },
            [
              icon('speaker'),
              el('span', { class: 'rail-name', text: channel.name }),
              people.length > 0 &&
                el('span', { class: 'count-pill is-live', text: String(people.length), title: 'Сейчас в канале' }),
            ],
          ),
          voicePeople(channel.id),
        ];
      }),
      // Состав сообщества виден всем участникам, аналитика — только
      // владельцу. Это подсказка интерфейса, а не защита: права
      // всё равно проверяет сервер.
      el('div', { class: 'chan-group', text: 'Сообщество' }),
      el(
        'button',
        { class: 'chan-item', type: 'button', onclick: () => navigate(`#/c/${community.id}/settings`) },
        [
          icon('people', 16),
          el('span', { class: 'rail-name', text: role === 'owner' ? 'Настройки и участники' : 'Участники' }),
        ],
      ),
      role === 'owner' &&
        el(
          'button',
          { class: 'chan-item', type: 'button', onclick: () => navigate(`#/c/${community.id}/analytics`) },
          [icon('chart', 16), el('span', { class: 'rail-name', text: 'Аналитика' })],
        ),
    ].filter(Boolean));
  }

  function drawConversations() {
    if (conversations.length === 0) {
      secondList.replaceChildren(
        el('p', {
          class: 'pane-empty',
          text: 'Переписок пока нет. Написать можно любому участнику ваших сообществ — через список участников или по имени в чате.',
        }),
      );
      return;
    }
    secondList.replaceChildren(
      ...conversations.map((conv) => {
        const online = presence.get(conv.user.id);
        const last = conv.last_message;
        return el(
          'button',
          {
            class: `dm-item${conv.id === activeConversation?.id ? ' is-active' : ''}${conv.unread ? ' has-unread' : ''}`,
            type: 'button',
            onclick: () => openConversation(conv),
          },
          [
            avatar(conv.user.name, online),
            el('span', { class: 'dm-texts' }, [
              el('span', { class: 'dm-name', text: conv.user.name }),
              el('span', {
                class: 'dm-last',
                text: last ? `${last.from_me ? 'Вы: ' : ''}${last.text}` : 'Нет сообщений',
              }),
            ]),
            conv.unread > 0 && el('span', { class: 'count-pill is-mention', text: countLabel(conv.unread) }),
          ],
        );
      }),
    );
  }

  const drawSecond = () => (direct ? drawConversations() : drawChannels());

  function drawSubtitle() {
    if (direct) {
      if (!activeConversation) {
        chat.subtitle.textContent = '';
        return;
      }
      const online = presence.get(activeConversation.user.id);
      chat.subtitle.textContent = online ? 'в сети' : 'не в сети';
      chat.subtitle.classList.toggle('is-online', Boolean(online));
    } else {
      const count = members.filter((m) => presence.get(m.id)).length;
      chat.subtitle.textContent = `${count} в сети`;
      chat.subtitle.classList.toggle('is-online', count > 0);
    }
  }

  // ===== кнопки в шапке чата и боковая панель =====

  function headButton(kind, label, iconName, onclick) {
    return el(
      'button',
      {
        class: `head-btn${panelKind === kind ? ' is-active' : ''}`,
        type: 'button',
        title: label,
        'aria-label': label,
        onclick: () => (panelKind === kind ? closePanel() : onclick()),
      },
      [icon(iconName, 18)],
    );
  }

  function drawHeadActions() {
    const hasChannel = Boolean(activeChannel);
    headActions.replaceChildren(...[
      hasChannel && headButton('search', direct ? 'Поиск в переписке' : 'Поиск по сообществу', 'search', showSearch),
      hasChannel && headButton('pins', 'Закреплённые', 'pin', showPins),
      !direct && headButton('members', 'Участники', 'people', showMembers),
      !direct &&
        el('button', {
          class: 'btn btn-primary btn-sm',
          type: 'button',
          text: 'Пригласить',
          onclick: () => showInviteModal(community.id),
        }),
    ].filter(Boolean));
  }

  function openPanel(kind, heading, body) {
    panelKind = kind;
    if (kind !== 'thread') {
      threadChat = null;
      threadRoot = null;
      activeChats = [chat];
    }
    panel.replaceChildren(
      ...[
        heading &&
          el('div', { class: 'panel-head' }, [
            el('span', { class: 'panel-title', text: heading }),
            el('button', { class: 'panel-close', type: 'button', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: closePanel }, [icon('close', 16)]),
          ]),
        body,
      ].filter(Boolean),
    );
    layout.classList.add('has-panel');
    drawHeadActions();
  }

  function closePanel() {
    panelKind = null;
    threadChat = null;
    threadRoot = null;
    activeChats = [chat];
    panel.replaceChildren();
    layout.classList.remove('has-panel');
    drawHeadActions();
  }

  function panelEmpty(text) {
    return el('p', { class: 'panel-empty', text });
  }

  function messageCard(message, { query, onUnpin } = {}) {
    const text = message.content || (message.attachment ? `📎 ${message.attachment.filename}` : '');
    return el('div', { class: 'panel-card' }, [
      el('button', { class: 'panel-item', type: 'button', onclick: () => jumpTo(message) }, [
        el('span', { class: 'panel-meta' }, [
          !direct && el('b', { text: `#${message.channel_name}` }),
          el('span', { text: message.author_name }),
          el('span', { class: 'panel-time', text: formatFull(message.created_at) }),
          message.thread_id && el('span', { class: 'panel-tag', text: 'в треде' }),
        ].filter(Boolean)),
        el('span', { class: 'panel-text' }, query ? highlight(text, query) : [text]),
      ]),
      onUnpin && el('button', { class: 'panel-unpin', type: 'button', text: 'Открепить', onclick: onUnpin }),
    ].filter(Boolean));
  }

  function showSearch() {
    const field = el('input', {
      class: 'input',
      type: 'search',
      maxlength: '100',
      placeholder: direct ? 'Искать в переписке' : 'Искать во всех каналах',
    });
    const results = el('div', { class: 'panel-list' }, [panelEmpty('Введите хотя бы два символа')]);
    let timer = null;
    let seq = 0;

    async function run() {
      const q = field.value.trim();
      const mySeq = ++seq;
      if (q.length < 2) {
        results.replaceChildren(panelEmpty('Введите хотя бы два символа'));
        return;
      }
      const scope = direct ? `channel_id=${activeChannel.id}` : `community_id=${community.id}`;
      try {
        const { messages } = await api(`/messages/search?${scope}&q=${encodeURIComponent(q)}`);
        if (mySeq !== seq) return;
        results.replaceChildren(
          ...(messages.length ? messages.map((m) => messageCard(m, { query: q })) : [panelEmpty('Ничего не нашлось')]),
        );
      } catch (err) {
        results.replaceChildren(panelEmpty(err.message));
      }
    }

    field.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 300);
    });
    openPanel('search', 'Поиск', el('div', { class: 'panel-body' }, [
      el('label', { class: 'panel-search' }, [icon('search', 16), field]),
      results,
    ]));
    field.focus();
  }

  async function showPins() {
    const list = el('div', { class: 'panel-list' }, [panelEmpty('Загружаем…')]);
    openPanel('pins', 'Закреплённые', el('div', { class: 'panel-body' }, [list]));
    const canUnpin = direct || role === 'owner';
    try {
      const { messages } = await api(`/messages/pinned?channel_id=${activeChannel.id}`);
      if (panelKind !== 'pins') return;
      list.replaceChildren(
        ...(messages.length
          ? messages.map((m) =>
            messageCard(m, {
              onUnpin: canUnpin
                ? async () => {
                  await api(`/messages/${m.id}/pin`, { method: 'PUT', body: { pinned: false } });
                  showPins();
                }
                : null,
            }))
          : [panelEmpty(canUnpin
            ? 'Пока ничего не закреплено. Закрепить можно из меню сообщения.'
            : 'Пока ничего не закреплено')]),
      );
    } catch (err) {
      list.replaceChildren(panelEmpty(err.message));
    }
  }

  function memberRow(m) {
    const online = presence.get(m.id);
    return el('div', { class: 'member-row' }, [
      avatar(m.name, online),
      el('span', { class: 'member-name', text: m.id === me ? `${m.name} (вы)` : m.name }),
      m.role === 'owner' && el('span', { class: 'panel-tag', text: 'владелец' }),
      m.id !== me &&
        el('button', { class: 'btn btn-secondary btn-sm member-dm', type: 'button', text: 'Написать', onclick: () => startDirect(m.id) }),
    ].filter(Boolean));
  }

  function showMembers() {
    const online = members.filter((m) => presence.get(m.id));
    const offline = members.filter((m) => !presence.get(m.id));
    openPanel('members', 'Участники', el('div', { class: 'panel-body' }, [
      el('div', { class: 'panel-list' }, [
        el('p', { class: 'panel-group', text: `В сети — ${online.length}` }),
        ...online.map(memberRow),
        el('p', { class: 'panel-group', text: `Не в сети — ${offline.length}` }),
        ...offline.map(memberRow),
      ]),
    ]));
  }

  function openThread(root) {
    if (!activeChannel) return;
    threadRoot = root;
    threadChat = createChat({
      community,
      role,
      members,
      thread: root,
      onRead: clearUnread,
      onTyping: (payload) => socket?.emit('typing', payload),
    });
    activeChats = [chat, threadChat];
    threadChat.head.append(
      el('button', { class: 'panel-close', type: 'button', title: 'Закрыть тред', 'aria-label': 'Закрыть тред', onclick: closePanel }, [icon('close', 16)]),
    );
    openPanel('thread', null, threadChat.node);
    threadChat.open(activeChannel, { title: 'Тред' });
  }

  // Переход к сообщению из поиска или закреплённых: в тред — открываем
  // тред, в общую ленту — окно вокруг сообщения.
  async function jumpTo(message) {
    const channel = direct
      ? activeChannel
      : textChannels.find((c) => c.id === message.channel_id);
    if (!channel) return;
    if (message.thread_id) {
      if (activeChannel?.id !== channel.id) await openTextChannel(channel, { keepPanel: true });
      openThread({ id: message.thread_id, channel_id: channel.id });
      return;
    }
    if (activeChannel?.id !== channel.id) {
      activeChannel = channel;
      drawSecond();
    }
    await chat.open(channel, { aroundId: message.id });
  }

  // ===== открытие каналов и переписок =====

  async function openTextChannel(channel, { keepPanel = false } = {}) {
    activeChannel = channel;
    if (!keepPanel && panelKind && panelKind !== 'members' && panelKind !== 'search') closePanel();
    drawChannels();
    drawHeadActions();
    const lastReadAt = unread.get(channel.id)?.last_read_at;
    await chat.open(channel, { lastReadAt });
  }

  async function openConversation(conv) {
    activeConversation = conv;
    activeChannel = { id: conv.id, type: 'direct', name: conv.user.name };
    if (panelKind) closePanel();
    // Адрес меняем без перерисовки экрана — так ссылку на переписку можно
    // сохранить, а экран не мигает.
    history.replaceState(null, '', `#/dm/${conv.id}`);
    drawConversations();
    drawHeadActions();
    drawSubtitle();
    await chat.open(activeChannel, { lastReadAt: conv.last_read_at });
  }

  function clearUnread(channelId) {
    const entry = unread.get(channelId);
    if (entry && (entry.unread || entry.mentions)) {
      entry.unread = 0;
      entry.mentions = 0;
      drawChannels();
      drawRail();
    }
    const conv = conversations.find((c) => c.id === channelId);
    if (conv && conv.unread) {
      conv.unread = 0;
      if (direct) drawConversations();
      drawRail();
    }
  }

  async function startDirect(userId) {
    try {
      const { conversation } = await api('/direct', { method: 'POST', body: { user_id: userId } });
      navigate(`#/dm/${conversation.id}`);
    } catch (err) {
      alert(err.message);
    }
  }

  async function refreshConversations() {
    try {
      ({ conversations } = await api('/direct'));
      for (const c of conversations) presence.set(c.user.id, c.user.online);
      if (activeConversation) {
        activeConversation = conversations.find((c) => c.id === activeConversation.id) ?? activeConversation;
      }
      if (direct) drawConversations();
      drawRail();
    } catch {
      /* подтянется при следующем событии */
    }
  }

  // Кто зашёл, пока мы подключались, мог «проскочить» мимо событий —
  // после подписки перечитываем список один раз.
  async function refreshPresence() {
    try {
      if (!direct) {
        ({ members } = await api(`/communities/${community.id}/members`));
        for (const m of members) presence.set(m.id, m.online);
      }
      presence.set(me, true);
      drawSubtitle();
      if (panelKind === 'members') showMembers();
      await refreshConversations();
    } catch {
      /* обновится по событиям */
    }
  }

  async function refreshVoice() {
    try {
      ({ channels: voice } = await api(`/communities/${community.id}/voice`));
      drawChannels();
    } catch {
      /* список подтянется при следующем событии */
    }
  }

  // ===== события из сокета =====

  function onSocketMessage(message) {
    const mine = message.user_id === me;
    const mentionsMe = message.mentions?.some((m) => m.user_id === me);
    const isActive = message.channel_id === activeChannel?.id;

    if (isActive) {
      chat.onMessage(message);
      threadChat?.onMessage(message);
      // Упоминание в треде открытого канала человек видит — отмечаем.
      if (message.thread_id && mentionsMe) chat.markRead();
    }

    if (message.is_direct) {
      const conv = conversations.find((c) => c.id === message.channel_id);
      if (!conv) {
        refreshConversations();
      } else if (!message.thread_id) {
        conv.last_message = {
          from_me: mine,
          text: message.content || (message.attachment ? 'вложение' : ''),
          created_at: message.created_at,
        };
        if (!mine && !isActive) conv.unread += 1;
        conversations = [conv, ...conversations.filter((c) => c !== conv)];
        if (direct) drawConversations();
        drawRail();
      }
    } else if (!mine && !isActive) {
      if (message.community_id === community?.id) {
        const entry = unread.get(message.channel_id)
          ?? { unread: 0, mentions: 0, channel_id: message.channel_id };
        if (!message.thread_id) entry.unread += 1;
        if (mentionsMe) entry.mentions += 1;
        unread.set(message.channel_id, entry);
        drawChannels();
        drawRail();
      } else {
        const other = communities.find((c) => c.id === message.community_id);
        if (other) {
          if (!message.thread_id) other.unread += 1;
          if (mentionsMe) other.mentions += 1;
          drawRail();
        }
      }
    }

    // Своё сообщение возвращается тем же каналом — на него не звеним.
    if (!mine && (document.hidden || mentionsMe || (message.is_direct && !isActive))) {
      playChime('message');
    }
  }

  function connect() {
    socket = io({ auth: { token: store.token } });
    // Подписка на все свои сообщества: так счётчики непрочитанного на
    // соседних сообществах тоже живые. Личные сообщения приходят сами —
    // через личную комнату пользователя.
    socket.on('connect', async () => {
      await Promise.all(communities.map((c) => socket.emitWithAck('join_community', c.id)));
      refreshPresence();
    });
    socket.on('message', onSocketMessage);
    socket.on('message_updated', (message) => {
      chat.onUpdated(message);
      threadChat?.onUpdated(message);
      if (panelKind === 'pins' && message.channel_id === activeChannel?.id) showPins();
    });
    socket.on('message_deleted', (payload) => {
      chat.onDeleted(payload);
      threadChat?.onDeleted(payload);
      if (threadRoot?.id === payload.id) closePanel();
      if (panelKind === 'pins' && payload.channel_id === activeChannel?.id) showPins();
    });
    socket.on('reactions_updated', (payload) => {
      chat.onReactions(payload);
      threadChat?.onReactions(payload);
    });
    socket.on('read_updated', (payload) => {
      if (payload.user_id === me) {
        // Прочитал в другой вкладке — счётчик гаснет и здесь.
        const entry = unread.get(payload.channel_id);
        if (entry) entry.last_read_at = payload.last_read_at;
        clearUnread(payload.channel_id);
      } else {
        chat.onReadUpdate(payload);
        threadChat?.onReadUpdate(payload);
      }
    });
    socket.on('typing', (payload) => {
      chat.onTypingEvent(payload);
      threadChat?.onTypingEvent(payload);
    });
    socket.on('presence', ({ user_id: userId, online }) => {
      presence.set(userId, online);
      for (const c of conversations) if (c.user.id === userId) c.user.online = online;
      if (direct) drawConversations();
      drawSubtitle();
      if (panelKind === 'members') showMembers();
    });
    socket.on('voice_changed', ({ channel_id: channelId }) => {
      if (voiceChannels.some((c) => c.id === channelId)) refreshVoice();
    });
    socket.on('removed_from_community', ({ community_id: removedId }) => {
      if (removedId === community?.id) return navigate('#/');
      const index = communities.findIndex((c) => c.id === removedId);
      if (index !== -1) communities.splice(index, 1);
      drawRail();
    });
  }

  async function joinVoice(channel) {
    const { call } = await api('/calls', { method: 'POST', body: { channel_id: channel.id } });
    const joined = await api(`/calls/${call.id}/join`, { method: 'POST', body: {} });
    store.activeCall = {
      callId: call.id,
      channelName: channel.name,
      communityName: community.name,
      communityId: community.id,
      guest: false,
      ...joined.livekit,
    };
    navigate(`#/call/${call.id}`);
  }

  // ===== сборка экрана =====

  drawRail();
  drawSecond();
  drawHeadActions();
  const layout = el('div', { class: 'app' }, [
    el('nav', { class: 'rail' }, [
      el('p', { class: 'pane-head' }, [logo(32), el('span', { text: 'Сообщества' })]),
      railList,
      el('div', { class: 'pane-foot' }, [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: '+ Сообщество',
          onclick: showCommunityModal,
        }),
      ]),
      // Профиль внизу левой колонки — как в макете: он относится ко
      // всему приложению, а не к конкретному сообществу.
      userZone(),
    ]),
    el('nav', { class: 'channels' }, [
      el('div', { class: 'pane-title', text: direct ? 'Личные сообщения' : community.name }),
      secondList,
    ]),
    chat.node,
    panel,
  ]);
  mount(layout);
  connect();

  if (direct) {
    let target = conversationId ? conversations.find((c) => c.id === conversationId) : conversations[0];
    if (conversationId && !target) {
      // Переписку только что создали — в загруженном списке её могло не быть.
      try {
        ({ conversation: target } = await api(`/direct/${conversationId}`));
        conversations = [target, ...conversations];
        presence.set(target.user.id, target.user.online);
        drawConversations();
      } catch {
        target = null;
      }
    }
    if (target) await openConversation(target);
    else {
      chat.title.textContent = 'Личные сообщения';
      drawSubtitle();
    }
  } else {
    chat.title.textContent = community.name;
    drawSubtitle();
    if (textChannels[0]) await openTextChannel(textChannels[0]);
  }
}

// Плашка профиля внизу колонки каналов: имя, статус и меню с настройками
// и выходом. Меню открывается вверх, чтобы не упираться в край экрана.
function userZone() {
  const name = store.user?.display_name || store.user?.email || '';
  const zone = el('div', { class: 'user-zone' });

  const menu = el('div', { class: 'user-menu' }, [
    el('div', { class: 'user-menu-head' }, [
      el('div', { class: 'user-avatar', text: initial(name) }),
      el('div', { class: 'user-texts' }, [
        el('span', { class: 'user-name', text: name }),
        el('span', { class: 'user-menu-mail', text: store.user?.email ?? '' }),
      ]),
    ]),
    el('button', { class: 'menu-item', type: 'button', onclick: () => navigate('#/settings') }, [
      icon('gear', 16),
      'Настройки',
    ]),
    el('button', { class: 'menu-item', type: 'button', onclick: () => navigate('#/settings') }, [
      icon('profile', 16),
      'Профиль',
    ]),
    el(
      'button',
      {
        class: 'menu-item menu-danger',
        type: 'button',
        onclick: () => {
          store.clearSession();
          navigate('#/login');
        },
      },
      [icon('signOut', 16), 'Выйти из аккаунта'],
    ),
  ]);

  const caret = el('span', { class: 'caret' }, [icon('caretUp', 14)]);

  function toggle(open) {
    const shouldOpen = open ?? !menu.isConnected;
    if (shouldOpen) {
      zone.prepend(menu);
      caret.replaceChildren(icon('caretDown', 14));
      setTimeout(() => document.addEventListener('click', onOutside), 0);
    } else {
      menu.remove();
      caret.replaceChildren(icon('caretUp', 14));
      document.removeEventListener('click', onOutside);
    }
  }

  function onOutside(event) {
    if (!zone.contains(event.target)) toggle(false);
  }

  zone.append(
    el('button', { class: 'user-bar', type: 'button', onclick: () => toggle() }, [
      el('div', { class: 'user-avatar', text: initial(name) }),
      el('div', { class: 'user-texts' }, [
        el('span', { class: 'user-name', text: name }),
        el('span', { class: 'user-status', text: 'В сети' }),
      ]),
      caret,
    ]),
  );

  return zone;
}

function renderEmptyState(conversations = []) {
  mount(
    el('div', { class: 'empty' }, [
      el('div', { class: 'empty-mark' }, [icon('plus', 24)]),
      el('h1', { class: 'empty-title', text: 'Пока нет сообществ' }),
      el('p', {
        class: 'empty-sub',
        text: 'Создайте своё — в нём сразу появятся текстовый и голосовой каналы',
      }),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: 'Создать сообщество',
          onclick: showCommunityModal,
        }),
        // Из всех сообществ можно выйти, а переписки останутся.
        conversations.length > 0 &&
          el('button', {
            class: 'btn btn-secondary',
            type: 'button',
            text: 'Личные сообщения',
            onclick: () => navigate('#/dm'),
          }),
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'Выйти',
          onclick: () => {
            store.clearSession();
            navigate('#/login');
          },
        }),
      ]),
    ]),
  );
}

function showModal(card) {
  const scrim = el('div', { class: 'modal-scrim' }, [card]);
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) scrim.remove();
  });
  document.getElementById('app').append(scrim);
  return scrim;
}

function showCommunityModal() {
  const input = el('input', {
    class: 'input',
    id: 'community-name',
    type: 'text',
    placeholder: 'Например, Каток по вечерам',
    autofocus: 'true',
  });
  const error = el('p', { class: 'field-error' });

  async function create() {
    const name = input.value.trim();
    if (!name) return;
    try {
      const { community } = await api('/communities', { method: 'POST', body: { name } });
      navigate(`#/c/${community.id}`);
    } catch (err) {
      error.textContent = err.message;
    }
  }

  const scrim = showModal(
    el('form', { class: 'modal', onsubmit: (e) => (e.preventDefault(), create()) }, [
      el('h2', { class: 'modal-title', text: 'Новое сообщество' }),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'community-name', text: 'Название' }),
        input,
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'Отмена',
          onclick: () => scrim.remove(),
        }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Создать' }),
      ]),
      error,
    ]),
  );
  input.focus();
}

// Экспортируется: с экрана звонка тоже можно позвать людей по ссылке.
export function showInviteModal(communityId) {
  const maxUses = el('input', {
    class: 'input',
    id: 'invite-uses',
    type: 'number',
    min: '1',
    inputmode: 'numeric',
    placeholder: 'Без ограничения',
  });
  const hours = el('input', {
    class: 'input',
    id: 'invite-ttl',
    type: 'number',
    min: '1',
    inputmode: 'numeric',
    placeholder: 'Без ограничения',
  });
  const result = el('div');
  const error = el('p', { class: 'field-error' });

  async function create() {
    error.textContent = '';
    const body = { community_id: communityId };
    if (maxUses.value) body.max_uses = Number(maxUses.value);
    if (hours.value) {
      body.expires_at = new Date(Date.now() + Number(hours.value) * 3600_000).toISOString();
    }
    try {
      const { invite } = await api('/invites', { method: 'POST', body });
      const link = `${location.origin}/#/invite/${invite.id}`;
      const linkInput = el('input', { class: 'input', type: 'text', readonly: 'true', value: link });

      result.replaceChildren(
        el('div', { class: 'modal-result' }, [
          el('div', { class: 'copy-row' }, [
            linkInput,
            el('button', {
              class: 'btn btn-secondary',
              type: 'button',
              text: 'Копировать',
              onclick: async (e) => {
                linkInput.select();
                try {
                  await navigator.clipboard.writeText(link);
                  e.target.textContent = 'Скопировано';
                } catch {
                  e.target.textContent = 'Выделено';
                }
              },
            }),
          ]),
          el('p', {
            class: 'field-hint',
            text: 'По этой ссылке можно зайти в звонок без регистрации',
          }),
        ]),
      );
    } catch (err) {
      error.textContent = err.message;
    }
  }

  const scrim = showModal(
    el('form', { class: 'modal', onsubmit: (e) => (e.preventDefault(), create()) }, [
      el('h2', { class: 'modal-title', text: 'Приглашение' }),
      el('p', { class: 'modal-sub', text: 'Ограничения можно не задавать' }),
      el('div', { class: 'field' }, [
        el('label', {
          class: 'field-label',
          for: 'invite-uses',
          text: 'Сколько раз можно использовать',
        }),
        maxUses,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'invite-ttl', text: 'Срок действия, часов' }),
        hours,
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'Закрыть',
          onclick: () => scrim.remove(),
        }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Создать ссылку' }),
      ]),
      result,
      error,
    ]),
  );
}
