// Как пользователь выглядит для остальных: заданное имя, иначе почта,
// а если он её скрыл — нейтральная подпись. Выражение одно на все запросы,
// чтобы имя не разъезжалось между чатом, звонком и списками.
import { query } from '../db.js';

// alias — под каким именем таблица users стоит в запросе: в одном запросе
// бывает сразу автор сообщения и автор того, на что он отвечает.
export function publicNameSql(alias = 'u') {
  return `COALESCE(
  NULLIF(${alias}.display_name, ''),
  CASE WHEN ${alias}.hide_email THEN 'Участник' ELSE ${alias}.email END
)`;
}

export const PUBLIC_NAME_SQL = publicNameSql('u');

export async function getProfile(userId) {
  const { rows } = await query(
    `SELECT id, email, display_name, hide_email, created_at,
            ${PUBLIC_NAME_SQL} AS public_name
     FROM users u WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}
