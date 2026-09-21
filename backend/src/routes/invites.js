// Приглашения — вход в продукт для нового человека: владелец создаёт ссылку,
// гость открывает её без регистрации (превью), а вступает в сообщество уже
// зарегистрированным. Ограничения по сроку и числу использований проверяются
// здесь же.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { logEvent, EVENT_TYPES } from '../lib/events.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { requireMembership } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';

export const invitesRouter = Router();

invitesRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.body?.community_id, 'community_id');
    await requireMembership(req.user.id, communityId);

    const { expires_at: expiresAt, max_uses: maxUses } = req.body ?? {};
    if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      throw new HttpError(400, 'invalid_max_uses');
    }
    // Дату разбираем сами: нечитаемая строка иначе доезжала до PostgreSQL
    // и возвращалась пользователю как внутренняя ошибка сервера.
    if (expiresAt != null && Number.isNaN(new Date(expiresAt).getTime())) {
      throw new HttpError(400, 'invalid_expires_at');
    }

    const { rows } = await query(
      `INSERT INTO invites (community_id, created_by, expires_at, max_uses)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [communityId, req.user.id, expiresAt ?? null, maxUses ?? null],
    );

    res.status(201).json({ invite: rows[0] });
  }),
);

// Превью инвайта доступно без регистрации (гостевой сценарий, раздел 11).
invitesRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const inviteId = parseUuid(req.params.id, 'invite_id');
    const { rows } = await query(
      `SELECT i.*, c.name AS community_name
       FROM invites i
       JOIN communities c ON c.id = i.community_id
       WHERE i.id = $1`,
      [inviteId],
    );
    if (rows.length === 0) throw new HttpError(404, 'invite_not_found');

    const invite = rows[0];
    const expired = invite.expires_at != null && new Date(invite.expires_at) <= new Date();
    const exhausted = invite.max_uses != null && invite.use_count >= invite.max_uses;

    const { rows: voiceChannels } = await query(
      `SELECT id, name FROM channels
       WHERE community_id = $1 AND type = 'voice'
       ORDER BY created_at LIMIT 1`,
      [invite.community_id],
    );

    // Раздел 6.2: в каждом событии обязан быть идентификатор пользователя.
    // Гостю, у которого его ещё нет, выдаём anonymous_id — с ним он дальше
    // подключается к звонку и связывается с user_id при регистрации.
    const anonymousId = req.user ? null : (req.query.anonymous_id ?? randomUUID());

    await logEvent(EVENT_TYPES.INVITE_LINK_OPENED, {
      invite_id: invite.id,
      community_id: invite.community_id,
      user_id: req.user?.id ?? null,
      anonymous_id: anonymousId,
      device_id: req.get('x-device-id') ?? req.query.device_id ?? null,
    });

    res.json({
      invite: {
        id: invite.id,
        community_id: invite.community_id,
        expires_at: invite.expires_at,
        max_uses: invite.max_uses,
        use_count: invite.use_count,
      },
      community: { id: invite.community_id, name: invite.community_name },
      voice_channel: voiceChannels[0] ?? null,
      anonymous_id: anonymousId,
      valid: !expired && !exhausted,
    });
  }),
);

invitesRouter.post(
  '/:id/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    const inviteId = parseUuid(req.params.id, 'invite_id');

    const result = await withTransaction(async (client) => {
      // Блокируем запись инвайта: одновременные вступления по одной ссылке
      // не должны превысить max_uses.
      const { rows } = await client.query('SELECT * FROM invites WHERE id = $1 FOR UPDATE', [
        inviteId,
      ]);
      if (rows.length === 0) throw new HttpError(404, 'invite_not_found');
      const invite = rows[0];

      if (invite.expires_at != null && new Date(invite.expires_at) <= new Date()) {
        throw new HttpError(410, 'invite_expired');
      }
      if (invite.max_uses != null && invite.use_count >= invite.max_uses) {
        throw new HttpError(410, 'invite_exhausted');
      }

      const { rows: existing } = await client.query(
        'SELECT * FROM community_members WHERE community_id = $1 AND user_id = $2',
        [invite.community_id, req.user.id],
      );
      if (existing.length > 0) {
        return { invite, member: existing[0], alreadyMember: true };
      }

      const { rows: memberRows } = await client.query(
        `INSERT INTO community_members (community_id, user_id, role, invite_id)
         VALUES ($1, $2, 'member', $3)
         RETURNING *`,
        [invite.community_id, req.user.id, invite.id],
      );
      await client.query('UPDATE invites SET use_count = use_count + 1 WHERE id = $1', [invite.id]);

      return { invite, member: memberRows[0], alreadyMember: false };
    });

    if (!result.alreadyMember) {
      await logEvent(EVENT_TYPES.COMMUNITY_JOINED, {
        user_id: req.user.id,
        community_id: result.invite.community_id,
        invite_id: result.invite.id,
        join_source: 'invite_link',
      });
    }

    res.status(result.alreadyMember ? 200 : 201).json({
      member: result.member,
      already_member: result.alreadyMember,
    });
  }),
);
