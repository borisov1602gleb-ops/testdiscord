// События сообщества: созвоны, встречи, лекции. Создают владелец и
// модераторы; участники отвечают «пойду», «может быть», «не пойду».
// Напоминания за 15 минут и в момент начала рассылает фоновая проверка
// (lib/event-sweeper.js). Повторяющееся каждую неделю событие — цепочка
// встреч: следующая появляется, когда начинается текущая.
//
// Для прошедшей встречи в голосовом канале видно, сколько человек пришло
// в звонок — и сколько из ответивших «пойду».
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireReadRole, requireMembership, hasPermission } from '../lib/access.js';
import { requireNotMuted } from '../lib/platform.js';
import { parseUuid } from '../lib/validate.js';
import { emitToCommunity, emitToUser } from '../lib/realtime.js';
import { PUBLIC_NAME_SQL, publicNameSql } from '../lib/users.js';

export const eventsRouter = Router();

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 1000;
const LOCATION_MAX = 200;
const MAX_UPCOMING = 50;
const MAX_PAST = 30;
// Без конца встреча считается часовой: столько длится «идёт сейчас» и
// окно, в котором приход в звонок засчитывается.
export const DEFAULT_DURATION_MIN = 60;
// Пришедшим считается и тот, кто зашёл в звонок чуть раньше начала.
const ARRIVE_EARLY_MIN = 15;
const MAX_DURATION_H = 24;
const MAX_AHEAD_DAYS = 366;
const ANSWERS = ['going', 'maybe', 'no'];

const END_SQL = `COALESCE(e.ends_at, e.starts_at + make_interval(mins => ${DEFAULT_DURATION_MIN}))`;

// Всё о событии для показа: место, кто создал, ответы и свой ответ.
// $1 — id смотрящего.
const EVENT_SELECT = `
  SELECT e.id, e.community_id, e.series_id, e.title, e.description, e.starts_at, e.ends_at,
         e.location_text, e.repeat_weekly, e.cancelled_at, e.created_at,
         ch.id AS channel_id, ch.name AS channel_name,
         ${PUBLIC_NAME_SQL} AS created_by_name,
         ${END_SQL} AS effective_end,
         (SELECT answer FROM event_rsvps WHERE event_id = e.id AND user_id = $1) AS my_answer,
         COALESCE((
           SELECT json_agg(json_build_object('user_id', r.user_id, 'name', ${publicNameSql('ru')}, 'answer', r.answer)
                           ORDER BY r.updated_at)
           FROM event_rsvps r JOIN users ru ON ru.id = r.user_id
           JOIN community_members cm ON cm.user_id = r.user_id AND cm.community_id = e.community_id
           WHERE r.event_id = e.id
         ), '[]'::json) AS answers
  FROM community_events e
  LEFT JOIN channels ch ON ch.id = e.channel_id
  LEFT JOIN users u ON u.id = e.created_by`;

function describeEvent(row) {
  const answers = row.answers ?? [];
  const count = (a) => answers.filter((x) => x.answer === a).length;
  const now = Date.now();
  return {
    id: row.id,
    community_id: row.community_id,
    series_id: row.series_id,
    title: row.title,
    description: row.description,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    effective_end: row.effective_end,
    channel: row.channel_id ? { id: row.channel_id, name: row.channel_name } : null,
    location_text: row.location_text,
    repeat_weekly: row.repeat_weekly,
    cancelled: row.cancelled_at !== null,
    created_by_name: row.created_by_name,
    live: !row.cancelled_at && Date.parse(row.starts_at) <= now && Date.parse(row.effective_end) > now,
    my_answer: row.my_answer ?? null,
    counts: { going: count('going'), maybe: count('maybe'), no: count('no') },
    // «Не пойду» показываем только числом: список отказавшихся никому не нужен.
    people: answers.filter((a) => a.answer !== 'no'),
  };
}

// Явка прошедших встреч в голосовом канале: кто был в звонке этого канала
// в окне встречи и сколько из них отвечали «пойду».
async function attendance(events) {
  const withChannel = events.filter((e) => e.channel);
  if (withChannel.length === 0) return;
  const { rows } = await query(
    `SELECT e.id,
            count(DISTINCT cp.user_id)::int AS came,
            count(DISTINCT cp.user_id) FILTER (WHERE r.answer = 'going')::int AS going_came
     FROM community_events e
     JOIN calls c ON c.channel_id = e.channel_id
     JOIN call_participants cp ON cp.call_id = c.id AND cp.user_id IS NOT NULL
     LEFT JOIN event_rsvps r ON r.event_id = e.id AND r.user_id = cp.user_id
     WHERE e.id = ANY($1::uuid[])
       AND cp.joined_at < ${END_SQL}
       AND COALESCE(cp.left_at, now()) > e.starts_at - make_interval(mins => ${ARRIVE_EARLY_MIN})
     GROUP BY e.id`,
    [withChannel.map((e) => e.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const event of withChannel) {
    const row = byId.get(event.id);
    event.attendance = { came: row?.came ?? 0, going_came: row?.going_came ?? 0 };
  }
}

export async function loadEvent(eventId, viewerId) {
  const { rows } = await query(`${EVENT_SELECT} WHERE e.id = $2`, [viewerId, eventId]);
  return rows[0] ? describeEvent(rows[0]) : null;
}

export function announceEvents(communityId) {
  emitToCommunity(communityId, 'events_updated', { community_id: communityId });
}

function cleanText(raw, max, field, { required = false } = {}) {
  const text = String(raw ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (required && !text) throw new HttpError(400, `${field}_required`);
  if (text.length > max) throw new HttpError(400, `${field}_too_long`, { max_length: max });
  return text || null;
}

function parseTime(raw, field) {
  const date = new Date(raw);
  if (raw == null || raw === '' || Number.isNaN(date.getTime())) throw new HttpError(400, `invalid_${field}`);
  return date;
}

// Поля события из тела запроса. partial — для правки: только присланное.
async function parseEventFields(body, communityId, { partial = false, current = null } = {}) {
  const fields = {};
  const has = (key) => !partial || body?.[key] !== undefined;
  if (has('title')) fields.title = cleanText(body?.title, TITLE_MAX, 'title', { required: true });
  if (has('description')) fields.description = cleanText(body?.description, DESCRIPTION_MAX, 'description');
  if (has('location_text')) fields.location_text = cleanText(body?.location_text, LOCATION_MAX, 'location');
  if (has('repeat_weekly')) fields.repeat_weekly = body?.repeat_weekly === true;

  if (has('starts_at')) {
    const startsAt = parseTime(body?.starts_at, 'starts_at');
    // Пара минут на то, пока человек заполнял форму.
    if (startsAt.getTime() < Date.now() - 5 * 60_000) throw new HttpError(400, 'event_in_past');
    if (startsAt.getTime() > Date.now() + MAX_AHEAD_DAYS * 86_400_000) throw new HttpError(400, 'event_too_far');
    fields.starts_at = startsAt;
  }
  if (has('ends_at')) fields.ends_at = body?.ends_at ? parseTime(body.ends_at, 'ends_at') : null;
  const startsAt = fields.starts_at ?? (current ? new Date(current.starts_at) : null);
  const endsAt = fields.ends_at !== undefined ? fields.ends_at : (current?.ends_at ? new Date(current.ends_at) : null);
  if (endsAt && (endsAt <= startsAt || endsAt - startsAt > MAX_DURATION_H * 3_600_000)) {
    throw new HttpError(400, 'invalid_ends_at', { max_hours: MAX_DURATION_H });
  }

  if (has('channel_id')) {
    fields.channel_id = null;
    if (body?.channel_id) {
      const channelId = parseUuid(body.channel_id, 'channel_id');
      // Место встречи — голосовой канал этого же сообщества.
      const { rows } = await query(
        "SELECT 1 FROM channels WHERE id = $1 AND community_id = $2 AND type = 'voice'",
        [channelId, communityId],
      );
      if (rows.length === 0) throw new HttpError(400, 'invalid_event_channel');
      fields.channel_id = channelId;
    }
  }
  return fields;
}

eventsRouter.get(
  '/:id/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const role = await requireReadRole(req.user.id, communityId);
    const past = req.query.scope === 'past';
    const { rows } = await query(
      past
        ? `${EVENT_SELECT}
           WHERE e.community_id = $2 AND e.cancelled_at IS NULL AND ${END_SQL} <= now()
           ORDER BY e.starts_at DESC LIMIT ${MAX_PAST}`
        : `${EVENT_SELECT}
           WHERE e.community_id = $2 AND e.cancelled_at IS NULL AND ${END_SQL} > now()
           ORDER BY e.starts_at LIMIT ${MAX_UPCOMING}`,
      [req.user.id, communityId],
    );
    const events = rows.map(describeEvent);
    if (past) await attendance(events);
    res.json({ events, can_manage: role !== 'inspector' && hasPermission(role, 'manage_events') });
  }),
);

eventsRouter.post(
  '/:id/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    requireNotMuted(req.user);
    await requirePermission(req.user.id, communityId, 'manage_events');
    const fields = await parseEventFields(req.body, communityId);
    const { rows } = await query(
      `INSERT INTO community_events
         (community_id, series_id, title, description, starts_at, ends_at, channel_id, location_text, repeat_weekly, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [communityId, randomUUID(), fields.title, fields.description, fields.starts_at, fields.ends_at,
        fields.channel_id, fields.location_text, fields.repeat_weekly, req.user.id],
    );
    announceEvents(communityId);
    res.status(201).json({ event: await loadEvent(rows[0].id, req.user.id) });
  }),
);

async function getEvent(communityId, eventId) {
  const { rows } = await query(
    'SELECT * FROM community_events WHERE id = $1 AND community_id = $2',
    [eventId, communityId],
  );
  if (rows.length === 0) throw new HttpError(404, 'event_not_found');
  return rows[0];
}

eventsRouter.patch(
  '/:id/events/:eventId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const eventId = parseUuid(req.params.eventId, 'event_id');
    requireNotMuted(req.user);
    await requirePermission(req.user.id, communityId, 'manage_events');
    const current = await getEvent(communityId, eventId);
    if (current.cancelled_at) throw new HttpError(410, 'event_cancelled');
    const fields = await parseEventFields(req.body, communityId, { partial: true, current });
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.json({ event: await loadEvent(eventId, req.user.id) });
    // Перенесли время — напоминания разошлются заново.
    const retime = fields.starts_at !== undefined && +fields.starts_at !== +new Date(current.starts_at);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    if (retime) sets.push('reminded_soon_at = NULL', 'reminded_start_at = NULL');
    await query(
      `UPDATE community_events SET ${sets.join(', ')} WHERE id = $1`,
      [eventId, ...keys.map((k) => fields[k])],
    );
    announceEvents(communityId);
    res.json({ event: await loadEvent(eventId, req.user.id) });
  }),
);

// Отмена встречи. У повторяющейся — заодно и повторы: следующая встреча
// создаётся из этой, а её больше нет.
eventsRouter.delete(
  '/:id/events/:eventId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const eventId = parseUuid(req.params.eventId, 'event_id');
    await requirePermission(req.user.id, communityId, 'manage_events');
    const event = await getEvent(communityId, eventId);
    if (!event.cancelled_at) {
      await query('UPDATE community_events SET cancelled_at = now() WHERE id = $1', [eventId]);
      // Кто собирался прийти, узнает сразу.
      const { rows } = await query(
        "SELECT user_id FROM event_rsvps WHERE event_id = $1 AND answer IN ('going', 'maybe')",
        [eventId],
      );
      const { rows: [community] } = await query('SELECT name FROM communities WHERE id = $1', [communityId]);
      for (const { user_id: userId } of rows) {
        emitToUser(userId, 'event_reminder', {
          kind: 'cancelled', id: eventId, community_id: communityId, community_name: community.name,
          title: event.title, starts_at: event.starts_at, channel_id: null,
        });
      }
      announceEvents(communityId);
    }
    res.status(204).end();
  }),
);

eventsRouter.put(
  '/:id/events/:eventId/rsvp',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const eventId = parseUuid(req.params.eventId, 'event_id');
    const answer = req.body?.answer ?? null;
    if (answer !== null && !ANSWERS.includes(answer)) throw new HttpError(400, 'invalid_answer', { allowed: ANSWERS });
    // Отвечают только участники: проверяющий от платформы смотрит, но не отвечает.
    await requireMembership(req.user.id, communityId);
    const { rows } = await query(
      `SELECT e.cancelled_at, ${END_SQL} <= now() AS ended
       FROM community_events e WHERE e.id = $1 AND e.community_id = $2`,
      [eventId, communityId],
    );
    if (rows.length === 0) throw new HttpError(404, 'event_not_found');
    if (rows[0].cancelled_at) throw new HttpError(410, 'event_cancelled');
    if (rows[0].ended) throw new HttpError(409, 'event_ended');
    if (answer === null) {
      await query('DELETE FROM event_rsvps WHERE event_id = $1 AND user_id = $2', [eventId, req.user.id]);
    } else {
      await query(
        `INSERT INTO event_rsvps (event_id, user_id, answer) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, user_id) DO UPDATE SET answer = EXCLUDED.answer, updated_at = now()`,
        [eventId, req.user.id, answer],
      );
    }
    announceEvents(communityId);
    res.json({ event: await loadEvent(eventId, req.user.id) });
  }),
);
