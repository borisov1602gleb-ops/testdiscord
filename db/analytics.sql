-- Готовые запросы к аналитическому логу (events_bronze).
-- Запускать так:  psql -U postgres -d community -f db\analytics.sql
-- Либо копировать отдельные запросы и выполнять по одному.
--
-- Важно: events_bronze — сырой слой. Данные в нём не очищены: возможны
-- дубли, битые поля и один и тот же человек под двумя идентификаторами,
-- поэтому запросы 1–7 ниже дают ориентировочные цифры.
-- Точные числа живут в витринах Gold (запросы 8–11 и экран аналитики):
-- они собираются ETL по очищенному слою Silver — см. db/analytics-layers.sql.

\echo '=== 1. Сколько событий каждого типа накопилось ==='
SELECT event_type AS событие,
       count(*) AS всего,
       min(received_at)::date AS первое,
       max(received_at)::date AS последнее
FROM events_bronze
GROUP BY event_type
ORDER BY всего DESC;

\echo ''
\echo '=== 2. Воронка приглашения (продуктовая гипотеза) ==='
-- Считаем по уникальным людям: у гостя есть только anonymous_id,
-- у зарегистрированного — user_id, поэтому берём то, что есть.
WITH people AS (
  SELECT event_type,
         coalesce(payload->>'user_id', payload->>'anonymous_id') AS person
  FROM events_bronze
)
SELECT
  count(DISTINCT person) FILTER (WHERE event_type = 'invite_link_opened')     AS открыли_приглашение,
  count(DISTINCT person) FILTER (WHERE event_type = 'call_joined')            AS зашли_в_звонок,
  count(DISTINCT person) FILTER (WHERE event_type = 'registration_completed') AS зарегистрировались,
  count(DISTINCT person) FILTER (WHERE event_type = 'community_joined')       AS вступили_в_сообщество
FROM people;

\echo ''
\echo '=== 3. Доля технических ошибок при подключении к звонку ==='
-- Защитная метрика: сколько попыток войти в звонок завершились неудачей.
SELECT payload->>'join_status' AS статус,
       count(*) AS попыток,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS доля_процентов
FROM events_bronze
WHERE event_type = 'call_joined'
GROUP BY 1
ORDER BY попыток DESC;

\echo ''
\echo '=== 4. Активность за последние 7 дней ==='
SELECT received_at::date AS день,
       count(*) FILTER (WHERE event_type = 'message_sent') AS сообщений,
       count(*) FILTER (WHERE event_type = 'call_participated') AS участий_в_звонках,
       count(DISTINCT payload->>'user_id') AS активных_пользователей
FROM events_bronze
WHERE received_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo ''
\echo '=== 5. WECU: вовлечённые пользователи за неделю ==='
-- Порог вовлечённости из спецификации: за неделю отправил >= 5 сообщений
-- ИЛИ провёл в звонках >= 300 секунд. Пороги подбираются на реальных данных.
WITH activity AS (
  SELECT payload->>'user_id' AS user_id,
         count(*) FILTER (WHERE event_type = 'message_sent') AS messages,
         coalesce(sum((payload->>'duration_sec')::int)
                  FILTER (WHERE event_type = 'call_participated'), 0) AS call_seconds
  FROM events_bronze
  WHERE received_at > now() - interval '7 days'
    AND payload->>'user_id' IS NOT NULL
  GROUP BY 1
)
SELECT count(*) FILTER (WHERE messages >= 5 OR call_seconds >= 300) AS вовлечённых,
       count(*) AS всего_активных
FROM activity;

\echo ''
\echo '=== 6. Сообщества по активности ==='
SELECT c.name AS сообщество,
       count(*) FILTER (WHERE e.event_type = 'message_sent') AS сообщений,
       count(*) FILTER (WHERE e.event_type = 'community_joined') AS вступлений,
       count(DISTINCT e.payload->>'user_id') AS участников_активных
FROM events_bronze e
JOIN communities c ON c.id::text = e.payload->>'community_id'
GROUP BY c.name
ORDER BY сообщений DESC;

\echo ''
\echo '=== 7. Длительность звонков ==='
SELECT count(*) AS участий,
       round(avg((payload->>'duration_sec')::int)) AS средняя_сек,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'duration_sec')::int) AS медиана_сек,
       max((payload->>'duration_sec')::int) AS максимум_сек
FROM events_bronze
WHERE event_type = 'call_participated';


\echo ''
\echo '=== 8. Состояние слоёв ==='
SELECT
  (SELECT count(*) FROM events_bronze)          AS bronze,
  (SELECT count(*) FROM events_silver)          AS silver,
  (SELECT count(*) FROM events_silver_rejected) AS в_карантине,
  (SELECT last_run_at FROM etl_state WHERE layer = 'gold') AS витрины_собраны;

\echo ''
\echo '=== 9. Почему события не прошли очистку ==='
-- Пусто — значит, лог пишется без мусора. Строки здесь означают, что
-- какое-то место в коде кладёт в payload не то, что ожидается.
SELECT reason AS причина, count(*) AS событий, max(received_at)::date AS последнее
FROM events_silver_rejected
GROUP BY reason
ORDER BY событий DESC;

\echo ''
\echo '=== 10. Воронка приглашения по витрине (по людям, с учётом склейки) ==='
SELECT c.name AS сообщество,
       f.opened AS открыли,
       f.joined_call AS зашли_в_звонок,
       f.joined_community AS вступили,
       f.registered AS из_них_зарегистрировались
FROM gold_invite_funnel f
JOIN communities c ON c.id = f.community_id
ORDER BY f.opened DESC;

\echo ''
\echo '=== 11. Вовлечённость по неделям (WECU) ==='
SELECT c.name AS сообщество,
       w.week_start AS неделя,
       w.engaged_people AS вовлечённых,
       w.active_people AS активных,
       w.messages AS сообщений,
       w.call_seconds AS секунд_в_звонках
FROM gold_community_weekly w
JOIN communities c ON c.id = w.community_id
ORDER BY w.week_start DESC, сообщество;
