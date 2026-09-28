// Автовыход из звонка. Вкладка звонка раз в несколько секунд шлёт «я ещё
// здесь»; кто перестал (закрыл вкладку, выключился компьютер, пропала
// связь), того сервер выводит из звонка сам. Время выхода — последний
// сигнал, а не момент проверки: длительность в аналитике не завышается.
//
// Перезагрузка страницы укладывается в запас времени: вкладка подключается
// заново к тому же участию, и звонок не рвётся.
import { query } from '../db.js';
import { config } from '../config.js';
import { closeParticipation } from '../routes/calls.js';

let timer = null;

export async function sweepStaleParticipants() {
  const { rows } = await query(
    `SELECT id FROM call_participants
     WHERE left_at IS NULL
       AND COALESCE(last_seen_at, joined_at) < now() - make_interval(secs => $1)`,
    [config.calls.staleSec],
  );
  for (const row of rows) {
    // Выражение — наша константа, не данные пользователя.
    await closeParticipation(row.id, 'COALESCE(last_seen_at, joined_at)');
  }
  return rows.length;
}

export function startCallSweeper() {
  if (!config.calls.sweepSec) return;
  timer = setInterval(() => {
    sweepStaleParticipants().catch((err) => console.error('[calls] sweep failed:', err.message));
  }, config.calls.sweepSec * 1000);
  timer.unref?.();
}
