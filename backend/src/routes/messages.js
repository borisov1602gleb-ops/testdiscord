// Сообщения в текстовых каналах: отправка, история с подгрузкой старых,
// правка и удаление своих, ответы, реакции, упоминания, вложения и
// «кто просмотрел». Всё, что меняется, рассылается по WebSocket уже после
// записи в базу.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, getChannel } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { emitMessage, emitToCommunity } from '../lib/realtime.js';
import { PUBLIC_NAME_SQL, publicNameSql } from '../lib/users.js';
import { describeAttachment } from './attachments.js';

export const messagesRouter = Router();

// Ограничение длины сообщения. Не из вредности: без него одно сообщение
// может весить мегабайты — это и база, и трафик всем, кто в канале.
const MAX_CONTENT_LENGTH = 2000;
// Сколько сообщений отдаём за раз: по умолчанию и максимум.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Упоминаний в одном сообщении — не больше этого: иначе одно сообщение
// превращается в рассылку по всему сообществу.
const MAX_MENTIONS = 20;
// Реакции — из короткого фиксированного набора. Произвольный текст в
// реакции — это ещё один канал для спама и мусора в базе.
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const SNIPPET_LENGTH = 120;

// Одно сообщение со всем, что нужно для показа. $1 в подзапросе прочтений —
// id смотрящего: счётчик «просмотрели» считается только для автора.
const MESSAGE_SELECT = `
  SELECT m.id, m.channel_id, m.user_id, m.content, m.created_at,
         m.edited_at, m.deleted_at, m.reply_to,
         ${PUBLIC_NAME_SQL} AS author_name,
         r.id AS reply_id, r.content AS reply_content, r.deleted_at AS reply_deleted_at,
         ${publicNameSql('ru')} AS reply_author_name,
         a.id AS attachment_id, a.filename AS attachment_filename,
         a.mime_type AS attachment_mime, a.size_bytes AS attachment_size,
         CASE WHEN m.user_id = $1 THEN (
           SELECT count(*)::int
           FROM channel_reads cr
           JOIN channels ch ON ch.id = cr.channel_id
           JOIN community_members cm
             ON cm.community_id = ch.community_id AND cm.user_id = cr.user_id
           WHERE cr.channel_id = m.channel_id
             AND cr.user_id <> m.user_id
             AND cr.last_read_at >= m.created_at
         ) END AS read_count
  FROM messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN messages r ON r.id = m.reply_to
  LEFT JOIN users ru ON ru.id = r.user_id
  LEFT JOIN attachments a ON a.id = m.attachment_id AND m.deleted_at IS NULL`;

// Реакции и упоминания догружаются одним запросом на всю пачку сообщений,
// а не по запросу на каждое.
async function hydrate(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [reactions, mentions] = await Promise.all([
    query(
      `SELECT message_id, emoji, array_agg(user_id ORDER BY created_at) AS user_ids
       FROM message_reactions WHERE message_id = ANY($1::uuid[])
       GROUP BY message_id, emoji`,
      [ids],
    ),
    query(
      `SELECT mm.message_id, u.id AS user_id, ${PUBLIC_NAME_SQL} AS name
       FROM message_mentions mm JOIN users u ON u.id = mm.user_id
       WHERE mm.message_id = ANY($1::uuid[])`,
      [ids],
    ),
  ]);

  const reactionsBy = new Map();
  for (const row of reactions.rows) {
    const list = reactionsBy.get(row.message_id) ?? [];
    list.push({ emoji: row.emoji, count: row.user_ids.length, user_ids: row.user_ids });
    reactionsBy.set(row.message_id, list);
  }
  const mentionsBy = new Map();
  for (const row of mentions.rows) {
    const list = mentionsBy.get(row.message_id) ?? [];
    list.push({ user_id: row.user_id, name: row.name });
    mentionsBy.set(row.message_id, list);
  }

  return rows.map((row) => {
    const deleted = row.deleted_at !== null;
    const reactionList = (reactionsBy.get(row.id) ?? [])
      .sort((x, y) => REACTIONS.indexOf(x.emoji) - REACTIONS.indexOf(y.emoji));
    return {
      id: row.id,
      channel_id: row.channel_id,
      user_id: row.user_id,
      author_name: row.author_name,
      content: deleted ? '' : row.content,
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted,
      reply: row.reply_id
        ? {
          id: row.reply_id,
          author_name: row.reply_author_name,
          deleted: row.reply_deleted_at !== null,
          snippet: row.reply_deleted_at !== null
            ? ''
            : row.reply_content.slice(0, SNIPPET_LENGTH),
        }
        : null,
      attachment: describeAttachment(row),
      reactions: deleted ? [] : reactionList,
      mentions: deleted ? [] : (mentionsBy.get(row.id) ?? []),
      read_count: row.read_count ?? null,
    };
  });
}

async function loadMessage(messageId, viewerId) {
  const { rows } = await query(`${MESSAGE_SELECT} WHERE m.id = $2`, [viewerId, messageId]);
  const [message] = await hydrate(rows);
  return message ?? null;
}

// Сообщение вместе с каналом — для проверок прав в правке, удалении и реакциях.
async function getMessageForUser(messageId, userId) {
  const { rows } = await query(
    `SELECT m.id, m.user_id, m.channel_id, m.deleted_at, c.community_id
     FROM messages m JOIN channels c ON c.id = m.channel_id
     WHERE m.id = $1`,
    [messageId],
  );
  if (rows.length === 0) throw new HttpError(404, 'message_not_found');
  const role = await requireMembership(userId, rows[0].community_id);
  return { ...rows[0], role };
}

function parseContent(raw, { allowEmpty = false } = {}) {
  const content = String(raw ?? '').trim();
  if (!content && !allowEmpty) throw new HttpError(400, 'content_required');
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new HttpError(400, 'content_too_long', { max_length: MAX_CONTENT_LENGTH });
  }
  return content;
}

// Упоминания присылает клиент списком id. Оставляем только тех, кто
// действительно состоит в сообществе: упомянуть постороннего нельзя.
async function parseMentions(raw, communityId, authorId) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_mentions');
  const ids = [...new Set(raw.map((id) => parseUuid(id, 'mentions')))]
    .filter((id) => id !== authorId);
  if (ids.length > MAX_MENTIONS) {
    throw new HttpError(400, 'too_many_mentions', { max: MAX_MENTIONS });
  }
  if (ids.length === 0) return [];
  const { rows } = await query(
    `SELECT user_id FROM community_members
     WHERE community_id = $1 AND user_id = ANY($2::uuid[])`,
    [communityId, ids],
  );
  return rows.map((row) => row.user_id);
}

async function saveMentions(client, messageId, userIds) {
  await client.query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
  if (userIds.length === 0) return;
  await client.query(
    `INSERT INTO message_mentions (message_id, user_id)
     SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [messageId, userIds],
  );
}

messagesRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channelId = parseUuid(req.body?.channel_id, 'channel_id');
    const attachmentId = req.body?.attachment_id
      ? parseUuid(req.body.attachment_id, 'attachment_id')
      : null;
    // Картинку можно отправить без подписи — тогда текст не обязателен.
    const content = parseContent(req.body?.content, { allowEmpty: Boolean(attachmentId) });
    const replyTo = req.body?.reply_to ? parseUuid(req.body.reply_to, 'reply_to') : null;

    const channel = await getChannel(channelId);
    if (channel.type !== 'text') throw new HttpError(400, 'channel_is_not_text');
    await requireMembership(req.user.id, channel.community_id);

    if (replyTo) {
      // Ответить можно только на сообщение из этого же канала: иначе через
      // ответ можно было бы подсмотреть текст из чужого сообщества.
      const { rows } = await query(
        'SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2',
        [replyTo, channelId],
      );
      if (rows.length === 0) throw new HttpError(400, 'invalid_reply');
    }
    if (attachmentId) {
      // Прикрепить можно только свой файл, загруженный в это сообщество
      // и ещё ни к чему не прикреплённый.
      const { rows } = await query(
        `SELECT 1 FROM attachments a
         WHERE a.id = $1 AND a.uploader_id = $2 AND a.community_id = $3
           AND NOT EXISTS (SELECT 1 FROM messages WHERE attachment_id = a.id)`,
        [attachmentId, req.user.id, channel.community_id],
      );
      if (rows.length === 0) throw new HttpError(400, 'invalid_attachment');
    }
    const mentions = await parseMentions(req.body?.mentions, channel.community_id, req.user.id);

    const { messageId, read } = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO messages (channel_id, user_id, content, reply_to, attachment_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [channelId, req.user.id, content, replyTo, attachmentId],
      );
      await saveMentions(client, rows[0].id, mentions);
      // Кто пишет в канал, тот прочитал всё, что было до его сообщения.
      const { rows: readRows } = await client.query(
        `WITH old AS (
           SELECT last_read_at FROM channel_reads WHERE channel_id = $1 AND user_id = $2
         )
         INSERT INTO channel_reads (channel_id, user_id, last_read_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (channel_id, user_id)
         DO UPDATE SET last_read_at = GREATEST(channel_reads.last_read_at, EXCLUDED.last_read_at)
         RETURNING last_read_at, (SELECT last_read_at FROM old) AS previous`,
        [channelId, req.user.id, rows[0].created_at],
      );
      return { messageId: rows[0].id, read: readRows[0] };
    });

    const message = await loadMessage(messageId, req.user.id);
    // Остальным уходит без счётчика прочтений: он виден только автору.
    emitMessage(channelId, channel.community_id, { ...message, read_count: null });
    if (!read.previous || read.last_read_at > read.previous) {
      emitToCommunity(channel.community_id, 'read_updated', {
        channel_id: channelId,
        user_id: req.user.id,
        last_read_at: read.last_read_at,
        previous: read.previous,
      });
    }
    await logEvent(EVENT_TYPES.MESSAGE_SENT, {
      user_id: req.user.id,
      community_id: channel.community_id,
      channel_id: channelId,
      message_id: message.id,
    });

    res.status(201).json({ message });
  }),
);

messagesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channelId = parseUuid(req.query.channel_id, 'channel_id');
    // limit приходит от клиента, поэтому зажимаем с обеих сторон:
    // отрицательное значение раньше уходило в SQL и роняло запрос.
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;
    // before — id самого старого из уже показанных: отдаём то, что раньше
    // него. Сравнение по паре (время, id), чтобы сообщения с одинаковым
    // временем не терялись и не повторялись на стыке страниц.
    const before = req.query.before ? parseUuid(req.query.before, 'before') : null;

    const channel = await getChannel(channelId);
    await requireMembership(req.user.id, channel.community_id);

    const params = [req.user.id, channelId, limit + 1];
    let cursor = '';
    if (before) {
      params.push(before);
      cursor = `AND (m.created_at, m.id) < (
        SELECT created_at, id FROM messages WHERE id = $4 AND channel_id = $2)`;
    }
    const { rows } = await query(
      `${MESSAGE_SELECT}
       WHERE m.channel_id = $2 ${cursor}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $3`,
      params,
    );
    // Берём на одно больше, чем просили: так без отдельного запроса видно,
    // есть ли что подгружать дальше.
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();

    res.json({ messages: await hydrate(page), has_more: hasMore });
  }),
);

messagesRouter.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const target = await getMessageForUser(messageId, req.user.id);
    // Править можно только своё — даже владельцу сообщества чужие слова
    // переписывать нельзя, только удалить.
    if (target.user_id !== req.user.id) throw new HttpError(403, 'not_message_author');
    if (target.deleted_at) throw new HttpError(410, 'message_deleted');

    const { rows: current } = await query(
      'SELECT attachment_id FROM messages WHERE id = $1',
      [messageId],
    );
    const content = parseContent(req.body?.content, {
      allowEmpty: Boolean(current[0].attachment_id),
    });
    const mentions = await parseMentions(req.body?.mentions, target.community_id, req.user.id);

    await withTransaction(async (client) => {
      await client.query(
        'UPDATE messages SET content = $2, edited_at = now() WHERE id = $1',
        [messageId, content],
      );
      await saveMentions(client, messageId, mentions);
    });

    const message = await loadMessage(messageId, req.user.id);
    emitToCommunity(target.community_id, 'message_updated', { ...message, read_count: null });
    res.json({ message });
  }),
);

messagesRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const target = await getMessageForUser(messageId, req.user.id);
    // Удалить может автор, а владелец — любое сообщение в своём сообществе:
    // это модерация.
    if (target.user_id !== req.user.id && target.role !== 'owner') {
      throw new HttpError(403, 'not_message_author');
    }
    if (target.deleted_at) return res.status(204).end();

    // Удаление мягкое: строка остаётся ради ответов на неё и аналитики,
    // а текст, вложение, реакции и упоминания стираются.
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE messages SET content = '', attachment_id = NULL, deleted_at = now()
         WHERE id = $1`,
        [messageId],
      );
      await client.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
      await client.query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
    });

    emitToCommunity(target.community_id, 'message_deleted', {
      id: messageId,
      channel_id: target.channel_id,
    });
    res.status(204).end();
  }),
);

// Реакция — переключатель: первое нажатие ставит, второе снимает.
messagesRouter.put(
  '/:id/reactions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const emoji = String(req.body?.emoji ?? '');
    if (!REACTIONS.includes(emoji)) {
      throw new HttpError(400, 'invalid_reaction', { allowed: REACTIONS });
    }
    const target = await getMessageForUser(messageId, req.user.id);
    if (target.deleted_at) throw new HttpError(410, 'message_deleted');

    const removed = await query(
      `DELETE FROM message_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, req.user.id, emoji],
    );
    if (removed.rowCount === 0) {
      await query(
        `INSERT INTO message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [messageId, req.user.id, emoji],
      );
    }

    const message = await loadMessage(messageId, req.user.id);
    const payload = {
      id: messageId,
      channel_id: target.channel_id,
      reactions: message.reactions,
    };
    emitToCommunity(target.community_id, 'reactions_updated', payload);
    res.json(payload);
  }),
);

// «Кто просмотрел» — как в Telegram: видно только автору сообщения.
// Прочитавшим считается участник, чья отметка прочтения канала не раньше
// времени отправки.
messagesRouter.get(
  '/:id/readers',
  requireAuth,
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const target = await getMessageForUser(messageId, req.user.id);
    if (target.user_id !== req.user.id) throw new HttpError(403, 'not_message_author');

    const { rows } = await query(
      `SELECT u.id, ${PUBLIC_NAME_SQL} AS name, cr.last_read_at AS read_at
       FROM messages m
       JOIN channels ch ON ch.id = m.channel_id
       JOIN channel_reads cr ON cr.channel_id = m.channel_id
       JOIN community_members cm
         ON cm.community_id = ch.community_id AND cm.user_id = cr.user_id
       JOIN users u ON u.id = cr.user_id
       WHERE m.id = $1 AND cr.user_id <> m.user_id AND cr.last_read_at >= m.created_at
       ORDER BY cr.last_read_at`,
      [messageId],
    );
    res.json({ readers: rows });
  }),
);
