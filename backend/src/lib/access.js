// Проверки прав: кто состоит в сообществе, существует ли канал и кто
// имеет доступ к переписке. Используются всеми маршрутами, где действие
// ограничено участниками.
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

// У личной переписки сразу подтягиваются её двое участников: по ним
// проверяется доступ и рассылаются события.
export async function getChannel(channelId) {
  const { rows } = await query(
    `SELECT c.id, c.community_id, c.name, c.type,
            CASE WHEN c.type = 'direct'
              THEN (SELECT array_agg(user_id) FROM direct_members WHERE channel_id = c.id)
            END AS member_ids
     FROM channels c WHERE c.id = $1`,
    [channelId],
  );
  if (rows.length === 0) throw new HttpError(404, 'channel_not_found');
  return rows[0];
}

// Каналы, где можно переписываться: текстовые каналы сообществ и личные.
export function isChatChannel(channel) {
  return channel.type === 'text' || channel.type === 'direct';
}

// Доступ к каналу: в сообществе — членство, в личной переписке — быть
// одним из двоих. Возвращает роль: владелец сообщества может больше.
export async function requireChannelAccess(userId, channel) {
  if (channel.type === 'direct') {
    if (!channel.member_ids?.includes(userId)) {
      throw new HttpError(403, 'not_a_conversation_member');
    }
    return 'member';
  }
  return requireMembership(userId, channel.community_id);
}
