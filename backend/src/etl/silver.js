// Слой SILVER: превращает сырой Bronze-лог в очищенный.
//
// Что здесь происходит:
//  1. обновляется карта личностей (anonymous_id → user_id);
//  2. новые события Bronze разбираются по типизированным колонкам;
//  3. событие, не прошедшее проверку, не удаляется, а откладывается
//     в events_silver_rejected с причиной;
//  4. уже загруженным строкам, чей гость успел зарегистрироваться,
//     переписывается person_id — иначе один человек так и остался бы
//     двумя в любой витрине.
//
// Загрузка инкрементальная: берём из Bronze всё, чего ещё нет ни в Silver,
// ни в карантине. Отметка времени как граница была бы дешевле, но тогда
// событие, приехавшее задним числом (перенос данных, разъехавшиеся часы),
// молча потерялось бы. Сравнение по event_id идёт по первичным ключам и на
// объёмах MVP стоит копейки; на больших объёмах здесь появилась бы
// водяная отметка и секционирование Bronze по дате.

// Разрешённые типы событий — ровно шесть из спецификации. Всё остальное
// (опечатка, событие от чужого сервиса, эксперимент) уезжает в карантин.
const KNOWN_TYPES = [
  'invite_link_opened',
  'call_joined',
  'registration_completed',
  'community_joined',
  'message_sent',
  'call_participated',
];

// Правдоподобные границы: длительность звонка больше суток и время из
// далёкого будущего — это сломанные данные, а не рекорд.
const MAX_DURATION_SEC = 86400;
const MAX_CLOCK_SKEW_HOURS = 24;

export async function refreshIdentityMap(client) {
  // Два источника склейки: событие регистрации, где гость назвал свой
  // anonymous_id, и записи участия в звонке, привязанные к user_id при
  // регистрации (edge case 12.4). Если один и тот же anonymous_id успел
  // побывать у двух людей (общий компьютер), оставляем первую привязку.
  const { rowCount } = await client.query(`
    INSERT INTO identity_map (anonymous_id, user_id, source, linked_at)
    SELECT DISTINCT ON (anonymous_id) anonymous_id, user_id, source, linked_at
    FROM (
      SELECT NULLIF(payload->>'anonymous_id', '') AS anonymous_id,
             silver_uuid(payload->>'user_id') AS user_id,
             'registration_completed' AS source,
             received_at AS linked_at
      FROM events_bronze
      WHERE event_type = 'registration_completed'
      UNION ALL
      SELECT anonymous_id, user_id, 'call_participants', joined_at
      FROM call_participants
      WHERE anonymous_id IS NOT NULL AND user_id IS NOT NULL
    ) candidates
    WHERE anonymous_id IS NOT NULL
      -- Bronze принимает что угодно, поэтому user_id в событии может
      -- указывать в пустоту. Без этой проверки одно такое событие роняло бы
      -- весь прогон ETL на внешнем ключе — и витрины замирали бы навсегда.
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = candidates.user_id)
    ORDER BY anonymous_id, linked_at
    ON CONFLICT (anonymous_id) DO NOTHING
  `);
  return rowCount;
}

export async function loadSilver(client) {
  await refreshIdentityMap(client);

  const { rows: loadRows } = await client.query(
    `
    WITH src AS (
      SELECT
        b.event_id,
        b.event_type,
        b.payload,
        b.received_at,
        b.source,
        NULLIF(b.payload->>'anonymous_id', '') AS anonymous_id,
        NULLIF(b.payload->>'device_id', '')    AS device_id,
        NULLIF(b.payload->>'join_status', '')  AS join_status,
        NULLIF(b.payload->>'user_id', '')      AS raw_user_id,
        NULLIF(b.payload->>'community_id', '') AS raw_community_id,
        NULLIF(b.payload->>'channel_id', '')   AS raw_channel_id,
        NULLIF(b.payload->>'call_id', '')      AS raw_call_id,
        NULLIF(b.payload->>'invite_id', '')    AS raw_invite_id,
        NULLIF(b.payload->>'message_id', '')   AS raw_message_id,
        NULLIF(b.payload->>'duration_sec', '') AS raw_duration,
        NULLIF(b.payload->>'timestamp', '')    AS raw_timestamp,
        silver_uuid(b.payload->>'user_id')      AS user_id,
        silver_uuid(b.payload->>'community_id') AS community_id,
        silver_uuid(b.payload->>'channel_id')   AS channel_id,
        silver_uuid(b.payload->>'call_id')      AS call_id,
        silver_uuid(b.payload->>'invite_id')    AS invite_id,
        silver_uuid(b.payload->>'message_id')   AS message_id,
        silver_int(b.payload->>'duration_sec')  AS duration_sec,
        silver_ts(b.payload->>'timestamp')      AS occurred_at
      FROM events_bronze b
      WHERE NOT EXISTS (SELECT 1 FROM events_silver s WHERE s.event_id = b.event_id)
        AND NOT EXISTS (SELECT 1 FROM events_silver_rejected r WHERE r.event_id = b.event_id)
    ),
    checked AS (
      SELECT s.*,
        CASE
          WHEN s.event_type <> ALL ($1::text[]) THEN 'unknown_event_type'
          WHEN (s.raw_user_id      IS NOT NULL AND s.user_id      IS NULL)
            OR (s.raw_community_id IS NOT NULL AND s.community_id IS NULL)
            OR (s.raw_channel_id   IS NOT NULL AND s.channel_id   IS NULL)
            OR (s.raw_call_id      IS NOT NULL AND s.call_id      IS NULL)
            OR (s.raw_invite_id    IS NOT NULL AND s.invite_id    IS NULL)
            OR (s.raw_message_id   IS NOT NULL AND s.message_id   IS NULL)
            THEN 'bad_uuid'
          WHEN s.user_id IS NULL AND s.anonymous_id IS NULL THEN 'no_person'
          WHEN s.raw_duration IS NOT NULL
           AND (s.duration_sec IS NULL OR s.duration_sec < 0 OR s.duration_sec > $2::int)
            THEN 'bad_duration'
          WHEN s.raw_timestamp IS NOT NULL AND s.occurred_at IS NULL THEN 'bad_timestamp'
          WHEN s.occurred_at > s.received_at + ($3::int * interval '1 hour') THEN 'bad_timestamp'
          ELSE NULL
        END AS reject_reason
      FROM src s
    ),
    accepted AS (
      INSERT INTO events_silver (
        event_id, event_type, occurred_at, received_at, person_id, user_id,
        anonymous_id, device_id, community_id, channel_id, call_id, invite_id,
        message_id, join_status, duration_sec, source
      )
      SELECT
        c.event_id,
        c.event_type,
        COALESCE(c.occurred_at, c.received_at),
        c.received_at,
        CASE
          WHEN c.user_id IS NOT NULL THEN 'user:' || c.user_id
          WHEN m.user_id IS NOT NULL THEN 'user:' || m.user_id
          ELSE 'anon:' || c.anonymous_id
        END,
        COALESCE(c.user_id, m.user_id),
        c.anonymous_id,
        c.device_id,
        -- Сообщество восстанавливается по каналу или звонку: в событии
        -- неудачного подключения его может не быть вовсе.
        COALESCE(c.community_id, ch.community_id, ch_call.community_id),
        c.channel_id,
        c.call_id,
        c.invite_id,
        c.message_id,
        c.join_status,
        c.duration_sec,
        c.source
      FROM checked c
      LEFT JOIN identity_map m ON m.anonymous_id = c.anonymous_id
      LEFT JOIN channels ch    ON ch.id = c.channel_id
      LEFT JOIN calls cl       ON cl.id = c.call_id
      LEFT JOIN channels ch_call ON ch_call.id = cl.channel_id
      WHERE c.reject_reason IS NULL
      ON CONFLICT (event_id) DO NOTHING
      RETURNING 1
    ),
    rejected AS (
      INSERT INTO events_silver_rejected (event_id, event_type, payload, received_at, reason)
      SELECT c.event_id, c.event_type, c.payload, c.received_at, c.reject_reason
      FROM checked c
      WHERE c.reject_reason IS NOT NULL
      ON CONFLICT (event_id) DO NOTHING
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM accepted) AS loaded,
      (SELECT count(*) FROM rejected) AS rejected,
      (SELECT count(*) FROM checked)  AS seen
    `,
    [KNOWN_TYPES, MAX_DURATION_SEC, MAX_CLOCK_SKEW_HOURS],
  );

  // Ретроспективная склейка: гость мог зарегистрироваться после того, как
  // его прошлые события уже уехали в Silver под анонимным person_id.
  const { rowCount: restated } = await client.query(`
    UPDATE events_silver s
    SET person_id = 'user:' || m.user_id,
        user_id   = m.user_id
    FROM identity_map m
    WHERE s.anonymous_id = m.anonymous_id
      AND s.user_id IS NULL
  `);

  await client.query(
    `INSERT INTO etl_state (layer, last_received_at, last_run_at, rows_loaded, last_error)
     VALUES ('silver', (SELECT max(received_at) FROM events_silver), now(), $1, NULL)
     ON CONFLICT (layer) DO UPDATE
     SET last_received_at = EXCLUDED.last_received_at,
         last_run_at = EXCLUDED.last_run_at,
         rows_loaded = etl_state.rows_loaded + EXCLUDED.rows_loaded,
         last_error = NULL`,
    [Number(loadRows[0].loaded)],
  );

  return {
    seen: Number(loadRows[0].seen),
    loaded: Number(loadRows[0].loaded),
    rejected: Number(loadRows[0].rejected),
    restated,
  };
}
