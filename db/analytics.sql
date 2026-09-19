-- Готовые запросы к аналитическому логу (events_bronze).
-- Запускать так:  psql -U postgres -d community -f db\analytics.sql
-- Либо копировать отдельные запросы и выполнять по одному.
--
-- Важно: events_bronze — сырой слой (Bronze). Данные в нём не очищены:
-- возможны дубли и события разных сценариев вперемешку, поэтому цифры здесь
-- ориентировочные. Очищенные витрины (Silver/Gold) — следующий этап.

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
