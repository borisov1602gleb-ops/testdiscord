// Метрики сообщества для владельца.
//
// Источник цифр — слой Gold: витрины уже посчитаны ETL по очищенному
// Silver, поэтому здесь нет ни разбора payload, ни склейки гостя с
// пользователем — только чтение готовых чисел. Исключение — «Всего»
// (участники, сообщения, звонки): это состояние продукта, его правильнее
// брать из рабочих таблиц, а не из лога событий.
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { parseUuid } from '../lib/validate.js';
import { WECU_MESSAGES, WECU_SECONDS, EARLY_LEAVE_DAYS } from '../etl/gold.js';
import { getEtlState, runEtl } from '../etl/index.js';

export const analyticsRouter = Router();

// Сколько дней показывает график активности.
const DAYS = 14;

async function requireOwner(userId, communityId) {
  const { rows } = await query(
    'SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2',
    [communityId, userId],
  );
  if (rows.length === 0) throw new HttpError(403, 'not_a_community_member');
  if (rows[0].role !== 'owner') throw new HttpError(403, 'owner_only');
}

async function collect(communityId) {
  const [funnel, errors, wecu, lifecycle, daily, calls, totals, freshness] = await Promise.all([
    query('SELECT * FROM gold_invite_funnel WHERE community_id = $1', [communityId]),
    query(
      `SELECT COALESCE(sum(join_attempts), 0) AS total,
              COALESCE(sum(join_failures), 0) AS failed
       FROM gold_community_daily WHERE community_id = $1`,
      [communityId],
    ),
    query(
      `SELECT * FROM gold_community_weekly
       WHERE community_id = $1 AND week_start = date_trunc('week', now())::date`,
      [communityId],
    ),
    // Активация и возврат считаются без владельца: он сообщество создал,
    // а не вступил в него, и его действия исказили бы обе доли.
    query(
      `SELECT
         count(*) FILTER (WHERE NOT is_owner) AS joined,
         count(*) FILTER (WHERE NOT is_owner AND activated_24h) AS activated,
         count(*) FILTER (WHERE NOT is_owner AND joined_at < now() - interval '7 days')
           AS eligible,
         count(*) FILTER (WHERE NOT is_owner AND returned_d7) AS returned,
         count(*) FILTER (WHERE NOT is_owner AND joined_at < now() - interval '30 days')
           AS eligible_30,
         count(*) FILTER (WHERE NOT is_owner AND returned_d30) AS returned_30,
         count(*) FILTER (WHERE NOT is_owner AND left_at IS NOT NULL) AS left_total,
         count(*) FILTER (WHERE NOT is_owner AND early_leave) AS left_early,
         count(*) FILTER (WHERE NOT is_owner AND left_reason = 'removed') AS removed
       FROM gold_member_lifecycle WHERE community_id = $1`,
      [communityId],
    ),
    query(
      // Сетка дней строится generate_series, иначе дни без активности
      // просто исчезли бы с графика и он бы врал.
      `SELECT series::date AS day,
              COALESCE(g.messages, 0) AS messages,
              COALESCE(g.call_participations, 0) AS calls,
              COALESCE(g.call_seconds, 0) AS seconds,
              COALESCE(g.active_people, 0) AS people,
              COALESCE(g.text_people, 0) AS text_people,
              COALESCE(g.voice_people, 0) AS voice_people
       FROM generate_series(
              now()::date - ($2::int - 1) * interval '1 day', now()::date, interval '1 day'
            ) AS series
       LEFT JOIN gold_community_daily g
         ON g.day = series::date AND g.community_id = $1
       ORDER BY series`,
      [communityId, DAYS],
    ),
    query('SELECT * FROM gold_call_stats WHERE community_id = $1', [communityId]),
    query(
      `SELECT
         (SELECT count(*) FROM community_members WHERE community_id = $1) AS members,
         (SELECT count(*) FROM messages m
          JOIN channels ch ON ch.id = m.channel_id
          WHERE ch.community_id = $1) AS messages,
         (SELECT count(*) FROM calls c
          JOIN channels ch ON ch.id = c.channel_id
          WHERE ch.community_id = $1) AS calls`,
      [communityId],
    ),
    getEtlState(),
  ]);

  const toNumber = (value) => Number(value ?? 0);
  const funnelRow = funnel.rows[0] ?? {};
  const wecuRow = wecu.rows[0] ?? {};
  const callRow = calls.rows[0] ?? {};

  return {
    funnel: {
      opened: toNumber(funnelRow.opened),
      joined_call: toNumber(funnelRow.joined_call),
      joined_community: toNumber(funnelRow.joined_community),
      registered: toNumber(funnelRow.registered),
      joined_total: toNumber(funnelRow.joined_total),
    },
    errors: {
      failed: toNumber(errors.rows[0].failed),
      total: toNumber(errors.rows[0].total),
    },
    wecu: {
      engaged: toNumber(wecuRow.engaged_people),
      active: toNumber(wecuRow.active_people),
      week_start: wecuRow.week_start ?? null,
      thresholds: { messages: WECU_MESSAGES, seconds: WECU_SECONDS },
      messages: toNumber(wecuRow.messages),
      // Драйвер из задания: сколько сообщений приходится на активного
      // человека. Считаем здесь, а не в витрине: это простое деление
      // двух уже посчитанных чисел.
      messages_per_active:
        toNumber(wecuRow.active_people) > 0
          ? Math.round((toNumber(wecuRow.messages) / toNumber(wecuRow.active_people)) * 10) / 10
          : null,
    },
    activation: {
      activated: toNumber(lifecycle.rows[0].activated),
      joined: toNumber(lifecycle.rows[0].joined),
    },
    retention: {
      returned: toNumber(lifecycle.rows[0].returned),
      eligible: toNumber(lifecycle.rows[0].eligible),
      returned_30: toNumber(lifecycle.rows[0].returned_30),
      eligible_30: toNumber(lifecycle.rows[0].eligible_30),
    },
    // Защитная метрика из задания: сколько людей ушло и сколько из них —
    // в первые дни после вступления.
    departures: {
      total: toNumber(lifecycle.rows[0].left_total),
      early: toNumber(lifecycle.rows[0].left_early),
      removed: toNumber(lifecycle.rows[0].removed),
      joined: toNumber(lifecycle.rows[0].joined),
      early_days: EARLY_LEAVE_DAYS,
    },
    daily: daily.rows.map((row) => ({
      day: row.day,
      messages: toNumber(row.messages),
      calls: toNumber(row.calls),
      seconds: toNumber(row.seconds),
      people: toNumber(row.people),
      text_people: toNumber(row.text_people),
      voice_people: toNumber(row.voice_people),
    })),
    durations: {
      participations: toNumber(callRow.participations),
      average: toNumber(callRow.avg_sec),
      median: toNumber(callRow.median_sec),
      p75: toNumber(callRow.p75_sec),
      p90: toNumber(callRow.p90_sec),
      longest: toNumber(callRow.longest_sec),
    },
    totals: {
      members: toNumber(totals.rows[0].members),
      messages: toNumber(totals.rows[0].messages),
      calls: toNumber(totals.rows[0].calls),
    },
    // Витрины пересчитываются по расписанию, поэтому экран честно
    // показывает, на какой момент цифры и сколько событий ещё в очереди.
    freshness,
  };
}

analyticsRouter.get(
  '/:id/analytics',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireOwner(req.user.id, communityId);
    res.json(await collect(communityId));
  }),
);

// Пересчёт по кнопке: ждать расписания, чтобы увидеть только что
// отправленное сообщение в статистике, неудобно.
analyticsRouter.post(
  '/:id/analytics/refresh',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireOwner(req.user.id, communityId);
    await runEtl();
    res.json(await collect(communityId));
  }),
);
