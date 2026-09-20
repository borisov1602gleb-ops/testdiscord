// Сообщения в текстовых каналах: отправка (с рассылкой по WebSocket всем,
// кто сейчас в канале) и история при открытии канала.
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, getChannel } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { emitMessage } from '../lib/realtime.js';
import { getProfile, PUBLIC_NAME_SQL } from '../lib/users.js';

export const messagesRouter = Router();

messagesRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channelId = parseUuid(req.body?.channel_id, 'channel_id');
    const content = String(req.body?.content ?? '').trim();
    if (!content) throw new HttpError(400, 'content_required');

    const channel = await getChannel(channelId);
    if (channel.type !== 'text') throw new HttpError(400, 'channel_is_not_text');
    await requireMembership(req.user.id, channel.community_id);

    const { rows } = await query(
      'INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3) RETURNING *',
      [channelId, req.user.id, content],
    );
    // Имя автора берём из профиля, а не из токена: пользователь мог сменить
    // его или скрыть почту уже после входа.
    const author = await getProfile(req.user.id);
    const message = { ...rows[0], author_name: author.public_name };

    emitMessage(channelId, message);
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
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const channel = await getChannel(channelId);
    await requireMembership(req.user.id, channel.community_id);

    const { rows } = await query(
      `SELECT m.*, ${PUBLIC_NAME_SQL} AS author_name
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [channelId, limit],
    );

    res.json({ messages: rows.reverse() });
  }),
);
