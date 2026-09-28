// Сообщения: отправка, история с подгрузкой и переходом к нужному месту,
// правка и удаление, ответы, треды, реакции, упоминания, вложения,
// закреплённые, поиск и «кто просмотрел». Работает одинаково для каналов
// сообществ и для личной переписки. Всё, что меняется, рассылается по
// WebSocket уже после записи в базу.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import { requireAuth } from '../middleware/auth.js';
import {
  requireMembership, getChannel, requireChannelAccess, isChatChannel, hasPermission,
  requireCanPost, usersWithAccess, channelVisibleSql,
} from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { emitToChannel } from '../lib/realtime.js';
import { PUBLIC_NAME_SQL, publicNameSql } from '../lib/users.js';
import { describeAttachment } from './attachments.js';
import { avatarUrl } from '../lib/signed-urls.js';
import { notifyModerators } from '../lib/reports.js';

export const messagesRouter = Router();

// Ограничение длины сообщения. Не из вредности: без него одно сообщение
// может весить мегабайты — это и база, и трафик всем, кто в канале.
const MAX_CONTENT_LENGTH = 2000;
// Сколько сообщений отдаём за раз: по умолчанию и максимум.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Сколько сообщений показываем вокруг найденного при переходе к нему.
const AROUND_EACH_SIDE = 25;
// Тред показывается целиком, но не бесконечно.
const THREAD_LIMIT = 300;
// Упоминаний в одном сообщении — не больше этого: иначе одно сообщение
// превращается в рассылку по всему сообществу.
const MAX_MENTIONS = 20;
const MAX_PINS_PER_CHANNEL = 50;
const SEARCH_MIN = 2;
const SEARCH_MAX = 100;
const SEARCH_LIMIT = 30;
// Реакции — из короткого фиксированного набора. Произвольный текст в
// реакции — это ещё один канал для спама и мусора в базе.
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const SNIPPET_LENGTH = 120;
// Упоминание тега разворачивается в людей: предел выше, чем для ручных
// упоминаний, но не бесконечный.
const MAX_TAG_MENTIONS = 5;
const MAX_EXPANDED_MENTIONS = 200;
// Опрос: вопрос, от двух до десяти вариантов.
const POLL_QUESTION_MAX = 200;
const POLL_OPTION_MAX = 100;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 10;
export const REPORT_REASONS = ['spam', 'abuse', 'other'];
const REPORT_COMMENT_MAX = 500;

// Кто из отметивших прочтение всё ещё имеет доступ к каналу: участник
// сообщества или один из двоих в личной переписке. Ушедшие не считаются.
const READER_HAS_ACCESS = `(
  EXISTS (SELECT 1 FROM direct_members dm
          WHERE dm.channel_id = cr.channel_id AND dm.user_id = cr.user_id)
  OR EXISTS (SELECT 1 FROM channels rc
             JOIN community_members cm
               ON cm.community_id = rc.community_id AND cm.user_id = cr.user_id
             WHERE rc.id = cr.channel_id AND ${channelVisibleSql('rc', 'cm')})
)`;

// Одно сообщение со всем, что нужно для показа. $1 — id смотрящего:
// счётчик «просмотрели» считается только для автора.
const MESSAGE_SELECT = `
  SELECT m.id, m.channel_id, m.user_id, m.content, m.created_at,
         m.edited_at, m.deleted_at, m.reply_to, m.thread_id, m.pinned_at,
         ch.community_id, ch.type AS channel_type, ch.name AS channel_name,
         ${PUBLIC_NAME_SQL} AS author_name, u.avatar_id AS author_avatar_id,
         r.id AS reply_id, r.content AS reply_content, r.deleted_at AS reply_deleted_at,
         ${publicNameSql('ru')} AS reply_author_name,
         a.id AS attachment_id, a.filename AS attachment_filename,
         a.mime_type AS attachment_mime, a.size_bytes AS attachment_size,
         a.duration_ms AS attachment_duration,
         th.thread_count, th.thread_last_at,
         CASE WHEN m.user_id = $1 THEN (
           SELECT count(*)::int
           FROM channel_reads cr
           WHERE cr.channel_id = m.channel_id
             AND cr.user_id <> m.user_id
             AND cr.last_read_at >= m.created_at
             AND ${READER_HAS_ACCESS}
         ) END AS read_count
  FROM messages m
  JOIN channels ch ON ch.id = m.channel_id
  JOIN users u ON u.id = m.user_id
  LEFT JOIN messages r ON r.id = m.reply_to
  LEFT JOIN users ru ON ru.id = r.user_id
  LEFT JOIN attachments a ON a.id = m.attachment_id AND m.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS thread_count, max(t.created_at) AS thread_last_at
    FROM messages t WHERE t.thread_id = m.id AND t.deleted_at IS NULL
  ) th ON m.thread_id IS NULL`;

// Реакции и упоминания догружаются одним запросом на всю пачку сообщений,
// а не по запросу на каждое.
async function hydrate(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [reactions, mentions, tagMentions, polls] = await Promise.all([
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
    query(
      `SELECT mt.message_id, t.id AS tag_id, t.name, t.color
       FROM message_tag_mentions mt JOIN community_tags t ON t.id = mt.tag_id
       WHERE mt.message_id = ANY($1::uuid[])`,
      [ids],
    ),
    loadPolls(ids),
  ]);
  const tagMentionsBy = new Map();
  for (const row of tagMentions.rows) {
    const list = tagMentionsBy.get(row.message_id) ?? [];
    list.push({ tag_id: row.tag_id, name: row.name, color: row.color });
    tagMentionsBy.set(row.message_id, list);
  }

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
      community_id: row.community_id,
      is_direct: row.channel_type === 'direct',
      channel_name: row.channel_name,
      user_id: row.user_id,
      author_name: row.author_name,
      author_avatar_url: avatarUrl(row.author_avatar_id),
      content: deleted ? '' : row.content,
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted,
      thread_id: row.thread_id,
      thread_count: row.thread_count ?? 0,
      thread_last_at: row.thread_last_at ?? null,
      pinned: row.pinned_at !== null && !deleted,
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
      tag_mentions: deleted ? [] : (tagMentionsBy.get(row.id) ?? []),
      poll: deleted ? null : (polls.get(row.id) ?? null),
      read_count: row.read_count ?? null,
    };
  });
}

// Опросы пачки сообщений: варианты и кто за что проголосовал. Опрос
// открытый — как в чатах друзей и команд, где важно, кто что выбрал.
export async function loadPolls(messageIds) {
  const byMessage = new Map();
  if (messageIds.length === 0) return byMessage;
  const { rows } = await query(
    `SELECT p.id, p.message_id, p.question, p.multiple, p.closed_at,
            o.id AS option_id, o.text, o.position,
            COALESCE(array_agg(v.user_id ORDER BY v.created_at) FILTER (WHERE v.user_id IS NOT NULL), '{}') AS voter_ids
     FROM polls p
     JOIN poll_options o ON o.poll_id = p.id
     LEFT JOIN poll_votes v ON v.option_id = o.id
     WHERE p.message_id = ANY($1::uuid[])
     GROUP BY p.id, o.id
     ORDER BY o.position`,
    [messageIds],
  );
  for (const row of rows) {
    let poll = byMessage.get(row.message_id);
    if (!poll) {
      poll = {
        id: row.id,
        question: row.question,
        multiple: row.multiple,
        closed: row.closed_at !== null,
        options: [],
        voters: 0,
      };
      byMessage.set(row.message_id, poll);
    }
    poll.options.push({ id: row.option_id, text: row.text, voter_ids: row.voter_ids });
  }
  for (const poll of byMessage.values()) {
    poll.voters = new Set(poll.options.flatMap((o) => o.voter_ids)).size;
  }
  return byMessage;
}

async function loadMessage(messageId, viewerId) {
  const { rows } = await query(`${MESSAGE_SELECT} WHERE m.id = $2`, [viewerId, messageId]);
  const [message] = await hydrate(rows);
  return message ?? null;
}

// Сообщение вместе с каналом и ролью смотрящего — для проверок прав.
async function getMessageForUser(messageId, userId) {
  const { rows } = await query(
    'SELECT id, user_id, channel_id, thread_id, deleted_at, pinned_at FROM messages WHERE id = $1',
    [messageId],
  );
  if (rows.length === 0) throw new HttpError(404, 'message_not_found');
  const channel = await getChannel(rows[0].channel_id);
  const role = await requireChannelAccess(userId, channel);
  return { ...rows[0], channel, role };
}

// Канал, в котором человек может читать и писать.
async function getChatChannel(channelId, userId) {
  const channel = await getChannel(channelId);
  if (!isChatChannel(channel)) throw new HttpError(400, 'channel_is_not_text');
  const role = await requireChannelAccess(userId, channel);
  return { channel, role };
}

function parseContent(raw, { allowEmpty = false } = {}) {
  const content = String(raw ?? '').trim();
  if (!content && !allowEmpty) throw new HttpError(400, 'content_required');
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new HttpError(400, 'content_too_long', { max_length: MAX_CONTENT_LENGTH });
  }
  return content;
}

// Упоминания присылает клиент списком id. Оставляем только тех, у кого
// есть доступ к каналу: упомянуть постороннего нельзя.
async function parseMentions(raw, channel, authorId) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_mentions');
  const ids = [...new Set(raw.map((id) => parseUuid(id, 'mentions')))]
    .filter((id) => id !== authorId);
  if (ids.length > MAX_MENTIONS) {
    throw new HttpError(400, 'too_many_mentions', { max: MAX_MENTIONS });
  }
  if (ids.length === 0) return [];
  // Упомянуть можно только того, кто видит канал: в закрытом канале
  // упоминание постороннего выдало бы ему, что там что-то происходит.
  return usersWithAccess(channel, ids);
}

// Упоминание тега: «@Дизайнер» уведомляет всех, у кого этот тег. Теги —
// только из сообщества этого канала; в личке тегов нет.
async function parseTagMentions(raw, channel) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_mentions');
  const ids = [...new Set(raw.map((id) => parseUuid(id, 'tag_mentions')))];
  if (ids.length === 0) return [];
  if (channel.type === 'direct') throw new HttpError(400, 'invalid_mentions');
  if (ids.length > MAX_TAG_MENTIONS) {
    throw new HttpError(400, 'too_many_mentions', { max: MAX_TAG_MENTIONS });
  }
  const { rows } = await query(
    'SELECT id FROM community_tags WHERE community_id = $1 AND id = ANY($2::uuid[])',
    [channel.community_id, ids],
  );
  if (rows.length !== ids.length) throw new HttpError(400, 'invalid_mentions');
  return ids;
}

// Кого затрагивает упоминание тегов: нынешние участники с этими тегами,
// кроме автора. Вместе с упомянутыми вручную — не больше предела.
async function expandTagMentions(tagIds, channel, authorId, userIds) {
  if (tagIds.length === 0) return userIds;
  const { rows } = await query(
    `SELECT DISTINCT mt.user_id
     FROM member_tags mt
     JOIN community_members cm ON cm.user_id = mt.user_id AND cm.community_id = $1
     WHERE mt.tag_id = ANY($2::uuid[]) AND mt.user_id <> $3`,
    [channel.community_id, tagIds, authorId],
  );
  const visible = channel.is_private
    ? await usersWithAccess(channel, rows.map((r) => r.user_id))
    : rows.map((r) => r.user_id);
  const all = [...new Set([...userIds, ...visible])];
  if (all.length > MAX_EXPANDED_MENTIONS) {
    throw new HttpError(400, 'too_many_mentions', { max: MAX_EXPANDED_MENTIONS });
  }
  return all;
}

async function saveTagMentions(client, messageId, tagIds) {
  await client.query('DELETE FROM message_tag_mentions WHERE message_id = $1', [messageId]);
  if (tagIds.length === 0) return;
  await client.query(
    `INSERT INTO message_tag_mentions (message_id, tag_id)
     SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [messageId, tagIds],
  );
}

function parsePoll(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new HttpError(400, 'invalid_poll');
  const question = String(raw.question ?? '').trim();
  if (!question) throw new HttpError(400, 'poll_question_required');
  if (question.length > POLL_QUESTION_MAX) {
    throw new HttpError(400, 'poll_question_too_long', { max_length: POLL_QUESTION_MAX });
  }
  if (!Array.isArray(raw.options)) throw new HttpError(400, 'invalid_poll');
  const options = raw.options.map((o) => String(o ?? '').trim()).filter(Boolean);
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    throw new HttpError(400, 'invalid_poll_options', { min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS });
  }
  if (options.some((o) => o.length > POLL_OPTION_MAX)) {
    throw new HttpError(400, 'poll_option_too_long', { max_length: POLL_OPTION_MAX });
  }
  // Два одинаковых варианта — это путаница, а не выбор.
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
    throw new HttpError(400, 'duplicate_poll_options');
  }
  return { question, options, multiple: raw.multiple === true };
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

// Закреплять в сообществе может владелец или модератор. В личной
// переписке — любой из двоих.
function canPin(channel, role) {
  return channel.type === 'direct' || hasPermission(role, 'pin_messages');
}

function parseLimit(raw) {
  // limit приходит от клиента, поэтому зажимаем с обеих сторон:
  // отрицательное значение раньше уходило в SQL и роняло запрос.
  const requested = Number(raw);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_LIMIT)
    : DEFAULT_LIMIT;
}

messagesRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channelId = parseUuid(req.body?.channel_id, 'channel_id');
    const attachmentId = req.body?.attachment_id
      ? parseUuid(req.body.attachment_id, 'attachment_id')
      : null;
    const poll = parsePoll(req.body?.poll);
    // Картинку или опрос можно отправить без подписи — тогда текст не
    // обязателен.
    const content = parseContent(req.body?.content, { allowEmpty: Boolean(attachmentId || poll) });
    const replyTo = req.body?.reply_to ? parseUuid(req.body.reply_to, 'reply_to') : null;
    const threadId = req.body?.thread_id ? parseUuid(req.body.thread_id, 'thread_id') : null;

    const { channel, role } = await getChatChannel(channelId, req.user.id);
    requireCanPost(channel, role);

    if (threadId) {
      // Тред открывается только от живого сообщения общей ленты этого же
      // канала: тредов внутри тредов нет.
      const { rows } = await query(
        `SELECT 1 FROM messages
         WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL AND deleted_at IS NULL`,
        [threadId, channelId],
      );
      if (rows.length === 0) throw new HttpError(400, 'invalid_thread');
    }
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
      // Прикрепить можно только свой файл, загруженный в этот канал (или,
      // по-старому, в это сообщество) и ещё ни к чему не прикреплённый.
      const { rows } = await query(
        `SELECT 1 FROM attachments a
         WHERE a.id = $1 AND a.uploader_id = $2
           AND (a.channel_id = $3
                OR (a.channel_id IS NULL AND a.community_id IS NOT DISTINCT FROM $4::uuid
                    AND $4::uuid IS NOT NULL))
           AND NOT EXISTS (SELECT 1 FROM messages WHERE attachment_id = a.id)`,
        [attachmentId, req.user.id, channelId, channel.community_id],
      );
      if (rows.length === 0) throw new HttpError(400, 'invalid_attachment');
    }
    const tagMentions = await parseTagMentions(req.body?.tag_mentions, channel);
    const mentions = await expandTagMentions(
      tagMentions, channel, req.user.id,
      await parseMentions(req.body?.mentions, channel, req.user.id),
    );

    const { messageId, read } = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO messages (channel_id, user_id, content, reply_to, attachment_id, thread_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [channelId, req.user.id, content, replyTo, attachmentId, threadId],
      );
      await saveMentions(client, rows[0].id, mentions);
      await saveTagMentions(client, rows[0].id, tagMentions);
      if (poll) {
        const { rows: pollRows } = await client.query(
          'INSERT INTO polls (message_id, question, multiple) VALUES ($1, $2, $3) RETURNING id',
          [rows[0].id, poll.question, poll.multiple],
        );
        await client.query(
          `INSERT INTO poll_options (poll_id, position, text)
           SELECT $1, ord, text FROM unnest($2::text[]) WITH ORDINALITY AS t(text, ord)`,
          [pollRows[0].id, poll.options],
        );
      }
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
    emitToChannel(channel, 'message', { ...message, read_count: null });
    if (!read.previous || read.last_read_at > read.previous) {
      emitToChannel(channel, 'read_updated', {
        channel_id: channelId,
        user_id: req.user.id,
        last_read_at: read.last_read_at,
        previous: read.previous,
      });
    }
    // Личная переписка — не активность сообщества: в событии нет
    // community_id, и витрины Gold её не учитывают.
    await logEvent(EVENT_TYPES.MESSAGE_SENT, {
      user_id: req.user.id,
      community_id: channel.community_id,
      channel_id: channelId,
      message_id: message.id,
      ...(channel.type === 'direct' ? { is_direct: true } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
      ...(poll ? { has_poll: true } : {}),
    });

    res.status(201).json({ message });
  }),
);

// Поиск по тексту: в одном сообществе (по всем его текстовым каналам)
// или в одном канале, включая личную переписку.
messagesRouter.get(
  '/search',
  requireAuth,
  asyncHandler(async (req, res) => {
    const text = String(req.query.q ?? '').trim();
    if (text.length < SEARCH_MIN) throw new HttpError(400, 'query_too_short', { min: SEARCH_MIN });
    if (text.length > SEARCH_MAX) throw new HttpError(400, 'query_too_long', { max: SEARCH_MAX });

    let scope;
    const params = [req.user.id];
    if (req.query.channel_id) {
      const { channel } = await getChatChannel(parseUuid(req.query.channel_id, 'channel_id'), req.user.id);
      params.push(channel.id);
      scope = 'm.channel_id = $2';
    } else {
      const communityId = parseUuid(req.query.community_id, 'community_id');
      await requireMembership(req.user.id, communityId);
      params.push(communityId);
      // Закрытые каналы, которых человек не видит, в поиск не попадают.
      scope = `ch.community_id = $2 AND ch.type = 'text' AND EXISTS (
        SELECT 1 FROM community_members cm
        WHERE cm.community_id = ch.community_id AND cm.user_id = $1
          AND ${channelVisibleSql('ch', 'cm')})`;
    }
    // % и _ в запросе — обычные символы, а не шаблоны LIKE.
    params.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

    const { rows } = await query(
      `${MESSAGE_SELECT}
       WHERE ${scope} AND m.deleted_at IS NULL AND m.content ILIKE $3
       ORDER BY m.created_at DESC
       LIMIT ${SEARCH_LIMIT}`,
      params,
    );
    res.json({ messages: await hydrate(rows) });
  }),
);

messagesRouter.get(
  '/pinned',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { channel } = await getChatChannel(parseUuid(req.query.channel_id, 'channel_id'), req.user.id);
    const { rows } = await query(
      `${MESSAGE_SELECT}
       WHERE m.channel_id = $2 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
       ORDER BY m.pinned_at DESC`,
      [req.user.id, channel.id],
    );
    res.json({ messages: await hydrate(rows) });
  }),
);

// История канала. Варианты:
//  - без параметров — последние сообщения общей ленты;
//  - before=<id> — то, что раньше (прокрутка вверх);
//  - after=<id>  — то, что позже (прокрутка вниз после перехода к старому);
//  - around=<id> — окно вокруг найденного или закреплённого сообщения;
//  - thread_id=<id> — тред целиком.
// Сравнение идёт по паре (время, id), чтобы сообщения с одинаковым временем
// не терялись и не повторялись на стыке страниц.
messagesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channelId = parseUuid(req.query.channel_id, 'channel_id');
    const limit = parseLimit(req.query.limit);
    await getChatChannel(channelId, req.user.id);

    if (req.query.thread_id) {
      const threadId = parseUuid(req.query.thread_id, 'thread_id');
      const { rows: rootRows } = await query(
        `${MESSAGE_SELECT} WHERE m.id = $2 AND m.channel_id = $3 AND m.thread_id IS NULL`,
        [req.user.id, threadId, channelId],
      );
      if (rootRows.length === 0) throw new HttpError(404, 'thread_not_found');
      const { rows } = await query(
        `${MESSAGE_SELECT}
         WHERE m.thread_id = $2
         ORDER BY m.created_at, m.id
         LIMIT ${THREAD_LIMIT}`,
        [req.user.id, threadId],
      );
      const [root] = await hydrate(rootRows);
      return res.json({ root, messages: await hydrate(rows) });
    }

    const pivotSql = (n) => `(SELECT created_at, id FROM messages
      WHERE id = $${n} AND channel_id = $2 AND thread_id IS NULL)`;

    if (req.query.around) {
      const around = parseUuid(req.query.around, 'around');
      const { rows: target } = await query(
        `SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND thread_id IS NULL`,
        [around, channelId],
      );
      if (target.length === 0) throw new HttpError(404, 'message_not_found');
      const [older, newer] = await Promise.all([
        query(
          `${MESSAGE_SELECT}
           WHERE m.channel_id = $2 AND m.thread_id IS NULL AND (m.created_at, m.id) <= ${pivotSql(3)}
           ORDER BY m.created_at DESC, m.id DESC LIMIT ${AROUND_EACH_SIDE + 2}`,
          [req.user.id, channelId, around],
        ),
        query(
          `${MESSAGE_SELECT}
           WHERE m.channel_id = $2 AND m.thread_id IS NULL AND (m.created_at, m.id) > ${pivotSql(3)}
           ORDER BY m.created_at, m.id LIMIT ${AROUND_EACH_SIDE + 1}`,
          [req.user.id, channelId, around],
        ),
      ]);
      // В «старших» есть и само сообщение, поэтому запас на одно больше.
      const olderRows = older.rows.slice(0, AROUND_EACH_SIDE + 1).reverse();
      const newerRows = newer.rows.slice(0, AROUND_EACH_SIDE);
      return res.json({
        messages: await hydrate([...olderRows, ...newerRows]),
        has_more: older.rows.length > AROUND_EACH_SIDE + 1,
        has_newer: newer.rows.length > AROUND_EACH_SIDE,
      });
    }

    if (req.query.after) {
      const after = parseUuid(req.query.after, 'after');
      const { rows } = await query(
        `${MESSAGE_SELECT}
         WHERE m.channel_id = $2 AND m.thread_id IS NULL AND (m.created_at, m.id) > ${pivotSql(3)}
         ORDER BY m.created_at, m.id LIMIT ${limit + 1}`,
        [req.user.id, channelId, after],
      );
      return res.json({
        messages: await hydrate(rows.slice(0, limit)),
        has_newer: rows.length > limit,
      });
    }

    const params = [req.user.id, channelId];
    let cursor = '';
    if (req.query.before) {
      params.push(parseUuid(req.query.before, 'before'));
      cursor = `AND (m.created_at, m.id) < ${pivotSql(3)}`;
    }
    const { rows } = await query(
      `${MESSAGE_SELECT}
       WHERE m.channel_id = $2 AND m.thread_id IS NULL ${cursor}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${limit + 1}`,
      params,
    );
    // Берём на одно больше, чем просили: так без отдельного запроса видно,
    // есть ли что подгружать дальше.
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();

    res.json({ messages: await hydrate(page), has_more: hasMore, has_newer: false });
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
      `SELECT attachment_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM polls WHERE message_id = $1) AS has_body
       FROM messages WHERE id = $1`,
      [messageId],
    );
    const content = parseContent(req.body?.content, { allowEmpty: current[0].has_body });
    const tagMentions = await parseTagMentions(req.body?.tag_mentions, target.channel);
    const mentions = await expandTagMentions(
      tagMentions, target.channel, req.user.id,
      await parseMentions(req.body?.mentions, target.channel, req.user.id),
    );

    await withTransaction(async (client) => {
      await client.query(
        'UPDATE messages SET content = $2, edited_at = now() WHERE id = $1',
        [messageId, content],
      );
      await saveMentions(client, messageId, mentions);
      await saveTagMentions(client, messageId, tagMentions);
    });

    const message = await loadMessage(messageId, req.user.id);
    emitToChannel(target.channel, 'message_updated', { ...message, read_count: null });
    res.json({ message });
  }),
);

// Удаление мягкое: строка остаётся ради ответов на неё, тредов и
// аналитики, а текст, вложение, реакции, упоминания, опрос и закрепление
// стираются. Используется и автором, и модерацией (в том числе по жалобе).
export async function softDeleteMessage(messageId, channel, threadId, actorId = null) {
  const hadReports = await withTransaction(async (client) => {
    await client.query(
      `UPDATE messages
       SET content = '', attachment_id = NULL, deleted_at = now(),
           pinned_at = NULL, pinned_by = NULL
       WHERE id = $1 AND deleted_at IS NULL`,
      [messageId],
    );
    await client.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
    await client.query('DELETE FROM message_mentions WHERE message_id = $1', [messageId]);
    await client.query('DELETE FROM message_tag_mentions WHERE message_id = $1', [messageId]);
    await client.query('DELETE FROM polls WHERE message_id = $1', [messageId]);
    // Жалобы на удалённое сообщение закрываются сами: разбирать нечего.
    const { rowCount } = await client.query(
      `UPDATE message_reports SET status = 'resolved', resolved_at = now(), resolved_by = $2
       WHERE message_id = $1 AND status = 'open'`,
      [messageId, actorId],
    );
    return rowCount > 0;
  });
  if (hadReports && channel.community_id) await notifyModerators(channel.community_id);
  emitToChannel(channel, 'message_deleted', {
    id: messageId,
    channel_id: channel.id,
    thread_id: threadId ?? null,
  });
}

messagesRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const target = await getMessageForUser(messageId, req.user.id);
    // Удалить может автор, а владелец и модератор — любое сообщение в
    // сообществе: это модерация. В личке чужое не удаляется.
    const moderates = target.channel.type !== 'direct' && hasPermission(target.role, 'delete_any_message');
    if (target.user_id !== req.user.id && !moderates) {
      throw new HttpError(403, 'not_message_author');
    }
    if (target.deleted_at) return res.status(204).end();

    await softDeleteMessage(messageId, target.channel, target.thread_id, req.user.id);
    res.status(204).end();
  }),
);

// Жалоба на сообщение. Только в сообществах: в личке модерации нет, там
// поможет выйти из переписки. На своё сообщение жаловаться нельзя.
messagesRouter.post(
  '/:id/report',
  requireAuth,
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const reason = String(req.body?.reason ?? '');
    if (!REPORT_REASONS.includes(reason)) {
      throw new HttpError(400, 'invalid_report_reason', { allowed: REPORT_REASONS });
    }
    const comment = String(req.body?.comment ?? '').trim().slice(0, REPORT_COMMENT_MAX) || null;
    const target = await getMessageForUser(messageId, req.user.id);
    if (target.channel.type === 'direct') throw new HttpError(400, 'cannot_report_direct');
    if (target.user_id === req.user.id) throw new HttpError(400, 'cannot_report_own');
    if (target.deleted_at) throw new HttpError(410, 'message_deleted');

    const { rowCount } = await query(
      `INSERT INTO message_reports (message_id, community_id, reporter_id, reason, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [messageId, target.channel.community_id, req.user.id, reason, comment],
    );
    if (rowCount > 0) await notifyModerators(target.channel.community_id);
    // Повторная жалоба того же человека — не ошибка, просто ничего не меняет.
    res.status(rowCount > 0 ? 201 : 200).json({ reported: true });
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
    emitToChannel(target.channel, 'reactions_updated', payload);
    res.json(payload);
  }),
);

messagesRouter.put(
  '/:id/pin',
  requireAuth,
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const pinned = req.body?.pinned !== false;
    const target = await getMessageForUser(messageId, req.user.id);
    if (!canPin(target.channel, target.role)) throw new HttpError(403, 'pin_not_allowed');
    if (target.deleted_at) throw new HttpError(410, 'message_deleted');
    // Закрепляется сообщение общей ленты: сообщение треда без контекста
    // треда в списке закреплённых было бы непонятно.
    if (target.thread_id) throw new HttpError(400, 'cannot_pin_thread_message');

    if (pinned && !target.pinned_at) {
      const { rows } = await query(
        `SELECT count(*)::int AS total FROM messages
         WHERE channel_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL`,
        [target.channel_id],
      );
      if (rows[0].total >= MAX_PINS_PER_CHANNEL) {
        throw new HttpError(409, 'too_many_pins', { max: MAX_PINS_PER_CHANNEL });
      }
    }
    await query(
      pinned
        ? 'UPDATE messages SET pinned_at = COALESCE(pinned_at, now()), pinned_by = COALESCE(pinned_by, $2) WHERE id = $1'
        : 'UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1',
      pinned ? [messageId, req.user.id] : [messageId],
    );

    const message = await loadMessage(messageId, req.user.id);
    emitToChannel(target.channel, 'message_updated', { ...message, read_count: null });
    res.json({ message });
  }),
);

// «Кто просмотрел» — как в Telegram: видно только автору сообщения.
// Прочитавшим считается тот, у кого есть доступ к каналу и чья отметка
// прочтения не раньше времени отправки.
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
       JOIN channel_reads cr ON cr.channel_id = m.channel_id
       JOIN users u ON u.id = cr.user_id
       WHERE m.id = $1 AND cr.user_id <> m.user_id AND cr.last_read_at >= m.created_at
         AND ${READER_HAS_ACCESS}
       ORDER BY cr.last_read_at`,
      [messageId],
    );
    res.json({ readers: rows });
  }),
);
