// Главный экран: сообщества слева, каналы рядом, чат справа. Отсюда же
// создаются сообщества и приглашения и происходит вход в голосовой канал.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, formatTime } from '../dom.js';
import { navigate } from '../router.js';

let socket = null;

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}

export async function renderHome(communityId) {
  mount(el('div', { class: 'centered' }, [el('p', { class: 'empty', text: 'Загружаем…' })]));

  const { communities } = await api('/communities');
  if (!communityId && communities.length > 0) return navigate(`#/c/${communities[0].id}`);
  if (communities.length === 0) return renderEmptyState();

  const { community, channels } = await api(`/communities/${communityId}`);
  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');

  let activeChannel = textChannels[0] ?? null;
  const messagesNode = el('div', { class: 'messages' });
  const seenMessageIds = new Set();

  function appendMessage(message) {
    if (seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);
    messagesNode.querySelector('.empty')?.remove();
    const author = message.author_email ?? (message.user_id === store.user?.id ? store.user.email : '');
    messagesNode.append(
      el('div', {}, [
        el('div', {}, [
          el('span', { class: 'message-author', text: author }),
          el('span', { class: 'message-time', text: formatTime(message.created_at) }),
        ]),
        el('div', { class: 'message-content', text: message.content }),
      ]),
    );
    messagesNode.scrollTop = messagesNode.scrollHeight;
  }

  async function openTextChannel(channel) {
    activeChannel = channel;
    seenMessageIds.clear();
    messagesNode.replaceChildren();
    draw();

    const { messages } = await api(`/messages?channel_id=${channel.id}`);
    if (messages.length === 0) {
      messagesNode.append(el('p', { class: 'empty', text: 'Пока ни одного сообщения' }));
    }
    messages.forEach(appendMessage);
    subscribe(channel.id);
  }

  function subscribe(channelId) {
    disconnectRealtime();
    socket = io({ auth: { token: store.token } });
    socket.on('connect', () => socket.emit('join_channel', channelId));
    socket.on('message', (message) => {
      if (message.channel_id === channelId) appendMessage(message);
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
      messagesNode.append(el('p', { class: 'error', text: err.message }));
    }
  }

  async function joinVoice(channel) {
    const { call } = await api('/calls', { method: 'POST', body: { channel_id: channel.id } });
    const joined = await api(`/calls/${call.id}/join`, { method: 'POST', body: {} });
    store.activeCall = {
      callId: call.id,
      channelName: channel.name,
      communityId: community.id,
      guest: false,
      ...joined.livekit,
    };
    navigate(`#/call/${call.id}`);
  }

  function draw() {
    const communityList = communities.map((item) =>
      el('button', {
        class: `list-item${item.id === community.id ? ' active' : ''}`,
        text: item.name,
        onclick: () => navigate(`#/c/${item.id}`),
      }),
    );

    const channelList = [
      el('p', { class: 'sidebar-header', text: 'Текстовые' }),
      ...textChannels.map((channel) =>
        el('button', {
          class: `list-item${channel.id === activeChannel?.id ? ' active' : ''}`,
          text: `# ${channel.name}`,
          onclick: () => openTextChannel(channel),
        }),
      ),
      el('p', { class: 'sidebar-header', text: 'Голосовые' }),
      ...voiceChannels.map((channel) =>
        el('button', {
          class: 'list-item',
          text: `🔊 ${channel.name}`,
          onclick: () => joinVoice(channel),
        }),
      ),
    ];

    const composerInput = el('input', {
      placeholder: activeChannel ? `Написать в #${activeChannel.name}` : 'Нет текстового канала',
      disabled: activeChannel ? null : 'true',
      onkeydown: (e) => {
        if (e.key === 'Enter') send(e.target);
      },
    });

    mount(
      el('div', { class: 'layout' }, [
        el('nav', { class: 'sidebar' }, [
          el('p', { class: 'sidebar-header', text: 'Сообщества' }),
          el('div', { class: 'sidebar-body' }, communityList),
          el('div', { class: 'sidebar-footer' }, [
            el('button', {
              class: 'ghost',
              text: '+ Сообщество',
              onclick: () => showCommunityModal(),
            }),
          ]),
        ]),
        el('nav', { class: 'sidebar' }, [
          el('p', { class: 'sidebar-header', text: community.name }),
          el('div', { class: 'sidebar-body' }, channelList),
          el('div', { class: 'sidebar-footer' }, [
            el('span', { text: store.user?.email ?? '' }),
            el('button', {
              class: 'ghost',
              text: 'Выйти',
              onclick: () => {
                store.clearSession();
                navigate('#/login');
              },
            }),
          ]),
        ]),
        el('main', { class: 'chat' }, [
          el('div', { class: 'chat-header' }, [
            el('h2', { text: activeChannel ? `# ${activeChannel.name}` : community.name }),
            el('button', {
              class: 'secondary',
              text: 'Пригласить',
              onclick: () => showInviteModal(community.id),
            }),
          ]),
          messagesNode,
          el('div', { class: 'composer' }, [
            composerInput,
            el('button', {
              text: 'Отправить',
              disabled: activeChannel ? null : 'true',
              onclick: () => send(composerInput),
            }),
          ]),
        ]),
      ]),
    );
  }

  if (activeChannel) await openTextChannel(activeChannel);
  else draw();
}

function renderEmptyState() {
  mount(
    el('div', { class: 'centered' }, [
      el('div', { class: 'card' }, [
        el('h1', { text: 'Пока нет сообществ' }),
        el('p', {
          class: 'subtitle',
          text: 'Создайте своё — в нём сразу появятся текстовый и голосовой каналы',
        }),
        el('div', { class: 'actions' }, [
          el('button', { text: 'Создать сообщество', onclick: () => showCommunityModal() }),
          el('button', {
            class: 'secondary',
            text: 'Выйти',
            onclick: () => {
              store.clearSession();
              navigate('#/login');
            },
          }),
        ]),
      ]),
    ]),
  );
}

function showModal(card) {
  const backdrop = el('div', { class: 'modal-backdrop' }, [card]);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.getElementById('app').append(backdrop);
  return backdrop;
}

function showCommunityModal() {
  const input = el('input', { placeholder: 'Например, Тактикульные шутеры', autofocus: 'true' });
  const error = el('p', { class: 'error' });

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

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
  });

  const backdrop = showModal(
    el('div', { class: 'card' }, [
      el('h1', { text: 'Новое сообщество' }),
      el('div', { class: 'field' }, [el('label', { text: 'Название' }), input]),
      el('div', { class: 'actions' }, [
        el('button', { text: 'Создать', onclick: create }),
        el('button', { class: 'secondary', text: 'Отмена', onclick: () => backdrop.remove() }),
      ]),
      error,
    ]),
  );
  input.focus();
}

function showInviteModal(communityId) {
  const maxUses = el('input', { type: 'number', min: '1', placeholder: 'без ограничения' });
  const hours = el('input', { type: 'number', min: '1', placeholder: 'бессрочно' });
  const result = el('div');
  const error = el('p', { class: 'error' });

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
      const linkInput = el('input', { readonly: 'true', value: link });
      result.replaceChildren(
        el('div', { class: 'invite-link' }, [
          linkInput,
          el('button', {
            class: 'secondary',
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
          class: 'hint',
          text: 'По этой ссылке можно зайти в звонок без регистрации',
        }),
      );
    } catch (err) {
      error.textContent = err.message;
    }
  }

  const backdrop = showModal(
    el('div', { class: 'card' }, [
      el('h1', { text: 'Приглашение' }),
      el('p', { class: 'subtitle', text: 'Ограничения можно не задавать' }),
      el('div', { class: 'field' }, [el('label', { text: 'Сколько раз можно использовать' }), maxUses]),
      el('div', { class: 'field' }, [el('label', { text: 'Срок действия, часов' }), hours]),
      el('div', { class: 'actions' }, [
        el('button', { text: 'Создать ссылку', onclick: create }),
        el('button', { class: 'secondary', text: 'Закрыть', onclick: () => backdrop.remove() }),
      ]),
      result,
      error,
    ]),
  );
}
