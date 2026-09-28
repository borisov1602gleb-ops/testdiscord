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

// ===== роли и права в сообществе =====
// Роли упорядочены: у старшей есть всё, что у младшей. Право описывается
// минимальной ролью, которой оно доступно, — так таблица прав читается
// как документ и меняется в одном месте.
export const ROLE_RANK = { member: 0, moderator: 1, owner: 2 };

export const PERMISSIONS = {
  delete_any_message: 'moderator', // удалять чужие сообщения
  pin_messages: 'moderator',       // закреплять
  kick_members: 'moderator',       // исключать тех, кто младше по роли
  manage_tags: 'moderator',        // создавать теги и выставлять их участникам
  manage_channels: 'moderator',    // создавать каналы
  manage_roles: 'owner',           // назначать и снимать модераторов
  manage_community: 'owner',       // переименовывать сообщество
  view_analytics: 'owner',         // смотреть аналитику
};

export function hasPermission(role, permission) {
  const needed = PERMISSIONS[permission];
  return needed !== undefined && (ROLE_RANK[role] ?? -1) >= ROLE_RANK[needed];
}

// Список прав для клиента: интерфейс по нему решает, какие кнопки
// показывать. Защита всё равно на сервере.
export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => hasPermission(role, p));
}

export async function requirePermission(userId, communityId, permission) {
  const role = await requireMembership(userId, communityId);
  if (!hasPermission(role, permission)) {
    throw new HttpError(403, 'not_allowed', { permission });
  }
  return role;
}
