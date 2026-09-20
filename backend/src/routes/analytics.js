// Метрики сообщества для владельца. Считаются прямо по Bronze-слою:
// отдельной витрины (Silver/Gold) пока нет, поэтому цифры ориентировочные —
// это честно написано и на экране.
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { parseUuid } from '../lib/validate.js';

export const analyticsRouter = Router();

// Пороги вовлечённости из спецификации: за неделю ≥ 5 сообщений
// либо ≥ 5 минут в звонках.
const WECU_MESSAGES = 5;
const WECU_SECONDS = 300;

analyticsRouter.get(
  '/:id/analytics',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');

    const { rows: memberRows } = await query(
      'SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2',
      [communityId, req.user.id],
    );
    if (memberRows.length === 0) throw new HttpError(403, 'not_a_community_member');
    if (memberRows[0].role !== 'owner') throw new HttpError(403, 'owner_only');

    const [funnel, errors, wecu, activation, retention, daily, durations, totals] =
      await Promise.all([
        query(
          `WITH ev AS (
             SELECT event_type, payload,
                    COALESCE(payload->>'user_id', payload->>'anonymous_id') AS person
             FROM events_bronze
             WHERE payload->>'community_id' = $1
           )
           SELECT
             count(DISTINCT person) FILTER (WHERE event_type = 'invite_link_opened') AS opened,
             count(DISTINCT person) FILTER (
               WHERE event_type = 'call_joined' AND payload->>'join_status' = 'success'
             ) AS joined_call,
             count(DISTINCT person) FILTER (WHERE event_type = 'community_joined') AS joined_community
           FROM ev`,
          [communityId],
        ),
        query(
          `SELECT count(*) FILTER (WHERE payload->>'join_status' = 'failed') AS failed,
                  count(*) AS total
           FROM events_bronze
           WHERE event_type = 'call_joined' AND payload->>'community_id' = $1`,
          [communityId],
        ),
        query(
          `WITH activity AS (
             SELECT payload->>'user_id' AS user_id,
                    count(*) FILTER (WHERE event_type = 'message_sent') AS messages,
                    COALESCE(sum((payload->>'duration_sec')::int)
                             FILTER (WHERE event_type = 'call_participated'), 0) AS seconds
             FROM events_bronze
             WHERE payload->>'community_id' = $1
               AND received_at > now() - interval '7 days'
               AND payload->>'user_id' IS NOT NULL
             GROUP BY 1
           )
           SELECT count(*) FILTER (WHERE messages >= $2 OR seconds >= $3) AS engaged,
                  count(*) AS active
           FROM activity`,
          [communityId, WECU_MESSAGES, WECU_SECONDS],
        ),
        query(
          `WITH joins AS (
             SELECT payload->>'user_id' AS user_id, min(received_at) AS joined_at
             FROM events_bronze
             WHERE event_type = 'community_joined' AND payload->>'community_id' = $1
             GROUP BY 1
           )
           SELECT count(*) AS joined,
                  count(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM events_bronze e
                    WHERE e.payload->>'community_id' = $1
                      AND e.payload->>'user_id' = j.user_id
                      AND e.event_type IN ('message_sent', 'call_participated')
                      AND e.received_at BETWEEN j.joined_at AND j.joined_at + interval '24 hours'
                  )) AS activated
           FROM joins j`,
          [communityId],
        ),
        query(
          `WITH joins AS (
             SELECT payload->>'user_id' AS user_id, min(received_at) AS joined_at
             FROM events_bronze
             WHERE event_type = 'community_joined' AND payload->>'community_id' = $1
             GROUP BY 1
           )
           SELECT count(*) AS eligible,
                  count(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM events_bronze e
                    WHERE e.payload->>'community_id' = $1
                      AND e.payload->>'user_id' = j.user_id
                      AND e.event_type IN ('message_sent', 'call_participated')
                      AND e.received_at >= j.joined_at + interval '7 days'
                  )) AS returned
           FROM joins j
           WHERE j.joined_at < now() - interval '7 days'`,
          [communityId],
        ),
        query(
          `SELECT day::date AS day,
                  count(*) FILTER (WHERE e.event_type = 'message_sent') AS messages,
                  count(*) FILTER (WHERE e.event_type = 'call_participated') AS calls,
                  count(DISTINCT e.payload->>'user_id') AS users
           FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') AS day
           LEFT JOIN events_bronze e
             ON e.received_at::date = day::date
            AND e.payload->>'community_id' = $1
           GROUP BY day
           ORDER BY day`,
          [communityId],
        ),
        query(
          `SELECT count(*) AS participations,
                  round(avg(seconds))::int AS average,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::int AS median,
                  max(seconds) AS longest
           FROM (
             SELECT (payload->>'duration_sec')::int AS seconds
             FROM events_bronze
             WHERE event_type = 'call_participated' AND payload->>'community_id' = $1
           ) t`,
          [communityId],
        ),
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
      ]);

    const toNumber = (value) => Number(value ?? 0);

    res.json({
      funnel: {
        opened: toNumber(funnel.rows[0].opened),
        joined_call: toNumber(funnel.rows[0].joined_call),
        joined_community: toNumber(funnel.rows[0].joined_community),
      },
      errors: {
        failed: toNumber(errors.rows[0].failed),
        total: toNumber(errors.rows[0].total),
      },
      wecu: {
        engaged: toNumber(wecu.rows[0].engaged),
        active: toNumber(wecu.rows[0].active),
        thresholds: { messages: WECU_MESSAGES, seconds: WECU_SECONDS },
      },
      activation: {
        activated: toNumber(activation.rows[0].activated),
        joined: toNumber(activation.rows[0].joined),
      },
      retention: {
        returned: toNumber(retention.rows[0].returned),
        eligible: toNumber(retention.rows[0].eligible),
      },
      daily: daily.rows.map((row) => ({
        day: row.day,
        messages: toNumber(row.messages),
        calls: toNumber(row.calls),
        users: toNumber(row.users),
      })),
      durations: {
        participations: toNumber(durations.rows[0].participations),
        average: toNumber(durations.rows[0].average),
        median: toNumber(durations.rows[0].median),
        longest: toNumber(durations.rows[0].longest),
      },
      totals: {
        members: toNumber(totals.rows[0].members),
        messages: toNumber(totals.rows[0].messages),
        calls: toNumber(totals.rows[0].calls),
      },
    });
  }),
);
