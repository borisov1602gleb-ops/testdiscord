// Запуск ETL Bronze → Silver → Gold.
//
// Один прогон — одна транзакция: либо слой сдвинулся целиком, либо не
// сдвинулся вовсе, промежуточных состояний на экране не бывает. Прогоны
// не должны накладываться друг на друга (по расписанию и по кнопке
// «Обновить» одновременно), поэтому берётся блокировка уровня транзакции:
// если её уже держит другой прогон, мы просто пропускаем свой.
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { loadSilver } from './silver.js';
import { buildGold } from './gold.js';

// Произвольное, но постоянное число — адрес этой блокировки в PostgreSQL.
const LOCK_ID = 864213;

export async function runEtl() {
  const startedAt = Date.now();
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [
      LOCK_ID,
    ]);
    if (!rows[0].locked) return { skipped: true, reason: 'already_running' };

    try {
      const silver = await loadSilver(client);
      const gold = await buildGold(client);
      return { skipped: false, silver, gold, took_ms: Date.now() - startedAt };
    } catch (err) {
      // Причину сбоя видно в etl_state, а не только в логе процесса.
      // Пишем её отдельным подключением: текущая транзакция откатится.
      pool
        .query(
          `INSERT INTO etl_state (layer, last_run_at, last_error)
           VALUES ('silver', now(), $1)
           ON CONFLICT (layer) DO UPDATE SET last_run_at = now(), last_error = $1`,
          [err.message],
        )
        .catch(() => {});
      throw err;
    }
  });
}

export async function getEtlState() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT last_run_at FROM etl_state WHERE layer = 'gold') AS gold_at,
      (SELECT last_run_at FROM etl_state WHERE layer = 'silver') AS silver_at,
      (SELECT last_error FROM etl_state WHERE layer = 'silver') AS last_error,
      (SELECT count(*) FROM events_silver) AS silver_rows,
      (SELECT count(*) FROM events_silver_rejected) AS rejected_rows,
      (SELECT count(*) FROM events_bronze b
        WHERE NOT EXISTS (SELECT 1 FROM events_silver s WHERE s.event_id = b.event_id)
          AND NOT EXISTS (SELECT 1 FROM events_silver_rejected r WHERE r.event_id = b.event_id)
      ) AS pending_rows
  `);
  return {
    last_run_at: rows[0].gold_at ?? rows[0].silver_at,
    last_error: rows[0].last_error,
    silver_rows: Number(rows[0].silver_rows),
    rejected_rows: Number(rows[0].rejected_rows),
    pending_rows: Number(rows[0].pending_rows),
  };
}

// Расписание: держит витрины свежими без ручного запуска. Интервал
// настраивается, 0 полностью выключает автозапуск.
export function startEtlScheduler() {
  const seconds = config.etl.intervalSec;
  if (seconds <= 0) {
    console.log('[etl] scheduler disabled (ETL_INTERVAL_SEC=0)');
    return null;
  }

  const tick = async () => {
    try {
      const result = await runEtl();
      if (!result.skipped && (result.silver.loaded > 0 || result.silver.rejected > 0)) {
        console.log(
          `[etl] silver +${result.silver.loaded} (rejected ${result.silver.rejected}), gold rebuilt in ${result.took_ms} ms`,
        );
      }
    } catch (err) {
      console.error('[etl] run failed:', err.message);
    }
  };

  tick();
  const timer = setInterval(tick, seconds * 1000);
  timer.unref();
  return timer;
}
