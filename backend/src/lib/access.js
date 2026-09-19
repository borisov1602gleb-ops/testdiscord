import { query } from '../db.js';
import { HttpError } from './http.js';

export async function requireMembership(userId, communityId) {
  const { rows } = await query(
    'SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2',
    [communityId, userId],
  );
  if (rows.length === 0) throw new HttpError(403, 'not_a_community_member');
  return rows[0].role;
}

export async function getChannel(channelId) {
  const { rows } = await query(
    'SELECT id, community_id, name, type FROM channels WHERE id = $1',
    [channelId],
  );
  if (rows.length === 0) throw new HttpError(404, 'channel_not_found');
  return rows[0];
}
