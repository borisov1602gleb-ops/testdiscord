// Счётчики для команды платформы: сколько жалоб ждут разбора и сколько
// обжалований — рассылаются только сотрудникам, по их праву. Обычным
// людям незачем знать, что на кого-то пожаловались.
import { query } from '../db.js';
import { emitToUser } from './realtime.js';
import { platformCan } from './platform.js';

export async function platformQueueCounts() {
  const { rows: [counts] } = await query(
    `SELECT
       (SELECT count(*)::int FROM platform_reports WHERE status = 'open') AS open_reports,
       (SELECT count(*)::int FROM platform_reports WHERE status = 'escalated') AS escalated_reports,
       (SELECT count(*)::int FROM platform_appeals WHERE status = 'pending') AS pending_appeals`,
  );
  return counts;
}

// Модератор видит открытые жалобы; администратор — ещё переданные выше и
// обжалования.
export function countsFor(role, counts) {
  return {
    open_reports: platformCan(role, 'handle_reports') ? counts.open_reports : 0,
    // Переданные выше решает администратор — модератору они не задача.
    escalated_reports: platformCan(role, 'handle_escalated') ? counts.escalated_reports : 0,
    pending_appeals: platformCan(role, 'review_appeals') ? counts.pending_appeals : 0,
  };
}

export async function notifyPlatformStaff() {
  const [counts, { rows: staff }] = await Promise.all([
    platformQueueCounts(),
    query("SELECT id, platform_role FROM users WHERE platform_role <> 'user'"),
  ]);
  for (const person of staff) {
    emitToUser(person.id, 'platform_queue', countsFor(person.platform_role, counts));
  }
}

// Человеку изменили положение: новая мера, снятие, ответ на обжалование,
// новая роль. Клиент перечитает /platform/me.
export function notifyStanding(userId) {
  emitToUser(userId, 'standing_changed', {});
}
