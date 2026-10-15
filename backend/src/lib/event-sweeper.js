// Напоминания о событиях сообществ. Раз в полминуты проверяем: у какой
// встречи до начала осталось 15 минут, какая уже началась. Напоминание
// получают те, кто ответил «пойду» или «может быть»; о начале узнаёт всё
// сообщество (плашка над чатом). У повторяющегося события в момент
// начала появляется следующая встреча — через неделю.
//
// Отметка «разослано» ставится тем же UPDATE, что и выбирает встречу, —
// так при нескольких проверках подряд напоминание не придёт дважды.
import { query } from '../db.js';
import { config } from '../config.js';
import { emitToUser } from './realtime.js';
import { announceEvents } from '../routes/events.js';

const SOON_MIN = 15;
// Встреча, начало которой сервер «проспал» больше чем на час (был
// выключен), напоминанием уже не нужна.
const LATE_LIMIT_MIN = 60;

let timer = null;

async function remind(kind, event) {
  const { rows } = await query(
    `SELECT r.user_id FROM event_rsvps r
     JOIN community_members cm ON cm.user_id = r.user_id AND cm.community_id = $2
     WHERE r.event_id = $1 AND r.answer IN ('going', 'maybe')`,
    [event.id, event.community_id],
  );
  const payload = {
    kind,
    id: event.id,
    community_id: event.community_id,
    community_name: event.community_name,
    title: event.title,
    starts_at: event.starts_at,
    channel_id: event.channel_id,
    channel_name: event.channel_name,
  };
  for (const { user_id: userId } of rows) emitToUser(userId, 'event_reminder', payload);
  return rows.length;
}

const PICK = `
  RETURNING e.id, e.community_id, e.series_id, e.title, e.description, e.starts_at, e.ends_at,
            e.channel_id, e.location_text, e.repeat_weekly, e.created_by,
            (SELECT name FROM communities WHERE id = e.community_id) AS community_name,
            (SELECT name FROM channels WHERE id = e.channel_id) AS channel_name`;

export async function sweepEvents() {
  const { rows: soon } = await query(
    `UPDATE community_events e SET reminded_soon_at = now()
     WHERE e.cancelled_at IS NULL AND e.reminded_soon_at IS NULL
       AND e.starts_at > now() AND e.starts_at <= now() + make_interval(mins => ${SOON_MIN})
     ${PICK}`,
  );
  for (const event of soon) await remind('soon', event);

  const { rows: started } = await query(
    `UPDATE community_events e SET reminded_start_at = now(), reminded_soon_at = COALESCE(reminded_soon_at, now())
     WHERE e.cancelled_at IS NULL AND e.reminded_start_at IS NULL
       AND e.starts_at <= now() AND e.starts_at > now() - make_interval(mins => ${LATE_LIMIT_MIN})
     ${PICK}`,
  );
  const touched = new Set();
  for (const event of started) {
    await remind('start', event);
    touched.add(event.community_id);
    if (event.repeat_weekly) await scheduleNext(event);
  }
  // Встречи, которые начались, пока сервер был выключен, просто
  // отмечаем — без напоминаний, но повтор всё равно назначаем.
  const { rows: missed } = await query(
    `UPDATE community_events e SET reminded_start_at = now(), reminded_soon_at = COALESCE(reminded_soon_at, now())
     WHERE e.cancelled_at IS NULL AND e.reminded_start_at IS NULL
       AND e.starts_at <= now() - make_interval(mins => ${LATE_LIMIT_MIN})
     ${PICK}`,
  );
  for (const event of missed) if (event.repeat_weekly) await scheduleNext(event);
  for (const communityId of touched) announceEvents(communityId);
  return { soon: soon.length, started: started.length };
}

// Следующая встреча цепочки — через неделю (или ближайшая будущая, если
// сервер долго стоял). Не создаётся второй раз, если уже есть.
async function scheduleNext(event) {
  const week = 7 * 86_400_000;
  let starts = new Date(event.starts_at).getTime() + week;
  while (starts < Date.now()) starts += week;
  const duration = event.ends_at ? new Date(event.ends_at) - new Date(event.starts_at) : null;
  await query(
    `INSERT INTO community_events
       (community_id, series_id, title, description, starts_at, ends_at, channel_id, location_text, repeat_weekly, created_by)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, true, $9
     WHERE NOT EXISTS (
       SELECT 1 FROM community_events WHERE series_id = $2 AND starts_at >= $5::timestamptz - interval '1 hour'
     )`,
    [event.community_id, event.series_id, event.title, event.description, new Date(starts),
      duration ? new Date(starts + duration) : null, event.channel_id, event.location_text, event.created_by],
  );
}

export function startEventSweeper() {
  if (!config.events.sweepSec) return;
  timer = setInterval(() => {
    sweepEvents().catch((err) => console.error('[events] sweep failed:', err.message));
  }, config.events.sweepSec * 1000);
  timer.unref?.();
}
