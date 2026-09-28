// Голосование в опросах. Сам опрос создаётся вместе с сообщением
// (POST /messages с полем poll); здесь — голос и закрытие.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getChannel, requireChannelAccess, hasPermission } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { emitToChannel } from '../lib/realtime.js';
import { loadPolls } from './messages.js';

export const pollsRouter = Router();

async function getPollForUser(pollId, userId) {
  const { rows } = await query(
    `SELECT p.id, p.message_id, p.multiple, p.closed_at, m.user_id AS author_id,
            m.channel_id, m.deleted_at
     FROM polls p JOIN messages m ON m.id = p.message_id
     WHERE p.id = $1`,
    [pollId],
  );
  if (rows.length === 0 || rows[0].deleted_at) throw new HttpError(404, 'poll_not_found');
  const channel = await getChannel(rows[0].channel_id);
  const role = await requireChannelAccess(userId, channel);
  return { ...rows[0], channel, role };
}

async function broadcast(poll) {
  const polls = await loadPolls([poll.message_id]);
  const payload = {
    message_id: poll.message_id,
    channel_id: poll.channel_id,
    poll: polls.get(poll.message_id) ?? null,
  };
  emitToChannel(poll.channel, 'poll_updated', payload);
  return payload;
}

// Голос — это набор выбранных вариантов целиком. Пустой набор снимает
// голос; в опросе с одним ответом — не больше одного варианта.
pollsRouter.put(
  '/:id/vote',
  requireAuth,
  asyncHandler(async (req, res) => {
    const pollId = parseUuid(req.params.id, 'poll_id');
    const poll = await getPollForUser(pollId, req.user.id);
    if (poll.closed_at) throw new HttpError(410, 'poll_closed');
    if (!Array.isArray(req.body?.option_ids)) throw new HttpError(400, 'invalid_vote');
    const optionIds = [...new Set(req.body.option_ids.map((id) => parseUuid(id, 'option_ids')))];
    if (!poll.multiple && optionIds.length > 1) throw new HttpError(400, 'single_choice_poll');

    if (optionIds.length) {
      const { rows } = await query(
        'SELECT count(*)::int AS total FROM poll_options WHERE poll_id = $1 AND id = ANY($2::uuid[])',
        [pollId, optionIds],
      );
      if (rows[0].total !== optionIds.length) throw new HttpError(400, 'invalid_vote');
    }

    await withTransaction(async (client) => {
      await client.query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [pollId, req.user.id]);
      if (optionIds.length) {
        await client.query(
          `INSERT INTO poll_votes (poll_id, option_id, user_id)
           SELECT $1, unnest($2::uuid[]), $3`,
          [pollId, optionIds, req.user.id],
        );
      }
    });
    res.json(await broadcast(poll));
  }),
);

// Закрыть опрос может автор, а в сообществе — ещё и модерация.
pollsRouter.post(
  '/:id/close',
  requireAuth,
  asyncHandler(async (req, res) => {
    const pollId = parseUuid(req.params.id, 'poll_id');
    const poll = await getPollForUser(pollId, req.user.id);
    const moderates = poll.channel.type !== 'direct' && hasPermission(poll.role, 'delete_any_message');
    if (poll.author_id !== req.user.id && !moderates) throw new HttpError(403, 'not_allowed');
    await query('UPDATE polls SET closed_at = COALESCE(closed_at, now()) WHERE id = $1', [pollId]);
    res.json(await broadcast(poll));
  }),
);
