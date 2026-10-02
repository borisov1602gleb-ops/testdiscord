// Команда платформы: роли поверх сообществ, права, проверка блокировок и
// заглушений, журнал действий и настройки платформы.
//
// Роли упорядочены так же, как роли сообщества: у старшей есть всё, что у
// младшей. Право описывается минимальной ролью — таблица читается как
// документ и меняется в одном месте. Действовать можно только в отношении
// тех, кто младше по роли.
import { query } from '../db.js';
import { HttpError } from './http.js';
import { config } from '../config.js';

export const PLATFORM_RANK = { user: 0, moderator: 1, admin: 2, superadmin: 3 };
export const PLATFORM_ROLES = Object.keys(PLATFORM_RANK);

export const PLATFORM_PERMISSIONS = {
  handle_reports: 'moderator',          // общая очередь жалоб: отклонить, передать выше
  remove_reported_message: 'moderator', // удалить сообщение, на которое пожаловались
  warn_users: 'moderator',              // предупреждение
  mute_users: 'moderator',              // заглушить на 1, 7 или 30 дней
  view_audit: 'moderator',              // журнал (модератор — только свои действия)
  handle_escalated: 'admin',            // жалобы, которые модератор передал выше
  remove_any_message: 'admin',          // удалить сообщение без жалобы, по ссылке
  suspend_users: 'admin',               // временная блокировка
  ban_users: 'admin',                   // вечная блокировка
  revoke_any_sanction: 'admin',         // снять чужую меру
  view_users: 'admin',                  // поиск людей, их сообщества и история мер
  manage_communities: 'admin',          // скрыть приглашения, заморозить, передать
  manage_moderators: 'admin',           // назначать и снимать модераторов платформы
  review_appeals: 'admin',              // рассматривать обжалования
  view_stats: 'admin',                  // статистика всей платформы
  delete_communities: 'superadmin',     // удалить сообщество
  manage_admins: 'superadmin',          // назначать и снимать администраторов
  export_user_data: 'superadmin',       // выгрузка данных по официальному запросу
  manage_settings: 'superadmin',        // настройки платформы
};

export function platformCan(role, permission) {
  const needed = PLATFORM_PERMISSIONS[permission];
  return needed !== undefined && (PLATFORM_RANK[role] ?? 0) >= PLATFORM_RANK[needed];
}

export function platformPermissionsFor(role) {
  return Object.keys(PLATFORM_PERMISSIONS).filter((p) => platformCan(role, p));
}

export function isStaff(role) {
  return (PLATFORM_RANK[role] ?? 0) > 0;
}

// Старше ли actor того, над кем действует. Самого себя наказывать нельзя.
export function outranks(actorRole, targetRole) {
  return (PLATFORM_RANK[actorRole] ?? 0) > (PLATFORM_RANK[targetRole] ?? 0);
}

// Middleware: у вошедшего есть право платформы.
export function requirePlatform(permission) {
  return (req, _res, next) => {
    if (!platformCan(req.user?.platformRole, permission)) {
      return next(new HttpError(403, 'not_allowed', { permission }));
    }
    return next();
  };
}

// ===== положение человека: роль, блокировка, заглушение =====
// Проверяется на каждый запрос, поэтому держим короткий кэш в памяти и
// сбрасываем его сразу при любой новой мере. Копия backend одна, так что
// сброса в своём процессе достаточно.
const STANDING_TTL_MS = 15_000;
const standingCache = new Map();

// Действующая мера нужного вида: бессрочная важнее срочной, из срочных —
// та, что кончается позже. kinds — константы из кода, не ввод.
const activeSanctionSql = (kinds) => `
  SELECT id, kind, reason, ends_at, created_at FROM platform_sanctions
  WHERE user_id = $1 AND kind IN (${kinds.map((k) => `'${k}'`).join(', ')}) AND revoked_at IS NULL
    AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
  ORDER BY (ends_at IS NULL) DESC, ends_at DESC LIMIT 1`;

export async function getStanding(userId) {
  const cached = standingCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const { rows } = await query(
    `SELECT u.platform_role,
            (SELECT row_to_json(s) FROM (${activeSanctionSql(['suspend', 'ban'])}) s) AS block,
            (SELECT row_to_json(s) FROM (${activeSanctionSql(['mute'])}) s) AS mute
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  const value = {
    role: row?.platform_role ?? 'user',
    block: row?.block ?? null,
    mute: row?.mute ?? null,
  };
  // Кэш не переживает конец меры: истекла блокировка — человек сразу свободен.
  const ends = [value.block?.ends_at, value.mute?.ends_at]
    .filter(Boolean).map((d) => new Date(d).getTime());
  standingCache.set(userId, { value, expiresAt: Math.min(Date.now() + STANDING_TTL_MS, ...ends) });
  return value;
}

export function invalidateStanding(userId) {
  standingCache.delete(userId);
}

export function blockError(block) {
  return new HttpError(403, 'account_blocked', {
    sanction_id: block.id, kind: block.kind, reason: block.reason, ends_at: block.ends_at,
  });
}

// Заглушённый читает, но ничего не пишет на всей платформе.
export function requireNotMuted(user) {
  if (user?.mute) {
    throw new HttpError(403, 'account_muted', {
      sanction_id: user.mute.id, reason: user.mute.reason, ends_at: user.mute.ends_at,
    });
  }
}

export async function requireNotMutedById(userId) {
  const standing = await getStanding(userId);
  requireNotMuted(standing);
}

// ===== состояние сообщества =====
// Замороженное сообщество — только для чтения для всех; удалённое не
// видно никому.
export function requireCommunityWritable(status) {
  if (status === 'deleted') throw new HttpError(404, 'community_not_found');
  if (status === 'frozen') throw new HttpError(403, 'community_frozen');
}

// ===== журнал =====
// actor — req.user (id, email, platformRole) или «система».
export async function audit(actor, action, { targetType = null, targetId = null, reason = null, details = {} } = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `INSERT INTO staff_audit_log (actor_id, actor_email, actor_role, action, target_type, target_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor?.id ?? null, actor?.email ?? null, actor?.platformRole ?? 'system', action,
      targetType, targetId == null ? null : String(targetId), reason, details],
  );
}

// ===== настройки платформы =====
export const SETTINGS = {
  registration_open: { type: 'boolean' },
  max_communities_per_user: { type: 'integer', min: 1, max: 1000 },
  max_invites_per_day: { type: 'integer', min: 1, max: 10000 },
};

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM platform_settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getSetting(key, fallback = null) {
  const { rows } = await query('SELECT value FROM platform_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? fallback;
}

// ===== суперадминистраторы из настроек сервера =====
// Список почт в SUPERADMIN_EMAILS — единственный способ стать
// суперадминистратором: через интерфейс эту роль не выдать и не снять.
// Если список задан, он главный: кого в нём нет, тот перестаёт быть
// суперадминистратором при запуске.
export function isConfiguredSuperadmin(email) {
  return Boolean(config.platform.superadminEmails?.includes(String(email).toLowerCase()));
}

export async function syncSuperadmins() {
  const list = config.platform.superadminEmails;
  if (!list) return;
  const promoted = await query(
    `UPDATE users SET platform_role = 'superadmin'
     WHERE lower(email) = ANY($1::text[]) AND platform_role <> 'superadmin'
     RETURNING id, email`,
    [list],
  );
  const demoted = await query(
    `UPDATE users SET platform_role = 'user'
     WHERE platform_role = 'superadmin' AND NOT (lower(email) = ANY($1::text[]))
     RETURNING id, email`,
    [list],
  );
  for (const row of promoted.rows) {
    await audit(null, 'superadmin_granted_by_config', { targetType: 'user', targetId: row.id, details: { email: row.email } });
  }
  for (const row of demoted.rows) {
    await audit(null, 'superadmin_revoked_by_config', { targetType: 'user', targetId: row.id, details: { email: row.email } });
  }
}
