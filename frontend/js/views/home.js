// Главный экран: сообщества слева, каналы рядом, чат справа. Отсюда же
// создаются сообщества и приглашения и происходит вход в голосовой канал.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, formatTime, icon, initial } from '../dom.js';
import { playChime } from '../settings.js';
import { navigate } from '../router.js';

let socket = null;

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
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
  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');

  let activeChannel = textChannels[0] ?? null;
  const feedNode = el('div', { class: 'chat-feed' });
  const seenMessageIds = new Set();

  function appendMessage(message) {
    if (seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);
    feedNode.querySelector('.empty-quiet')?.remove();

    const author = message.author_name ?? '';
    feedNode.append(
      el('article', { class: 'msg' }, [
        el('div', { class: 'msg-avatar', text: initial(author) }),
        el('div', {}, [
          el('div', { class: 'msg-head' }, [
            el('span', { class: 'msg-author', text: author }),
            el('span', { class: 'msg-time', text: formatTime(message.created_at) }),
          ]),
          el('p', { class: 'msg-text', text: message.content }),
        ]),
      ]),
    );
    feedNode.scrollTop = feedNode.scrollHeight;
  }

  async function openTextChannel(channel) {
    activeChannel = channel;
    seenMessageIds.clear();
    feedNode.replaceChildren();
    draw();

    const { messages } = await api(`/messages?channel_id=${channel.id}`);
    if (messages.length === 0) {
      feedNode.append(el('p', { class: 'empty-quiet', text: 'Пока ни одного сообщения' }));
    }
    messages.forEach(appendMessage);
    subscribe(channel.id);
  }

  function subscribe(channelId) {
    disconnectRealtime();
    socket = io({ auth: { token: store.token } });
    socket.on('connect', () => socket.emit('join_channel', channelId));
    socket.on('message', (message) => {
      if (message.channel_id !== channelId) return;
      appendMessage(message);
      // Своё же сообщение возвращается тем же каналом — на него не звеним.
      if (message.user_id !== store.user?.id && document.hidden) playChime('message');
    });
  }

  async function send(input) {
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    try {
      const { message } = await api('/messages', {
        method: 'POST',
        body: { channel_id: activeChannel.id, content },
      });
      // Обычно сообщение приходит обратно по WebSocket; если соединения нет,
      // показываем его сразу (повтор отсекается по id).
      appendMessage(message);
    } catch (err) {
      feedNode.append(el('p', { class: 'field-error', text: err.message }));
    }
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

  function draw() {
    const composerInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: activeChannel ? `Написать в #${activeChannel.name}` : 'Нет текстового канала',
      disabled: activeChannel ? null : 'true',
    });

    mount(
      el('div', { class: 'app' }, [
        el('nav', { class: 'rail' }, [
          el('p', { class: 'pane-head', text: 'Сообщества' }),
          el(
            'div',
            { class: 'pane-list' },
            communities.map((item) =>
              el(
                'button',
                {
                  class: `rail-item${item.id === community.id ? ' is-active' : ''}`,
                  type: 'button',
                  onclick: () => navigate(`#/c/${item.id}`),
                },
                [
                  el('span', { class: 'rail-badge', text: initial(item.name) }),
                  el('span', { class: 'rail-name', text: item.name }),
                ],
              ),
            ),
          ),
          el('div', { class: 'pane-foot' }, [
            el('button', {
              class: 'btn btn-ghost',
              type: 'button',
              text: '+ Сообщество',
              onclick: showCommunityModal,
            }),
          ]),
        ]),

        el('nav', { class: 'channels' }, [
          el('div', { class: 'pane-title', text: community.name }),
          el('div', { class: 'pane-list' }, [
            el('div', { class: 'chan-group', text: 'Текстовые' }),
            ...textChannels.map((channel) =>
              el(
                'button',
                {
                  class: `chan-item${channel.id === activeChannel?.id ? ' is-active' : ''}`,
                  type: 'button',
                  onclick: () => openTextChannel(channel),
                },
                [
                  el('span', { class: 'chan-hash', text: '#' }),
                  el('span', { class: 'rail-name', text: channel.name }),
                ],
              ),
            ),
            el('div', { class: 'chan-group', text: 'Голосовые' }),
            ...voiceChannels.map((channel) =>
              el(
                'button',
                { class: 'chan-item', type: 'button', onclick: () => joinVoice(channel) },
                [icon('speaker'), el('span', { class: 'rail-name', text: channel.name })],
              ),
            ),
            // Аналитика — только для владельца. Это подсказка интерфейса,
            // а не защита: доступ всё равно проверяется на сервере.
            role === 'owner' && el('div', { class: 'chan-group', text: 'Управление' }),
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
          ]),
          userZone(),
        ]),

        el('main', { class: 'chat' }, [
          el('header', { class: 'chat-head' }, [
            el('span', {
              class: 'chat-title',
              text: activeChannel ? `# ${activeChannel.name}` : community.name,
            }),
            el('button', {
              class: 'btn btn-primary btn-sm',
              type: 'button',
              text: 'Пригласить',
              onclick: () => showInviteModal(community.id),
            }),
          ]),
          feedNode,
          el(
            'form',
            { class: 'composer', onsubmit: (e) => (e.preventDefault(), send(composerInput)) },
            [
              composerInput,
              el('button', {
                class: 'btn btn-primary',
                type: 'submit',
                text: 'Отправить',
                disabled: activeChannel ? null : 'true',
              }),
            ],
          ),
        ]),
      ]),
    );
  }

  if (activeChannel) await openTextChannel(activeChannel);
  else draw();
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
