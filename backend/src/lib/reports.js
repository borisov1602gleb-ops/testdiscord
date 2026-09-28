// Счётчик открытых жалоб для модерации. Уходит только тем, кто может
// разбирать жалобы, — остальным незачем знать, что на кого-то пожаловались.
import { query } from '../db.js';
import { ROLE_RANK, PERMISSIONS } from './access.js';
import { emitToUser } from './realtime.js';

export async function openReportCount(communityId) {
  const { rows } = await query(
    `SELECT count(DISTINCT message_id)::int AS total
     FROM message_reports WHERE community_id = $1 AND status = 'open'`,
    [communityId],
  );
  return rows[0].total;
}

export async function notifyModerators(communityId) {
  const minRank = ROLE_RANK[PERMISSIONS.handle_reports];
  const [count, { rows }] = await Promise.all([
    openReportCount(communityId),
    query('SELECT user_id, role FROM community_members WHERE community_id = $1', [communityId]),
  ]);
  for (const row of rows) {
    if (ROLE_RANK[row.role] >= minRank) {
      emitToUser(row.user_id, 'reports_updated', { community_id: communityId, open_count: count });
    }
  }
}
