// Вход и регистрация по коду на почту: /auth/send-code выдаёт код,
// /auth/verify-code его проверяет, заводит пользователя при первом входе
// и возвращает токен. Здесь же гостевое участие в звонке привязывается
// к появившемуся user_id.
import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import { sendLoginCode } from '../lib/mailer.js';
import { signToken } from '../middleware/auth.js';
import { config } from '../config.js';

export const authRouter = Router();

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

authRouter.post(
  '/send-code',
  asyncHandler(async (req, res) => {
    const { email } = req.body ?? {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      throw new HttpError(400, 'invalid_email');
    }
    const normalizedEmail = normalizeEmail(email);

    const { rows: recent } = await query(
      `SELECT created_at FROM login_codes
       WHERE email = $1 AND created_at > now() - make_interval(secs => $2)
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedEmail, config.loginCode.resendCooldownSec],
    );
    if (recent.length > 0) {
      const retryAfter = Math.max(
        1,
        Math.ceil(
          config.loginCode.resendCooldownSec -
            (Date.now() - new Date(recent[0].created_at).getTime()) / 1000,
        ),
      );
      res.set('Retry-After', String(retryAfter));
      throw new HttpError(429, 'code_already_sent', { retry_after_sec: retryAfter });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await query(
      `INSERT INTO login_codes (email, code, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [normalizedEmail, code, config.loginCode.ttlSec],
    );
    await sendLoginCode(normalizedEmail, code);

    res.status(201).json({
      sent: true,
      expires_in_sec: config.loginCode.ttlSec,
      ...(config.loginCode.exposeInResponse ? { dev_code: code } : {}),
    });
  }),
);

authRouter.post(
  '/verify-code',
  asyncHandler(async (req, res) => {
    const { email, code, anonymous_id: anonymousId, registration_source: source } = req.body ?? {};
    if (!email || !code) throw new HttpError(400, 'email_and_code_required');
    const normalizedEmail = normalizeEmail(email);

    const result = await withTransaction(async (client) => {
      const { rows: codeRows } = await client.query(
        `SELECT id FROM login_codes
         WHERE email = $1 AND code = $2 AND used = false AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [normalizedEmail, String(code)],
      );
      if (codeRows.length === 0) throw new HttpError(400, 'invalid_or_expired_code');

      await client.query('UPDATE login_codes SET used = true WHERE id = $1', [codeRows[0].id]);

      const { rows: existing } = await client.query(
        'SELECT id, email, registration_source, created_at FROM users WHERE email = $1',
        [normalizedEmail],
      );

      let user = existing[0];
      const isNewUser = !user;
      if (isNewUser) {
        const { rows } = await client.query(
          `INSERT INTO users (email, registration_source)
           VALUES ($1, $2)
           RETURNING id, email, registration_source, created_at`,
          [normalizedEmail, source || 'email_code'],
        );
        user = rows[0];
      }

      // Edge case 12.4: гость подключился к звонку анонимно и зарегистрировался
      // уже во время звонка. Привязываем его прошлые записи участия к user_id
      // ДО записи registration_completed, иначе duration_sec при выходе
      // из звонка потеряется.
      let linkedParticipants = 0;
      if (anonymousId) {
        const { rowCount } = await client.query(
          `UPDATE call_participants
           SET user_id = $1
           WHERE anonymous_id = $2 AND user_id IS NULL`,
          [user.id, String(anonymousId)],
        );
        linkedParticipants = rowCount;
      }

      return { user, isNewUser, linkedParticipants };
    });

    if (result.isNewUser) {
      await logEvent(EVENT_TYPES.REGISTRATION_COMPLETED, {
        user_id: result.user.id,
        anonymous_id: anonymousId ?? null,
        registration_source: result.user.registration_source,
        invite_id: req.body?.invite_id ?? null,
        community_id: req.body?.community_id ?? null,
      });
    }

    res.json({
      token: signToken(result.user),
      user: result.user,
      is_new_user: result.isNewUser,
      linked_call_participants: result.linkedParticipants,
    });
  }),
);
