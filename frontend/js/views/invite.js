// Превью приглашения — первый экран для человека со стороны. Главная задача:
// дать зайти в звонок без регистрации, а регистрацию предложить потом.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon, logo } from '../dom.js';
import { navigate } from '../router.js';

function renderCard(children, invalid = false) {
  mount(
    el('div', { class: invalid ? 'invite is-invalid' : 'invite' }, [
      el('div', { class: 'invite-card' }, [el('div', { class: 'invite-logo' }, [logo(44)]), ...children]),
    ]),
  );
}

export async function renderInvite(inviteId) {
  let preview;
  try {
    preview = await api(`/invites/${inviteId}?anonymous_id=${store.anonymousId}`, { auth: false });
  } catch (err) {
    return renderCard(
      [
        el('span', { class: 'invite-kicker', text: 'Приглашение в сообщество' }),
        el('h1', { class: 'empty-title', text: 'Приглашение недоступно' }),
        el('p', { class: 'invite-hint', text: err.message }),
        el('div', { class: 'invite-actions' }, [
          el('button', {
            class: 'btn btn-secondary btn-block',
            type: 'button',
            text: 'На главную',
            onclick: () => navigate('#/'),
          }),
        ]),
      ],
      true,
    );
  }

  if (!preview.valid) {
    return renderCard(
      [
        el('span', { class: 'invite-kicker', text: 'Приглашение в сообщество' }),
        el('h1', {
          class: 'empty-title',
          text: 'Срок действия приглашения истёк или оно исчерпано',
        }),
        el('p', { class: 'invite-hint', text: 'Попросите новую ссылку у того, кто вас позвал' }),
      ],
      true,
    );
  }

  const error = el('p', { class: 'field-error' });

  async function joinCall() {
    error.textContent = '';
    if (!preview.voice_channel) {
      error.textContent = 'В сообществе нет голосового канала';
      return;
    }
    try {
      const body = {
        channel_id: preview.voice_channel.id,
        invite_id: inviteId,
        anonymous_id: store.anonymousId,
      };
      const { call } = await api('/calls', { method: 'POST', body, auth: store.isAuthenticated });
      const joined = await api(`/calls/${call.id}/join`, {
        method: 'POST',
        auth: store.isAuthenticated,
        body: store.isAuthenticated
          ? { invite_id: inviteId }
          : { anonymous_id: store.anonymousId, invite_id: inviteId },
      });
      store.activeCall = {
        callId: call.id,
        channelName: preview.voice_channel.name,
        communityName: preview.community.name,
        inviteId,
        guest: !store.isAuthenticated,
        ...joined.livekit,
      };
      navigate(`#/call/${call.id}`);
    } catch (err) {
      error.textContent = err.message;
    }
  }

  async function joinCommunity() {
    try {
      await api(`/invites/${inviteId}/join`, { method: 'POST' });
      navigate('#/');
    } catch (err) {
      error.textContent = err.message;
    }
  }

  renderCard([
    el('span', { class: 'invite-kicker', text: 'Приглашение в сообщество' }),
    el('h1', { class: 'invite-name', text: preview.community.name }),
    preview.voice_channel &&
      el('span', { class: 'invite-meta' }, [
        icon('speaker', 15),
        `Голосовой канал: ${preview.voice_channel.name}`,
      ]),
    el('div', { class: 'invite-actions' }, [
      el('button', {
        class: 'btn btn-primary btn-lg btn-block',
        type: 'button',
        text: 'Присоединиться к звонку',
        onclick: joinCall,
      }),
      el('button', {
        class: 'btn btn-secondary btn-block',
        type: 'button',
        text: store.isAuthenticated ? 'Вступить в сообщество' : 'Войти и вступить',
        onclick: store.isAuthenticated
          ? joinCommunity
          : () => {
              store.pendingInvite = inviteId;
              navigate('#/login');
            },
      }),
    ]),
    !store.isAuthenticated &&
      el('p', {
        class: 'invite-hint',
        text: 'К звонку можно подключиться без регистрации — она понадобится, только чтобы остаться в сообществе',
      }),
    error,
  ]);
}
