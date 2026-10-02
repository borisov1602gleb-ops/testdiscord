// Окончательное стирание того, что платформа скрыла: через срок хранения
// (30 дней) текст удалённых сообщений стирается, а удалённые сообщества
// теряют содержимое. До этого всё можно вернуть по обжалованию.
//
// Строка сообщества остаётся (с пометкой purged_at и без названия): на неё
// ссылаются события аналитики, и витрины не должны сломаться.
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { audit } from './platform.js';

const SWEEP_EVERY_MS = 60 * 60 * 1000;

export async function purgeExpired() {
  const days = config.platform.retentionDays;
  const { rowCount: messages } = await query(
    `UPDATE messages SET content = '', attachment_id = NULL, platform_purged_at = now()
     WHERE platform_removed_at < now() - make_interval(days => $1) AND platform_purged_at IS NULL`,
    [days],
  );
  const { rows: communities } = await query(
    `SELECT id FROM communities
     WHERE platform_status = 'deleted' AND purged_at IS NULL
       AND platform_status_at < now() - make_interval(days => $1)`,
    [days],
  );
  for (const { id } of communities) {
    await withTransaction(async (client) => {
      // Каналы уносят с собой сообщения, реакции, вложения, доски.
      await client.query('DELETE FROM channels WHERE community_id = $1', [id]);
      await client.query('DELETE FROM community_tags WHERE community_id = $1', [id]);
      await client.query('DELETE FROM community_bans WHERE community_id = $1', [id]);
      await client.query('DELETE FROM community_members WHERE community_id = $1', [id]);
      await client.query(
        `UPDATE communities SET name = 'Удалённое сообщество', avatar_id = NULL, purged_at = now()
         WHERE id = $1`,
        [id],
      );
      await audit(null, 'community_purged', { targetType: 'community', targetId: id, details: { retention_days: days } }, client);
    });
  }
  if (messages > 0) await audit(null, 'messages_purged', { details: { count: messages, retention_days: days } });
  return { messages, communities: communities.length };
}

export function startPlatformSweeper() {
  const run = () => purgeExpired().catch((err) => console.error('[platform] purge failed:', err.message));
  run();
  setInterval(run, SWEEP_EVERY_MS).unref();
}
