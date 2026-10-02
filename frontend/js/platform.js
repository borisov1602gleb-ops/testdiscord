// Служба платформы в интерфейсе: положение человека (роль, меры,
// обжалования), подписи, уведомления о мерах и форма жалобы в службу.
// Права приходят с сервера списком — интерфейс по нему решает, что
// показывать. Проверяет всё равно сервер.
import { api } from './api.js';
import { el, icon } from './dom.js';

export const PLATFORM_ROLE_LABELS = {
  user: 'Пользователь',
  moderator: 'Модератор платформы',
  admin: 'Администратор платформы',
  superadmin: 'Суперадминистратор',
};

export const SANCTION_LABELS = {
  warning: 'Предупреждение',
  mute: 'Заглушение',
  suspend: 'Временная блокировка',
  ban: 'Вечная блокировка',
  message_removed: 'Сообщение удалено службой платформы',
  community_invites_hidden: 'Приглашения сообщества скрыты',
  community_frozen: 'Сообщество заморожено',
  community_deleted: 'Сообщество удалено',
};

export const REPORT_REASONS = [
  ['spam', 'Спам'],
  ['abuse', 'Оскорбления'],
  ['illegal', 'Запрещено законом'],
  ['other', 'Другое'],
];
export const REPORT_REASON_LABELS = Object.fromEntries(REPORT_REASONS);

export const APPEAL_STATUS_LABELS = {
  pending: 'на рассмотрении',
  accepted: 'удовлетворено',
  rejected: 'отклонено',
};

export function formatDateTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

export function untilText(endsAt) {
  return endsAt ? `до ${formatDateTime(endsAt)}` : 'бессрочно';
}

// ===== положение =====
let state = null;
const listeners = new Set();

export async function loadPlatform() {
  try {
    state = await api('/platform/me');
  } catch {
    state = state ?? { role: 'user', permissions: [], sanctions: [], block: null, mute: null, queue: null };
  }
  listeners.forEach((cb) => cb(state));
  return state;
}

export function platformState() {
  return state;
}

export function onPlatformChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function platformCan(permission) {
  return Boolean(state?.permissions?.includes(permission));
}

export function isStaff() {
  return Boolean(state && state.role !== 'user');
}

export function isMuted() {
  return Boolean(state?.mute);
}

export function setQueue(queue) {
  if (!state) return;
  state.queue = queue;
  listeners.forEach((cb) => cb(state));
}

export function queueTotal(queue = state?.queue) {
  if (!queue) return 0;
  return queue.open_reports + queue.escalated_reports + queue.pending_appeals;
}

// Что человеку стоит показать: новые меры и ответы на обжалования.
export function unseenNotices() {
  return (state?.sanctions ?? []).filter((s) =>
    !s.seen || (s.appeal && s.appeal.status !== 'pending' && !s.appeal.response_seen));
}

export async function markSeen(ids) {
  if (!ids.length) return;
  await api('/platform/me/seen', { method: 'POST', body: { sanction_ids: ids } }).catch(() => {});
  await loadPlatform();
}

function noticeText(s) {
  if (s.appeal && s.appeal.status !== 'pending' && !s.appeal.response_seen) {
    return `Обжалование «${SANCTION_LABELS[s.kind]}» ${APPEAL_STATUS_LABELS[s.appeal.status]}: ${s.appeal.response}`;
  }
  const where = s.community ? ` («${s.community.name}»)` : '';
  const until = ['mute', 'suspend', 'ban'].includes(s.kind) ? `, ${untilText(s.ends_at)}` : '';
  return `${SANCTION_LABELS[s.kind]}${where}${until}. Причина: ${s.reason}`;
}

// Полоса уведомлений над чатом: мера, ответ на обжалование. «Понятно»
// убирает, «Подробнее» ведёт на страницу мер, где можно обжаловать.
export function noticeBar() {
  const node = el('div', { class: 'platform-notices' });
  let seenMounted = false;
  function draw() {
    // Полоса пропала с экрана — больше не слушаем изменения.
    if (seenMounted && !node.isConnected) {
      off();
      return;
    }
    if (node.isConnected) seenMounted = true;
    const items = unseenNotices();
    node.hidden = items.length === 0;
    node.replaceChildren(...items.slice(0, 3).map((s) => el('div', { class: `platform-notice is-${s.kind}` }, [
      icon(s.kind === 'warning' ? 'alert' : 'shield', 16),
      el('p', { class: 'platform-notice-text', text: noticeText(s) }),
      el('div', { class: 'platform-notice-actions' }, [
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/standing', text: s.can_appeal ? 'Обжаловать' : 'Подробнее' }),
        el('button', {
          class: 'btn btn-secondary btn-sm',
          type: 'button',
          text: 'Понятно',
          onclick: () => markSeen([s.id]),
        }),
      ]),
    ])));
  }
  const off = onPlatformChange(draw);
  draw();
  return node;
}

// ===== жалоба в службу платформы =====
// Возвращает содержимое для всплывающего окна или модального окна.
export function platformReportForm({ targetType, targetId, onDone }) {
  let reason = null;
  const comment = el('textarea', {
    class: 'input platform-report-comment',
    rows: '3',
    maxlength: '1000',
    placeholder: 'Что не так — по желанию, но так быстрее разберёмся',
  });
  const status = el('p', { class: 'report-status' });
  const reasons = el('div', { class: 'report-reasons' }, REPORT_REASONS.map(([id, label]) => el('button', {
    class: 'report-reason',
    type: 'button',
    text: label,
    onclick: (e) => {
      reason = id;
      reasons.querySelectorAll('.report-reason').forEach((b) => b.classList.toggle('is-active', b === e.currentTarget));
    },
  })));
  const submit = el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    text: 'Отправить в службу платформы',
    onclick: async () => {
      if (!reason) {
        status.textContent = 'Выберите причину';
        return;
      }
      submit.disabled = true;
      try {
        await api('/platform/reports', {
          method: 'POST',
          body: { target_type: targetType, target_id: targetId, reason, comment: comment.value },
        });
        status.textContent = 'Жалоба отправлена в службу платформы. Спасибо!';
        setTimeout(() => onDone?.(), 1400);
      } catch (err) {
        submit.disabled = false;
        status.textContent = err.message;
      }
    },
  });
  return [reasons, comment, submit, status];
}
