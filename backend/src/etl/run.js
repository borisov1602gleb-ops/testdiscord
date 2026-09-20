// Ручной прогон ETL: npm run etl (из каталога backend).
// Полезен, когда backend не запущен или нужно пересчитать витрины прямо
// сейчас и увидеть результат в консоли.
import { pool, waitForDatabase } from '../db.js';
import { ensureAnalyticsSchema, runEtl } from './index.js';

await waitForDatabase();
await ensureAnalyticsSchema();

const result = await runEtl();
if (result.skipped) {
  console.log(`[etl] пропущен: ${result.reason}`);
} else {
  console.log(
    `[etl] Silver: прочитано ${result.silver.seen}, загружено ${result.silver.loaded}, ` +
      `отклонено ${result.silver.rejected}, склеено задним числом ${result.silver.restated}`,
  );
  console.log(
    `[etl] Gold: дней ${result.gold.daily}, недель ${result.gold.weekly}, ` +
      `воронок ${result.gold.funnels}, участников ${result.gold.members}, ` +
      `сводок по звонкам ${result.gold.call_stats} (${result.took_ms} мс)`,
  );
}

await pool.end();
