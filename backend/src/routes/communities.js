// Сообщества: создание (вместе с владельцем и парой каналов), список своих
// сообществ для боковой панели и карточка одного сообщества с его каналами.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import { requireMembership } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { PUBLIC_NAME_SQL } from '../lib/users.js';
import { evictFromCommunity } from '../lib/realtime.js';

export const communitiesRouter = Router();

// Ограничения на состав сообщества. Каналов не бесконечно много: список
// в колонке должен оставаться обозримым, а не превращаться в свалку.
const MAX_NAME_LENGTH = 60;
const MAX_CHANNEL_NAME_LENGTH = 40;
const MAX_CHANNELS = 20;

// Настраивать сообщество может только владелец. Отдельная проверка, а не
// requireMembership: участник тоже состоит в сообществе, но менять его не может.
async function requireOwner(userId, communityId) {
  const role = await requireMembership(userId, communityId);
  if (role !== 'owner') throw new HttpError(403, 'owner_only');
  return role;
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
            count(m.id)::int AS unread,
            count(mm.message_id)::int AS mentions
     FROM community_members cm
     JOIN channels ch ON ch.community_id = cm.community_id AND ch.type = 'text'
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
      communities: rows.map((c) => ({ ...c, ...(totals.get(c.id) ?? { unread: 0, mentions: 0 }) })),
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
       JOIN call_participants cp ON cp.call_id = c.id AND cp.left_at IS NULL
       LEFT JOIN users u ON u.id = cp.user_id
       WHERE ch.community_id = $1 AND c.ended_at IS NULL
       ORDER BY cp.joined_at`,
      [communityId],
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
    const { rows: channels } = await query(
      'SELECT * FROM channels WHERE community_id = $1 ORDER BY type, created_at',
      [req.params.id],
    );

    res.json({ community: rows[0], channels, role });
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
    const { rows } = await query(
      `SELECT u.id, ${PUBLIC_NAME_SQL} AS name, m.role, m.joined_at
       FROM community_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.community_id = $1
       ORDER BY (m.role = 'owner') DESC, m.joined_at`,
      [communityId],
    );

    res.json({ members: rows });
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
    await requireOwner(req.user.id, communityId);

    const name = String(req.body?.name ?? '').trim();
    const type = String(req.body?.type ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');
    if (name.length > MAX_CHANNEL_NAME_LENGTH) {
      throw new HttpError(400, 'name_too_long', { max_length: MAX_CHANNEL_NAME_LENGTH });
    }
    if (type !== 'text' && type !== 'voice') throw new HttpError(400, 'invalid_channel_type');

    const { rows: countRows } = await query(
      'SELECT count(*)::int AS total FROM channels WHERE community_id = $1',
      [communityId],
    );
    if (countRows[0].total >= MAX_CHANNELS) {
      throw new HttpError(409, 'too_many_channels', { max: MAX_CHANNELS });
    }

    const { rows } = await query(
      'INSERT INTO channels (community_id, name, type) VALUES ($1, $2, $3) RETURNING *',
      [communityId, name, type],
    );
    res.status(201).json({ channel: rows[0] });
  }),
);

// Удаление участника: себя — любой, кроме владельца; другого — только
// владелец. Владелец уйти не может: сообщество осталось бы без хозяина,
// а передачи прав в MVP нет.
async function removeMember({ actorId, communityId, targetId, res }) {
  const actorRole = await requireMembership(actorId, communityId);
  const isSelf = actorId === targetId;

  if (!isSelf && actorRole !== 'owner') throw new HttpError(403, 'owner_only');
  if (isSelf && actorRole === 'owner') throw new HttpError(400, 'owner_cannot_leave');

  const { rows } = await query(
    `DELETE FROM community_members
     WHERE community_id = $1 AND user_id = $2 AND role <> 'owner'
     RETURNING id`,
    [communityId, targetId],
  );
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
  });

  res.json({ left: true, reason: isSelf ? 'left' : 'removed' });
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
