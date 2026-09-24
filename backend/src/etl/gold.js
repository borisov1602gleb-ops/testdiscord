// Слой GOLD: витрины под конкретные вопросы экрана аналитики.
//
// Витрины пересобираются целиком на каждом прогоне. Для объёмов MVP это
// дешевле и надёжнее инкрементальной сборки: события могут приехать задним
// числом, а склейка гостя с пользователем меняет уже посчитанное — при
// полной пересборке расхождению просто неоткуда взяться.
//
// Всё, что считается «в человеках», считается по person_id из Silver,
// поэтому гость и он же после регистрации — один человек, а не два.

// Пороги вовлечённости из спецификации: за неделю ≥ 5 сообщений
// либо ≥ 5 минут в звонках.
export const WECU_MESSAGES = 5;
export const WECU_SECONDS = 300;

// Сколько дней считается «ранним» уходом из сообщества. Защитная метрика
// из задания: человек зашёл и почти сразу ушёл — значит сообщество ему
// ничего не дало.
export const EARLY_LEAVE_DAYS = 7;

export async function buildGold(client) {
  await client.query(`
    TRUNCATE gold_community_daily, gold_community_weekly, gold_invite_funnel,
             gold_member_lifecycle, gold_call_stats
  `);

  // ===== активность по дням =====
  await client.query(`
    INSERT INTO gold_community_daily (
      community_id, day, messages, call_participations, call_seconds,
      invite_opens, join_attempts, join_failures, new_members, active_people,
      text_people, voice_people
    )
    SELECT
      community_id,
      occurred_at::date,
      count(*) FILTER (WHERE event_type = 'message_sent'),
      count(*) FILTER (WHERE event_type = 'call_participated'),
      COALESCE(sum(duration_sec) FILTER (WHERE event_type = 'call_participated'), 0),
      count(*) FILTER (WHERE event_type = 'invite_link_opened'),
      count(*) FILTER (WHERE event_type = 'call_joined'),
      count(*) FILTER (WHERE event_type = 'call_joined' AND join_status = 'failed'),
      count(*) FILTER (WHERE event_type = 'community_joined'),
      -- Активный человек — тот, кто что-то сделал: написал, поучаствовал в
      -- звонке, вступил или хотя бы успешно подключился. Открытие ссылки и
      -- неудачная попытка подключения активностью не считаются, иначе в
      -- знаменатель вовлечённости попадают случайные заходы.
      count(DISTINCT person_id) FILTER (WHERE gold_is_active_action(event_type, join_status)),
      -- Два драйвера North Star считаются отдельно: человек может писать,
      -- но не звонить, и наоборот.
      count(DISTINCT person_id) FILTER (WHERE event_type = 'message_sent'),
      count(DISTINCT person_id) FILTER (WHERE event_type = 'call_participated')
    FROM events_silver
    WHERE community_id IS NOT NULL
    GROUP BY 1, 2
  `);

  // ===== вовлечённость по неделям (WECU) =====
  // Сначала считаем вклад каждого человека за неделю, потом сравниваем
  // с порогом: иначе «5 сообщений» получились бы суммой по всем.
  await client.query(
    `
    INSERT INTO gold_community_weekly (
      community_id, week_start, active_people, engaged_people, messages, call_seconds
    )
    WITH per_person AS (
      SELECT
        community_id,
        date_trunc('week', occurred_at)::date AS week_start,
        person_id,
        count(*) FILTER (WHERE event_type = 'message_sent') AS messages,
        COALESCE(sum(duration_sec) FILTER (WHERE event_type = 'call_participated'), 0) AS seconds,
        bool_or(gold_is_active_action(event_type, join_status)) AS active
      FROM events_silver
      WHERE community_id IS NOT NULL
      GROUP BY 1, 2, 3
    )
    SELECT
      community_id,
      week_start,
      count(*) FILTER (WHERE active),
      count(*) FILTER (WHERE messages >= $1 OR seconds >= $2),
      sum(messages),
      sum(seconds)
    FROM per_person
    GROUP BY 1, 2
    `,
    [WECU_MESSAGES, WECU_SECONDS],
  );

  // ===== воронка приглашения =====
  // Каждый следующий шаг считается только среди прошедших предыдущий и
  // только по времени вперёд: «зашёл в звонок» засчитывается, если это
  // случилось не раньше, чем он открыл ссылку.
  await client.query(`
    INSERT INTO gold_invite_funnel (
      community_id, opened, joined_call, registered, joined_community, joined_total
    )
    WITH per_person AS (
      SELECT
        community_id,
        person_id,
        min(occurred_at) FILTER (WHERE event_type = 'invite_link_opened') AS opened_at,
        min(occurred_at) FILTER (
          WHERE event_type = 'call_joined' AND join_status = 'success'
        ) AS call_at,
        min(occurred_at) FILTER (WHERE event_type = 'community_joined') AS joined_at
      FROM events_silver
      WHERE community_id IS NOT NULL
      GROUP BY 1, 2
    ),
    registrations AS (
      SELECT person_id, min(occurred_at) AS registered_at
      FROM events_silver
      WHERE event_type = 'registration_completed'
      GROUP BY 1
    ),
    steps AS (
      SELECT
        p.community_id,
        p.opened_at IS NOT NULL AS opened,
        p.opened_at IS NOT NULL AND p.call_at >= p.opened_at AS joined_call,
        p.opened_at IS NOT NULL AND p.call_at >= p.opened_at
          AND p.joined_at >= p.call_at AS joined_community,
        p.opened_at IS NOT NULL AND r.registered_at >= p.opened_at AS registered,
        p.joined_at IS NOT NULL AS joined_any
      FROM per_person p
      LEFT JOIN registrations r ON r.person_id = p.person_id
    )
    SELECT
      community_id,
      count(*) FILTER (WHERE opened),
      count(*) FILTER (WHERE joined_call),
      count(*) FILTER (WHERE registered),
      count(*) FILTER (WHERE joined_community),
      count(*) FILTER (WHERE joined_any)
    FROM steps
    GROUP BY 1
  `);

  // ===== жизненный цикл участника =====
  // Состав берём из community_members: это источник правды, в нём есть и
  // владелец, и те, кто вступил до появления логирования. Действия
  // подтягиваем из Silver.
  await client.query(
    `
    INSERT INTO gold_member_lifecycle (
      community_id, person_id, user_id, is_owner, joined_at,
      first_action_at, last_action_at, actions, activated_24h, returned_d7,
      left_at, left_reason, early_leave, returned_d30
    )
    -- Состав считается не только по нынешним участникам: ушедшие тоже
    -- должны попасть в витрину, иначе доля покинувших всегда будет нулевой.
    WITH people AS (
      SELECT community_id, user_id, role, joined_at
      FROM community_members
      UNION
      SELECT community_id, user_id, 'member', min(occurred_at)
      FROM events_silver
      WHERE event_type = 'community_joined'
        AND community_id IS NOT NULL
        AND user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM community_members m
          WHERE m.community_id = events_silver.community_id
            AND m.user_id = events_silver.user_id
        )
      GROUP BY community_id, user_id
    ),
    departures AS (
      -- Если человек уходил и возвращался несколько раз, берём последний уход.
      SELECT DISTINCT ON (community_id, user_id)
             community_id, user_id, occurred_at, reason
      FROM events_silver
      WHERE event_type = 'community_left'
        AND community_id IS NOT NULL
        AND user_id IS NOT NULL
      ORDER BY community_id, user_id, occurred_at DESC
    ),
    actions AS (
      SELECT community_id, person_id, occurred_at
      FROM events_silver
      WHERE event_type IN ('message_sent', 'call_participated')
        AND community_id IS NOT NULL
    )
    SELECT
      p.community_id,
      'user:' || p.user_id,
      p.user_id,
      p.role = 'owner',
      p.joined_at,
      min(a.occurred_at),
      max(a.occurred_at),
      count(a.*),
      -- bool_or по пустому набору даёт NULL, а в витрине нужен честный false:
      -- «не действовал» — это не «неизвестно».
      COALESCE(bool_or(a.occurred_at BETWEEN p.joined_at AND p.joined_at + interval '24 hours'), false),
      COALESCE(bool_or(a.occurred_at >= p.joined_at + interval '7 days'), false),
      d.occurred_at,
      d.reason,
      -- Ранний уход: покинул сообщество в первые дни после вступления.
      COALESCE(d.occurred_at < p.joined_at + ($1::int * interval '1 day'), false),
      COALESCE(bool_or(a.occurred_at >= p.joined_at + interval '30 days'), false)
    FROM people p
    LEFT JOIN actions a
      ON a.community_id = p.community_id
     AND a.person_id = 'user:' || p.user_id
    LEFT JOIN departures d
      ON d.community_id = p.community_id
     AND d.user_id = p.user_id
    GROUP BY p.community_id, p.user_id, p.role, p.joined_at, d.occurred_at, d.reason
  `,
    [EARLY_LEAVE_DAYS],
  );

  // ===== длительности звонков =====
  await client.query(`
    INSERT INTO gold_call_stats (
      community_id, participations, total_sec, avg_sec, median_sec, longest_sec,
      p75_sec, p90_sec
    )
    SELECT
      community_id,
      count(*),
      COALESCE(sum(duration_sec), 0),
      COALESCE(round(avg(duration_sec))::int, 0),
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_sec)::int, 0),
      COALESCE(max(duration_sec), 0),
      COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_sec)::int, 0),
      COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_sec)::int, 0)
    FROM events_silver
    WHERE event_type = 'call_participated'
      AND community_id IS NOT NULL
      AND duration_sec IS NOT NULL
    GROUP BY 1
  `);

  const { rows } = await client.query(`
    SELECT
      (SELECT count(*) FROM gold_community_daily)   AS daily,
      (SELECT count(*) FROM gold_community_weekly)  AS weekly,
      (SELECT count(*) FROM gold_invite_funnel)     AS funnels,
      (SELECT count(*) FROM gold_member_lifecycle)  AS members,
      (SELECT count(*) FROM gold_call_stats)        AS call_stats
  `);

  await client.query(`
    INSERT INTO etl_state (layer, last_received_at, last_run_at, rows_loaded, last_error)
    VALUES ('gold', (SELECT max(received_at) FROM events_silver), now(), 0, NULL)
    ON CONFLICT (layer) DO UPDATE
    SET last_received_at = EXCLUDED.last_received_at,
        last_run_at = EXCLUDED.last_run_at,
        last_error = NULL
  `);

  return {
    daily: Number(rows[0].daily),
    weekly: Number(rows[0].weekly),
    funnels: Number(rows[0].funnels),
    members: Number(rows[0].members),
    call_stats: Number(rows[0].call_stats),
  };
}
