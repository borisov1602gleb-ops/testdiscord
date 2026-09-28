// Каналы: отметка «прочитал до этого места». Из неё считаются и
// непрочитанные у самого человека, и «кто просмотрел» у авторов сообщений.
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getChannel, requireChannelAccess, isChatChannel } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { emitToChannel } from '../lib/realtime.js';

export const channelsRouter = Router();

channelsRouter.post(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const channelId = parseUuid(req.params.id, 'channel_id');
    const channel = await getChannel(channelId);
    if (!isChatChannel(channel)) throw new HttpError(400, 'channel_is_not_text');
    await requireChannelAccess(req.user.id, channel);

    // Время ставит сервер, а не клиент: иначе можно было бы отметить
    // прочитанным то, что ещё не написано. Отметка только растёт.
    // previous нужен клиентам авторов: по нему видно, какие сообщения
    // этот человек прочитал только что, и счётчик растёт без перезапроса.
    const { rows } = await query(
      `WITH old AS (
         SELECT last_read_at FROM channel_reads WHERE channel_id = $1 AND user_id = $2
       )
       INSERT INTO channel_reads (channel_id, user_id, last_read_at)
       VALUES ($1, $2, now())
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET last_read_at = GREATEST(channel_reads.last_read_at, EXCLUDED.last_read_at)
       RETURNING last_read_at, (SELECT last_read_at FROM old) AS previous`,
      [channelId, req.user.id],
    );
    const { last_read_at: lastReadAt, previous } = rows[0];

    if (!previous || lastReadAt > previous) {
      emitToChannel(channel, 'read_updated', {
        channel_id: channelId,
        user_id: req.user.id,
        last_read_at: lastReadAt,
        previous,
      });
    }
    res.json({ channel_id: channelId, last_read_at: lastReadAt });
  }),
);
