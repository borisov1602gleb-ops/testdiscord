// Проверки прав: кто состоит в сообществе, существует ли канал и кто
// имеет доступ к переписке. Используются всеми маршрутами, где действие
// ограничено участниками.
import { query } from '../db.js';
import { HttpError } from './http.js';

// Удалённое платформой сообщество не видно никому — даже его участникам.
async function membership(userId, communityId) {
  const { rows } = await query(
    `SELECT cm.role, c.platform_status
     FROM community_members cm JOIN communities c ON c.id = cm.community_id
     WHERE cm.community_id = $1 AND cm.user_id = $2`,
    [communityId, userId],
  );
  if (rows.length === 0) throw new HttpError(403, 'not_a_community_member');
  if (rows[0].platform_status === 'deleted') throw new HttpError(404, 'community_not_found');
  return rows[0];
}

export async function requireMembership(userId, communityId) {
  return (await membership(userId, communityId)).role;
}

// Состояние сообщества на платформе: active, invites_hidden, frozen, deleted.
export async function communityStatus(communityId) {
  const { rows } = await query('SELECT platform_status FROM communities WHERE id = $1', [communityId]);
  if (rows.length === 0) throw new HttpError(404, 'community_not_found');
  return rows[0].platform_status;
}

// У личной переписки сразу подтягиваются её двое участников: по ним
// проверяется доступ и рассылаются события.
export async function getChannel(channelId) {
  const { rows } = await query(
    `SELECT c.id, c.community_id, c.name, c.type, c.is_private, c.read_only,
            (SELECT platform_status FROM communities WHERE id = c.community_id) AS community_status,
            CASE WHEN c.type = 'direct'
              THEN (SELECT array_agg(user_id) FROM direct_members WHERE channel_id = c.id)
            END AS member_ids,
            CASE WHEN c.is_private
              THEN COALESCE((SELECT array_agg(tag_id) FROM channel_allowed_tags WHERE channel_id = c.id), '{}')
            END AS allowed_tag_ids
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

// Кто видит закрытый канал — одно правило для всех запросов: владелец,
// модераторы и участники, у которых есть хотя бы один из разрешённых
// тегов. ch — псевдоним таблицы channels, cm — community_members нужного
// человека в этом сообществе.
export function channelVisibleSql(ch = 'ch', cm = 'cm') {
  return `(NOT ${ch}.is_private
    OR ${cm}.role IN ('owner', 'moderator')
    OR EXISTS (
      SELECT 1 FROM channel_allowed_tags cat
      JOIN member_tags mt ON mt.tag_id = cat.tag_id
      WHERE cat.channel_id = ${ch}.id AND mt.user_id = ${cm}.user_id
    ))`;
}

async function hasAllowedTag(userId, channel) {
  if (!channel.allowed_tag_ids?.length) return false;
  const { rows } = await query(
    'SELECT 1 FROM member_tags WHERE user_id = $1 AND tag_id = ANY($2::uuid[]) LIMIT 1',
    [userId, channel.allowed_tag_ids],
  );
  return rows.length > 0;
}

// Доступ к каналу: в сообществе — членство (а в закрытый канал — ещё и
// роль или нужный тег), в личной переписке — быть одним из двоих.
// Возвращает роль: старшие роли могут больше.
export async function requireChannelAccess(userId, channel) {
  if (channel.type === 'direct') {
    if (!channel.member_ids?.includes(userId)) {
      throw new HttpError(403, 'not_a_conversation_member');
    }
    return 'member';
  }
  const role = await requireMembership(userId, channel.community_id);
  if (channel.is_private && ROLE_RANK[role] < ROLE_RANK.moderator && !(await hasAllowedTag(userId, channel))) {
    throw new HttpError(403, 'private_channel');
  }
  return role;
}

// Замороженное платформой сообщество — только для чтения у всех.
export function requireChannelWritable(channel) {
  if (channel.community_status === 'frozen') throw new HttpError(403, 'community_frozen');
}

// Писать в канал «только для чтения» могут старшие роли.
export function requireCanPost(channel, role) {
  requireChannelWritable(channel);
  if (channel.read_only && !hasPermission(role, 'post_read_only')) {
    throw new HttpError(403, 'channel_read_only');
  }
}

// Кто из перечисленных людей видит канал: для упоминаний и рассылки
// событий закрытого канала.
export async function usersWithAccess(channel, userIds = null) {
  if (channel.type === 'direct') {
    return (channel.member_ids ?? []).filter((id) => !userIds || userIds.includes(id));
  }
  const { rows } = await query(
    `SELECT cm.user_id FROM community_members cm
     JOIN channels ch ON ch.id = $1
     WHERE cm.community_id = ch.community_id
       AND ($2::uuid[] IS NULL OR cm.user_id = ANY($2::uuid[]))
       AND ${channelVisibleSql('ch', 'cm')}`,
    [channel.id, userIds],
  );
  return rows.map((r) => r.user_id);
}

// ===== роли и права в сообществе =====
// Роли упорядочены: у старшей есть всё, что у младшей. Право описывается
// минимальной ролью, которой оно доступно, — так таблица прав читается
// как документ и меняется в одном месте.
export const ROLE_RANK = { member: 0, moderator: 1, owner: 2 };

export const PERMISSIONS = {
  delete_any_message: 'moderator', // удалять чужие сообщения
  pin_messages: 'moderator',       // закреплять
  kick_members: 'moderator',       // исключать и банить тех, кто младше по роли
  handle_reports: 'moderator',     // разбирать жалобы на сообщения
  manage_tags: 'moderator',        // создавать теги и выставлять их участникам
  manage_channels: 'moderator',    // создавать каналы, делать их закрытыми
  post_read_only: 'moderator',     // писать в каналы «только для чтения»
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

// В замороженном платформой сообществе ничего нового не создаётся и не
// настраивается. Удалять нарушения и исключать людей при этом можно.
const BLOCKED_WHEN_FROZEN = new Set(['manage_tags', 'manage_channels', 'manage_community', 'manage_roles', 'pin_messages']);

export async function requirePermission(userId, communityId, permission) {
  const { role, platform_status: status } = await membership(userId, communityId);
  if (!hasPermission(role, permission)) {
    throw new HttpError(403, 'not_allowed', { permission });
  }
  if (status === 'frozen' && BLOCKED_WHEN_FROZEN.has(permission)) {
    throw new HttpError(403, 'community_frozen');
  }
  return role;
}
