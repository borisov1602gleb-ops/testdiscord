// Проверка слоёв Silver и Gold на заведомо грязных данных.
//
// Скрипт создаёт временное сообщество, кладёт в Bronze смесь нормальных и
// битых событий, прогоняет ETL и проверяет, что:
//   * мусор уехал в карантин с правильной причиной, а не в витрины;
//   * повторный прогон ничего не задваивает;
//   * гость и он же после регистрации — один человек;
//   * воронка, активность и длительности посчитаны так, как ожидается.
// В конце все тестовые данные удаляются и витрины пересобираются заново.
//
// Запуск: node scripts/etl-test.mjs (нужен доступ к базе, backend не нужен).
import { randomUUID } from 'node:crypto';
import { pool, waitForDatabase } from '../src/db.js';
import { applySchema } from '../src/lib/schema.js';
import { runEtl } from '../src/etl/index.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (ожидалось ${JSON.stringify(expected)})`}`);
}

const stamp = Date.now();
const anonymousId = `etl-guest-${stamp}`;
const eventIds = [];

async function bronze(eventType, payload, { minutesAgo = 0 } = {}) {
  const eventId = randomUUID();
  eventIds.push(eventId);
  await pool.query(
    `INSERT INTO events_bronze (event_id, event_type, payload, received_at, source)
     VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval, 'etl-test')`,
    [eventId, eventType, { event_id: eventId, ...payload }, String(minutesAgo)],
  );
  return eventId;
}

await waitForDatabase();
await applySchema();

// ===== подготовка: сообщество с владельцем и каналами =====
const { rows: ownerRows } = await pool.query(
  `INSERT INTO users (email, registration_source) VALUES ($1, 'etl-test') RETURNING id`,
  [`etl-owner-${stamp}@example.com`],
);
const ownerId = ownerRows[0].id;

const { rows: communityRows } = await pool.query(
  'INSERT INTO communities (name, owner_id) VALUES ($1, $2) RETURNING id',
  [`ETL тест ${stamp}`, ownerId],
);
const communityId = communityRows[0].id;

await pool.query(
  `INSERT INTO community_members (community_id, user_id, role, joined_at)
   VALUES ($1, $2, 'owner', now() - interval '30 days')`,
  [communityId, ownerId],
);

const { rows: channelRows } = await pool.query(
  `INSERT INTO channels (community_id, name, type)
   VALUES ($1, 'general', 'text'), ($1, 'voice', 'voice')
   RETURNING id, type`,
  [communityId],
);
const textChannelId = channelRows.find((c) => c.type === 'text').id;
const voiceChannelId = channelRows.find((c) => c.type === 'voice').id;

const { rows: callRows } = await pool.query(
  'INSERT INTO calls (channel_id) VALUES ($1) RETURNING id',
  [voiceChannelId],
);
const callId = callRows[0].id;

const { rows: inviteRows } = await pool.query(
  'INSERT INTO invites (community_id, created_by) VALUES ($1, $2) RETURNING id',
  [communityId, ownerId],
);
const inviteId = inviteRows[0].id;

// ===== шаг 1: гость приходит по ссылке, ещё не зарегистрирован =====
await bronze('invite_link_opened', {
  invite_id: inviteId,
  community_id: communityId,
  anonymous_id: anonymousId,
  device_id: 'device-test',
}, { minutesAgo: 30 });

// В событии подключения сообщества нет — Silver должен восстановить его
// по call_id, иначе неудачные подключения не попадут ни в одно сообщество.
await bronze('call_joined', {
  call_id: callId,
  anonymous_id: anonymousId,
  invite_id: inviteId,
  join_status: 'success',
}, { minutesAgo: 29 });

await bronze('call_joined', {
  call_id: callId,
  anonymous_id: `stranger-${stamp}`,
  join_status: 'failed',
}, { minutesAgo: 28 });

// ===== мусор, который обязан уехать в карантин =====
const rejectedIds = {
  unknown: await bronze('weird_event', { user_id: ownerId, community_id: communityId }),
  badUuid: await bronze('message_sent', { user_id: 'не-uuid', community_id: communityId }),
  noPerson: await bronze('message_sent', { community_id: communityId }),
  badDuration: await bronze('call_participated', {
    user_id: ownerId,
    community_id: communityId,
    duration_sec: -42,
  }),
  badTimestamp: await bronze('message_sent', {
    user_id: ownerId,
    community_id: communityId,
    channel_id: textChannelId,
    timestamp: 'вчера вечером',
  }),
  // Раздел 6.2: join_status — перечисление, а community_id обязан
  // существовать в справочнике.
  badEnum: await bronze('call_joined', {
    call_id: callId,
    anonymous_id: `enum-${stamp}`,
    join_status: 'наверное получилось',
  }),
  unknownRef: await bronze('message_sent', {
    user_id: ownerId,
    community_id: '22222222-2222-2222-2222-222222222222',
  }),
};

await runEtl();
// Считаем именно свои события: в базе параллельно живут чужие, и общий
// счётчик прогона ничего бы не доказывал.
const { rows: loadedRows } = await pool.query(
  'SELECT count(*)::int AS n FROM events_silver WHERE event_id = ANY($1)',
  [eventIds],
);
check('первый прогон загрузил годные события', loadedRows[0].n, 3);

const { rows: guestRows } = await pool.query(
  `SELECT DISTINCT person_id FROM events_silver WHERE anonymous_id = $1`,
  [anonymousId],
);
check('гость пока учитывается как аноним', guestRows.map((r) => r.person_id), [`anon:${anonymousId}`]);

const { rows: enriched } = await pool.query(
  `SELECT community_id FROM events_silver
   WHERE event_type = 'call_joined' AND anonymous_id = $1`,
  [anonymousId],
);
check('сообщество восстановлено по call_id', enriched[0].community_id, communityId);

// ===== шаг 2: гость регистрируется и вступает, дальше пишет и звонит =====
const { rows: userRows } = await pool.query(
  `INSERT INTO users (email, registration_source) VALUES ($1, 'etl-test') RETURNING id`,
  [`etl-guest-${stamp}@example.com`],
);
const guestUserId = userRows[0].id;

await pool.query(
  `INSERT INTO community_members (community_id, user_id, role, invite_id, joined_at)
   VALUES ($1, $2, 'member', $3, now() - interval '20 minutes')`,
  [communityId, guestUserId, inviteId],
);

await bronze('registration_completed', {
  user_id: guestUserId,
  anonymous_id: anonymousId,
  registration_source: 'email_code',
}, { minutesAgo: 22 });

await bronze('community_joined', {
  user_id: guestUserId,
  community_id: communityId,
  invite_id: inviteId,
  join_source: 'invite_link',
}, { minutesAgo: 20 });

await bronze('message_sent', {
  user_id: guestUserId,
  community_id: communityId,
  channel_id: textChannelId,
  message_id: randomUUID(),
}, { minutesAgo: 15 });

await bronze('message_sent', {
  user_id: guestUserId,
  community_id: communityId,
  channel_id: textChannelId,
  message_id: randomUUID(),
}, { minutesAgo: 14 });

await bronze('call_participated', {
  user_id: guestUserId,
  community_id: communityId,
  call_id: callId,
  duration_sec: 600,
}, { minutesAgo: 10 });

await runEtl();

const { rows: stitched } = await pool.query(
  `SELECT DISTINCT person_id FROM events_silver WHERE anonymous_id = $1`,
  [anonymousId],
);
check('после регистрации это один человек', stitched.map((r) => r.person_id), [`user:${guestUserId}`]);

// ===== карантин =====
const { rows: reasons } = await pool.query(
  `SELECT event_id, reason FROM events_silver_rejected WHERE event_id = ANY($1)`,
  [Object.values(rejectedIds)],
);
const byId = Object.fromEntries(reasons.map((r) => [r.event_id, r.reason]));
check('неизвестный тип события', byId[rejectedIds.unknown], 'unknown_event_type');
check('битый uuid', byId[rejectedIds.badUuid], 'bad_uuid');
check('событие без человека', byId[rejectedIds.noPerson], 'no_person');
check('отрицательная длительность', byId[rejectedIds.badDuration], 'bad_duration');
check('нечитаемое время', byId[rejectedIds.badTimestamp], 'bad_timestamp');
check('join_status вне перечисления', byId[rejectedIds.badEnum], 'bad_enum');
check('ссылка на несуществующее сообщество', byId[rejectedIds.unknownRef], 'unknown_reference');

const { rows: leaked } = await pool.query(
  `SELECT count(*)::int AS n FROM events_silver WHERE event_id = ANY($1)`,
  [Object.values(rejectedIds)],
);
check('мусор не попал в Silver', leaked[0].n, 0);

// ===== уход из сообщества =====
// Проверяем всю цепочку: событие → Silver → витрина жизненного цикла.
await pool.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [
  communityId,
  guestUserId,
]);
await bronze('community_left', {
  user_id: guestUserId,
  community_id: communityId,
  reason: 'left',
  removed_by: null,
}, { minutesAgo: 5 });
await runEtl();

const { rows: departed } = await pool.query(
  `SELECT left_at IS NOT NULL AS has_left, left_reason, early_leave
   FROM gold_member_lifecycle WHERE community_id = $1 AND user_id = $2`,
  [communityId, guestUserId],
);
check('ушедший остаётся в витрине', departed.length, 1);
check('уход записан с причиной', departed[0]?.left_reason, 'left');
check('уход в первые дни считается ранним', departed[0]?.early_leave, true);

// ===== событие про несуществующего пользователя не ломает прогон =====
// Bronze принимает что угодно, поэтому в логе может оказаться user_id,
// которого в базе нет. Раньше одно такое событие роняло ETL на внешнем
// ключе, и витрины замирали навсегда.
const ghostId = await bronze('registration_completed', {
  user_id: '11111111-1111-1111-1111-111111111111',
  anonymous_id: `ghost-${stamp}`,
});
let ghostRunFailed = false;
try {
  await runEtl();
} catch {
  ghostRunFailed = true;
}
check('событие про несуществующего пользователя не ломает ETL', ghostRunFailed, false);
const { rows: ghostRows } = await pool.query(
  'SELECT count(*)::int AS n FROM events_silver WHERE event_id = $1',
  [ghostId],
);
check('такое событие всё равно попадает в Silver', ghostRows[0].n, 1);

// ===== повторный прогон ничего не задваивает =====
const { rows: beforeRows } = await pool.query(
  'SELECT count(*)::int AS n FROM events_silver WHERE community_id = $1',
  [communityId],
);
await runEtl();
const { rows: afterRows } = await pool.query(
  'SELECT count(*)::int AS n FROM events_silver WHERE community_id = $1',
  [communityId],
);
check('повторный прогон не задваивает', afterRows[0].n, beforeRows[0].n);

// ===== витрины =====
const { rows: funnelRows } = await pool.query(
  'SELECT * FROM gold_invite_funnel WHERE community_id = $1',
  [communityId],
);
check('воронка по людям, а не по событиям', {
  opened: funnelRows[0].opened,
  joined_call: funnelRows[0].joined_call,
  joined_community: funnelRows[0].joined_community,
  registered: funnelRows[0].registered,
}, { opened: 1, joined_call: 1, joined_community: 1, registered: 1 });

const { rows: dailyRows } = await pool.query(
  `SELECT messages, call_participations, call_seconds, join_attempts, join_failures, active_people
   FROM gold_community_daily WHERE community_id = $1 AND day = now()::date`,
  [communityId],
);
check('активность за сегодня', dailyRows[0], {
  messages: 2,
  call_participations: 1,
  call_seconds: 600,
  join_attempts: 2,
  join_failures: 1,
  // владелец сегодня ничего не делал, «неудачный» гость активным не считается
  active_people: 1,
});

const { rows: statsRows } = await pool.query(
  'SELECT participations, avg_sec, median_sec, longest_sec FROM gold_call_stats WHERE community_id = $1',
  [communityId],
);
check('длительности звонков', statsRows[0], {
  participations: 1,
  avg_sec: 600,
  median_sec: 600,
  longest_sec: 600,
});

const { rows: lifecycleRows } = await pool.query(
  `SELECT count(*) FILTER (WHERE NOT is_owner)::int AS joined,
          count(*) FILTER (WHERE NOT is_owner AND activated_24h)::int AS activated,
          count(*) FILTER (WHERE is_owner)::int AS owners
   FROM gold_member_lifecycle WHERE community_id = $1`,
  [communityId],
);
check('активация считается без владельца', lifecycleRows[0], {
  joined: 1,
  activated: 1,
  owners: 1,
});

// ===== уборка =====
await pool.query('DELETE FROM events_silver WHERE event_id = ANY($1)', [eventIds]);
await pool.query('DELETE FROM events_silver_rejected WHERE event_id = ANY($1)', [eventIds]);
await pool.query('DELETE FROM events_bronze WHERE event_id = ANY($1)', [eventIds]);
await pool.query('DELETE FROM identity_map WHERE anonymous_id = $1', [anonymousId]);
await pool.query('DELETE FROM communities WHERE id = $1', [communityId]);
await pool.query('DELETE FROM users WHERE id = ANY($1)', [[ownerId, guestUserId]]);
await runEtl();

console.log(failures === 0 ? '\nВсе проверки пройдены' : `\nПровалено проверок: ${failures}`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
