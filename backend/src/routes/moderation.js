// Разбор жалоб: очередь для модераторов и решение по каждому сообщению —
// удалить или оставить. Жалобы группируются по сообщению: десять жалоб на
// один спам — это одна задача, а не десять.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { notifyPlatformStaff } from '../lib/platform-notify.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, getChannel } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { PUBLIC_NAME_SQL, publicNameSql } from '../lib/users.js';
import { notifyModerators, openReportCount } from '../lib/reports.js';
import { softDeleteMessage } from './messages.js';

export const moderationRouter = Router();

const REASON_LABELS = { spam: 'Спам', abuse: 'Оскорбления', other: 'Другое' };

moderationRouter.get(
  '/:id/reports',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requirePermission(req.user.id, communityId, 'handle_reports');
    const { rows } = await query(
      `SELECT r.message_id, r.reason, r.comment, r.created_at,
              ${publicNameSql('rep')} AS reporter_name,
              m.content, m.created_at AS message_created_at, m.channel_id, m.thread_id,
              m.user_id AS author_id, ${PUBLIC_NAME_SQL} AS author_name,
              ch.name AS channel_name
       FROM message_reports r
       JOIN messages m ON m.id = r.message_id
       JOIN channels ch ON ch.id = m.channel_id
       JOIN users u ON u.id = m.user_id
       JOIN users rep ON rep.id = r.reporter_id
       WHERE r.community_id = $1 AND r.status = 'open'
       ORDER BY r.created_at`,
      [communityId],
    );
    const byMessage = new Map();
    for (const row of rows) {
      let item = byMessage.get(row.message_id);
      if (!item) {
        item = {
          message: {
            id: row.message_id,
            channel_id: row.channel_id,
            channel_name: row.channel_name,
            thread_id: row.thread_id,
            user_id: row.author_id,
            author_name: row.author_name,
            content: row.content,
            created_at: row.message_created_at,
          },
          reports: [],
        };
        byMessage.set(row.message_id, item);
      }
      item.reports.push({
        reason: row.reason,
        reason_label: REASON_LABELS[row.reason],
        comment: row.comment,
        reporter_name: row.reporter_name,
        created_at: row.created_at,
      });
    }
    // Сверху — сообщения, на которые жаловались больше всего.
    const items = [...byMessage.values()].sort((a, b) => b.reports.length - a.reports.length);
    res.json({ items, open_count: items.length });
  }),
);

moderationRouter.get(
  '/:id/reports/count',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requirePermission(req.user.id, communityId, 'handle_reports');
    res.json({ open_count: await openReportCount(communityId) });
  }),
);

// Решение по сообщению: delete — удалить его (жалобы закроются вместе с
// ним), dismiss — оставить, жалобы отклонить.
moderationRouter.post(
  '/:id/reports/:messageId/resolve',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const messageId = parseUuid(req.params.messageId, 'message_id');
    await requirePermission(req.user.id, communityId, 'handle_reports');
    const action = String(req.body?.action ?? '');
    if (action !== 'delete' && action !== 'dismiss') throw new HttpError(400, 'invalid_action');

    const { rows } = await query(
      `SELECT m.id, m.channel_id, m.thread_id
       FROM messages m JOIN message_reports r ON r.message_id = m.id
       WHERE m.id = $1 AND r.community_id = $2 AND r.status = 'open'
       LIMIT 1`,
      [messageId, communityId],
    );
    if (rows.length === 0) throw new HttpError(404, 'report_not_found');

    if (action === 'delete') {
      const channel = await getChannel(rows[0].channel_id);
      await softDeleteMessage(messageId, channel, rows[0].thread_id, req.user.id);
    } else {
      await query(
        `UPDATE message_reports SET status = 'dismissed', resolved_at = now(), resolved_by = $2
         WHERE message_id = $1 AND status = 'open'`,
        [messageId, req.user.id],
      );
      await notifyModerators(communityId);
    }
    res.json({ resolved: true, action });
  }),
);

// Передать жалобы на сообщение в службу платформы: модераторы сообщества
// не справляются сами, нарушение серьёзное или оно касается владельца.
// Жалобы сообщества закрываются со статусом «передано», а у платформы
// появляется одна жалоба с их сутью.
moderationRouter.post(
  '/:id/reports/:messageId/escalate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const messageId = parseUuid(req.params.messageId, 'message_id');
    await requirePermission(req.user.id, communityId, 'handle_reports');
    const note = String(req.body?.comment ?? '').trim().slice(0, 500) || null;

    const { rows } = await query(
      `SELECT r.reason, r.comment, m.user_id AS author_id
       FROM message_reports r JOIN messages m ON m.id = r.message_id
       WHERE r.message_id = $1 AND r.community_id = $2 AND r.status = 'open'`,
      [messageId, communityId],
    );
    if (rows.length === 0) throw new HttpError(404, 'report_not_found');
    // Причина — самая частая среди жалоб; комментарии сводятся в один.
    const counts = new Map();
    for (const r of rows) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    const reason = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const comment = [note && `Модератор сообщества: ${note}`,
      ...rows.map((r) => r.comment).filter(Boolean).map((c) => `Жалоба: ${c}`)]
      .filter(Boolean).join('\n').slice(0, 2000) || null;

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO platform_reports
           (target_type, message_id, target_user_id, community_id, reporter_id, source, reason, comment)
         VALUES ('message', $1, $2, $3, $4, 'community', $5, $6)
         ON CONFLICT DO NOTHING`,
        [messageId, rows[0].author_id, communityId, req.user.id, reason, comment],
      );
      await client.query(
        `UPDATE message_reports SET status = 'escalated', resolved_at = now(), resolved_by = $2
         WHERE message_id = $1 AND status = 'open'`,
        [messageId, req.user.id],
      );
    });
    await notifyModerators(communityId);
    await notifyPlatformStaff();
    res.json({ escalated: true });
  }),
);
