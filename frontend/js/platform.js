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

// Новое предупреждение показывается отдельным окном сверху (warningCard),
// а не строкой в полосе уведомлений.
function isFreshWarning(s) {
  return s.kind === 'warning' && !s.seen;
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
    const items = unseenNotices().filter((s) => !isFreshWarning(s));
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

// ===== окно предупреждения =====
// Карточка сверху по центру экрана — по макету: значок, «Предупреждение
// от модератора платформы», какое оно по счёту, где было нарушение,
// причина и кнопки. «Понятно» отмечает просмотренным; крестик прячет до
// перезагрузки страницы.
const ISSUER_LABELS = {
  moderator: 'модератора платформы',
  admin: 'администратора платформы',
  superadmin: 'администрации платформы',
};
const hiddenWarnings = new Set();

function ordinal(n) {
  return `${n}-е`;
}

export function warningCard() {
  const host = el('div', { class: 'warning-host' });
  let mounted = false;
  function draw() {
    if (mounted && !host.isConnected) {
      off();
      return;
    }
    if (host.isConnected) mounted = true;
    const items = unseenNotices().filter((s) => isFreshWarning(s) && !hiddenWarnings.has(s.id));
    // Старые сначала: человек читает их по порядку.
    const s = items.at(-1);
    if (!s) {
      host.replaceChildren();
      return;
    }
    if (host.firstChild?.dataset.id === s.id) return;
    const n = s.warning_number ?? 1;
    const where = s.community
      ? `Сообщество «${s.community.name}»${s.channel ? ` · канал #${s.channel.name}` : ''}`
      : s.in_direct ? 'Личная переписка' : 'Платформа целиком';
    const next = n >= 2
      ? 'Это уже не первое предупреждение. При новых нарушениях служба платформы может ограничить отправку сообщений или заблокировать аккаунт.'
      : 'Предупреждение ничего не ограничивает. При повторных нарушениях служба платформы может ограничить отправку сообщений или заблокировать аккаунт.';
    const card = el('div', { class: 'warning-card', role: 'alert', 'data-id': s.id }, [
      el('div', { class: 'warning-stripe' }),
      el('div', { class: 'warning-body' }, [
        el('span', { class: 'warning-icon' }, [icon('warning', 24)]),
        el('div', { class: 'warning-main' }, [
          el('div', { class: 'warning-title-row' }, [
            el('span', { class: 'warning-title', text: `Предупреждение от ${ISSUER_LABELS[s.issued_by_role] ?? 'службы платформы'}` }),
            el('span', {
              class: 'warning-count',
              text: `${ordinal(n)} за ${s.warning_window_days ?? 90} дней`,
              title: 'Сколько предупреждений у вас за этот срок, включая это',
            }),
          ]),
          el('p', { class: 'warning-where', text: `${where} · ${formatDateTime(s.created_at)}` }),
          el('div', { class: 'warning-reason' }, [
            el('span', { class: 'warning-reason-label', text: 'Причина' }),
            el('span', { class: 'warning-reason-text', text: s.reason }),
          ]),
          el('p', { class: 'warning-next', text: next }),
          el('div', { class: 'warning-actions' }, [
            el('button', {
              class: 'warning-ok',
              type: 'button',
              text: 'Понятно',
              onclick: async (e) => {
                e.currentTarget.disabled = true;
                card.classList.add('is-leaving');
                await markSeen([s.id]);
              },
            }),
            s.can_appeal && el('a', { class: 'warning-link', href: '#/standing' }, [icon('scales', 16), 'Обжаловать']),
            items.length > 1 && el('span', { class: 'warning-more', text: `и ещё ${items.length - 1}` }),
          ]),
        ]),
        el('button', {
          class: 'warning-close',
          type: 'button',
          'aria-label': 'Скрыть до перезагрузки',
          title: 'Скрыть до перезагрузки',
          onclick: () => {
            hiddenWarnings.add(s.id);
            draw();
          },
        }, [icon('close', 16)]),
      ]),
    ]);
    host.replaceChildren(card);
  }
  const off = onPlatformChange(draw);
  draw();
  return host;
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
