// Главный экран: сообщества слева, каналы рядом, чат справа. Отсюда же
// создаются сообщества и приглашения и происходит вход в голосовой канал.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon, initial, logo } from '../dom.js';
import { playChime } from '../settings.js';
import { navigate } from '../router.js';
import { createChat } from './chat.js';

let socket = null;
let activeChat = null;

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  activeChat = null;
}

// Вернулся во вкладку — значит, увидел то, что пришло, пока его не было.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) activeChat?.markRead();
});

function countLabel(n) {
  return n > 99 ? '99+' : String(n);
}

export async function renderHome(communityId) {
  mount(
    el('div', { class: 'empty' }, [el('p', { class: 'empty-quiet', text: 'Загружаем…' })]),
  );

  const { communities } = await api('/communities');
  if (!communityId && communities.length > 0) return navigate(`#/c/${communities[0].id}`);
  if (communities.length === 0) return renderEmptyState();

  // role приходит из того же запроса: по нему решаем, показывать ли владельцу
  // вкладку аналитики. Сервер всё равно проверяет права сам.
  const { community, channels, role } = await api(`/communities/${communityId}`);
  const [{ members }, unreadData, voiceData] = await Promise.all([
    api(`/communities/${communityId}/members`),
    api(`/communities/${communityId}/unread`),
    api(`/communities/${communityId}/voice`),
  ]);
  const me = store.user?.id;
  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const unread = new Map(unreadData.channels.map((c) => [c.channel_id, c]));
  let voice = voiceData.channels;
  let activeChannel = null;

  const chat = createChat({
    community,
    role,
    members,
    // Канал на экране — в нём непрочитанных нет.
    onRead: (channelId) => {
      const entry = unread.get(channelId);
      if (entry && (entry.unread || entry.mentions)) {
        entry.unread = 0;
        entry.mentions = 0;
        drawChannels();
        drawRail();
      }
    },
  });
  activeChat = chat;
  chat.head.append(
    el('button', {
      class: 'btn btn-primary btn-sm',
      type: 'button',
      text: 'Пригласить',
      onclick: () => showInviteModal(community.id),
    }),
  );
  chat.title.textContent = community.name;

  const railList = el('div', { class: 'pane-list' });
  const channelList = el('div', { class: 'pane-list' });

  function drawRail() {
    const ownTotal = [...unread.values()].reduce((sum, c) => sum + c.unread, 0);
    const ownMentions = [...unread.values()].reduce((sum, c) => sum + c.mentions, 0);
    railList.replaceChildren(
      ...communities.map((item) => {
        const current = item.id === community.id;
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
    channelList.replaceChildren(...[
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
        {
          class: 'chan-item',
          type: 'button',
          onclick: () => navigate(`#/c/${community.id}/settings`),
        },
        [
          icon('people', 16),
          el('span', {
            class: 'rail-name',
            text: role === 'owner' ? 'Настройки и участники' : 'Участники',
          }),
        ],
      ),
      role === 'owner' &&
        el(
          'button',
          {
            class: 'chan-item',
            type: 'button',
            onclick: () => navigate(`#/c/${community.id}/analytics`),
          },
          [icon('chart', 16), el('span', { class: 'rail-name', text: 'Аналитика' })],
        ),
    ].filter(Boolean));
  }

  async function openTextChannel(channel) {
    activeChannel = channel;
    drawChannels();
    const lastReadAt = unread.get(channel.id)?.last_read_at;
    await chat.open(channel, { lastReadAt });
  }

  async function refreshVoice() {
    try {
      ({ channels: voice } = await api(`/communities/${community.id}/voice`));
      drawChannels();
    } catch {
      /* список подтянется при следующем событии */
    }
  }

  function connect() {
    socket = io({ auth: { token: store.token } });
    // Одна подписка на всё сообщество: новые сообщения во всех каналах
    // (для счётчиков), правки, реакции, прочтения и голосовые каналы.
    socket.on('connect', () => socket.emit('join_community', community.id));
    socket.on('message', (message) => {
      const mentionsMe = message.mentions?.some((m) => m.user_id === me);
      if (message.channel_id === activeChannel?.id) {
        chat.onMessage(message);
      } else if (message.user_id !== me) {
        const entry = unread.get(message.channel_id) ?? { unread: 0, mentions: 0, channel_id: message.channel_id };
        entry.unread += 1;
        if (mentionsMe) entry.mentions += 1;
        unread.set(message.channel_id, entry);
        drawChannels();
        drawRail();
      }
      // Своё сообщение возвращается тем же каналом — на него не звеним.
      if (message.user_id !== me && (document.hidden || mentionsMe)) playChime('message');
    });
    socket.on('message_updated', (message) => chat.onUpdated(message));
    socket.on('message_deleted', (payload) => chat.onDeleted(payload));
    socket.on('reactions_updated', (payload) => chat.onReactions(payload));
    socket.on('read_updated', (payload) => {
      if (payload.user_id === me) {
        // Прочитал в другой вкладке — счётчик гаснет и здесь.
        const entry = unread.get(payload.channel_id);
        if (entry) {
          entry.unread = 0;
          entry.mentions = 0;
          entry.last_read_at = payload.last_read_at;
          drawChannels();
          drawRail();
        }
      } else {
        chat.onReadUpdate(payload);
      }
    });
    socket.on('voice_changed', refreshVoice);
    socket.on('removed_from_community', ({ community_id: removedId }) => {
      if (removedId === community.id) navigate('#/');
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

  drawRail();
  drawChannels();
  mount(
    el('div', { class: 'app' }, [
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
        el('div', { class: 'pane-title', text: community.name }),
        channelList,
      ]),
      chat.node,
    ]),
  );
  connect();

  if (textChannels[0]) await openTextChannel(textChannels[0]);
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

function renderEmptyState() {
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
