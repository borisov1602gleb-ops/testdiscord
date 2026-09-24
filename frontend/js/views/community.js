// Экран сообщества: кто в нём состоит, какие есть каналы и настройки для
// владельца. Участник видит состав и каналы, владелец дополнительно может
// переименовать сообщество и добавить канал — права проверяет сервер,
// интерфейс лишь не показывает лишнего.
import { api } from '../api.js';
import { el, mount, icon, initial } from '../dom.js';
import { navigate } from '../router.js';
import { showInviteModal } from './home.js';

// Опасное действие подтверждается вторым нажатием на ту же кнопку:
// отдельное окно ради одного вопроса — лишнее, а случайный клик
// не должен никого выкидывать из сообщества.
function confirmingButton({ label, confirmLabel, className, onConfirm }) {
  let armed = false;
  const button = el('button', {
    class: className,
    type: 'button',
    text: label,
    onclick: async () => {
      if (!armed) {
        armed = true;
        button.textContent = confirmLabel;
        setTimeout(() => {
          if (!armed) return;
          armed = false;
          button.textContent = label;
        }, 4000);
        return;
      }
      armed = false;
      button.disabled = true;
      button.textContent = 'Секунду…';
      await onConfirm(button);
    },
  });
  return button;
}

const ROLE_LABELS = { owner: 'Владелец', member: 'Участник' };

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export async function renderCommunity(communityId) {
  mount(el('div', { class: 'empty' }, [el('p', { class: 'empty-quiet', text: 'Загружаем…' })]));

  let community;
  let channels;
  let role;
  let members;
  try {
    [{ community, channels, role }, { members }] = await Promise.all([
      api(`/communities/${communityId}`),
      api(`/communities/${communityId}/members`),
    ]);
  } catch (err) {
    return mount(
      el('div', { class: 'empty' }, [
        el('h1', { class: 'empty-title', text: 'Сообщество недоступно' }),
        el('p', { class: 'empty-sub', text: err.message }),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: 'На главную',
          onclick: () => navigate('#/'),
        }),
      ]),
    );
  }

  const isOwner = role === 'owner';

  // ===== название сообщества =====
  const nameInput = el('input', {
    class: 'input',
    id: 'community-rename',
    type: 'text',
    maxlength: '60',
    value: community.name,
  });
  const nameNote = el('p', { class: 'saved-note' });

  async function rename() {
    const name = nameInput.value.trim();
    if (!name || name === community.name) return;
    nameNote.className = 'saved-note';
    nameNote.textContent = 'Сохраняем…';
    try {
      const result = await api(`/communities/${communityId}`, {
        method: 'PATCH',
        body: { name },
      });
      community = result.community;
      nameNote.textContent = 'Название сохранено';
      // Заголовок экрана меняем сразу: иначе человек видит старое имя
      // и думает, что ничего не произошло.
      title.textContent = community.name;
    } catch (err) {
      nameNote.className = 'field-error';
      nameNote.textContent = err.message;
    }
  }

  // ===== каналы =====
  const channelList = el('div', { class: 'settings-section' });
  // Заголовок со счётчиком держим отдельно: после создания канала он
  // должен обновиться вместе со списком, а не остаться прежним.
  const channelsKicker = el('p', { class: 'settings-kicker' });

  function drawChannels() {
    channelsKicker.textContent = `Каналы · ${channels.length}`;
    channelList.replaceChildren(
      ...channels.map((channel) =>
        el('div', { class: 'settings-row' }, [
          channel.type === 'voice' ? icon('speaker', 18) : el('span', { class: 'chan-hash', text: '#' }),
          el('div', {}, [
            el('p', { class: 'row-title', text: channel.name }),
            el('p', {
              class: 'row-note',
              text: channel.type === 'voice' ? 'Голосовой канал' : 'Текстовый канал',
            }),
          ]),
        ]),
      ),
    );
  }
  drawChannels();

  const newChannelName = el('input', {
    class: 'input',
    id: 'new-channel-name',
    type: 'text',
    maxlength: '40',
    placeholder: 'например, поиск-тиммейтов',
  });
  const newChannelType = el(
    'select',
    { class: 'select', id: 'new-channel-type' },
    [
      el('option', { value: 'text', text: 'Текстовый' }),
      el('option', { value: 'voice', text: 'Голосовой' }),
    ],
  );
  const channelNote = el('p', { class: 'saved-note' });

  async function addChannel() {
    const name = newChannelName.value.trim();
    if (!name) return;
    channelNote.className = 'saved-note';
    channelNote.textContent = 'Создаём…';
    try {
      const { channel } = await api(`/communities/${communityId}/channels`, {
        method: 'POST',
        body: { name, type: newChannelType.value },
      });
      channels = [...channels, channel];
      drawChannels();
      newChannelName.value = '';
      channelNote.textContent = `Канал «${channel.name}» создан`;
    } catch (err) {
      channelNote.className = 'field-error';
      channelNote.textContent = err.message;
    }
  }

  // ===== участники =====
  const membersSection = el('section', { class: 'settings-section' });
  const membersKicker = el('p', { class: 'settings-kicker' });

  async function removeMember(member, button) {
    try {
      await api(`/communities/${communityId}/members/${member.id}`, { method: 'DELETE' });
      members = members.filter((m) => m.id !== member.id);
      drawMembers();
    } catch (err) {
      button.disabled = false;
      button.textContent = err.message;
    }
  }

  function drawMembers() {
    membersKicker.textContent = `Участники · ${members.length}`;
    membersSection.replaceChildren(
      ...members.map((member) =>
        el('div', { class: 'settings-row' }, [
          el('div', { class: 'user-avatar', text: initial(member.name) }),
          el('div', {}, [
            el('p', { class: 'row-title', text: member.name }),
            el('p', { class: 'row-note', text: `В сообществе с ${formatDate(member.joined_at)}` }),
          ]),
          el('span', {
            class: member.role === 'owner' ? 'role-badge is-owner' : 'role-badge',
            text: ROLE_LABELS[member.role] ?? member.role,
          }),
          // Исключить может только владелец и только не себя: сообщество
          // не должно остаться без хозяина.
          isOwner &&
            member.role !== 'owner' &&
            confirmingButton({
              label: 'Исключить',
              confirmLabel: 'Точно исключить?',
              className: 'btn btn-ghost btn-sm',
              onConfirm: (button) => removeMember(member, button),
            }),
        ]),
      ),
    );
  }
  drawMembers();

  // ===== уход из сообщества =====
  const leaveNote = el('p', { class: 'field-error' });

  async function leaveCommunity(button) {
    try {
      await api(`/communities/${communityId}/members/me`, { method: 'DELETE' });
      navigate('#/');
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Покинуть сообщество';
      leaveNote.textContent = err.message;
    }
  }

  const title = el('h1', { class: 'settings-title', text: community.name });

  mount(
    el('div', { class: 'settings' }, [
      el('nav', { class: 'settings-nav' }, [
        el('p', { class: 'settings-kicker', text: 'Сообщество' }),
        el('button', {
          class: 'set-nav',
          type: 'button',
          text: '← К каналам',
          onclick: () => navigate(`#/c/${communityId}`),
        }),
        el('button', {
          class: 'set-nav is-active',
          type: 'button',
          text: isOwner ? 'Настройки сообщества' : 'О сообществе',
        }),
        isOwner &&
          el('button', {
            class: 'set-nav',
            type: 'button',
            text: 'Аналитика',
            onclick: () => navigate(`#/c/${communityId}/analytics`),
          }),
      ]),

      el('div', { class: 'settings-pane' }, [
        el('header', { class: 'settings-head' }, [
          title,
          el('button', {
            class: 'btn btn-secondary btn-sm',
            type: 'button',
            text: 'Пригласить',
            onclick: () => showInviteModal(communityId),
          }),
        ]),

        el('div', { class: 'settings-body' }, [
          isOwner &&
            el('section', { class: 'settings-section' }, [
              el('p', { class: 'settings-kicker', text: 'Название' }),
              el('div', { class: 'field' }, [
                el('label', {
                  class: 'field-label',
                  for: 'community-rename',
                  text: 'Как сообщество называется для всех',
                }),
                nameInput,
              ]),
              el('div', { class: 'btn-row' }, [
                el('button', {
                  class: 'btn btn-primary',
                  type: 'button',
                  text: 'Сохранить',
                  onclick: rename,
                }),
              ]),
              nameNote,
            ]),

          channelsKicker,
          channelList,

          isOwner &&
            el('section', { class: 'settings-section' }, [
              el('div', { class: 'field' }, [
                el('label', {
                  class: 'field-label',
                  for: 'new-channel-name',
                  text: 'Новый канал',
                }),
                newChannelName,
              ]),
              el('div', { class: 'field' }, [
                el('label', { class: 'field-label', for: 'new-channel-type', text: 'Тип' }),
                newChannelType,
              ]),
              el('div', { class: 'btn-row' }, [
                el('button', {
                  class: 'btn btn-secondary',
                  type: 'button',
                  text: 'Создать канал',
                  onclick: addChannel,
                }),
              ]),
              channelNote,
            ]),

          membersKicker,
          membersSection,

          // Владельцу выход закрыт: пока нет передачи прав, сообщество
          // осталось бы без хозяина.
          !isOwner &&
            el('section', { class: 'settings-section' }, [
              el('p', { class: 'settings-kicker', text: 'Участие' }),
              el('div', { class: 'settings-row' }, [
                icon('signOut', 18),
                el('div', {}, [
                  el('p', { class: 'row-title', text: 'Покинуть сообщество' }),
                  el('p', {
                    class: 'row-note',
                    text: 'Сообщество пропадёт из списка. Написанные сообщения останутся в истории.',
                  }),
                ]),
                confirmingButton({
                  label: 'Покинуть сообщество',
                  confirmLabel: 'Точно выйти?',
                  className: 'btn btn-secondary btn-sm',
                  onConfirm: (button) => leaveCommunity(button),
                }),
              ]),
              leaveNote,
            ]),

          el('p', {
            class: 'row-note',
            text: isOwner
              ? 'Настройки видны только вам: участники видят состав сообщества и список каналов, но менять их не могут.'
              : 'Менять название и создавать каналы может только владелец сообщества.',
          }),
        ]),
      ]),
    ]),
  );
}
