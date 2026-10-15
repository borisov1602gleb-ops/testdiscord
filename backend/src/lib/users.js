// Как пользователь выглядит для остальных: заданное имя, иначе почта,
// а если он её скрыл — нейтральная подпись. Выражение одно на все запросы,
// чтобы имя не разъезжалось между чатом, звонком и списками.
import { query } from '../db.js';
import { avatarUrl } from './signed-urls.js';

// alias — под каким именем таблица users стоит в запросе: в одном запросе
// бывает сразу автор сообщения и автор того, на что он отвечает.
export function publicNameSql(alias = 'u') {
  return `COALESCE(
  NULLIF(${alias}.display_name, ''),
  CASE WHEN ${alias}.hide_email THEN 'Участник' ELSE ${alias}.email END
)`;
}

export const PUBLIC_NAME_SQL = publicNameSql('u');

// Поля подписи-статуса для запросов: alias — псевдоним таблицы users.
export function statusSql(alias = 'u') {
  return `${alias}.status_text, ${alias}.status_emoji, ${alias}.status_expires_at`;
}

// Подпись так, как её видят другие: истёкшая или пустая — null. Срок
// проверяется при чтении, отдельная уборка не нужна.
export function describeStatus(row) {
  if (!row?.status_text && !row?.status_emoji) return null;
  if (row.status_expires_at && new Date(row.status_expires_at) <= new Date()) return null;
  return {
    text: row.status_text ?? '',
    emoji: row.status_emoji ?? '',
    expires_at: row.status_expires_at ?? null,
  };
}

export async function getStatus(userId) {
  const { rows } = await query(`SELECT ${statusSql('u')} FROM users u WHERE id = $1`, [userId]);
  return describeStatus(rows[0]);
}

export async function getProfile(userId) {
  const { rows } = await query(
    `SELECT id, email, display_name, hide_email, created_at, avatar_id, presence_mode,
            ${statusSql('u')},
            ${PUBLIC_NAME_SQL} AS public_name
     FROM users u WHERE id = $1`,
    [userId],
  );
  if (!rows[0]) return null;
  const {
    avatar_id: avatarId, status_text: _t, status_emoji: _e, status_expires_at: _x, ...profile
  } = rows[0];
  return { ...profile, avatar_url: avatarUrl(avatarId), status: describeStatus(rows[0]) };
}
