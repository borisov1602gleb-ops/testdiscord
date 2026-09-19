// Звонки. Backend отвечает за состояние (кто когда подключился и сколько
// пробыл) и за выдачу токена доступа; сам звук идёт мимо него — напрямую
// между браузером и LiveKit. Поэтому участие корректно закрывается даже
// тогда, когда сервер звонков недоступен.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import { optionalAuth } from '../middleware/auth.js';
import { requireMembership, getChannel } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { createCallToken } from '../lib/livekit.js';
import { config } from '../config.js';

export const callsRouter = Router();

// Гость (без user_id) допускается в звонок только по действующему инвайту
// того же сообщества — это единственный вход без регистрации (раздел 10).
async function authorizeCallAccess({ user, communityId, inviteId, anonymousId }) {
  if (user) {
    await requireMembership(user.id, communityId);
    return;
  }
  if (!anonymousId) throw new HttpError(400, 'anonymous_id_required');
  if (!inviteId) throw new HttpError(401, 'invite_id_required_for_guest');

  const { rows } = await query('SELECT * FROM invites WHERE id = $1', [
    parseUuid(inviteId, 'invite_id'),
  ]);
  const invite = rows[0];
  if (!invite || invite.community_id !== communityId) throw new HttpError(403, 'invite_mismatch');
  if (invite.expires_at != null && new Date(invite.expires_at) <= new Date()) {
    throw new HttpError(410, 'invite_expired');
  }
}

callsRouter.post(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const channelId = parseUuid(req.body?.channel_id, 'channel_id');
    const channel = await getChannel(channelId);
    if (channel.type !== 'voice') throw new HttpError(400, 'channel_is_not_voice');

    await authorizeCallAccess({
      user: req.user,
      communityId: channel.community_id,
      inviteId: req.body?.invite_id,
      anonymousId: req.body?.anonymous_id,
    });

    // В голосовом канале одновременно живёт одна звонковая сессия.
    const { rows: active } = await query(
      'SELECT * FROM calls WHERE channel_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [channelId],
    );
    if (active.length > 0) {
      return res.json({ call: active[0], created: false });
    }

    const { rows } = await query('INSERT INTO calls (channel_id) VALUES ($1) RETURNING *', [
      channelId,
    ]);
    return res.status(201).json({ call: rows[0], created: true });
  }),
);

callsRouter.post(
  '/:id/join',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const callId = parseUuid(req.params.id, 'call_id');
    const anonymousId = req.user ? null : (req.body?.anonymous_id ?? null);
    const inviteId = req.body?.invite_id ?? null;

    const { rows: callRows } = await query(
      `SELECT c.*, ch.community_id
       FROM calls c
       JOIN channels ch ON ch.id = c.channel_id
       WHERE c.id = $1`,
      [callId],
    );

    const logJoin = (status, communityId) =>
      logEvent(EVENT_TYPES.CALL_JOINED, {
        call_id: callId,
        community_id: communityId ?? null,
        user_id: req.user?.id ?? null,
        anonymous_id: anonymousId,
        invite_id: inviteId,
        join_status: status,
      });

    if (callRows.length === 0) {
      await logJoin('failed', null);
      throw new HttpError(404, 'call_not_found');
    }
    const call = callRows[0];
    if (call.ended_at != null) {
      await logJoin('failed', call.community_id);
      throw new HttpError(410, 'call_ended');
    }

    try {
      await authorizeCallAccess({
        user: req.user,
        communityId: call.community_id,
        inviteId,
        anonymousId,
      });
    } catch (err) {
      await logJoin('failed', call.community_id);
      throw err;
    }

    // Повторное подключение (перезагрузка страницы, обрыв связи) не должно
    // плодить незакрытые записи участия: иначе звонок никогда не завершится,
    // а duration_sec первой записи потеряется.
    const { rows: openRows } = await query(
      `SELECT * FROM call_participants
       WHERE call_id = $1
         AND left_at IS NULL
         AND (($2::uuid IS NOT NULL AND user_id = $2::uuid)
              OR ($3::text IS NOT NULL AND anonymous_id = $3::text))
       ORDER BY joined_at DESC
       LIMIT 1`,
      [callId, req.user?.id ?? null, anonymousId],
    );

    const participantRows = openRows.length
      ? openRows
      : (
          await query(
            `INSERT INTO call_participants (call_id, user_id, anonymous_id)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [callId, req.user?.id ?? null, anonymousId],
          )
        ).rows;

    const identity = req.user?.id ?? anonymousId;
    const livekitToken = await createCallToken({
      roomName: callId,
      identity,
      name: req.user?.email ?? 'guest',
    });

    await logJoin('success', call.community_id);

    res.status(201).json({
      participant: participantRows[0],
      livekit: { url: config.livekit.url, token: livekitToken, room: callId, identity },
    });
  }),
);

callsRouter.post(
  '/:id/leave',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const callId = parseUuid(req.params.id, 'call_id');
    const anonymousId = req.body?.anonymous_id ?? null;
    if (!req.user && !anonymousId) throw new HttpError(400, 'anonymous_id_required');

    const participant = await withTransaction(async (client) => {
      // Гость мог зарегистрироваться прямо во время звонка (edge case 12.4):
      // к этому моменту у его записи уже проставлен user_id, поэтому ищем
      // запись и по user_id, и по anonymous_id.
      const { rows } = await client.query(
        `UPDATE call_participants
         SET left_at = now(),
             duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (now() - joined_at))::int)
         WHERE id = (
           SELECT id FROM call_participants
           WHERE call_id = $1
             AND left_at IS NULL
             AND (($2::uuid IS NOT NULL AND user_id = $2::uuid)
                  OR ($3::text IS NOT NULL AND anonymous_id = $3::text))
           ORDER BY joined_at DESC
           LIMIT 1
           FOR UPDATE
         )
         RETURNING *`,
        [callId, req.user?.id ?? null, anonymousId],
      );
      if (rows.length === 0) throw new HttpError(404, 'active_participation_not_found');

      const { rows: stillActive } = await client.query(
        'SELECT 1 FROM call_participants WHERE call_id = $1 AND left_at IS NULL LIMIT 1',
        [callId],
      );
      if (stillActive.length === 0) {
        await client.query('UPDATE calls SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [
          callId,
        ]);
      }

      return rows[0];
    });

    // Событие участия фиксируется только для зарегистрированных пользователей
    // (раздел 12.2): у гостя нет user_id, его вклад попадёт в аналитику
    // только если он зарегистрировался и запись была привязана к user_id.
    if (participant.user_id) {
      const { rows: communityRows } = await query(
        `SELECT ch.community_id
         FROM calls c JOIN channels ch ON ch.id = c.channel_id
         WHERE c.id = $1`,
        [callId],
      );
      await logEvent(EVENT_TYPES.CALL_PARTICIPATED, {
        user_id: participant.user_id,
        community_id: communityRows[0]?.community_id ?? null,
        call_id: callId,
        duration_sec: participant.duration_sec,
      });
    }

    res.json({ participant });
  }),
);
