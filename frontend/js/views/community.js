// Экран сообщества: состав, роли, теги, каналы и настройки. Что видно и
// что можно менять, зависит от прав (permissions), которые присылает
// сервер: участник видит состав и каналы, модератор дополнительно
// создаёт каналы, ведёт теги и исключает участников, владелец —
// назначает модераторов и переименовывает сообщество. Права проверяет
// сервер, интерфейс лишь не показывает лишнего.
import { api } from '../api.js';
import { el, mount, icon, showModal } from '../dom.js';
import { platformReportForm } from '../platform.js';
import { avatarNode, pickAndUploadAvatar } from '../avatar.js';
import { navigate } from '../router.js';
import { showInviteModal } from './home.js';
import {
  can, tagChip, TAG_COLORS, ROLE_LABELS, MAX_TAGS_PER_MEMBER,
} from '../roles.js';

const ROLE_RANK = { member: 0, moderator: 1, owner: 2 };

// Что умеет каждая роль — для людей, а не для кода. Держим рядом с
// экраном, где роли назначают: так понятно, что именно даёшь человеку.
const ROLE_ABILITIES = [
  ['Писать, отвечать, ставить реакции, прикреплять файлы', true, true, true],
  ['Править и удалять свои сообщения', true, true, true],
  ['Приглашать людей по ссылке', true, true, true],
  ['Удалять чужие сообщения', false, true, true],
  ['Закреплять сообщения', false, true, true],
  ['Создавать каналы, делать их закрытыми или «только для чтения»', false, true, true],
  ['Писать в каналы «только для чтения»', false, true, true],
  ['Видеть все закрытые каналы', false, true, true],
  ['Создавать теги и выставлять их участникам', false, true, true],
  ['Исключать и банить участников (кроме модераторов и владельца)', false, true, true],
  ['Разбирать жалобы на сообщения', false, true, true],
  ['Назначать и снимать модераторов', false, false, true],
  ['Переименовывать сообщество и менять его аватарку', false, false, true],
  ['Смотреть аналитику', false, false, true],
  ['Передать права владельца другому участнику', false, false, true],
];

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

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// Выбор цвета тега — ряд кружков. Возвращает узел и функцию «какой выбран».
function colorPicker(initialColor = 'violet') {
  let selected = initialColor;
  const row = el('div', { class: 'color-row', role: 'radiogroup', 'aria-label': 'Цвет тега' });
  function draw() {
    row.replaceChildren(
      ...TAG_COLORS.map((c) =>
        el('button', {
          class: `color-dot tag-${c.id}${c.id === selected ? ' is-active' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': String(c.id === selected),
          title: c.label,
          'aria-label': c.label,
          onclick: () => {
            selected = c.id;
            draw();
          },
        }),
      ),
    );
  }
  draw();
  return { node: row, value: () => selected };
}

export async function renderCommunity(communityId) {
  mount(el('div', { class: 'empty' }, [el('p', { class: 'empty-quiet', text: 'Загружаем…' })]));

  let community;
  let channels;
  let role;
  let permissions;
  let members;
  let tags;
  try {
    const [info, membersData] = await Promise.all([
      api(`/communities/${communityId}`),
      api(`/communities/${communityId}/members`),
    ]);
    ({ community, channels, role } = info);
    permissions = info.permissions ?? [];
    ({ members, tags } = membersData);
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
  const canManageTags = can(permissions, 'manage_tags');
  const canManageRoles = can(permissions, 'manage_roles');
  const canKick = can(permissions, 'kick_members');
  const canManageChannels = can(permissions, 'manage_channels');
  const canRename = can(permissions, 'manage_community');

  async function reloadMembers() {
    ({ members, tags } = await api(`/communities/${communityId}/members`));
    drawTags();
    drawMembers();
  }

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

  let editingChannelId = null;

  function channelNoteText(channel) {
    const parts = [channel.type === 'voice' ? 'Голосовой канал' : 'Текстовый канал'];
    if (channel.is_private) {
      const names = tags.filter((t) => channel.allowed_tag_ids?.includes(t.id)).map((t) => t.name);
      parts.push(names.length
        ? `закрытый: видят модераторы и теги ${names.join(', ')}`
        : 'закрытый: видят только владелец и модераторы');
    }
    if (channel.read_only) parts.push('только для чтения — пишут модераторы');
    return parts.join(' · ');
  }

  // Настройки доступа к каналу — общие для создания и правки: закрытый
  // (и для каких тегов), «только для чтения» (только у текстовых).
  function accessFields(initial = {}, getType = () => initial.type ?? 'text') {
    const isPrivate = el('input', { type: 'checkbox' });
    const readOnly = el('input', { type: 'checkbox' });
    isPrivate.checked = Boolean(initial.is_private);
    readOnly.checked = Boolean(initial.read_only);
    const chosen = new Set(initial.allowed_tag_ids ?? []);
    const tagPicker = el('div', { class: 'tag-picker' });
    const readOnlyRow = el('label', { class: 'check' }, [
      readOnly,
      el('span', { text: 'Только для чтения — писать могут владелец и модераторы (например, «Объявления»)' }),
    ]);
    function draw() {
      tagPicker.hidden = !isPrivate.checked;
      tagPicker.replaceChildren(
        el('span', { class: 'row-note', text: tags.length ? 'Кому ещё открыт, кроме модераторов:' : 'Создайте теги ниже, чтобы открыть канал части участников' }),
        ...tags.map((tag) => tagChip(tag, {
          active: chosen.has(tag.id),
          onclick: () => {
            if (chosen.has(tag.id)) chosen.delete(tag.id);
            else chosen.add(tag.id);
            draw();
          },
        })),
      );
      readOnlyRow.hidden = getType() !== 'text';
    }
    isPrivate.addEventListener('change', draw);
    draw();
    return {
      node: el('div', { class: 'channel-access' }, [
        el('label', { class: 'check' }, [
          isPrivate,
          el('span', { text: 'Закрытый — видят владелец, модераторы и участники с выбранными тегами' }),
        ]),
        tagPicker,
        readOnlyRow,
      ]),
      redraw: draw,
      value: () => ({
        is_private: isPrivate.checked,
        allowed_tag_ids: isPrivate.checked ? [...chosen] : [],
        read_only: getType() === 'text' && readOnly.checked,
      }),
    };
  }

  function channelEditRow(channel) {
    const nameField = el('input', { class: 'input', type: 'text', maxlength: '40', value: channel.name });
    const access = accessFields(channel);
    const error = el('p', { class: 'field-error' });
    async function save() {
      try {
        const { channel: updated } = await api(`/communities/${communityId}/channels/${channel.id}`, {
          method: 'PATCH',
          body: { name: nameField.value.trim(), ...access.value() },
        });
        channels = channels.map((c) => (c.id === updated.id ? updated : c));
        editingChannelId = null;
        drawChannels();
      } catch (err) {
        error.textContent = err.message;
      }
    }
    return el('form', { class: 'settings-row tag-edit', onsubmit: (e) => (e.preventDefault(), save()) }, [
      el('div', { class: 'tag-edit-fields' }, [nameField, access.node, error]),
      el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          text: 'Отмена',
          onclick: () => {
            editingChannelId = null;
            drawChannels();
          },
        }),
        el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Сохранить' }),
      ]),
    ]);
  }

  function drawChannels() {
    channelsKicker.textContent = `Каналы · ${channels.length}`;
    channelList.replaceChildren(
      ...channels.map((channel) => (channel.id === editingChannelId
        ? channelEditRow(channel)
        : el('div', { class: 'settings-row' }, [
          channel.type === 'voice' ? icon('speaker', 18) : el('span', { class: 'chan-hash', text: '#' }),
          el('div', { class: 'member-info' }, [
            el('p', { class: 'row-title' }, [
              channel.name,
              channel.is_private && el('span', { class: 'chan-flag' }, [icon('lock', 13)]),
              channel.read_only && el('span', { class: 'chan-flag' }, [icon('megaphone', 13)]),
            ]),
            el('p', { class: 'row-note', text: channelNoteText(channel) }),
          ]),
          canManageChannels &&
            el('div', { class: 'row-actions' }, [
              el('button', {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                text: 'Изменить',
                onclick: () => {
                  editingChannelId = channel.id;
                  drawChannels();
                },
              }),
            ]),
        ]))),
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
  const newChannelAccess = accessFields({}, () => newChannelType.value);
  newChannelType.addEventListener('change', () => newChannelAccess.redraw());
  const channelNote = el('p', { class: 'saved-note' });

  async function addChannel() {
    const name = newChannelName.value.trim();
    if (!name) return;
    channelNote.className = 'saved-note';
    channelNote.textContent = 'Создаём…';
    try {
      const { channel } = await api(`/communities/${communityId}/channels`, {
        method: 'POST',
        body: { name, type: newChannelType.value, ...newChannelAccess.value() },
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

  // ===== теги =====
  const tagsKicker = el('p', { class: 'settings-kicker' });
  const tagsList = el('div', { class: 'settings-section' });
  const tagNote = el('p', { class: 'saved-note' });
  let editingTagId = null;

  function drawTags() {
    tagsKicker.textContent = `Теги · ${tags.length}`;
    if (tags.length === 0) {
      tagsList.replaceChildren(
        el('p', {
          class: 'row-note',
          text: canManageTags
            ? 'Тегов пока нет. Тег — подпись участника: «Дизайнер», «9 класс», «Капитан». На права не влияет.'
            : 'Тегов пока нет.',
        }),
      );
      return;
    }
    tagsList.replaceChildren(
      ...tags.map((tag) => {
        if (tag.id === editingTagId) return tagEditRow(tag);
        return el('div', { class: 'settings-row tag-row' }, [
          tagChip(tag),
          el('p', { class: 'row-note', text: `${tag.member_count} ${peopleWord(tag.member_count)}` }),
          canManageTags &&
            el('div', { class: 'row-actions' }, [
              el('button', {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                text: 'Изменить',
                onclick: () => {
                  editingTagId = tag.id;
                  drawTags();
                },
              }),
              confirmingButton({
                label: 'Удалить',
                confirmLabel: 'Снять со всех и удалить?',
                className: 'btn btn-ghost btn-sm',
                onConfirm: async (button) => {
                  try {
                    await api(`/communities/${communityId}/tags/${tag.id}`, { method: 'DELETE' });
                    await reloadMembers();
                  } catch (err) {
                    button.disabled = false;
                    button.textContent = err.message;
                  }
                },
              }),
            ]),
        ]);
      }),
    );
  }

  function peopleWord(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'участник';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'участника';
    return 'участников';
  }

  function tagEditRow(tag) {
    const input = el('input', { class: 'input', type: 'text', maxlength: '24', value: tag.name });
    const picker = colorPicker(tag.color);
    const error = el('p', { class: 'field-error' });
    async function save() {
      try {
        await api(`/communities/${communityId}/tags/${tag.id}`, {
          method: 'PATCH',
          body: { name: input.value.trim(), color: picker.value() },
        });
        editingTagId = null;
        await reloadMembers();
      } catch (err) {
        error.textContent = err.message;
      }
    }
    return el('form', { class: 'settings-row tag-edit', onsubmit: (e) => (e.preventDefault(), save()) }, [
      el('div', { class: 'tag-edit-fields' }, [input, picker.node, error]),
      el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          text: 'Отмена',
          onclick: () => {
            editingTagId = null;
            drawTags();
          },
        }),
        el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Сохранить' }),
      ]),
    ]);
  }

  const newTagName = el('input', {
    class: 'input',
    id: 'new-tag-name',
    type: 'text',
    maxlength: '24',
    placeholder: 'например, Дизайнер',
  });
  const newTagColor = colorPicker('violet');

  async function addTag() {
    const name = newTagName.value.trim();
    if (!name) return;
    tagNote.className = 'saved-note';
    tagNote.textContent = 'Создаём…';
    try {
      const { tag } = await api(`/communities/${communityId}/tags`, {
        method: 'POST',
        body: { name, color: newTagColor.value() },
      });
      newTagName.value = '';
      tagNote.textContent = `Тег «${tag.name}» создан — выставить его можно в списке участников ниже`;
      await reloadMembers();
    } catch (err) {
      tagNote.className = 'field-error';
      tagNote.textContent = err.message;
    }
  }

  // ===== участники =====
  const membersSection = el('section', { class: 'settings-section' });
  const membersKicker = el('p', { class: 'settings-kicker' });
  let tagEditorFor = null; // у кого сейчас открыт выбор тегов

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

  async function transferOwnership(member, button) {
    try {
      await api(`/communities/${communityId}/transfer`, { method: 'POST', body: { user_id: member.id } });
      // Права поменялись целиком — проще перерисовать экран.
      renderCommunity(communityId);
    } catch (err) {
      button.disabled = false;
      button.textContent = err.message;
    }
  }

  async function banMember(member, button) {
    try {
      await api(`/communities/${communityId}/bans`, { method: 'POST', body: { user_id: member.id } });
      members = members.filter((m) => m.id !== member.id);
      drawMembers();
      await loadBans();
    } catch (err) {
      button.disabled = false;
      button.textContent = err.message;
    }
  }

  // ===== баны =====
  const bansSection = el('section', { class: 'settings-section' });
  let bans = [];

  async function loadBans() {
    if (!canKick) return;
    try {
      ({ bans } = await api(`/communities/${communityId}/bans`));
    } catch {
      bans = [];
    }
    drawBans();
  }

  function drawBans() {
    if (!canKick) return;
    bansSection.replaceChildren(
      el('p', { class: 'settings-kicker', text: `Баны · ${bans.length}` }),
      ...(bans.length
        ? bans.map((ban) =>
          el('div', { class: 'settings-row' }, [
            avatarNode(ban.name, null, 'user-avatar'),
            el('div', { class: 'member-info' }, [
              el('p', { class: 'row-title', text: ban.name }),
              el('p', {
                class: 'row-note',
                text: `С ${formatDate(ban.created_at)}${ban.banned_by_name ? `, забанил(а) ${ban.banned_by_name}` : ''}${ban.reason ? ` — «${ban.reason}»` : ''}`,
              }),
            ]),
            el('div', { class: 'row-actions' }, [
              confirmingButton({
                label: 'Разбанить',
                confirmLabel: 'Точно разбанить?',
                className: 'btn btn-ghost btn-sm',
                onConfirm: async (button) => {
                  try {
                    await api(`/communities/${communityId}/bans/${ban.user_id}`, { method: 'DELETE' });
                    await loadBans();
                  } catch (err) {
                    button.disabled = false;
                    button.textContent = err.message;
                  }
                },
              }),
            ]),
          ]))
        : [el('p', { class: 'row-note', text: 'Забаненных нет. Забаненный не может вернуться ни по какой ссылке, пока его не разбанят.' })]),
    );
  }

  async function changeRole(member, select) {
    select.disabled = true;
    try {
      const { member: updated } = await api(`/communities/${communityId}/members/${member.id}`, {
        method: 'PATCH',
        body: { role: select.value },
      });
      members = members.map((m) => (m.id === updated.id ? updated : m));
      drawMembers();
    } catch (err) {
      select.disabled = false;
      select.value = member.role;
      alert(err.message);
    }
  }

  // Выбор тегов участника: нажатие включает и выключает тег, «Сохранить»
  // отправляет набор целиком.
  function tagEditor(member) {
    const chosen = new Set(member.tags.map((t) => t.id));
    const chips = el('div', { class: 'tag-picker' });
    const error = el('p', { class: 'field-error' });
    function draw() {
      chips.replaceChildren(
        ...tags.map((tag) =>
          tagChip(tag, {
            active: chosen.has(tag.id),
            title: chosen.has(tag.id) ? 'Снять тег' : 'Выставить тег',
            onclick: () => {
              if (chosen.has(tag.id)) chosen.delete(tag.id);
              else if (chosen.size >= MAX_TAGS_PER_MEMBER) {
                error.textContent = `Не больше ${MAX_TAGS_PER_MEMBER} тегов на человека`;
                return;
              } else chosen.add(tag.id);
              error.textContent = '';
              draw();
            },
          })),
      );
    }
    draw();
    async function save() {
      try {
        const { member: updated } = await api(`/communities/${communityId}/members/${member.id}/tags`, {
          method: 'PUT',
          body: { tag_ids: [...chosen] },
        });
        members = members.map((m) => (m.id === updated.id ? updated : m));
        tagEditorFor = null;
        ({ tags } = await api(`/communities/${communityId}/tags`));
        drawTags();
        drawMembers();
      } catch (err) {
        error.textContent = err.message;
      }
    }
    return el('div', { class: 'tag-editor' }, [
      tags.length
        ? chips
        : el('p', { class: 'row-note', text: 'Сначала создайте теги в разделе выше' }),
      error,
      el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          text: 'Отмена',
          onclick: () => {
            tagEditorFor = null;
            drawMembers();
          },
        }),
        tags.length > 0 && el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Сохранить', onclick: save }),
      ]),
    ]);
  }

  function memberRow(member) {
    const outranks = ROLE_RANK[role] > ROLE_RANK[member.role];
    const roleControl = canManageRoles && member.role !== 'owner'
      ? el('select', {
        class: 'select select-sm',
        'aria-label': `Роль: ${member.name}`,
        onchange: (e) => changeRole(member, e.target),
      }, [
        el('option', { value: 'member', text: ROLE_LABELS.member }),
        el('option', { value: 'moderator', text: ROLE_LABELS.moderator }),
      ])
      : el('span', {
        class: `role-badge${member.role !== 'member' ? ` is-${member.role}` : ''}`,
        text: ROLE_LABELS[member.role] ?? member.role,
      });
    if (roleControl.tagName === 'SELECT') roleControl.value = member.role;

    return el('div', { class: 'member-card' }, [
      el('div', { class: 'settings-row' }, [
        avatarNode(member.name, member.avatar_url, 'user-avatar'),
        el('div', { class: 'member-info' }, [
          el('p', { class: 'row-title', text: member.name }),
          el('p', { class: 'row-note', text: `В сообществе с ${formatDate(member.joined_at)}` }),
          member.tags.length > 0 &&
            el('div', { class: 'member-tags' }, member.tags.map((t) => tagChip(t, { small: true }))),
        ]),
        el('div', { class: 'row-actions' }, [
          roleControl,
          canManageTags &&
            el('button', {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              text: 'Теги',
              onclick: () => {
                tagEditorFor = tagEditorFor === member.id ? null : member.id;
                drawMembers();
              },
            }),
          // Исключить можно только того, кто младше по роли: модератор —
          // участника, владелец — участника и модератора.
          canKick && outranks &&
            confirmingButton({
              label: 'Исключить',
              confirmLabel: 'Точно исключить?',
              className: 'btn btn-ghost btn-sm',
              onConfirm: (button) => removeMember(member, button),
            }),
          // Передать сообщество — только владелец и только участнику;
          // сам он станет модератором.
          isOwner && member.role !== 'owner' &&
            confirmingButton({
              label: 'Передать права',
              confirmLabel: 'Сделать владельцем?',
              className: 'btn btn-ghost btn-sm',
              onConfirm: (button) => transferOwnership(member, button),
            }),
          // Бан строже исключения: по ссылке больше не вернуться.
          canKick && outranks &&
            confirmingButton({
              label: 'Забанить',
              confirmLabel: 'Забанить навсегда?',
              className: 'btn btn-ghost btn-sm btn-ghost-danger',
              onConfirm: (button) => banMember(member, button),
            }),
        ]),
      ]),
      tagEditorFor === member.id && tagEditor(member),
    ]);
  }

  function drawMembers() {
    membersKicker.textContent = `Участники · ${members.length}`;
    membersSection.replaceChildren(...members.map(memberRow));
  }

  drawTags();
  drawMembers();
  loadBans();

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

  // ===== уведомления сообщества =====
  // Уровень для всего сообщества; у отдельного канала его можно
  // переопределить колокольчиком в шапке канала.
  const notifySection = el('section', { class: 'settings-section' });
  async function drawNotify() {
    let level = 'mentions';
    try {
      const { settings: list } = await api('/users/me/notifications');
      level = list.find((n) => n.target_type === 'community' && n.target_id === communityId)?.level ?? 'mentions';
    } catch {
      /* покажем значение по умолчанию */
    }
    const options = [
      ['all', 'Все сообщения', 'Звук и уведомление о каждом сообщении'],
      ['mentions', 'Только упоминания', 'По умолчанию: когда упомянули вас или ваш тег'],
      ['none', 'Ничего', 'Сообщество приглушено; упоминания видны значком'],
    ];
    notifySection.replaceChildren(
      el('p', { class: 'settings-kicker', text: 'Мои уведомления' }),
      ...options.map(([value, label, note]) => {
        const radio = el('input', { type: 'radio', name: 'community-notify', value });
        radio.checked = value === level;
        radio.addEventListener('change', async () => {
          await api('/users/me/notifications', {
            method: 'PUT',
            body: { target_type: 'community', target_id: communityId, level: value },
          });
        });
        return el('label', { class: 'check' }, [
          radio,
          el('span', {}, [el('span', { class: 'row-title', text: label }), el('span', { class: 'row-note', text: note })]),
        ]);
      }),
    );
  }
  drawNotify();
  const communityAvatar = el('div', { class: 'avatar-slot' });
  const drawCommunityAvatar = () => communityAvatar.replaceChildren(
    avatarNode(community.name, community.avatar_url, 'user-avatar avatar-large'),
  );
  drawCommunityAvatar();
  const avatarNote = el('p', { class: 'saved-note' });

  async function changeCommunityAvatar() {
    try {
      const result = await pickAndUploadAvatar(`/communities/${communityId}/avatar`);
      if (!result) return;
      community = { ...community, avatar_url: result.avatar_url };
      drawCommunityAvatar();
      avatarNote.textContent = 'Аватарка сообщества обновлена';
    } catch (err) {
      avatarNote.className = 'field-error';
      avatarNote.textContent = err.message;
    }
  }
  const manages = canManageTags || canRename;

  const rolesTable = el('table', { class: 'roles-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Что можно' }),
        el('th', { text: 'Участник' }),
        el('th', { text: 'Модератор' }),
        el('th', { text: 'Владелец' }),
      ]),
    ]),
    el('tbody', {}, ROLE_ABILITIES.map(([label, ...allowed]) =>
      el('tr', {}, [
        el('td', { text: label }),
        ...allowed.map((yes) => el('td', { class: yes ? 'is-yes' : 'is-no', text: yes ? '✓' : '—' })),
      ]))),
  ]);

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
          text: manages ? 'Настройки сообщества' : 'О сообществе',
        }),
        can(permissions, 'view_analytics') &&
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
          el('span', { class: `role-badge${role !== 'member' ? ` is-${role}` : ''}`, text: `Вы: ${ROLE_LABELS[role]}` }),
          el('button', {
            class: 'btn btn-secondary btn-sm',
            type: 'button',
            text: 'Пригласить',
            onclick: () => showInviteModal(communityId),
          }),
        ]),

        el('div', { class: 'settings-body' }, [
          canRename &&
            el('section', { class: 'settings-section' }, [
              el('p', { class: 'settings-kicker', text: 'Название и аватарка' }),
              el('div', { class: 'settings-row' }, [
                communityAvatar,
                el('p', { class: 'row-note', text: 'Показывается в списке сообществ слева' }),
                el('div', { class: 'row-actions' }, [
                  el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Сменить аватарку', onclick: changeCommunityAvatar }),
                ]),
              ]),
              avatarNote,
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

          canManageChannels &&
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
              newChannelAccess.node,
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

          tagsKicker,
          tagsList,

          canManageTags &&
            el('form', { class: 'settings-section', onsubmit: (e) => (e.preventDefault(), addTag()) }, [
              el('div', { class: 'field' }, [
                el('label', { class: 'field-label', for: 'new-tag-name', text: 'Новый тег' }),
                newTagName,
              ]),
              el('div', { class: 'field' }, [
                el('span', { class: 'field-label', text: 'Цвет' }),
                newTagColor.node,
              ]),
              el('div', { class: 'btn-row' }, [
                el('button', { class: 'btn btn-secondary', type: 'submit', text: 'Создать тег' }),
              ]),
              tagNote,
            ]),

          notifySection,

          membersKicker,
          membersSection,

          canKick && bansSection,

          el('section', { class: 'settings-section' }, [
            el('p', { class: 'settings-kicker', text: 'Роли — кто что может' }),
            rolesTable,
            el('p', {
              class: 'row-note',
              text: 'Теги на права не влияют — это подписи, чтобы было понятно, кто есть кто.',
            }),
          ]),

          // Владелец уйти не может — сообщество осталось бы без хозяина.
          // Сначала передать права, потом выйти уже модератором.
          isOwner &&
            el('section', { class: 'settings-section' }, [
              el('p', { class: 'settings-kicker', text: 'Участие' }),
              el('p', {
                class: 'row-note',
                text: 'Чтобы уйти из сообщества, сначала передайте права владельца кому-то из участников — кнопкой «Передать права» в списке выше. Вы станете модератором и сможете выйти.',
              }),
            ]),
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
              el('div', { class: 'settings-row' }, [
                icon('flag', 18),
                el('div', {}, [
                  el('p', { class: 'row-title', text: 'Пожаловаться на сообщество' }),
                  el('p', {
                    class: 'row-note',
                    text: 'Если всё сообщество нарушает правила — например, создано для мошенничества. Жалоба уйдёт в службу платформы.',
                  }),
                ]),
                el('button', {
                  class: 'btn btn-ghost btn-sm',
                  type: 'button',
                  text: 'Пожаловаться',
                  onclick: () => {
                    const scrim = showModal(el('div', { class: 'modal' }, [
                      el('h2', { class: 'modal-title', text: `Пожаловаться: ${community.name}` }),
                      ...platformReportForm({ targetType: 'community', targetId: communityId, onDone: () => scrim.remove() }),
                      el('div', { class: 'modal-actions' }, [
                        el('button', { class: 'btn btn-secondary', type: 'button', text: 'Отмена', onclick: () => scrim.remove() }),
                      ]),
                    ]));
                  },
                }),
              ]),
            ]),
        ]),
      ]),
    ]),
  );
}
