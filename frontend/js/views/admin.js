// Панель команды платформы. Вкладки и кнопки зависят от роли: модератор
// разбирает жалобы и видит свой журнал, администратор — ещё обжалования,
// людей, сообщества, команду и статистику, суперадминистратор — всё,
// включая настройки и выгрузку по официальным запросам.
//
// Каждое действие требует причину: она уходит в журнал и человеку.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon, showModal } from '../dom.js';
import { navigate } from '../router.js';
import {
  loadPlatform, platformCan, PLATFORM_ROLE_LABELS, SANCTION_LABELS, REPORT_REASON_LABELS,
  APPEAL_STATUS_LABELS, untilText, formatDateTime, queueTotal,
} from '../platform.js';

const TABS = [
  ['reports', 'Жалобы', 'handle_reports'],
  ['appeals', 'Обжалования', 'review_appeals'],
  ['users', 'Люди', 'view_users'],
  ['communities', 'Сообщества', 'manage_communities'],
  ['team', 'Команда', 'manage_moderators'],
  ['audit', 'Журнал', 'view_audit'],
  ['platform', 'Платформа', 'view_stats'],
];

const TARGET_LABELS = { message: 'Сообщение', user: 'Человек', community: 'Сообщество' };
const STATUS_LABELS = {
  open: 'Новая', escalated: 'Передана выше', resolved: 'Решена', dismissed: 'Отклонена',
};
const COMMUNITY_STATUS_LABELS = {
  active: 'Обычное', invites_hidden: 'Приглашения скрыты', frozen: 'Заморожено', deleted: 'Удалено',
};
const ACTION_LABELS = {
  view_report_context: 'Открыл переписку по жалобе',
  report_dismissed: 'Отклонил жалобу',
  report_escalated: 'Передал жалобу выше',
  report_resolved: 'Закрыл жалобу',
  message_removed: 'Удалил сообщение',
  user_warning: 'Вынес предупреждение',
  user_mute: 'Заглушил',
  user_suspend: 'Временно заблокировал',
  user_ban: 'Заблокировал навсегда',
  sanction_revoked: 'Снял меру',
  view_user: 'Открыл карточку человека',
  role_changed: 'Сменил роль',
  user_data_exported: 'Выгрузил данные по запросу',
  community_active: 'Вернул сообществу обычный режим',
  community_invites_hidden: 'Скрыл приглашения сообщества',
  community_frozen: 'Заморозил сообщество',
  community_deleted: 'Удалил сообщество',
  community_transferred: 'Передал сообщество',
  appeal_accepted: 'Удовлетворил обжалование',
  appeal_rejected: 'Отклонил обжалование',
  settings_changed: 'Изменил настройки платформы',
  superadmin_granted_by_config: 'Назначен суперадминистратор (настройки сервера)',
  superadmin_revoked_by_config: 'Снят суперадминистратор (настройки сервера)',
  community_purged: 'Стёрто содержимое удалённого сообщества',
  messages_purged: 'Стёрт текст удалённых сообщений',
};
const SETTING_LABELS = {
  registration_open: 'Регистрация новых аккаунтов открыта',
  max_communities_per_user: 'Сколько сообществ может создать один человек',
  max_invites_per_day: 'Сколько приглашений в сутки может создать один человек',
};
const CANNOT_REVIEW = {
  own_decision: 'Ваше решение — его рассматривает другой сотрудник',
  issuer_outranks_you: 'Решение старшего по роли',
  not_allowed: 'Нет прав',
};

// Список, который сейчас на экране, перечитывается, когда в очереди
// что-то меняется (новая жалоба, новое обжалование). В карточке жалобы
// не перечитываем — чтобы не сбить того, кто её разбирает.
let liveRefresh = null;
let liveSocket = null;

// ===== общие кусочки =====

// replaceChildren, в отличие от el(), пустые значения не пропускает —
// условные куски («если есть права») отфильтровываем сами.
function fill(node, ...children) {
  node.replaceChildren(...children.filter((c) => c != null && c !== false && c !== ''));
}

function pill(text, kind = '') {
  return el('span', { class: `admin-pill${kind ? ` is-${kind}` : ''}`, text });
}

function note(text) {
  return el('p', { class: 'row-note', text });
}

// Окно действия: причина обязательна, плюс срок или галочка, если нужны.
function actionDialog({ title, hint, days = null, allowForever = false, finalOption = false, confirmText, danger = false, reasonLabel = 'Причина — её увидит человек и она попадёт в журнал', onConfirm }) {
  const reason = el('textarea', { class: 'input', rows: '3', maxlength: '1000' });
  const daysSelect = days && el('select', { class: 'select' }, [
    ...days.map((d) => el('option', { value: String(d), text: d === 1 ? '1 день' : `${d} дней` })),
    allowForever && el('option', { value: 'forever', text: 'Навсегда' }),
  ]);
  const finalBox = finalOption && el('input', { type: 'checkbox' });
  const error = el('p', { class: 'field-error' });
  const confirm = el('button', {
    class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
    type: 'submit',
    text: confirmText,
  });
  const scrim = showModal(el('form', {
    class: 'modal admin-dialog',
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!reason.value.trim()) {
        error.textContent = 'Укажите причину';
        return;
      }
      confirm.disabled = true;
      try {
        await onConfirm({
          reason: reason.value.trim(),
          days: daysSelect ? daysSelect.value : null,
          final: finalBox ? finalBox.checked : false,
        });
        scrim.remove();
      } catch (err) {
        confirm.disabled = false;
        error.textContent = err.message;
      }
    },
  }, [
    el('h2', { class: 'modal-title', text: title }),
    hint && note(hint),
    daysSelect && el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Срок' }), daysSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: reasonLabel }), reason]),
    finalBox && el('label', { class: 'check' }, [
      finalBox,
      el('span', { text: 'По требованию государственного органа — такое удаление не обжалуется и не отменяется' }),
    ]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Отмена', onclick: () => scrim.remove() }),
      confirm,
    ]),
    error,
  ]));
  reason.focus();
}

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = el('a', { href: URL.createObjectURL(blob), download: name, hidden: '' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Кнопки мер против человека — по правам того, кто смотрит.
function userActions(user, { reportId = null, onDone }) {
  const buttons = [];
  const sanction = (kind, body) => api(`/platform/staff/users/${user.id}/sanctions`, {
    method: 'POST', body: { kind, report_id: reportId, ...body },
  }).then(onDone);
  if (platformCan('warn_users')) {
    buttons.push(el('button', {
      class: 'btn btn-secondary btn-sm', type: 'button', text: 'Предупредить',
      onclick: () => actionDialog({
        title: `Предупреждение: ${user.name}`,
        hint: 'Ничего не ограничивает, человек увидит его при входе.',
        confirmText: 'Предупредить',
        onConfirm: ({ reason }) => sanction('warning', { reason }),
      }),
    }));
  }
  if (platformCan('mute_users')) {
    buttons.push(el('button', {
      class: 'btn btn-secondary btn-sm', type: 'button', text: 'Заглушить',
      onclick: () => actionDialog({
        title: `Заглушить: ${user.name}`,
        hint: 'Человек всё читает, но не пишет, не ставит реакции и не говорит в звонках — на всей платформе.',
        days: [1, 7, 30],
        confirmText: 'Заглушить',
        onConfirm: ({ reason, days }) => sanction('mute', { reason, days: Number(days) }),
      }),
    }));
  }
  if (platformCan('suspend_users')) {
    buttons.push(el('button', {
      class: 'btn btn-danger btn-sm', type: 'button', text: 'Заблокировать',
      onclick: () => actionDialog({
        title: `Заблокировать: ${user.name}`,
        hint: 'Человек не сможет пользоваться платформой; увидит причину и сможет обжаловать.',
        days: [1, 7, 30],
        allowForever: platformCan('ban_users'),
        confirmText: 'Заблокировать',
        danger: true,
        onConfirm: ({ reason, days }) => (days === 'forever'
          ? sanction('ban', { reason })
          : sanction('suspend', { reason, days: Number(days) })),
      }),
    }));
  }
  return buttons;
}

function sanctionRow(s, onDone) {
  const active = !s.revoked_at && (!s.ends_at || new Date(s.ends_at) > new Date());
  const mine = s.issued_by === store.user?.id;
  const canRevoke = active && !s.final && (mine || platformCan('revoke_any_sanction'));
  return el('div', { class: `settings-row admin-sanction${active ? ' is-active' : ''}` }, [
    el('div', { class: 'member-info' }, [
      el('p', { class: 'row-title', text: SANCTION_LABELS[s.kind] ?? s.kind }),
      note(`${formatDateTime(s.created_at)}${s.issued_by_name ? ` · ${s.issued_by_name}` : ''}${['mute', 'suspend', 'ban'].includes(s.kind) ? ` · ${untilText(s.ends_at)}` : ''}`),
      note(`Причина: ${s.reason}`),
      s.revoked_at && note(`Снято: ${s.revoke_reason ?? ''}`),
      s.appeal_status && note(`Обжалование: ${APPEAL_STATUS_LABELS[s.appeal_status]}`),
    ]),
    el('div', { class: 'row-actions' }, [
      active ? pill('действует', 'danger') : pill(s.revoked_at ? 'снято' : 'истекло'),
      canRevoke && el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: 'Снять',
        onclick: () => actionDialog({
          title: `Снять: ${SANCTION_LABELS[s.kind]}`,
          confirmText: 'Снять меру',
          onConfirm: ({ reason }) => api(`/platform/staff/sanctions/${s.id}/revoke`, { method: 'POST', body: { reason } }).then(onDone),
        }),
      }),
    ]),
  ]);
}

// ===== вкладки =====

async function reportsTab(body, { filter = 'open' } = {}) {
  liveRefresh = () => reportsTab(body, { filter });
  const filters = [['open', 'Новые'], ['escalated', 'Переданные выше'], ['closed', 'Разобранные']];
  const list = el('div', { class: 'admin-list' }, [note('Загружаем…')]);
  fill(body, 
    el('div', { class: 'admin-filters' }, filters.map(([id, label]) => el('button', {
      class: `admin-filter${filter === id ? ' is-active' : ''}`,
      type: 'button',
      text: label,
      onclick: () => reportsTab(body, { filter: id }),
    }))),
    list,
  );
  const { reports } = await api(`/platform/staff/reports?status=${filter}`);
  if (reports.length === 0) {
    list.replaceChildren(note(filter === 'closed' ? 'Разобранных жалоб пока нет.' : 'Жалоб нет — всё спокойно.'));
    return;
  }
  list.replaceChildren(...reports.map((r) => el('button', {
    class: 'admin-card',
    type: 'button',
    onclick: () => reportDetail(body, r.id, filter),
  }, [
    el('div', { class: 'admin-card-head' }, [
      pill(TARGET_LABELS[r.target_type]),
      pill(REPORT_REASON_LABELS[r.reason], r.reason === 'illegal' ? 'danger' : ''),
      r.source === 'community' && pill('из сообщества', 'accent'),
      pill(STATUS_LABELS[r.status], r.status === 'escalated' ? 'warn' : ''),
      el('span', { class: 'admin-card-date', text: formatDateTime(r.created_at) }),
    ]),
    r.message && el('p', { class: 'admin-quote', text: r.message.removed ? '(сообщение удалено)' : r.message.content }),
    el('p', { class: 'row-note', text: [
      r.target_user && `На кого: ${r.target_user.name}`,
      r.community && `Сообщество: ${r.community.name}`,
      r.message?.is_direct && 'Личная переписка',
      r.reporter_name && `Пожаловался: ${r.reporter_name}`,
    ].filter(Boolean).join(' · ') }),
    r.comment && el('p', { class: 'row-note admin-comment', text: r.comment }),
    r.decision && el('p', { class: 'row-note', text: `Решение: ${r.decision}${r.handler_name ? ` (${r.handler_name})` : ''}` }),
  ])));
}

async function reportDetail(body, reportId, filter) {
  liveRefresh = null;
  fill(body, note('Загружаем…'));
  const data = await api(`/platform/staff/reports/${reportId}`);
  const { report, context } = data;
  const back = () => reportsTab(body, { filter });
  const refresh = () => reportDetail(body, reportId, filter);
  const open = ['open', 'escalated'].includes(report.status);
  const escalatedLocked = report.status === 'escalated' && !platformCan('handle_escalated');

  const decide = (path, title, confirmText) => actionDialog({
    title,
    confirmText,
    reasonLabel: 'Комментарий к решению — попадёт в журнал',
    onConfirm: ({ reason }) => api(`/platform/staff/reports/${reportId}/${path}`, { method: 'POST', body: { reason } }).then(back),
  });

  const actions = [];
  if (open && !escalatedLocked) {
    if (report.message && !report.message.removed) {
      actions.push(el('button', {
        class: 'btn btn-danger btn-sm', type: 'button', text: 'Удалить сообщение',
        onclick: () => actionDialog({
          title: 'Удалить сообщение',
          hint: 'У всех будет «Удалено модерацией платформы». Текст хранится 30 дней — на случай обжалования.',
          finalOption: platformCan('remove_any_message'),
          confirmText: 'Удалить',
          danger: true,
          onConfirm: ({ reason, final }) => api(`/platform/staff/messages/${report.message.id}/remove`, {
            method: 'POST', body: { reason, report_id: reportId, final },
          }).then(refresh),
        }),
      }));
    }
    if (report.target_user && data.can_act_on_target) {
      actions.push(...userActions(report.target_user, { reportId, onDone: refresh }));
    }
    if (report.community && platformCan('manage_communities')) {
      actions.push(el('button', {
        class: 'btn btn-secondary btn-sm', type: 'button', text: 'К сообществу',
        onclick: () => communityDetail(body, report.community.id),
      }));
    }
    actions.push(el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: 'Нарушения нет',
      onclick: () => decide('dismiss', 'Отклонить жалобу', 'Отклонить'),
    }));
    if (report.status === 'open' && !platformCan('handle_escalated')) {
      actions.push(el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: 'Передать администраторам',
        onclick: () => decide('escalate', 'Передать администраторам', 'Передать'),
      }));
    }
    actions.push(el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: 'Закрыть как решённую',
      onclick: () => decide('resolve', 'Закрыть жалобу', 'Закрыть'),
    }));
  }

  fill(body, 
    el('button', { class: 'btn btn-ghost btn-sm admin-back', type: 'button', text: '← К списку жалоб', onclick: back }),
    el('section', { class: 'settings-section' }, [
      el('div', { class: 'admin-card-head' }, [
        pill(TARGET_LABELS[report.target_type]),
        pill(REPORT_REASON_LABELS[report.reason], report.reason === 'illegal' ? 'danger' : ''),
        pill(STATUS_LABELS[report.status], report.status === 'escalated' ? 'warn' : ''),
        el('span', { class: 'admin-card-date', text: formatDateTime(report.created_at) }),
      ]),
      report.comment && el('p', { class: 'admin-comment', text: report.comment }),
      note([
        report.target_user && `На кого: ${report.target_user.name} (${PLATFORM_ROLE_LABELS[report.target_user.platform_role]})`,
        report.community && `Сообщество: ${report.community.name} — ${COMMUNITY_STATUS_LABELS[report.community.status]}`,
        report.reporter_name && `Пожаловался: ${report.reporter_name}`,
      ].filter(Boolean).join(' · ')),
      report.decision && note(`Решение: ${report.decision}`),
    ]),
    context.length > 0 && el('section', { class: 'settings-section' }, [
      el('p', { class: 'settings-kicker', text: report.message?.is_direct ? 'Личная переписка — сообщение и пять до него' : `#${report.message?.channel_name} — сообщение и пять до него` }),
      note('Этот просмотр записан в журнал: читать переписку сверх жалобы нельзя.'),
      el('div', { class: 'admin-context' }, context.map((m) => el('div', { class: `admin-context-msg${m.reported ? ' is-reported' : ''}` }, [
        el('span', { class: 'admin-context-author', text: m.author_name }),
        el('span', { class: 'admin-card-date', text: formatDateTime(m.created_at) }),
        el('p', { class: 'admin-context-text', text: m.deleted ? (m.reported && report.message.removed_by_platform ? '(удалено службой платформы)' : '(удалено)') : m.content }),
      ]))),
    ]),
    data.target_history.length > 0 && el('section', { class: 'settings-section' }, [
      el('p', { class: 'settings-kicker', text: `Прошлые меры: ${report.target_user.name}` }),
      ...data.target_history.map((s) => note(`${formatDateTime(s.created_at)} — ${SANCTION_LABELS[s.kind]}: ${s.reason}${s.revoked_at ? ' (снято)' : ''}`)),
    ]),
    actions.length > 0 && el('div', { class: 'admin-actions' }, actions),
    escalatedLocked && note('Жалоба передана администраторам — решение за ними.'),
  );
}

async function appealsTab(body, { filter = 'pending' } = {}) {
  liveRefresh = () => appealsTab(body, { filter });
  const list = el('div', { class: 'admin-list' }, [note('Загружаем…')]);
  fill(body, 
    el('div', { class: 'admin-filters' }, [['pending', 'Ждут решения'], ['closed', 'Рассмотренные']].map(([id, label]) => el('button', {
      class: `admin-filter${filter === id ? ' is-active' : ''}`, type: 'button', text: label,
      onclick: () => appealsTab(body, { filter: id }),
    }))),
    note('Обжалование рассматривает не тот, кто принял решение, и не младше его по роли.'),
    list,
  );
  const { appeals } = await api(`/platform/staff/appeals?status=${filter}`);
  if (appeals.length === 0) {
    list.replaceChildren(note(filter === 'pending' ? 'Обжалований нет.' : 'Рассмотренных пока нет.'));
    return;
  }
  const refresh = () => appealsTab(body, { filter });
  list.replaceChildren(...appeals.map((a) => {
    const decide = (decision) => actionDialog({
      title: decision === 'accept' ? 'Удовлетворить обжалование' : 'Отклонить обжалование',
      hint: decision === 'accept'
        ? 'Мера будет снята: блокировка, заглушение, удаление сообщения или ограничение сообщества.'
        : 'Мера остаётся. Повторно обжаловать будет нельзя.',
      reasonLabel: 'Ответ человеку — он его увидит',
      confirmText: decision === 'accept' ? 'Удовлетворить' : 'Отклонить',
      danger: decision !== 'accept',
      onConfirm: ({ reason }) => api(`/platform/staff/appeals/${a.id}/decide`, {
        method: 'POST', body: { decision, response: reason },
      }).then(refresh),
    });
    return el('div', { class: 'admin-card is-static' }, [
      el('div', { class: 'admin-card-head' }, [
        pill(SANCTION_LABELS[a.sanction.kind]),
        a.status === 'pending'
          ? pill(a.waiting_days >= 3 ? `ждёт ${a.waiting_days} дн.` : 'новое', a.waiting_days >= 3 ? 'warn' : '')
          : pill(APPEAL_STATUS_LABELS[a.status], a.status === 'accepted' ? 'ok' : ''),
        el('span', { class: 'admin-card-date', text: formatDateTime(a.created_at) }),
      ]),
      note(`${a.user.name} · решение: ${a.sanction.issued_by_name ?? '—'} (${PLATFORM_ROLE_LABELS[a.sanction.issued_by_role] ?? a.sanction.issued_by_role})`),
      note(`Причина меры: ${a.sanction.reason}`),
      a.sanction.community && note(`Сообщество: ${a.sanction.community.name}`),
      a.sanction.message_content && el('p', { class: 'admin-quote', text: a.sanction.message_content }),
      el('p', { class: 'admin-appeal-text', text: a.text }),
      a.response && note(`Ответ: ${a.response}${a.reviewer_name ? ` (${a.reviewer_name})` : ''}`),
      a.status === 'pending' && (a.can_review
        ? el('div', { class: 'admin-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Удовлетворить', onclick: () => decide('accept') }),
          el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Отклонить', onclick: () => decide('reject') }),
        ])
        : note(CANNOT_REVIEW[a.cannot_review_reason] ?? 'Рассматривает другой сотрудник')),
    ]);
  }));
}

async function usersTab(body, { q = '' } = {}) {
  const field = el('input', { class: 'input', type: 'search', placeholder: 'Почта или имя', value: q });
  const list = el('div', { class: 'admin-list' }, [note('Загружаем…')]);
  let timer;
  field.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(field.value), 300);
  });
  fill(body, el('div', { class: 'admin-search' }, [icon('search', 16), field]), list);
  async function load(value) {
    const { users } = await api(`/platform/staff/users?q=${encodeURIComponent(value.trim())}`);
    list.replaceChildren(...(users.length ? users.map((u) => el('button', {
      class: 'admin-card admin-row', type: 'button', onclick: () => userDetail(body, u.id),
    }, [
      el('div', { class: 'member-info' }, [
        el('p', { class: 'row-title', text: u.name }),
        note(u.email),
      ]),
      u.platform_role !== 'user' && pill(PLATFORM_ROLE_LABELS[u.platform_role], 'accent'),
      u.active_measure && pill(SANCTION_LABELS[u.active_measure], 'danger'),
    ])) : [note('Никого не нашли.')]));
  }
  await load(q);
  field.focus();
}

async function userDetail(body, userId) {
  liveRefresh = null;
  fill(body, note('Загружаем…'));
  const data = await api(`/platform/staff/users/${userId}`);
  const { user } = data;
  const refresh = () => userDetail(body, userId);
  const roleOptions = ['user', 'moderator', ...(platformCan('manage_admins') ? ['admin'] : [])];
  const canChangeRole = data.can_act && platformCan('manage_moderators')
    && (user.platform_role !== 'admin' || platformCan('manage_admins'));
  const roleSelect = canChangeRole && el('select', { class: 'select select-sm' }, roleOptions.map((r) => el('option', {
    value: r, text: PLATFORM_ROLE_LABELS[r],
  })));
  if (roleSelect) {
    roleSelect.value = user.platform_role;
    roleSelect.addEventListener('change', () => {
      const next = roleSelect.value;
      roleSelect.value = user.platform_role;
      actionDialog({
        title: `Роль: ${PLATFORM_ROLE_LABELS[next]}`,
        confirmText: 'Сменить роль',
        onConfirm: ({ reason }) => api(`/platform/staff/users/${userId}/role`, { method: 'PATCH', body: { role: next, reason } }).then(refresh),
      });
    });
  }
  fill(body, 
    el('button', { class: 'btn btn-ghost btn-sm admin-back', type: 'button', text: '← К поиску', onclick: () => usersTab(body) }),
    el('section', { class: 'settings-section' }, [
      el('div', { class: 'settings-row' }, [
        el('div', { class: 'member-info' }, [
          el('p', { class: 'row-title', text: user.name }),
          note(`${user.email} · с ${formatDateTime(user.created_at)}`),
          note(`Жалоб на него: ${data.reports.total}, открытых: ${data.reports.open}`),
        ]),
        el('div', { class: 'row-actions' }, [
          roleSelect || pill(PLATFORM_ROLE_LABELS[user.platform_role], user.platform_role !== 'user' ? 'accent' : ''),
        ]),
      ]),
      data.can_act && el('div', { class: 'admin-actions' }, [
        ...userActions(user, { onDone: refresh }),
        platformCan('export_user_data') && el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', text: 'Выгрузка по запросу',
          onclick: () => exportDialog(user),
        }),
      ]),
    ]),
    el('section', { class: 'settings-section' }, [
      el('p', { class: 'settings-kicker', text: `Меры · ${data.sanctions.length}` }),
      ...(data.sanctions.length ? data.sanctions.map((s) => sanctionRow(s, refresh)) : [note('Мер не было.')]),
    ]),
    el('section', { class: 'settings-section' }, [
      el('p', { class: 'settings-kicker', text: `Сообщества · ${data.communities.length}` }),
      ...data.communities.map((c) => el('div', { class: 'settings-row' }, [
        el('div', { class: 'member-info' }, [
          el('p', { class: 'row-title', text: c.name }),
          note(`${{ owner: 'владелец', moderator: 'модератор', member: 'участник' }[c.role]} · ${COMMUNITY_STATUS_LABELS[c.platform_status]}`),
        ]),
        platformCan('manage_communities') && el('div', { class: 'row-actions' }, [
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Открыть', onclick: () => communityDetail(body, c.id) }),
        ]),
      ])),
    ]),
  );
}

function exportDialog(user) {
  const authority = el('input', { class: 'input', type: 'text', maxlength: '300', placeholder: 'Например, Следственный отдел по …' });
  const number = el('input', { class: 'input', type: 'text', maxlength: '100', placeholder: 'Номер и дата запроса' });
  const reason = el('textarea', { class: 'input', rows: '2', maxlength: '1000' });
  const error = el('p', { class: 'field-error' });
  const scrim = showModal(el('form', {
    class: 'modal admin-dialog',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const data = await api(`/platform/staff/users/${user.id}/export`, {
          method: 'POST', body: { authority: authority.value, request_number: number.value, reason: reason.value },
        });
        download(`vygruzka-${user.id}.json`, data);
        scrim.remove();
      } catch (err) {
        error.textContent = err.message;
      }
    },
  }, [
    el('h2', { class: 'modal-title', text: `Выгрузка данных: ${user.name}` }),
    note('Только по официальному запросу. Основание и сама выгрузка записываются в журнал.'),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Кто запросил' }), authority]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Номер запроса' }), number]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Комментарий' }), reason]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Отмена', onclick: () => scrim.remove() }),
      el('button', { class: 'btn btn-primary', type: 'submit', text: 'Выгрузить' }),
    ]),
    error,
  ]));
}

async function communitiesTab(body, { q = '' } = {}) {
  const field = el('input', { class: 'input', type: 'search', placeholder: 'Название или почта владельца', value: q });
  const list = el('div', { class: 'admin-list' }, [note('Загружаем…')]);
  let timer;
  field.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(field.value), 300);
  });
  fill(body, el('div', { class: 'admin-search' }, [icon('search', 16), field]), list);
  async function load(value) {
    const { communities } = await api(`/platform/staff/communities?q=${encodeURIComponent(value.trim())}`);
    list.replaceChildren(...(communities.length ? communities.map((c) => el('button', {
      class: 'admin-card admin-row', type: 'button', onclick: () => communityDetail(body, c.id),
    }, [
      el('div', { class: 'member-info' }, [
        el('p', { class: 'row-title', text: c.name }),
        note(`Владелец: ${c.owner_name} · участников: ${c.members}`),
      ]),
      c.platform_status !== 'active' && pill(COMMUNITY_STATUS_LABELS[c.platform_status], 'danger'),
    ])) : [note('Ничего не нашли.')]));
  }
  await load(q);
}

async function communityDetail(body, communityId) {
  liveRefresh = null;
  fill(body, note('Загружаем…'));
  const data = await api(`/platform/staff/communities/${communityId}`);
  const c = data.community;
  const refresh = () => communityDetail(body, communityId);
  const setStatus = (status, title, hint, danger = false) => actionDialog({
    title, hint, confirmText: title, danger,
    onConfirm: ({ reason }) => api(`/platform/staff/communities/${communityId}/status`, { method: 'POST', body: { status, reason } }).then(refresh),
  });
  const statusButtons = [];
  if (!c.purged_at) {
    if (c.platform_status !== 'active') {
      statusButtons.push(el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Вернуть обычный режим',
        onclick: () => setStatus('active', 'Вернуть обычный режим', 'Ограничение снимется, владелец получит уведомление.') }));
    }
    if (c.platform_status !== 'invites_hidden' && c.platform_status !== 'deleted') {
      statusButtons.push(el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Скрыть приглашения',
        onclick: () => setStatus('invites_hidden', 'Скрыть приглашения', 'Новые люди не смогут вступить и зайти в звонок по ссылке; внутри всё работает.') }));
    }
    if (c.platform_status !== 'frozen' && c.platform_status !== 'deleted') {
      statusButtons.push(el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Заморозить',
        onclick: () => setStatus('frozen', 'Заморозить', 'Всё только для чтения: ни сообщений, ни звонков, ни новых каналов.') }));
    }
    if (c.platform_status !== 'deleted' && platformCan('delete_communities')) {
      statusButtons.push(el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Удалить',
        onclick: () => setStatus('deleted', 'Удалить сообщество', 'Сообщество пропадёт у всех. 30 дней его можно восстановить, потом содержимое сотрётся.', true) }));
    }
  }
  fill(body, 
    el('button', { class: 'btn btn-ghost btn-sm admin-back', type: 'button', text: '← К сообществам', onclick: () => communitiesTab(body) }),
    el('section', { class: 'settings-section' }, [
      el('div', { class: 'settings-row' }, [
        el('div', { class: 'member-info' }, [
          el('p', { class: 'row-title', text: c.name }),
          note(`Владелец: ${c.owner_name} (${c.owner_email}) · участников: ${c.members} · открытых жалоб: ${data.open_reports}`),
          note(`Создано ${formatDateTime(c.created_at)}${c.purged_at ? ' · содержимое стёрто' : ''}`),
        ]),
        el('div', { class: 'row-actions' }, [pill(COMMUNITY_STATUS_LABELS[c.platform_status], c.platform_status === 'active' ? 'ok' : 'danger')]),
      ]),
      statusButtons.length > 0 && el('div', { class: 'admin-actions' }, statusButtons),
    ]),
    el('section', { class: 'settings-section' }, [
      el('p', { class: 'settings-kicker', text: `Участники · ${data.members.length}` }),
      ...data.members.map((m) => el('div', { class: 'settings-row' }, [
        el('div', { class: 'member-info' }, [
          el('p', { class: 'row-title', text: m.name }),
          note(`${{ owner: 'владелец', moderator: 'модератор', member: 'участник' }[m.role]}${m.platform_role !== 'user' ? ` · ${PLATFORM_ROLE_LABELS[m.platform_role]}` : ''}`),
        ]),
        el('div', { class: 'row-actions' }, [
          m.role !== 'owner' && !c.purged_at && c.platform_status !== 'deleted' && el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', text: 'Сделать владельцем',
            onclick: () => actionDialog({
              title: `Передать сообщество: ${m.name}`,
              hint: 'Например, если владелец заблокирован или пропал. Прежний владелец станет модератором.',
              confirmText: 'Передать',
              onConfirm: ({ reason }) => api(`/platform/staff/communities/${communityId}/transfer`, {
                method: 'POST', body: { user_id: m.id, reason },
              }).then(refresh),
            }),
          }),
          platformCan('view_users') && el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Карточка', onclick: () => userDetail(body, m.id) }),
        ]),
      ])),
    ]),
    data.sanctions.length > 0 && el('section', { class: 'settings-section' }, [
      el('p', { class: 'settings-kicker', text: 'История решений' }),
      ...data.sanctions.map((s) => note(`${formatDateTime(s.created_at)} — ${SANCTION_LABELS[s.kind]}: ${s.reason}${s.issued_by_name ? ` (${s.issued_by_name})` : ''}${s.revoked_at ? ' · снято' : ''}`)),
    ]),
  );
}

async function teamTab(body) {
  const { team } = await api('/platform/staff/team');
  fill(body, 
    note('Назначить человека модератором или администратором — во вкладке «Люди», в его карточке. Суперадминистратор задаётся только в настройках сервера.'),
    el('div', { class: 'admin-list' }, team.map((u) => el('button', {
      class: 'admin-card admin-row', type: 'button', onclick: () => userDetail(body, u.id),
    }, [
      el('div', { class: 'member-info' }, [el('p', { class: 'row-title', text: u.name }), note(u.email)]),
      pill(PLATFORM_ROLE_LABELS[u.platform_role], 'accent'),
    ]))),
  );
}

async function auditTab(body) {
  const role = (await loadPlatform()).role;
  const scope = role === 'moderator' ? 'Ваши действия' : role === 'admin' ? 'Ваши действия и действия модераторов' : 'Все действия команды';
  const list = el('div', { class: 'admin-audit' });
  const more = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Показать ещё' });
  fill(body, note(`${scope}. Записи журнала нельзя изменить или удалить — даже в базе данных.`), list, more);
  let before = null;
  async function load() {
    const { entries } = await api(`/platform/staff/audit${before ? `?before=${before}` : ''}`);
    for (const e of entries) {
      list.append(el('div', { class: 'admin-audit-row' }, [
        el('span', { class: 'admin-card-date', text: formatDateTime(e.created_at) }),
        el('span', { class: 'admin-audit-actor', text: e.actor_email ?? 'система' }),
        el('span', { class: 'admin-audit-action', text: ACTION_LABELS[e.action] ?? e.action }),
        el('span', { class: 'row-note', text: e.reason ?? '' }),
      ]));
    }
    before = entries.at(-1)?.id ?? before;
    more.hidden = entries.length < 100;
  }
  more.addEventListener('click', load);
  await load();
  if (!list.children.length) list.append(note('Записей пока нет.'));
}

async function platformTab(body) {
  const { stats } = await api('/platform/staff/stats');
  const tile = (label, value, sub = '') => el('div', { class: 'tile' }, [
    el('span', { class: 'tile-label', text: label }),
    el('span', { class: 'tile-value', text: String(value) }),
    sub && el('span', { class: 'tile-note', text: sub }),
  ]);
  const nodes = [
    el('p', { class: 'settings-kicker', text: 'Платформа сейчас' }),
    el('div', { class: 'tiles' }, [
      tile('Людей', stats.users, `+${stats.users_new_7d} за неделю`),
      tile('Сообществ', stats.communities, `заморожено ${stats.communities_frozen}, скрыты приглашения ${stats.communities_invites_hidden}`),
      tile('Сообщений за неделю', stats.messages_7d, `писали ${stats.writers_7d} чел.`),
      tile('Жалобы', stats.open_reports, `передано выше ${stats.escalated_reports}`),
      tile('Обжалования', stats.pending_appeals, 'ждут решения'),
      tile('Под мерами', stats.blocked_users + stats.muted_users, `заблокировано ${stats.blocked_users}, заглушено ${stats.muted_users}`),
    ]),
  ];
  if (platformCan('manage_settings')) {
    const { settings } = await api('/platform/staff/settings');
    const registration = el('input', { type: 'checkbox' });
    registration.checked = settings.registration_open !== false;
    const maxCommunities = el('input', { class: 'input', type: 'number', min: '1', max: '1000', value: String(settings.max_communities_per_user ?? 20) });
    const maxInvites = el('input', { class: 'input', type: 'number', min: '1', max: '10000', value: String(settings.max_invites_per_day ?? 50) });
    const saved = el('p', { class: 'saved-note' });
    nodes.push(el('section', { class: 'settings-section' }, [
      el('p', { class: 'settings-kicker', text: 'Настройки платформы' }),
      el('label', { class: 'check' }, [registration, el('span', { text: SETTING_LABELS.registration_open })]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: SETTING_LABELS.max_communities_per_user }), maxCommunities]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: SETTING_LABELS.max_invites_per_day }), maxInvites]),
      el('div', { class: 'btn-row' }, [el('button', {
        class: 'btn btn-primary', type: 'button', text: 'Сохранить',
        onclick: () => actionDialog({
          title: 'Изменить настройки платформы',
          reasonLabel: 'Почему меняем — попадёт в журнал',
          confirmText: 'Сохранить',
          onConfirm: async ({ reason }) => {
            await api('/platform/staff/settings', {
              method: 'PUT',
              body: {
                reason,
                settings: {
                  registration_open: registration.checked,
                  max_communities_per_user: Number(maxCommunities.value),
                  max_invites_per_day: Number(maxInvites.value),
                },
              },
            });
            saved.textContent = 'Сохранено';
          },
        }),
      })]),
      saved,
    ]));
  }
  fill(body, ...nodes);
}

const RENDERERS = {
  reports: reportsTab,
  appeals: appealsTab,
  users: usersTab,
  communities: communitiesTab,
  team: teamTab,
  audit: auditTab,
  platform: platformTab,
};

export async function renderAdmin(tab) {
  mount(el('div', { class: 'empty' }, [el('p', { class: 'empty-quiet', text: 'Загружаем…' })]));
  const state = await loadPlatform();
  const tabs = TABS.filter(([, , perm]) => platformCan(perm));
  if (tabs.length === 0) return navigate('#/');
  const current = tabs.find(([id]) => id === tab) ?? tabs[0];
  const queue = state.queue ?? {};
  const badges = {
    reports: (queue.open_reports ?? 0) + (queue.escalated_reports ?? 0),
    appeals: queue.pending_appeals ?? 0,
  };

  const body = el('div', { class: 'settings-body admin-body' });
  const badgeNodes = {};
  const drawBadges = (q) => {
    const counts = { reports: (q.open_reports ?? 0) + (q.escalated_reports ?? 0), appeals: q.pending_appeals ?? 0 };
    for (const [id, node] of Object.entries(badgeNodes)) {
      node.hidden = !counts[id];
      node.textContent = String(counts[id] ?? 0);
    }
  };
  mount(el('div', { class: 'settings admin' }, [
    el('nav', { class: 'settings-nav' }, [
      el('p', { class: 'settings-kicker', text: 'Служба платформы' }),
      el('button', { class: 'set-nav', type: 'button', text: '← К сообществам', onclick: () => navigate('#/') }),
      ...tabs.map(([id, label]) => el('button', {
        class: `set-nav${id === current[0] ? ' is-active' : ''}`,
        type: 'button',
        onclick: () => navigate(`#/admin/${id}`),
      }, [
        el('span', { text: label }),
        (badgeNodes[id] = el('span', { class: 'count-pill', text: String(badges[id] ?? 0), hidden: badges[id] ? null : '' })),
      ])),
    ]),
    el('div', { class: 'settings-pane' }, [
      el('header', { class: 'settings-head' }, [
        el('h1', { class: 'settings-title', text: current[1] }),
        el('span', { class: 'role-badge is-owner', text: PLATFORM_ROLE_LABELS[state.role] }),
        queueTotal() > 0 && el('span', { class: 'row-note', text: `В очереди: ${queueTotal()}` }),
      ]),
      body,
    ]),
  ]));
  liveRefresh = null;
  await RENDERERS[current[0]](body);

  // Живые счётчики: событие platform_queue приходит, когда меняется очередь.
  liveSocket?.disconnect();
  liveSocket = io({ auth: { token: store.token } });
  liveSocket.on('platform_queue', (q) => {
    drawBadges(q);
    liveRefresh?.();
  });
  window.addEventListener('hashchange', () => {
    liveSocket?.disconnect();
    liveSocket = null;
    liveRefresh = null;
  }, { once: true });
}
