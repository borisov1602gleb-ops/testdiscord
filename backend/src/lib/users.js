// Как пользователь выглядит для остальных: заданное имя, иначе почта,
// а если он её скрыл — нейтральная подпись. Выражение одно на все запросы,
// чтобы имя не разъезжалось между чатом, звонком и списками.
import { query } from '../db.js';

export const PUBLIC_NAME_SQL = `COALESCE(
  NULLIF(u.display_name, ''),
  CASE WHEN u.hide_email THEN 'Участник' ELSE u.email END
)`;

export async function getProfile(userId) {
  const { rows } = await query(
    `SELECT id, email, display_name, hide_email, created_at,
            ${PUBLIC_NAME_SQL} AS public_name
     FROM users u WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}
