// Сообщества: создание (вместе с владельцем и парой каналов), список своих
// сообществ для боковой панели и карточка одного сообщества с его каналами.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import {
  requireMembership, requirePermission, hasPermission, permissionsFor, ROLE_RANK,
  channelVisibleSql, getChannel,
} from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { PUBLIC_NAME_SQL, publicNameSql } from '../lib/users.js';
import { avatarUrl } from '../lib/signed-urls.js';
import { rawBody, contentTypeOf, saveUpload, IMAGE_TYPES } from './attachments.js';
import {
  evictFromCommunity, isOnline, emitToCommunity, emitToUser, resetChannelRooms,
} from '../lib/realtime.js';

export const communitiesRouter = Router();

// Ограничения на состав сообщества. Каналов не бесконечно много: список
// в колонке должен оставаться обозримым, а не превращаться в свалку.
const MAX_NAME_LENGTH = 60;
const MAX_CHANNEL_NAME_LENGTH = 40;
const MAX_CHANNELS = 20;

// Теги: сколько всего в сообществе и сколько на одном человеке. Больше —
// и подписи превращаются в шум рядом с каждым именем.
const MAX_TAGS = 30;
const MAX_TAGS_PER_MEMBER = 5;
const MAX_TAG_NAME_LENGTH = 24;
const TAG_COLORS = ['violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'];

// Настраивать сообщество может только владелец. Отдельная проверка, а не
// requireMembership: участник тоже состоит в сообществе, но менять его не может.
async function requireOwner(userId, communityId) {
  const role = await requireMembership(userId, communityId);
  if (role !== 'owner') throw new HttpError(403, 'owner_only');
  return role;
}

async function listTags(communityId) {
  const { rows } = await query(
    `SELECT t.id, t.name, t.color,
            (SELECT count(*)::int FROM member_tags mt
             JOIN community_members cm ON cm.user_id = mt.user_id AND cm.community_id = t.community_id
             WHERE mt.tag_id = t.id) AS member_count
     FROM community_tags t WHERE t.community_id = $1
     ORDER BY t.created_at`,
    [communityId],
  );
  return rows;
}

// Участник так, как его видят остальные: имя, роль, теги, в сети ли.
async function listMembers(communityId, userId = null) {
  const { rows } = await query(
    `SELECT u.id, ${PUBLIC_NAME_SQL} AS name, m.role, m.joined_at, u.avatar_id,
            COALESCE(
              (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)
                               ORDER BY t.created_at)
               FROM member_tags mt JOIN community_tags t ON t.id = mt.tag_id
               WHERE mt.user_id = u.id AND t.community_id = m.community_id),
              '[]'::json
            ) AS tags
     FROM community_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.community_id = $1 AND ($2::uuid IS NULL OR m.user_id = $2::uuid)
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, m.joined_at`,
    [communityId, userId],
  );
  // «В сети» — есть хотя бы одно открытое соединение по WebSocket.
  return rows.map(({ avatar_id: avatarId, ...m }) => ({
    ...m,
    avatar_url: avatarUrl(avatarId),
    online: isOnline(m.id),
  }));
}

// У человека поменялись роль или теги — поменялся и список закрытых
// каналов, которые он видит: его вкладки перечитают список каналов.
function emitToUserChannelsChanged(userId, communityId) {
  emitToUser(userId, 'channels_updated', { community_id: communityId });
}

// Изменился участник (роль, теги) — открытые вкладки перерисуют подписи.
async function announceMember(communityId, userId) {
  const [member] = await listMembers(communityId, userId);
  if (member) emitToCommunity(communityId, 'member_updated', { community_id: communityId, member });
}

function parseTagFields(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || body?.name !== undefined) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');
    if (name.length > MAX_TAG_NAME_LENGTH) {
      throw new HttpError(400, 'name_too_long', { max_length: MAX_TAG_NAME_LENGTH });
    }
    fields.name = name;
  }
  if (!partial || body?.color !== undefined) {
    const color = String(body?.color ?? '');
    if (!TAG_COLORS.includes(color)) throw new HttpError(400, 'invalid_tag_color', { allowed: TAG_COLORS });
    fields.color = color;
  }
  return fields;
}

// Уникальность имени тега держит индекс в базе; его нарушение — это
// понятная ошибка «такой тег уже есть», а не сбой сервера.
function rethrowTagConflict(err) {
  if (err.code === '23505') throw new HttpError(409, 'tag_exists');
  throw err;
}

communitiesRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');

    const created = await withTransaction(async (client) => {
      const { rows: communityRows } = await client.query(
        'INSERT INTO communities (name, owner_id) VALUES ($1, $2) RETURNING *',
        [name, req.user.id],
      );
      const community = communityRows[0];

      await client.query(
        `INSERT INTO community_members (community_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [community.id, req.user.id],
      );

      // MVP: каждое сообщество получает ровно один текстовый и один голосовой канал.
      const { rows: channels } = await client.query(
        `INSERT INTO channels (community_id, name, type)
         VALUES ($1, 'general', 'text'), ($1, 'General Voice', 'voice')
         RETURNING *`,
        [community.id],
      );

      return { community, channels };
    });

    res.status(201).json(created);
  }),
);

// Непрочитанные по каждому текстовому каналу. Отсчёт — от отметки
// прочтения, а если человек канал ещё не открывал — от момента вступления:
// новичку не нужно видеть «999 непрочитанных» из чужой истории.
// Свои и удалённые сообщения не считаются.
async function unreadByChannel(userId, communityId = null) {
  const { rows } = await query(
    `SELECT ch.community_id, ch.id AS channel_id,
            COALESCE(cr.last_read_at, cm.joined_at) AS last_read_at,
            -- Сообщения тредов в счётчик канала не входят: в общей ленте
            -- их не видно. Упоминание в треде считается — его нельзя
            -- пропустить.
            count(m.id) FILTER (WHERE m.thread_id IS NULL)::int AS unread,
            count(mm.message_id)::int AS mentions
     FROM community_members cm
     JOIN channels ch ON ch.community_id = cm.community_id AND ch.type = 'text'
       AND ${channelVisibleSql('ch', 'cm')}
     LEFT JOIN channel_reads cr ON cr.channel_id = ch.id AND cr.user_id = cm.user_id
     LEFT JOIN messages m
       ON m.channel_id = ch.id
      AND m.user_id <> cm.user_id
      AND m.deleted_at IS NULL
      AND m.created_at > COALESCE(cr.last_read_at, cm.joined_at)
     LEFT JOIN message_mentions mm ON mm.message_id = m.id AND mm.user_id = cm.user_id
     WHERE cm.user_id = $1 AND ($2::uuid IS NULL OR cm.community_id = $2::uuid)
     GROUP BY ch.community_id, ch.id, cr.last_read_at, cm.joined_at`,
    [userId, communityId],
  );
  return rows;
}

communitiesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.*, m.role
       FROM community_members m
       JOIN communities c ON c.id = m.community_id
       WHERE m.user_id = $1
       ORDER BY m.joined_at`,
      [req.user.id],
    );
    const totals = new Map();
    for (const row of await unreadByChannel(req.user.id)) {
      const total = totals.get(row.community_id) ?? { unread: 0, mentions: 0 };
      total.unread += row.unread;
      total.mentions += row.mentions;
      totals.set(row.community_id, total);
    }
    res.json({
      communities: rows.map(({ avatar_id: avatarId, ...c }) => ({
        ...c,
        avatar_url: avatarUrl(avatarId),
        ...(totals.get(c.id) ?? { unread: 0, mentions: 0 }),
      })),
    });
  }),
);

communitiesRouter.get(
  '/:id/unread',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireMembership(req.user.id, communityId);
    const rows = await unreadByChannel(req.user.id, communityId);
    res.json({
      // last_read_at нужен клиенту, чтобы провести черту «Новые сообщения».
      channels: rows.map(({ channel_id, unread, mentions, last_read_at }) => ({
        channel_id, unread, mentions, last_read_at,
      })),
    });
  }),
);

// Кто сейчас сидит в голосовых каналах — чтобы видеть это из списка
// каналов, не заходя в звонок. Гости показываются без имени.
communitiesRouter.get(
  '/:id/voice',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireMembership(req.user.id, communityId);
    const { rows } = await query(
      `SELECT c.channel_id, cp.user_id, cp.joined_at,
              CASE WHEN u.id IS NULL THEN 'Гость' ELSE ${PUBLIC_NAME_SQL} END AS name
       FROM calls c
       JOIN channels ch ON ch.id = c.channel_id
       JOIN community_members cm ON cm.community_id = ch.community_id AND cm.user_id = $2
       JOIN call_participants cp ON cp.call_id = c.id AND cp.left_at IS NULL
       LEFT JOIN users u ON u.id = cp.user_id
       WHERE ch.community_id = $1 AND c.ended_at IS NULL
         AND ${channelVisibleSql('ch', 'cm')}
       ORDER BY cp.joined_at`,
      [communityId, req.user.id],
    );
    const channels = {};
    for (const row of rows) {
      (channels[row.channel_id] ??= []).push({
        user_id: row.user_id,
        name: row.name,
        joined_at: row.joined_at,
      });
    }
    res.json({ channels });
  }),
);

communitiesRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM communities WHERE id = $1', [req.params.id]);
    if (rows.length === 0) throw new HttpError(404, 'community_not_found');

    const role = await requireMembership(req.user.id, req.params.id);
    // Закрытые каналы, которые человеку не видны, в список не попадают
    // вовсе — даже названием.
    const { rows: channels } = await query(
      `SELECT ch.id, ch.community_id, ch.name, ch.type, ch.created_at, ch.is_private, ch.read_only,
              COALESCE((SELECT array_agg(tag_id) FROM channel_allowed_tags WHERE channel_id = ch.id), '{}')
                AS allowed_tag_ids
       FROM channels ch
       JOIN community_members cm ON cm.community_id = ch.community_id AND cm.user_id = $2
       WHERE ch.community_id = $1 AND ${channelVisibleSql('ch', 'cm')}
       ORDER BY ch.type, ch.created_at`,
      [req.params.id, req.user.id],
    );

    const { avatar_id: avatarId, ...community } = rows[0];
    res.json({
      community: { ...community, avatar_url: avatarUrl(avatarId) },
      channels,
      role,
      permissions: permissionsFor(role),
    });
  }),
);

communitiesRouter.get(
  '/:id/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireMembership(req.user.id, communityId);
    // Имя берём тем же выражением, что и в чате: как человек назвался, так
    // он и выглядит везде, включая скрытую почту.
    const [members, tags] = await Promise.all([listMembers(communityId), listTags(communityId)]);
    res.json({ members, tags });
  }),
);

// Назначить или снять модератора. Только владелец; владельца самого
// разжаловать нельзя — передачи прав пока нет.
communitiesRouter.patch(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const targetId = parseUuid(req.params.userId, 'user_id');
    await requirePermission(req.user.id, communityId, 'manage_roles');

    const role = String(req.body?.role ?? '');
    if (role !== 'moderator' && role !== 'member') throw new HttpError(400, 'invalid_role');

    const { rows } = await query(
      `UPDATE community_members SET role = $3
       WHERE community_id = $1 AND user_id = $2 AND role <> 'owner'
       RETURNING user_id`,
      [communityId, targetId, role],
    );
    if (rows.length === 0) throw new HttpError(404, 'member_not_found');

    // Разжалованный модератор теряет доступ к закрытым каналам без тега.
    const { rows: privateRows } = await query(
      'SELECT id FROM channels WHERE community_id = $1 AND is_private',
      [communityId],
    );
    resetChannelRooms(privateRows.map((r) => r.id), targetId);
    emitToUserChannelsChanged(targetId, communityId);

    await announceMember(communityId, targetId);
    const [member] = await listMembers(communityId, targetId);
    res.json({ member });
  }),
);

// ===== теги =====

communitiesRouter.get(
  '/:id/tags',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireMembership(req.user.id, communityId);
    res.json({ tags: await listTags(communityId) });
  }),
);

communitiesRouter.post(
  '/:id/tags',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requirePermission(req.user.id, communityId, 'manage_tags');
    const { name, color } = parseTagFields(req.body);

    const { rows: countRows } = await query(
      'SELECT count(*)::int AS total FROM community_tags WHERE community_id = $1',
      [communityId],
    );
    if (countRows[0].total >= MAX_TAGS) throw new HttpError(409, 'too_many_tags', { max: MAX_TAGS });

    const { rows } = await query(
      `INSERT INTO community_tags (community_id, name, color, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id, name, color`,
      [communityId, name, color, req.user.id],
    ).catch(rethrowTagConflict);
    emitToCommunity(communityId, 'tags_updated', { community_id: communityId });
    res.status(201).json({ tag: { ...rows[0], member_count: 0 } });
  }),
);

communitiesRouter.patch(
  '/:id/tags/:tagId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const tagId = parseUuid(req.params.tagId, 'tag_id');
    await requirePermission(req.user.id, communityId, 'manage_tags');
    const fields = parseTagFields(req.body, { partial: true });
    if (Object.keys(fields).length === 0) throw new HttpError(400, 'nothing_to_update');

    const { rows } = await query(
      `UPDATE community_tags
       SET name = COALESCE($3, name), color = COALESCE($4, color)
       WHERE id = $2 AND community_id = $1
       RETURNING id, name, color`,
      [communityId, tagId, fields.name ?? null, fields.color ?? null],
    ).catch(rethrowTagConflict);
    if (rows.length === 0) throw new HttpError(404, 'tag_not_found');
    emitToCommunity(communityId, 'tags_updated', { community_id: communityId });
    res.json({ tag: rows[0] });
  }),
);

communitiesRouter.delete(
  '/:id/tags/:tagId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const tagId = parseUuid(req.params.tagId, 'tag_id');
    await requirePermission(req.user.id, communityId, 'manage_tags');
    // Снимается и со всех участников — это делает ON DELETE CASCADE.
    const { rowCount } = await query(
      'DELETE FROM community_tags WHERE id = $2 AND community_id = $1',
      [communityId, tagId],
    );
    if (rowCount === 0) throw new HttpError(404, 'tag_not_found');
    emitToCommunity(communityId, 'tags_updated', { community_id: communityId });
    res.status(204).end();
  }),
);

// Выставить участнику набор тегов целиком: что прислали — то и будет.
// Так клиенту не нужно отдельно «добавить» и «снять».
communitiesRouter.put(
  '/:id/members/:userId/tags',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const targetId = parseUuid(req.params.userId, 'user_id');
    await requirePermission(req.user.id, communityId, 'manage_tags');
    await requireMembership(targetId, communityId).catch(() => {
      throw new HttpError(404, 'member_not_found');
    });

    if (!Array.isArray(req.body?.tag_ids)) throw new HttpError(400, 'invalid_tags');
    const tagIds = [...new Set(req.body.tag_ids.map((id) => parseUuid(id, 'tag_ids')))];
    if (tagIds.length > MAX_TAGS_PER_MEMBER) {
      throw new HttpError(400, 'too_many_member_tags', { max: MAX_TAGS_PER_MEMBER });
    }
    // Все теги должны быть из этого же сообщества.
    if (tagIds.length) {
      const { rows } = await query(
        'SELECT count(*)::int AS total FROM community_tags WHERE community_id = $1 AND id = ANY($2::uuid[])',
        [communityId, tagIds],
      );
      if (rows[0].total !== tagIds.length) throw new HttpError(400, 'invalid_tags');
    }

    await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM member_tags
         WHERE user_id = $2
           AND tag_id IN (SELECT id FROM community_tags WHERE community_id = $1)
           AND NOT (tag_id = ANY($3::uuid[]))`,
        [communityId, targetId, tagIds],
      );
      if (tagIds.length) {
        await client.query(
          `INSERT INTO member_tags (tag_id, user_id, assigned_by)
           SELECT unnest($1::uuid[]), $2, $3 ON CONFLICT DO NOTHING`,
          [tagIds, targetId, req.user.id],
        );
      }
    });

    // Доступ к закрытым каналам мог поменяться вместе с тегами.
    const { rows: privateRows } = await query(
      'SELECT id FROM channels WHERE community_id = $1 AND is_private',
      [communityId],
    );
    resetChannelRooms(privateRows.map((r) => r.id), targetId);
    emitToUserChannelsChanged(targetId, communityId);

    await announceMember(communityId, targetId);
    const [member] = await listMembers(communityId, targetId);
    res.json({ member });
  }),
);

communitiesRouter.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireOwner(req.user.id, communityId);

    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');
    if (name.length > MAX_NAME_LENGTH) {
      throw new HttpError(400, 'name_too_long', { max_length: MAX_NAME_LENGTH });
    }

    const { rows } = await query(
      'UPDATE communities SET name = $2 WHERE id = $1 RETURNING *',
      [communityId, name],
    );
    res.json({ community: rows[0] });
  }),
);

communitiesRouter.post(
  '/:id/channels',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requirePermission(req.user.id, communityId, 'manage_channels');

    const name = String(req.body?.name ?? '').trim();
    const type = String(req.body?.type ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');
    if (name.length > MAX_CHANNEL_NAME_LENGTH) {
      throw new HttpError(400, 'name_too_long', { max_length: MAX_CHANNEL_NAME_LENGTH });
    }
    if (type !== 'text' && type !== 'voice') throw new HttpError(400, 'invalid_channel_type');
    const access = await parseChannelAccess(req.body, communityId, type);

    const { rows: countRows } = await query(
      'SELECT count(*)::int AS total FROM channels WHERE community_id = $1',
      [communityId],
    );
    if (countRows[0].total >= MAX_CHANNELS) {
      throw new HttpError(409, 'too_many_channels', { max: MAX_CHANNELS });
    }

    const channel = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO channels (community_id, name, type, is_private, read_only)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [communityId, name, type, access.isPrivate ?? false, access.readOnly ?? false],
      );
      await saveAllowedTags(client, rows[0].id, access.allowedTagIds ?? []);
      return rows[0];
    });
    emitToCommunity(communityId, 'channels_updated', { community_id: communityId });
    res.status(201).json({ channel: { ...channel, allowed_tag_ids: access.allowedTagIds ?? [] } });
  }),
);

// Закрытость и «только для чтения». Разрешённые теги — только из этого
// сообщества; «только для чтения» бывает лишь у текстового канала.
async function parseChannelAccess(body, communityId, type) {
  const result = {};
  if (body?.is_private !== undefined) result.isPrivate = body.is_private === true;
  if (body?.read_only !== undefined) {
    result.readOnly = body.read_only === true;
    if (result.readOnly && type !== 'text') throw new HttpError(400, 'read_only_text_only');
  }
  if (body?.allowed_tag_ids !== undefined) {
    if (!Array.isArray(body.allowed_tag_ids)) throw new HttpError(400, 'invalid_tags');
    const ids = [...new Set(body.allowed_tag_ids.map((id) => parseUuid(id, 'allowed_tag_ids')))];
    if (ids.length) {
      const { rows } = await query(
        'SELECT count(*)::int AS total FROM community_tags WHERE community_id = $1 AND id = ANY($2::uuid[])',
        [communityId, ids],
      );
      if (rows[0].total !== ids.length) throw new HttpError(400, 'invalid_tags');
    }
    result.allowedTagIds = ids;
  }
  return result;
}

async function saveAllowedTags(client, channelId, tagIds) {
  await client.query('DELETE FROM channel_allowed_tags WHERE channel_id = $1', [channelId]);
  if (tagIds.length) {
    await client.query(
      'INSERT INTO channel_allowed_tags (channel_id, tag_id) SELECT $1, unnest($2::uuid[])',
      [channelId, tagIds],
    );
  }
}

// Изменить канал: название, закрытость, разрешённые теги, «только для
// чтения». После изменения все выходят из комнаты канала и заходят
// заново уже с проверкой новых правил.
communitiesRouter.patch(
  '/:id/channels/:channelId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const channelId = parseUuid(req.params.channelId, 'channel_id');
    await requirePermission(req.user.id, communityId, 'manage_channels');
    const current = await getChannel(channelId);
    if (current.community_id !== communityId) throw new HttpError(404, 'channel_not_found');

    let name = null;
    if (req.body?.name !== undefined) {
      name = String(req.body.name).trim();
      if (!name) throw new HttpError(400, 'name_required');
      if (name.length > MAX_CHANNEL_NAME_LENGTH) {
        throw new HttpError(400, 'name_too_long', { max_length: MAX_CHANNEL_NAME_LENGTH });
      }
    }
    const access = await parseChannelAccess(req.body, communityId, current.type);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE channels
         SET name = COALESCE($2, name),
             is_private = COALESCE($3, is_private),
             read_only = COALESCE($4, read_only)
         WHERE id = $1`,
        [channelId, name, access.isPrivate ?? null, access.readOnly ?? null],
      );
      if (access.allowedTagIds) await saveAllowedTags(client, channelId, access.allowedTagIds);
    });

    resetChannelRooms([channelId]);
    emitToCommunity(communityId, 'channels_updated', { community_id: communityId });
    const channel = await getChannel(channelId);
    res.json({ channel: { ...channel, allowed_tag_ids: channel.allowed_tag_ids ?? [] } });
  }),
);

// Удаление участника: себя — любой, кроме владельца; другого — владелец
// или модератор, и только того, кто младше по роли: модератор не
// исключает модератора и тем более владельца. Владелец уйти не может:
// сообщество осталось бы без хозяина, а передачи прав пока нет.
// Проверка «можно ли убрать этого человека»: право на исключение и
// старшинство. Для бана та же проверка — бан строже исключения.
async function checkCanRemove(actorRole, communityId, targetId) {
  if (!hasPermission(actorRole, 'kick_members')) throw new HttpError(403, 'not_allowed');
  const { rows: target } = await query(
    'SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2',
    [communityId, targetId],
  );
  if (target.length === 0) return null;
  if (ROLE_RANK[target[0].role] >= ROLE_RANK[actorRole]) {
    throw new HttpError(403, 'cannot_remove_equal_or_higher');
  }
  return target[0].role;
}

async function removeMember({ actorId, communityId, targetId, res }) {
  const actorRole = await requireMembership(actorId, communityId);
  const isSelf = actorId === targetId;

  if (isSelf && actorRole === 'owner') throw new HttpError(400, 'owner_cannot_leave');
  if (!isSelf && (await checkCanRemove(actorRole, communityId, targetId)) === null) {
    throw new HttpError(404, 'member_not_found');
  }
  await detachMember({ actorId, communityId, targetId, isSelf });
  res.json({ left: true, reason: isSelf ? 'left' : 'removed' });
}

// Убрать человека из сообщества: членство, теги, открытые вкладки,
// событие аналитики. Общая часть выхода, исключения и бана.
async function detachMember({ actorId, communityId, targetId, isSelf, banned = false }) {
  const { rows } = await withTransaction(async (client) => {
    const result = await client.query(
      `DELETE FROM community_members
       WHERE community_id = $1 AND user_id = $2 AND role <> 'owner'
       RETURNING id`,
      [communityId, targetId],
    );
    // Теги этого сообщества уходят вместе с участником: вернётся —
    // начнёт с чистого листа.
    await client.query(
      `DELETE FROM member_tags
       WHERE user_id = $2 AND tag_id IN (SELECT id FROM community_tags WHERE community_id = $1)`,
      [communityId, targetId],
    );
    return result;
  });
  if (rows.length === 0) throw new HttpError(404, 'member_not_found');

  // Открытые вкладки исключённого сразу перестают получать события
  // сообщества, а не после перезагрузки.
  const { rows: channelRows } = await query(
    'SELECT id FROM channels WHERE community_id = $1',
    [communityId],
  );
  evictFromCommunity(targetId, communityId, channelRows.map((c) => c.id));

  // Сообщения и участие в звонках остаются: история сообщества не должна
  // рассыпаться из-за того, что человек ушёл.
  await logEvent(EVENT_TYPES.COMMUNITY_LEFT, {
    user_id: targetId,
    community_id: communityId,
    reason: isSelf ? 'left' : 'removed',
    removed_by: isSelf ? null : actorId,
    // Бан в аналитике — то же исключение, с пометкой: причина остаётся
    // из привычного набора, и витрины не нужно переделывать.
    ...(banned ? { banned: true } : {}),
  });

  emitToCommunity(communityId, 'member_removed', { community_id: communityId, user_id: targetId });
}

communitiesRouter.delete(
  '/:id/members/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await removeMember({ actorId: req.user.id, communityId, targetId: req.user.id, res });
  }),
);

communitiesRouter.delete(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const targetId = parseUuid(req.params.userId, 'user_id');
    await removeMember({ actorId: req.user.id, communityId, targetId, res });
  }),
);

// ===== бан =====
// Исключённый может вернуться по любой действующей ссылке, забаненный —
// нет, пока его не разбанят. Банить можно и того, кого уже исключили.

const BAN_REASON_MAX = 200;

communitiesRouter.get(
  '/:id/bans',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requirePermission(req.user.id, communityId, 'kick_members');
    const { rows } = await query(
      `SELECT b.user_id, ${PUBLIC_NAME_SQL} AS name, b.reason, b.created_at,
              ${publicNameSql('by_u')} AS banned_by_name
       FROM community_bans b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN users by_u ON by_u.id = b.banned_by
       WHERE b.community_id = $1
       ORDER BY b.created_at DESC`,
      [communityId],
    );
    res.json({ bans: rows });
  }),
);

communitiesRouter.post(
  '/:id/bans',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const targetId = parseUuid(req.body?.user_id, 'user_id');
    const reason = String(req.body?.reason ?? '').trim().slice(0, BAN_REASON_MAX) || null;
    const actorRole = await requireMembership(req.user.id, communityId);
    if (targetId === req.user.id) throw new HttpError(400, 'cannot_ban_yourself');

    const targetRole = await checkCanRemove(actorRole, communityId, targetId);
    // Не участник — забанить можно только того, кто в сообществе бывал:
    // иначе бан превращается в способ узнавать чужие id.
    if (targetRole === null) {
      const { rows } = await query(
        `SELECT 1 FROM events_bronze
         WHERE event_type = 'community_joined'
           AND payload->>'community_id' = $1 AND payload->>'user_id' = $2
         LIMIT 1`,
        [communityId, targetId],
      );
      if (rows.length === 0) throw new HttpError(404, 'member_not_found');
    }

    await query(
      `INSERT INTO community_bans (community_id, user_id, banned_by, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_id, user_id) DO UPDATE SET reason = EXCLUDED.reason`,
      [communityId, targetId, req.user.id, reason],
    );
    if (targetRole !== null) {
      await detachMember({ actorId: req.user.id, communityId, targetId, isSelf: false, banned: true });
    }
    res.status(201).json({ banned: true });
  }),
);

communitiesRouter.delete(
  '/:id/bans/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const targetId = parseUuid(req.params.userId, 'user_id');
    await requirePermission(req.user.id, communityId, 'kick_members');
    const { rowCount } = await query(
      'DELETE FROM community_bans WHERE community_id = $1 AND user_id = $2',
      [communityId, targetId],
    );
    if (rowCount === 0) throw new HttpError(404, 'ban_not_found');
    res.status(204).end();
  }),
);

// ===== аватарка сообщества =====
const COMMUNITY_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

communitiesRouter.post(
  '/:id/avatar',
  requireAuth,
  rawBody(COMMUNITY_AVATAR_MAX_BYTES),
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requirePermission(req.user.id, communityId, 'manage_community');
    const mimeType = contentTypeOf(req);
    if (!IMAGE_TYPES.has(mimeType)) {
      throw new HttpError(415, 'unsupported_file_type', { allowed: [...IMAGE_TYPES] });
    }
    const file = await saveUpload({
      buffer: req.body,
      mimeType,
      filename: 'community-avatar',
      uploaderId: req.user.id,
      communityId,
    });
    await query('UPDATE communities SET avatar_id = $2 WHERE id = $1', [communityId, file.id]);
    res.json({ avatar_url: avatarUrl(file.id) });
  }),
);

communitiesRouter.delete(
  '/:id/avatar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requirePermission(req.user.id, communityId, 'manage_community');
    await query('UPDATE communities SET avatar_id = NULL WHERE id = $1', [communityId]);
    res.json({ avatar_url: null });
  }),
);

// ===== передача прав владельца =====
// Владелец отдаёт сообщество другому участнику и сам становится
// модератором: так он не теряет возможность помогать, а сообщество не
// остаётся без хозяина. После этого бывший владелец может и уйти.
communitiesRouter.post(
  '/:id/transfer',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const targetId = parseUuid(req.body?.user_id, 'user_id');
    await requireOwner(req.user.id, communityId);
    if (targetId === req.user.id) throw new HttpError(400, 'already_owner');

    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE community_members SET role = 'owner'
         WHERE community_id = $1 AND user_id = $2
         RETURNING user_id`,
        [communityId, targetId],
      );
      if (rows.length === 0) throw new HttpError(404, 'member_not_found');
      await client.query(
        `UPDATE community_members SET role = 'moderator' WHERE community_id = $1 AND user_id = $2`,
        [communityId, req.user.id],
      );
      await client.query('UPDATE communities SET owner_id = $2 WHERE id = $1', [communityId, targetId]);
    });

    await announceMember(communityId, targetId);
    await announceMember(communityId, req.user.id);
    res.json({ transferred: true });
  }),
);
