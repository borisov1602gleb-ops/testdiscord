import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount } from '../dom.js';
import { navigate } from '../router.js';

export async function renderInvite(inviteId) {
  let preview;
  try {
    preview = await api(`/invites/${inviteId}?anonymous_id=${store.anonymousId}`, { auth: false });
  } catch (err) {
    return mount(
      el('div', { class: 'centered' }, [
        el('div', { class: 'card' }, [
          el('h1', { text: 'Приглашение недоступно' }),
          el('p', { class: 'subtitle', text: err.message }),
          el('div', { class: 'actions' }, [
            el('button', { text: 'На главную', onclick: () => navigate('#/') }),
          ]),
        ]),
      ]),
    );
  }

  const error = el('p', { class: 'error' });

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

  function goToLogin() {
    store.pendingInvite = inviteId;
    navigate('#/login');
  }

  mount(
    el('div', { class: 'centered' }, [
      el('div', { class: 'card' }, [
        el('p', { class: 'subtitle', text: 'Приглашение в сообщество' }),
        el('h1', { text: preview.community.name }),
        preview.valid
          ? el('p', {
              class: 'subtitle',
              text: preview.voice_channel
                ? `Голосовой канал: ${preview.voice_channel.name}`
                : 'Голосовых каналов пока нет',
            })
          : el('div', {
              class: 'banner warning',
              text: 'Срок действия приглашения истёк или оно исчерпано',
            }),
        preview.valid &&
          el('div', { class: 'actions' }, [
            el('button', { text: 'Присоединиться к звонку', onclick: joinCall }),
            el('button', {
              class: 'secondary',
              text: store.isAuthenticated ? 'Вступить в сообщество' : 'Войти и вступить',
              onclick: store.isAuthenticated
                ? async () => {
                    try {
                      await api(`/invites/${inviteId}/join`, { method: 'POST' });
                      navigate('#/');
                    } catch (err) {
                      error.textContent = err.message;
                    }
                  }
                : goToLogin,
            }),
          ]),
        !store.isAuthenticated &&
          el('p', {
            class: 'hint',
            text: 'К звонку можно подключиться без регистрации — она понадобится, только чтобы остаться в сообществе',
          }),
        error,
      ]),
    ]),
  );
}
