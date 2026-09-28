// Личные сообщения. Переписка — это канал типа 'direct' с двумя
// участниками; сами сообщения ходят через те же маршруты /messages, что и
// в сообществах. Здесь — только список переписок и начало новой.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getChannel, requireChannelAccess } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { isOnline } from '../lib/realtime.js';
import { PUBLIC_NAME_SQL } from '../lib/users.js';

export const directRouter = Router();

const SNIPPET_LENGTH = 80;

// Список переписок: собеседник, последнее сообщение и сколько непрочитанных.
// Отсчёт непрочитанного — как в каналах: от отметки прочтения, а если её
// ещё нет — от начала переписки.
async function listConversations(userId, channelId = null) {
  const { rows } = await query(
    `SELECT ch.id, ch.created_at,
            other.user_id AS other_id, ${PUBLIC_NAME_SQL} AS other_name,
            last.content AS last_content, last.created_at AS last_at,
            last.user_id AS last_user_id, last.deleted_at IS NOT NULL AS last_deleted,
            last.has_attachment AS last_has_attachment,
            COALESCE(cr.last_read_at, mine.joined_at) AS last_read_at,
            (SELECT count(*)::int FROM messages m
             WHERE m.channel_id = ch.id AND m.user_id <> $1 AND m.deleted_at IS NULL
               AND m.thread_id IS NULL
               AND m.created_at > COALESCE(cr.last_read_at, mine.joined_at)) AS unread
     FROM direct_members mine
     JOIN channels ch ON ch.id = mine.channel_id
     JOIN direct_members other ON other.channel_id = ch.id AND other.user_id <> mine.user_id
     JOIN users u ON u.id = other.user_id
     LEFT JOIN channel_reads cr ON cr.channel_id = ch.id AND cr.user_id = mine.user_id
     LEFT JOIN LATERAL (
       SELECT m.content, m.created_at, m.user_id, m.deleted_at,
              m.attachment_id IS NOT NULL AS has_attachment
       FROM messages m WHERE m.channel_id = ch.id AND m.thread_id IS NULL
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1
     ) last ON true
     WHERE mine.user_id = $1 AND ($2::uuid IS NULL OR ch.id = $2::uuid)
     ORDER BY COALESCE(last.created_at, ch.created_at) DESC`,
    [userId, channelId],
  );
  return rows.map((row) => ({
    id: row.id,
    user: { id: row.other_id, name: row.other_name, online: isOnline(row.other_id) },
    last_message: row.last_at
      ? {
        from_me: row.last_user_id === userId,
        text: row.last_deleted
          ? 'сообщение удалено'
          : (row.last_content || (row.last_has_attachment ? 'вложение' : '')).slice(0, SNIPPET_LENGTH),
        created_at: row.last_at,
      }
      : null,
    last_read_at: row.last_read_at,
    unread: row.unread,
  }));
}

directRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ conversations: await listConversations(req.user.id) });
  }),
);

directRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channel = await getChannel(parseUuid(req.params.id, 'channel_id'));
    if (channel.type !== 'direct') throw new HttpError(404, 'conversation_not_found');
    await requireChannelAccess(req.user.id, channel);
    const [conversation] = await listConversations(req.user.id, channel.id);
    res.json({ conversation });
  }),
);

// Начать переписку (или открыть уже существующую). Написать можно только
// тому, с кем есть общее сообщество: иначе личка стала бы каналом спама
// для любого, кто узнал чужой id.
directRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const otherId = parseUuid(req.body?.user_id, 'user_id');
    const me = req.user.id;
    if (otherId === me) throw new HttpError(400, 'cannot_message_yourself');

    const { rows: shared } = await query(
      `SELECT 1 FROM community_members a
       JOIN community_members b ON b.community_id = a.community_id
       WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
      [me, otherId],
    );
    if (shared.length === 0) throw new HttpError(403, 'no_shared_community');

    // Ключ пары одинаков с обеих сторон, а уникальный индекс по нему не
    // даёт появиться двум перепискам, если оба нажали одновременно.
    const key = [me, otherId].sort().join(':');
    const created = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO channels (community_id, name, type, direct_key)
         VALUES (NULL, '', 'direct', $1)
         ON CONFLICT (direct_key) DO NOTHING
         RETURNING id`,
        [key],
      );
      if (rows.length === 0) return false;
      await client.query(
        `INSERT INTO direct_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [rows[0].id, me, otherId],
      );
      return true;
    });

    const { rows } = await query('SELECT id FROM channels WHERE direct_key = $1', [key]);
    const [conversation] = await listConversations(me, rows[0].id);
    res.status(created ? 201 : 200).json({ conversation, created });
  }),
);
