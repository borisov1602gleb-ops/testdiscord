// Служба платформы: жалобы людей, меры команды платформы, обжалования,
// журнал действий, статистика и настройки.
//
// Принципы:
//  - каждое действие сотрудника пишется в журнал с причиной;
//  - действовать можно только в отношении тех, кто младше по роли;
//  - чужая переписка не открывается свободно: видно сообщение из жалобы
//    и пять сообщений до него, и сам просмотр тоже попадает в журнал;
//  - обжалование рассматривает не тот, кто наказал, и не младше его.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth, requireAuthAllowBlocked } from '../middleware/auth.js';
import { getChannel, requireChannelAccess } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { PUBLIC_NAME_SQL, publicNameSql } from '../lib/users.js';
import { config } from '../config.js';
import {
  PLATFORM_RANK, platformCan, platformPermissionsFor, requirePlatform, outranks, isStaff,
  invalidateStanding, audit, SETTINGS, getSettings,
} from '../lib/platform.js';
import { notifyPlatformStaff, notifyStanding, platformQueueCounts, countsFor } from '../lib/platform-notify.js';
import {
  emitToChannel, emitToCommunity, evictFromCommunity, disconnectUser,
} from '../lib/realtime.js';
import { loadMessage } from './messages.js';
import { announceMember } from './communities.js';

export const platformRouter = Router();

const REPORT_REASONS = ['spam', 'abuse', 'illegal', 'other'];
const COMMENT_MAX = 1000;
const REASON_MAX = 1000;
const APPEAL_MIN = 10;
const APPEAL_MAX = 2000;
const CONTEXT_BEFORE = 5;
const SANCTION_DAYS = [1, 7, 30];
// Какие меры можно обжаловать. Предупреждение ничего не ограничивает.
const APPEALABLE = new Set([
  'mute', 'suspend', 'ban', 'message_removed',
  'community_invites_hidden', 'community_frozen', 'community_deleted',
]);
// Подписи мер для текста решения по жалобе — его читают люди.
const KIND_LABELS = {
  warning: 'Предупреждение',
  mute: 'Заглушение',
  suspend: 'Временная блокировка',
  ban: 'Вечная блокировка',
};
const COMMUNITY_STATUS_LABELS = {
  active: 'обычный режим',
  invites_hidden: 'приглашения скрыты',
  frozen: 'заморожено',
  deleted: 'удалено',
};
const USER_SANCTIONS = {
  warning: 'warn_users',
  mute: 'mute_users',
  suspend: 'suspend_users',
  ban: 'ban_users',
};
const COMMUNITY_STATUSES = {
  active: 'manage_communities',
  invites_hidden: 'manage_communities',
  frozen: 'manage_communities',
  deleted: 'delete_communities',
};

function requireReason(raw, field = 'reason') {
  const text = String(raw ?? '').trim();
  if (!text) throw new HttpError(400, `${field}_required`);
  if (text.length > REASON_MAX) throw new HttpError(400, `${field}_too_long`, { max_length: REASON_MAX });
  return text;
}

async function getUserRow(userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.platform_role, u.created_at, ${PUBLIC_NAME_SQL} AS name
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (rows.length === 0) throw new HttpError(404, 'user_not_found');
  return rows[0];
}

// Действовать можно только над тем, кто младше по роли платформы.
function requireOutranks(actor, target) {
  if (target.id === actor.id) throw new HttpError(400, 'cannot_target_yourself');
  if (!outranks(actor.platformRole, target.platform_role)) {
    throw new HttpError(403, 'target_outranks_you');
  }
}

// Жалоба, к которой привязано действие: закрывается вместе с ним.
async function resolveReport(client, reportId, actor, decision) {
  if (!reportId) return;
  await client.query(
    `UPDATE platform_reports SET status = 'resolved', handled_by = $2, handled_at = now(), decision = $3
     WHERE id = $1 AND status IN ('open', 'escalated')`,
    [reportId, actor.id, decision],
  );
}

function optionalReportId(raw) {
  return raw ? parseUuid(raw, 'report_id') : null;
}

// ===== снятие меры =====
// Общая часть для «снять» и «обжалование удовлетворено»: вернуть
// сообщение, разморозить сообщество, снять блокировку.
async function revokeSanction(client, sanction, actor, reason) {
  if (sanction.revoked_at) throw new HttpError(409, 'already_revoked');
  if (sanction.final) throw new HttpError(409, 'final_decision');
  await client.query(
    `UPDATE platform_sanctions SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
     WHERE id = $1`,
    [sanction.id, actor.id, reason],
  );
  const effects = {};
  if (sanction.kind === 'message_removed' && sanction.message_id) {
    const { rows } = await client.query(
      `UPDATE messages SET deleted_at = NULL, platform_removed_at = NULL
       WHERE id = $1 AND platform_removed_at IS NOT NULL AND platform_purged_at IS NULL
       RETURNING id, channel_id`,
      [sanction.message_id],
    );
    if (rows.length === 0) throw new HttpError(409, 'message_already_purged');
    effects.restoredMessage = rows[0];
  }
  if (sanction.kind.startsWith('community_') && sanction.community_id) {
    const { rows } = await client.query(
      `UPDATE communities SET platform_status = 'active', platform_status_at = now()
       WHERE id = $1 AND platform_status = $2 AND purged_at IS NULL
       RETURNING id`,
      [sanction.community_id, sanction.kind.replace('community_', '')],
    );
    if (sanction.kind === 'community_deleted' && rows.length === 0) {
      throw new HttpError(409, 'community_already_purged');
    }
    effects.community = sanction.community_id;
  }
  return effects;
}

async function afterRevoke(sanction, effects) {
  invalidateStanding(sanction.user_id);
  notifyStanding(sanction.user_id);
  if (effects.restoredMessage) {
    const message = await loadMessage(effects.restoredMessage.id, null);
    const channel = await getChannel(effects.restoredMessage.channel_id);
    emitToChannel(channel, 'message_updated', { ...message, read_count: null });
  }
  if (effects.community) emitToCommunity(effects.community, 'channels_updated', { community_id: effects.community });
}

async function getSanction(id, client = null) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run('SELECT * FROM platform_sanctions WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, 'sanction_not_found');
  return rows[0];
}

// ======================================================================
// Для всех: своё положение, уведомления о мерах, обжалования, жалобы.
// ======================================================================

const SANCTION_VIEW = `
  SELECT s.id, s.kind, s.reason, s.starts_at, s.ends_at, s.final, s.seen_at,
         s.revoked_at, s.revoke_reason, s.created_at, s.message_id, s.community_id,
         c.name AS community_name,
         a.id AS appeal_id, a.status AS appeal_status, a.text AS appeal_text,
         a.response AS appeal_response, a.reviewed_at AS appeal_reviewed_at,
         a.response_seen_at AS appeal_response_seen_at
  FROM platform_sanctions s
  LEFT JOIN communities c ON c.id = s.community_id
  LEFT JOIN platform_appeals a ON a.sanction_id = s.id`;

function describeSanctionForUser(row) {
  const now = Date.now();
  const active = !row.revoked_at && (!row.ends_at || new Date(row.ends_at).getTime() > now);
  const withinWindow = Date.now() - new Date(row.created_at).getTime()
    < config.platform.appealWindowDays * 24 * 3600 * 1000;
  return {
    id: row.id,
    kind: row.kind,
    reason: row.reason,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    final: row.final,
    seen: row.seen_at !== null,
    active,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
    created_at: row.created_at,
    message_id: row.message_id,
    community: row.community_id ? { id: row.community_id, name: row.community_name } : null,
    appeal: row.appeal_id
      ? {
        id: row.appeal_id,
        status: row.appeal_status,
        text: row.appeal_text,
        response: row.appeal_response,
        reviewed_at: row.appeal_reviewed_at,
        response_seen: row.appeal_response_seen_at !== null,
      }
      : null,
    can_appeal: APPEALABLE.has(row.kind) && active && !row.final && !row.appeal_id && withinWindow,
  };
}

// Положение человека на платформе: роль, права, действующие меры и
// история. Доступно и заблокированному — это его экран блокировки.
platformRouter.get(
  '/me',
  requireAuthAllowBlocked,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `${SANCTION_VIEW} WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
      [req.user.id],
    );
    const sanctions = rows.map(describeSanctionForUser);
    const role = req.user.platformRole;
    res.json({
      role,
      permissions: platformPermissionsFor(role),
      block: req.user.block,
      mute: req.user.mute,
      sanctions,
      queue: isStaff(role) ? countsFor(role, await platformQueueCounts()) : null,
    });
  }),
);

// Человек увидел уведомление о мере или ответ на обжалование.
platformRouter.post(
  '/me/seen',
  requireAuthAllowBlocked,
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.sanction_ids)
      ? req.body.sanction_ids.slice(0, 100).map((id) => parseUuid(id, 'sanction_ids'))
      : [];
    if (ids.length) {
      await query(
        `UPDATE platform_sanctions SET seen_at = now()
         WHERE user_id = $1 AND id = ANY($2::uuid[]) AND seen_at IS NULL`,
        [req.user.id, ids],
      );
      await query(
        `UPDATE platform_appeals SET response_seen_at = now()
         WHERE user_id = $1 AND sanction_id = ANY($2::uuid[])
           AND status <> 'pending' AND response_seen_at IS NULL`,
        [req.user.id, ids],
      );
    }
    res.json({ ok: true });
  }),
);

// Подать обжалование. Заблокированный тоже может — для этого у него и
// остаётся вход.
platformRouter.post(
  '/appeals',
  requireAuthAllowBlocked,
  asyncHandler(async (req, res) => {
    const sanctionId = parseUuid(req.body?.sanction_id, 'sanction_id');
    const text = String(req.body?.text ?? '').trim();
    if (text.length < APPEAL_MIN) throw new HttpError(400, 'appeal_too_short', { min_length: APPEAL_MIN });
    if (text.length > APPEAL_MAX) throw new HttpError(400, 'appeal_too_long', { max_length: APPEAL_MAX });

    const { rows } = await query(`${SANCTION_VIEW} WHERE s.id = $1 AND s.user_id = $2`, [sanctionId, req.user.id]);
    if (rows.length === 0) throw new HttpError(404, 'sanction_not_found');
    const sanction = describeSanctionForUser(rows[0]);
    if (sanction.appeal) throw new HttpError(409, 'already_appealed');
    if (!APPEALABLE.has(sanction.kind)) throw new HttpError(400, 'not_appealable');
    if (sanction.final) throw new HttpError(409, 'final_decision');
    if (!sanction.active) throw new HttpError(409, 'sanction_not_active');
    if (!sanction.can_appeal) throw new HttpError(410, 'appeal_window_closed', { days: config.platform.appealWindowDays });

    const { rows: created } = await query(
      `INSERT INTO platform_appeals (sanction_id, user_id, text) VALUES ($1, $2, $3)
       ON CONFLICT (sanction_id) DO NOTHING RETURNING id, status, created_at`,
      [sanctionId, req.user.id, text],
    );
    if (created.length === 0) throw new HttpError(409, 'already_appealed');
    await notifyPlatformStaff();
    res.status(201).json({ appeal: created[0] });
  }),
);

// Пожаловаться в службу платформы: на сообщение (в том числе в личке),
// на человека или на сообщество целиком.
platformRouter.post(
  '/reports',
  requireAuth,
  asyncHandler(async (req, res) => {
    const targetType = String(req.body?.target_type ?? '');
    const reason = String(req.body?.reason ?? '');
    if (!['message', 'user', 'community'].includes(targetType)) throw new HttpError(400, 'invalid_target');
    if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, 'invalid_report_reason', { allowed: REPORT_REASONS });
    const comment = String(req.body?.comment ?? '').trim().slice(0, COMMENT_MAX) || null;
    const targetId = parseUuid(req.body?.target_id, 'target_id');
    const me = req.user.id;

    let row;
    if (targetType === 'message') {
      const { rows } = await query(
        'SELECT id, user_id, channel_id, deleted_at FROM messages WHERE id = $1', [targetId],
      );
      if (rows.length === 0) throw new HttpError(404, 'message_not_found');
      // Пожаловаться можно только на то, что сам видишь.
      const channel = await getChannel(rows[0].channel_id);
      await requireChannelAccess(me, channel);
      if (rows[0].user_id === me) throw new HttpError(400, 'cannot_report_own');
      if (rows[0].deleted_at) throw new HttpError(410, 'message_deleted');
      row = { message_id: targetId, target_user_id: rows[0].user_id, community_id: channel.community_id };
    } else if (targetType === 'user') {
      if (targetId === me) throw new HttpError(400, 'cannot_report_yourself');
      // Только на того, с кем пересекался: общее сообщество или переписка.
      const { rows } = await query(
        `SELECT 1 FROM community_members a
         JOIN community_members b ON b.community_id = a.community_id
         WHERE a.user_id = $1 AND b.user_id = $2
         UNION ALL
         SELECT 1 FROM direct_members a
         JOIN direct_members b ON b.channel_id = a.channel_id
         WHERE a.user_id = $1 AND b.user_id = $2
         LIMIT 1`,
        [me, targetId],
      );
      if (rows.length === 0) throw new HttpError(404, 'user_not_found');
      row = { message_id: null, target_user_id: targetId, community_id: null };
    } else {
      const { rows } = await query(
        `SELECT c.owner_id FROM communities c
         JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = $2
         WHERE c.id = $1 AND c.platform_status <> 'deleted'`,
        [targetId, me],
      );
      if (rows.length === 0) throw new HttpError(404, 'community_not_found');
      row = { message_id: null, target_user_id: rows[0].owner_id, community_id: targetId };
    }

    const { rowCount } = await query(
      `INSERT INTO platform_reports
         (target_type, message_id, target_user_id, community_id, reporter_id, reason, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [targetType, row.message_id, row.target_user_id, row.community_id, me, reason, comment],
    );
    if (rowCount > 0) await notifyPlatformStaff();
    res.status(rowCount > 0 ? 201 : 200).json({ reported: true });
  }),
);

// ======================================================================
// Команда платформы
// ======================================================================

platformRouter.use('/staff', requireAuth);

// ----- жалобы -----
const REPORT_LIST = `
  SELECT r.id, r.target_type, r.reason, r.comment, r.status, r.source, r.created_at,
         r.decision, r.handled_at, r.escalated_at,
         r.message_id, m.content AS message_content, m.created_at AS message_created_at,
         m.deleted_at AS message_deleted_at, m.platform_removed_at,
         ch.name AS channel_name, ch.type AS channel_type,
         r.target_user_id, ${publicNameSql('tu')} AS target_name, tu.platform_role AS target_role,
         r.community_id, c.name AS community_name, c.platform_status AS community_status,
         ${publicNameSql('ru')} AS reporter_name,
         ${publicNameSql('hu')} AS handler_name
  FROM platform_reports r
  LEFT JOIN messages m ON m.id = r.message_id
  LEFT JOIN channels ch ON ch.id = m.channel_id
  LEFT JOIN users tu ON tu.id = r.target_user_id
  LEFT JOIN communities c ON c.id = r.community_id
  LEFT JOIN users ru ON ru.id = r.reporter_id
  LEFT JOIN users hu ON hu.id = r.handled_by`;

function describeReport(row) {
  return {
    id: row.id,
    target_type: row.target_type,
    reason: row.reason,
    comment: row.comment,
    status: row.status,
    source: row.source,
    created_at: row.created_at,
    decision: row.decision,
    handled_at: row.handled_at,
    handler_name: row.handler_name,
    reporter_name: row.reporter_name,
    message: row.message_id
      ? {
        id: row.message_id,
        content: row.message_deleted_at ? '' : row.message_content,
        removed: row.message_deleted_at !== null,
        removed_by_platform: row.platform_removed_at !== null,
        created_at: row.message_created_at,
        channel_name: row.channel_type === 'direct' ? null : row.channel_name,
        is_direct: row.channel_type === 'direct',
      }
      : null,
    target_user: row.target_user_id
      ? { id: row.target_user_id, name: row.target_name, platform_role: row.target_role }
      : null,
    community: row.community_id
      ? { id: row.community_id, name: row.community_name, status: row.community_status }
      : null,
  };
}

platformRouter.get(
  '/staff/reports',
  requirePlatform('handle_reports'),
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? 'open');
    const where = {
      open: "r.status = 'open'",
      escalated: "r.status = 'escalated'",
      closed: "r.status IN ('resolved', 'dismissed')",
    }[status];
    if (!where) throw new HttpError(400, 'invalid_status');
    const order = status === 'closed' ? 'r.handled_at DESC' : 'r.created_at';
    const { rows } = await query(`${REPORT_LIST} WHERE ${where} ORDER BY ${order} LIMIT 100`);
    res.json({ reports: rows.map(describeReport) });
  }),
);

// Одна жалоба с контекстом: сообщение и пять до него в той же ленте, а
// также история мер того, на кого жалуются. Просмотр пишется в журнал.
platformRouter.get(
  '/staff/reports/:id',
  requirePlatform('handle_reports'),
  asyncHandler(async (req, res) => {
    const reportId = parseUuid(req.params.id, 'report_id');
    const { rows } = await query(`${REPORT_LIST} WHERE r.id = $1`, [reportId]);
    if (rows.length === 0) throw new HttpError(404, 'report_not_found');
    const report = describeReport(rows[0]);

    let context = [];
    if (report.message) {
      const { rows: ctx } = await query(
        `SELECT m.id, m.content, m.created_at, m.deleted_at, m.user_id, ${PUBLIC_NAME_SQL} AS author_name
         FROM messages target
         JOIN messages m ON m.channel_id = target.channel_id
           AND m.thread_id IS NOT DISTINCT FROM target.thread_id
           AND (m.created_at, m.id) <= (target.created_at, target.id)
         JOIN users u ON u.id = m.user_id
         WHERE target.id = $1
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ${CONTEXT_BEFORE + 1}`,
        [report.message.id],
      );
      context = ctx.reverse().map((m) => ({
        id: m.id,
        author_id: m.user_id,
        author_name: m.author_name,
        content: m.deleted_at ? '' : m.content,
        deleted: m.deleted_at !== null,
        created_at: m.created_at,
        reported: m.id === report.message.id,
      }));
      await audit(req.user, 'view_report_context', {
        targetType: 'report', targetId: reportId,
        details: { message_id: report.message.id, is_direct: report.message.is_direct, messages_shown: context.length },
      });
    }

    let history = [];
    if (report.target_user) {
      const { rows: hist } = await query(
        `SELECT id, kind, reason, created_at, ends_at, revoked_at FROM platform_sanctions
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [report.target_user.id],
      );
      history = hist;
    }
    res.json({
      report,
      context,
      target_history: history,
      can_act_on_target: report.target_user
        ? outranks(req.user.platformRole, report.target_user.platform_role) && report.target_user.id !== req.user.id
        : false,
    });
  }),
);

async function getOpenReport(reportId) {
  const { rows } = await query('SELECT * FROM platform_reports WHERE id = $1', [reportId]);
  if (rows.length === 0) throw new HttpError(404, 'report_not_found');
  if (!['open', 'escalated'].includes(rows[0].status)) throw new HttpError(409, 'report_closed');
  return rows[0];
}

// Нарушения нет. Переданную выше жалобу отклоняет уже администратор.
platformRouter.post(
  '/staff/reports/:id/dismiss',
  requirePlatform('handle_reports'),
  asyncHandler(async (req, res) => {
    const reportId = parseUuid(req.params.id, 'report_id');
    const reason = requireReason(req.body?.reason);
    const report = await getOpenReport(reportId);
    if (report.status === 'escalated' && !platformCan(req.user.platformRole, 'handle_escalated')) {
      throw new HttpError(403, 'escalated_needs_admin');
    }
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE platform_reports SET status = 'dismissed', handled_by = $2, handled_at = now(), decision = $3
         WHERE id = $1`,
        [reportId, req.user.id, reason],
      );
      await audit(req.user, 'report_dismissed', { targetType: 'report', targetId: reportId, reason }, client);
    });
    await notifyPlatformStaff();
    res.json({ status: 'dismissed' });
  }),
);

// Модератор не может решить сам (нужна блокировка, удаление без жалобы,
// мера против сообщества) — передаёт администраторам.
platformRouter.post(
  '/staff/reports/:id/escalate',
  requirePlatform('handle_reports'),
  asyncHandler(async (req, res) => {
    const reportId = parseUuid(req.params.id, 'report_id');
    const reason = requireReason(req.body?.reason);
    const report = await getOpenReport(reportId);
    if (report.status === 'escalated') throw new HttpError(409, 'already_escalated');
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE platform_reports SET status = 'escalated', escalated_by = $2, escalated_at = now(),
                comment = concat_ws(E'\\n', comment, $3::text)
         WHERE id = $1`,
        [reportId, req.user.id, `Передано выше: ${reason}`],
      );
      await audit(req.user, 'report_escalated', { targetType: 'report', targetId: reportId, reason }, client);
    });
    await notifyPlatformStaff();
    res.json({ status: 'escalated' });
  }),
);

// Закрыть жалобу как решённую, если меры уже приняты отдельно.
platformRouter.post(
  '/staff/reports/:id/resolve',
  requirePlatform('handle_reports'),
  asyncHandler(async (req, res) => {
    const reportId = parseUuid(req.params.id, 'report_id');
    const reason = requireReason(req.body?.reason);
    const report = await getOpenReport(reportId);
    if (report.status === 'escalated' && !platformCan(req.user.platformRole, 'handle_escalated')) {
      throw new HttpError(403, 'escalated_needs_admin');
    }
    await withTransaction(async (client) => {
      await resolveReport(client, reportId, req.user, reason);
      await audit(req.user, 'report_resolved', { targetType: 'report', targetId: reportId, reason }, client);
    });
    await notifyPlatformStaff();
    res.json({ status: 'resolved' });
  }),
);

// ----- сообщения -----
// Модератор удаляет только то, на что пожаловались; администратор — любое
// сообщение по ссылке. «По требованию госоргана» (final) — только
// администратор: такое удаление не обжалуется и не возвращается.
platformRouter.post(
  '/staff/messages/:id/remove',
  requirePlatform('remove_reported_message'),
  asyncHandler(async (req, res) => {
    const messageId = parseUuid(req.params.id, 'message_id');
    const reason = requireReason(req.body?.reason);
    const reportId = optionalReportId(req.body?.report_id);
    const final = req.body?.final === true;
    const role = req.user.platformRole;

    const { rows } = await query(
      `SELECT m.id, m.user_id, m.channel_id, m.thread_id, m.deleted_at, ch.community_id, u.platform_role
       FROM messages m JOIN channels ch ON ch.id = m.channel_id JOIN users u ON u.id = m.user_id
       WHERE m.id = $1`,
      [messageId],
    );
    if (rows.length === 0) throw new HttpError(404, 'message_not_found');
    const message = rows[0];
    if (message.deleted_at) throw new HttpError(409, 'message_already_deleted');
    requireOutranks(req.user, { id: message.user_id, platform_role: message.platform_role });

    if (!platformCan(role, 'remove_any_message')) {
      const { rows: reported } = await query(
        `SELECT 1 FROM platform_reports
         WHERE message_id = $1 AND status IN ('open', 'escalated') LIMIT 1`,
        [messageId],
      );
      if (reported.length === 0) throw new HttpError(403, 'not_allowed', { permission: 'remove_any_message' });
    }
    if (final && !platformCan(role, 'remove_any_message')) {
      throw new HttpError(403, 'not_allowed', { permission: 'remove_any_message' });
    }

    const sanction = await withTransaction(async (client) => {
      await client.query(
        `UPDATE messages SET deleted_at = now(), platform_removed_at = now(), pinned_at = NULL, pinned_by = NULL
         WHERE id = $1`,
        [messageId],
      );
      const { rows: [created] } = await client.query(
        `INSERT INTO platform_sanctions
           (user_id, kind, message_id, community_id, report_id, reason, issued_by, issued_by_role, final)
         VALUES ($1, 'message_removed', $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [message.user_id, messageId, message.community_id, reportId, reason, req.user.id, role, final],
      );
      // Все жалобы на это сообщение — и платформы, и сообщества — решены.
      await client.query(
        `UPDATE platform_reports SET status = 'resolved', handled_by = $2, handled_at = now(),
                decision = $3
         WHERE message_id = $1 AND status IN ('open', 'escalated')`,
        [messageId, req.user.id, `Сообщение удалено: ${reason}`],
      );
      await client.query(
        `UPDATE message_reports SET status = 'resolved', resolved_at = now(), resolved_by = $2
         WHERE message_id = $1 AND status = 'open'`,
        [messageId, req.user.id],
      );
      await audit(req.user, 'message_removed', {
        targetType: 'message', targetId: messageId, reason,
        details: { author_id: message.user_id, sanction_id: created.id, final, report_id: reportId },
      }, client);
      return created;
    });

    const channel = await getChannel(message.channel_id);
    emitToChannel(channel, 'message_deleted', {
      id: messageId, channel_id: channel.id, thread_id: message.thread_id ?? null, removed_by_platform: true,
    });
    notifyStanding(message.user_id);
    await notifyPlatformStaff();
    res.json({ removed: true, sanction_id: sanction.id });
  }),
);

// ----- меры против людей -----
platformRouter.post(
  '/staff/users/:id/sanctions',
  requirePlatform('warn_users'),
  asyncHandler(async (req, res) => {
    const userId = parseUuid(req.params.id, 'user_id');
    const kind = String(req.body?.kind ?? '');
    const permission = USER_SANCTIONS[kind];
    if (!permission) throw new HttpError(400, 'invalid_sanction_kind', { allowed: Object.keys(USER_SANCTIONS) });
    if (!platformCan(req.user.platformRole, permission)) throw new HttpError(403, 'not_allowed', { permission });
    const reason = requireReason(req.body?.reason);
    const reportId = optionalReportId(req.body?.report_id);
    let days = null;
    if (kind === 'mute' || kind === 'suspend') {
      days = Number(req.body?.days);
      if (!SANCTION_DAYS.includes(days)) throw new HttpError(400, 'invalid_days', { allowed: SANCTION_DAYS });
    }

    const target = await getUserRow(userId);
    requireOutranks(req.user, target);

    const sanction = await withTransaction(async (client) => {
      const { rows: [created] } = await client.query(
        `INSERT INTO platform_sanctions (user_id, kind, report_id, reason, issued_by, issued_by_role, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END)
         RETURNING *`,
        [userId, kind, reportId, reason, req.user.id, req.user.platformRole, days],
      );
      await resolveReport(client, reportId, req.user, `${KIND_LABELS[kind]}: ${reason}`);
      await audit(req.user, `user_${kind}`, {
        targetType: 'user', targetId: userId, reason,
        details: { sanction_id: created.id, days, report_id: reportId },
      }, client);
      return created;
    });

    invalidateStanding(userId);
    notifyStanding(userId);
    // Заблокированного выводим из всех открытых вкладок сразу.
    if (kind === 'suspend' || kind === 'ban') disconnectUser(userId);
    await notifyPlatformStaff();
    res.status(201).json({ sanction });
  }),
);

// Снять меру досрочно: свою — модератор, чужую — администратор.
platformRouter.post(
  '/staff/sanctions/:id/revoke',
  requirePlatform('warn_users'),
  asyncHandler(async (req, res) => {
    const sanctionId = parseUuid(req.params.id, 'sanction_id');
    const reason = requireReason(req.body?.reason);
    const sanction = await getSanction(sanctionId);
    if (sanction.issued_by !== req.user.id && !platformCan(req.user.platformRole, 'revoke_any_sanction')) {
      throw new HttpError(403, 'not_allowed', { permission: 'revoke_any_sanction' });
    }
    if (sanction.kind === 'community_deleted' && !platformCan(req.user.platformRole, 'delete_communities')) {
      throw new HttpError(403, 'not_allowed', { permission: 'delete_communities' });
    }
    const target = await getUserRow(sanction.user_id);
    if (target.id !== req.user.id && !outranks(req.user.platformRole, target.platform_role)) {
      throw new HttpError(403, 'target_outranks_you');
    }
    const effects = await withTransaction(async (client) => {
      const result = await revokeSanction(client, sanction, req.user, reason);
      // Обжалование по снятой мере больше не нужно рассматривать.
      await client.query(
        `UPDATE platform_appeals SET status = 'accepted', reviewer_id = $2, reviewed_at = now(),
                response = $3
         WHERE sanction_id = $1 AND status = 'pending'`,
        [sanctionId, req.user.id, `Мера снята: ${reason}`],
      );
      await audit(req.user, 'sanction_revoked', {
        targetType: 'sanction', targetId: sanctionId, reason,
        details: { kind: sanction.kind, user_id: sanction.user_id },
      }, client);
      return result;
    });
    await afterRevoke(sanction, effects);
    await notifyPlatformStaff();
    res.json({ revoked: true });
  }),
);

// ----- люди -----
const STAFF_USER = `
  SELECT u.id, u.email, u.platform_role, u.created_at, ${PUBLIC_NAME_SQL} AS name,
         (SELECT kind FROM platform_sanctions s
          WHERE s.user_id = u.id AND s.kind IN ('suspend', 'ban', 'mute') AND s.revoked_at IS NULL
            AND (s.ends_at IS NULL OR s.ends_at > now())
          ORDER BY CASE s.kind WHEN 'ban' THEN 0 WHEN 'suspend' THEN 1 ELSE 2 END LIMIT 1) AS active_measure
  FROM users u`;

platformRouter.get(
  '/staff/users',
  requirePlatform('view_users'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const params = [];
    let where = 'TRUE';
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where = '(u.email ILIKE $1 OR u.display_name ILIKE $1)';
    }
    const { rows } = await query(`${STAFF_USER} WHERE ${where} ORDER BY u.created_at DESC LIMIT 50`, params);
    res.json({ users: rows });
  }),
);

platformRouter.get(
  '/staff/users/:id',
  requirePlatform('view_users'),
  asyncHandler(async (req, res) => {
    const userId = parseUuid(req.params.id, 'user_id');
    const { rows } = await query(`${STAFF_USER} WHERE u.id = $1`, [userId]);
    if (rows.length === 0) throw new HttpError(404, 'user_not_found');
    const [communities, sanctions, reports] = await Promise.all([
      query(
        `SELECT c.id, c.name, c.platform_status, cm.role, cm.joined_at
         FROM community_members cm JOIN communities c ON c.id = cm.community_id
         WHERE cm.user_id = $1 ORDER BY cm.joined_at`,
        [userId],
      ),
      query(
        `SELECT s.*, ${publicNameSql('iu')} AS issued_by_name, a.status AS appeal_status
         FROM platform_sanctions s
         LEFT JOIN users iu ON iu.id = s.issued_by
         LEFT JOIN platform_appeals a ON a.sanction_id = s.id
         WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
        [userId],
      ),
      query(
        `SELECT count(*) FILTER (WHERE status IN ('open', 'escalated'))::int AS open,
                count(*)::int AS total
         FROM platform_reports WHERE target_user_id = $1`,
        [userId],
      ),
    ]);
    await audit(req.user, 'view_user', { targetType: 'user', targetId: userId });
    res.json({
      user: rows[0],
      communities: communities.rows,
      sanctions: sanctions.rows,
      reports: reports.rows[0],
      can_act: outranks(req.user.platformRole, rows[0].platform_role) && userId !== req.user.id,
    });
  }),
);

// Назначить роль платформы. Модераторов назначает администратор,
// администраторов — суперадминистратор. Суперадминистратор задаётся только
// настройками сервера.
platformRouter.patch(
  '/staff/users/:id/role',
  requirePlatform('manage_moderators'),
  asyncHandler(async (req, res) => {
    const userId = parseUuid(req.params.id, 'user_id');
    const role = String(req.body?.role ?? '');
    if (!['user', 'moderator', 'admin'].includes(role)) throw new HttpError(400, 'invalid_role');
    const reason = requireReason(req.body?.reason);
    const target = await getUserRow(userId);
    if (target.id === req.user.id) throw new HttpError(400, 'cannot_change_own_role');
    if (target.platform_role === 'superadmin') throw new HttpError(403, 'superadmin_by_config_only');
    const touchesAdmin = role === 'admin' || target.platform_role === 'admin';
    if (touchesAdmin && !platformCan(req.user.platformRole, 'manage_admins')) {
      throw new HttpError(403, 'not_allowed', { permission: 'manage_admins' });
    }
    if (target.platform_role === role) return res.json({ role });

    await withTransaction(async (client) => {
      await client.query('UPDATE users SET platform_role = $2 WHERE id = $1', [userId, role]);
      await audit(req.user, 'role_changed', {
        targetType: 'user', targetId: userId, reason, details: { from: target.platform_role, to: role },
      }, client);
    });
    invalidateStanding(userId);
    notifyStanding(userId);
    res.json({ role });
  }),
);

platformRouter.get(
  '/staff/team',
  requirePlatform('manage_moderators'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `${STAFF_USER} WHERE u.platform_role <> 'user'
       ORDER BY CASE u.platform_role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.created_at`,
    );
    res.json({ team: rows });
  }),
);

// Выгрузка данных о человеке по официальному запросу: основание
// обязательно, сама выгрузка — в журнале.
platformRouter.post(
  '/staff/users/:id/export',
  requirePlatform('export_user_data'),
  asyncHandler(async (req, res) => {
    const userId = parseUuid(req.params.id, 'user_id');
    const authority = requireReason(req.body?.authority, 'authority');
    const requestNumber = requireReason(req.body?.request_number, 'request_number');
    const reason = requireReason(req.body?.reason);
    await getUserRow(userId);
    const [profile, communities, messages, sanctions, appeals] = await Promise.all([
      query('SELECT id, email, display_name, hide_email, registration_source, created_at, platform_role FROM users WHERE id = $1', [userId]),
      query(
        `SELECT c.id, c.name, cm.role, cm.joined_at FROM community_members cm
         JOIN communities c ON c.id = cm.community_id WHERE cm.user_id = $1`,
        [userId],
      ),
      query(
        `SELECT m.id, m.channel_id, ch.community_id, ch.type AS channel_type, m.content,
                m.created_at, m.edited_at, m.deleted_at, m.platform_removed_at
         FROM messages m JOIN channels ch ON ch.id = m.channel_id
         WHERE m.user_id = $1 ORDER BY m.created_at LIMIT 10000`,
        [userId],
      ),
      query('SELECT * FROM platform_sanctions WHERE user_id = $1 ORDER BY created_at', [userId]),
      query('SELECT * FROM platform_appeals WHERE user_id = $1 ORDER BY created_at', [userId]),
    ]);
    await audit(req.user, 'user_data_exported', {
      targetType: 'user', targetId: userId, reason,
      details: { authority, request_number: requestNumber, messages: messages.rows.length },
    });
    res.json({
      exported_at: new Date().toISOString(),
      basis: { authority, request_number: requestNumber, reason },
      profile: profile.rows[0],
      communities: communities.rows,
      messages: messages.rows,
      sanctions: sanctions.rows,
      appeals: appeals.rows,
    });
  }),
);

// ----- сообщества -----
const STAFF_COMMUNITY = `
  SELECT c.id, c.name, c.platform_status, c.platform_status_at, c.created_at, c.purged_at,
         c.owner_id, ${PUBLIC_NAME_SQL} AS owner_name, u.email AS owner_email, u.platform_role AS owner_role,
         (SELECT count(*)::int FROM community_members cm WHERE cm.community_id = c.id) AS members
  FROM communities c JOIN users u ON u.id = c.owner_id`;

platformRouter.get(
  '/staff/communities',
  requirePlatform('manage_communities'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const params = [];
    let where = 'TRUE';
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where = '(c.name ILIKE $1 OR u.email ILIKE $1)';
    }
    const { rows } = await query(`${STAFF_COMMUNITY} WHERE ${where} ORDER BY c.created_at DESC LIMIT 50`, params);
    res.json({ communities: rows });
  }),
);

platformRouter.get(
  '/staff/communities/:id',
  requirePlatform('manage_communities'),
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const { rows } = await query(`${STAFF_COMMUNITY} WHERE c.id = $1`, [communityId]);
    if (rows.length === 0) throw new HttpError(404, 'community_not_found');
    const [members, sanctions, reports] = await Promise.all([
      query(
        `SELECT u.id, ${PUBLIC_NAME_SQL} AS name, u.email, cm.role, u.platform_role
         FROM community_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.community_id = $1
         ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, cm.joined_at
         LIMIT 200`,
        [communityId],
      ),
      query(
        `SELECT s.id, s.kind, s.reason, s.created_at, s.revoked_at, ${publicNameSql('iu')} AS issued_by_name
         FROM platform_sanctions s LEFT JOIN users iu ON iu.id = s.issued_by
         WHERE s.community_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
        [communityId],
      ),
      query(
        `SELECT count(*) FILTER (WHERE status IN ('open', 'escalated'))::int AS open
         FROM platform_reports WHERE community_id = $1`,
        [communityId],
      ),
    ]);
    res.json({
      community: rows[0],
      members: members.rows,
      sanctions: sanctions.rows,
      open_reports: reports.rows[0].open,
    });
  }),
);

// Состояние сообщества: обычное, скрыть приглашения, заморозить, удалить.
// Новое решение заменяет прежнее; мера записывается на владельца — он
// может её обжаловать.
platformRouter.post(
  '/staff/communities/:id/status',
  requirePlatform('manage_communities'),
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const status = String(req.body?.status ?? '');
    const permission = COMMUNITY_STATUSES[status];
    if (!permission) throw new HttpError(400, 'invalid_status', { allowed: Object.keys(COMMUNITY_STATUSES) });
    if (!platformCan(req.user.platformRole, permission)) throw new HttpError(403, 'not_allowed', { permission });
    const reason = requireReason(req.body?.reason);
    const reportId = optionalReportId(req.body?.report_id);

    const { rows } = await query(`${STAFF_COMMUNITY} WHERE c.id = $1`, [communityId]);
    if (rows.length === 0) throw new HttpError(404, 'community_not_found');
    const community = rows[0];
    if (community.purged_at) throw new HttpError(409, 'community_already_purged');
    if (community.platform_status === status) return res.json({ status });
    // Восстановить удалённое может только тот, кто может удалять.
    if (community.platform_status === 'deleted' && !platformCan(req.user.platformRole, 'delete_communities')) {
      throw new HttpError(403, 'not_allowed', { permission: 'delete_communities' });
    }
    requireOutranks(req.user, { id: community.owner_id, platform_role: community.owner_role });

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE platform_sanctions SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
         WHERE community_id = $1 AND kind LIKE 'community_%' AND revoked_at IS NULL`,
        [communityId, req.user.id, `Заменено решением: ${COMMUNITY_STATUS_LABELS[status]}`],
      );
      await client.query(
        `UPDATE platform_appeals SET status = 'accepted', reviewer_id = $2, reviewed_at = now(), response = $3
         WHERE status = 'pending' AND sanction_id IN (
           SELECT id FROM platform_sanctions WHERE community_id = $1 AND kind LIKE 'community_%')`,
        [communityId, req.user.id, `Решение пересмотрено: ${reason}`],
      );
      if (status !== 'active') {
        await client.query(
          `INSERT INTO platform_sanctions (user_id, kind, community_id, report_id, reason, issued_by, issued_by_role)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [community.owner_id, `community_${status}`, communityId, reportId, reason, req.user.id, req.user.platformRole],
        );
      }
      await client.query(
        'UPDATE communities SET platform_status = $2, platform_status_at = now() WHERE id = $1',
        [communityId, status],
      );
      await resolveReport(client, reportId, req.user, `Сообщество — ${COMMUNITY_STATUS_LABELS[status]}: ${reason}`);
      await audit(req.user, `community_${status}`, {
        targetType: 'community', targetId: communityId, reason,
        details: { from: community.platform_status, owner_id: community.owner_id },
      }, client);
    });

    if (status === 'deleted') {
      // Удалённое сообщество пропадает у всех участников сразу.
      const { rows: members } = await query(
        'SELECT user_id FROM community_members WHERE community_id = $1', [communityId],
      );
      const { rows: channels } = await query('SELECT id FROM channels WHERE community_id = $1', [communityId]);
      for (const m of members) evictFromCommunity(m.user_id, communityId, channels.map((c) => c.id));
    } else {
      emitToCommunity(communityId, 'channels_updated', { community_id: communityId });
    }
    notifyStanding(community.owner_id);
    await notifyPlatformStaff();
    res.json({ status });
  }),
);

// Передать сообщество другому участнику, если владелец заблокирован или
// пропал. Прежний владелец, если остался в сообществе, — модератор.
platformRouter.post(
  '/staff/communities/:id/transfer',
  requirePlatform('manage_communities'),
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const targetId = parseUuid(req.body?.user_id, 'user_id');
    const reason = requireReason(req.body?.reason);
    const { rows } = await query('SELECT owner_id, platform_status FROM communities WHERE id = $1', [communityId]);
    if (rows.length === 0) throw new HttpError(404, 'community_not_found');
    const oldOwner = rows[0].owner_id;
    if (oldOwner === targetId) throw new HttpError(400, 'already_owner');
    if (rows[0].platform_status === 'deleted') throw new HttpError(409, 'community_deleted');

    await withTransaction(async (client) => {
      const { rows: updated } = await client.query(
        `UPDATE community_members SET role = 'owner' WHERE community_id = $1 AND user_id = $2 RETURNING user_id`,
        [communityId, targetId],
      );
      if (updated.length === 0) throw new HttpError(404, 'member_not_found');
      await client.query(
        `UPDATE community_members SET role = 'moderator' WHERE community_id = $1 AND user_id = $2`,
        [communityId, oldOwner],
      );
      await client.query('UPDATE communities SET owner_id = $2 WHERE id = $1', [communityId, targetId]);
      await audit(req.user, 'community_transferred', {
        targetType: 'community', targetId: communityId, reason, details: { from: oldOwner, to: targetId },
      }, client);
    });
    await announceMember(communityId, targetId);
    await announceMember(communityId, oldOwner);
    res.json({ transferred: true });
  }),
);

// ----- обжалования -----
// Кто может рассмотреть: администратор и старше, не тот, кто наказал, и не
// младше его. Если меру выдал единственный суперадминистратор — больше
// некому, и он рассматривает сам (это видно в журнале).
async function reviewRule(appealRow, reviewer) {
  if (!platformCan(reviewer.platformRole, 'review_appeals')) return 'not_allowed';
  if ((PLATFORM_RANK[reviewer.platformRole] ?? 0) < (PLATFORM_RANK[appealRow.issued_by_role] ?? 0)) {
    return 'issuer_outranks_you';
  }
  if (appealRow.issued_by === reviewer.id) {
    if (appealRow.issued_by_role !== 'superadmin') return 'own_decision';
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM users WHERE platform_role = 'superadmin' AND id <> $1",
      [reviewer.id],
    );
    if (rows[0].n > 0) return 'own_decision';
  }
  return null;
}

const APPEAL_LIST = `
  SELECT a.id, a.text, a.status, a.created_at, a.reviewed_at, a.response,
         s.id AS sanction_id, s.kind, s.reason, s.created_at AS sanction_created_at, s.ends_at,
         s.issued_by, s.issued_by_role, s.message_id, s.community_id,
         ${publicNameSql('iu')} AS issued_by_name,
         a.user_id, ${publicNameSql('au')} AS user_name, au.platform_role AS user_role,
         ${publicNameSql('ru')} AS reviewer_name,
         c.name AS community_name,
         m.content AS message_content
  FROM platform_appeals a
  JOIN platform_sanctions s ON s.id = a.sanction_id
  JOIN users au ON au.id = a.user_id
  LEFT JOIN users iu ON iu.id = s.issued_by
  LEFT JOIN users ru ON ru.id = a.reviewer_id
  LEFT JOIN communities c ON c.id = s.community_id
  LEFT JOIN messages m ON m.id = s.message_id`;

platformRouter.get(
  '/staff/appeals',
  requirePlatform('review_appeals'),
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? 'pending');
    if (!['pending', 'closed'].includes(status)) throw new HttpError(400, 'invalid_status');
    const where = status === 'pending' ? "a.status = 'pending'" : "a.status <> 'pending'";
    const order = status === 'pending' ? 'a.created_at' : 'a.reviewed_at DESC';
    const { rows } = await query(`${APPEAL_LIST} WHERE ${where} ORDER BY ${order} LIMIT 100`);
    const appeals = [];
    for (const row of rows) {
      const blocked = status === 'pending' ? await reviewRule(row, req.user) : 'closed';
      appeals.push({
        id: row.id,
        text: row.text,
        status: row.status,
        created_at: row.created_at,
        reviewed_at: row.reviewed_at,
        response: row.response,
        reviewer_name: row.reviewer_name,
        waiting_days: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86_400_000),
        user: { id: row.user_id, name: row.user_name },
        sanction: {
          id: row.sanction_id,
          kind: row.kind,
          reason: row.reason,
          created_at: row.sanction_created_at,
          ends_at: row.ends_at,
          issued_by_name: row.issued_by_name,
          issued_by_role: row.issued_by_role,
          community: row.community_id ? { id: row.community_id, name: row.community_name } : null,
          // Удалённое сообщение для рассмотрения показывается целиком.
          message_content: row.message_content,
        },
        can_review: blocked === null,
        cannot_review_reason: blocked,
      });
    }
    res.json({ appeals });
  }),
);

platformRouter.post(
  '/staff/appeals/:id/decide',
  requirePlatform('review_appeals'),
  asyncHandler(async (req, res) => {
    const appealId = parseUuid(req.params.id, 'appeal_id');
    const decision = String(req.body?.decision ?? '');
    if (!['accept', 'reject'].includes(decision)) throw new HttpError(400, 'invalid_decision');
    const response = requireReason(req.body?.response, 'response');

    const { rows } = await query(`${APPEAL_LIST} WHERE a.id = $1`, [appealId]);
    if (rows.length === 0) throw new HttpError(404, 'appeal_not_found');
    const appeal = rows[0];
    if (appeal.status !== 'pending') throw new HttpError(409, 'appeal_closed');
    const blocked = await reviewRule(appeal, req.user);
    if (blocked) throw new HttpError(403, blocked);

    const sanction = await getSanction(appeal.sanction_id);
    const effects = await withTransaction(async (client) => {
      let result = {};
      if (decision === 'accept') {
        result = await revokeSanction(client, sanction, req.user, `Обжалование удовлетворено: ${response}`);
      }
      await client.query(
        `UPDATE platform_appeals SET status = $2, reviewer_id = $3, reviewed_at = now(), response = $4
         WHERE id = $1`,
        [appealId, decision === 'accept' ? 'accepted' : 'rejected', req.user.id, response],
      );
      await audit(req.user, `appeal_${decision === 'accept' ? 'accepted' : 'rejected'}`, {
        targetType: 'appeal', targetId: appealId, reason: response,
        details: {
          sanction_id: sanction.id, kind: sanction.kind, user_id: sanction.user_id,
          self_review: appeal.issued_by === req.user.id,
        },
      }, client);
      return result;
    });
    if (decision === 'accept') await afterRevoke(sanction, effects);
    else notifyStanding(sanction.user_id);
    await notifyPlatformStaff();
    res.json({ status: decision === 'accept' ? 'accepted' : 'rejected' });
  }),
);

// ----- журнал -----
// Модератор видит свои действия, администратор — свои и модераторов,
// суперадминистратор — все.
platformRouter.get(
  '/staff/audit',
  requirePlatform('view_audit'),
  asyncHandler(async (req, res) => {
    const role = req.user.platformRole;
    const params = [];
    let where = 'TRUE';
    if (role === 'moderator') {
      params.push(req.user.id);
      where = 'l.actor_id = $1';
    } else if (role === 'admin') {
      params.push(req.user.id);
      where = "(l.actor_id = $1 OR l.actor_role = 'moderator')";
    }
    const before = Number(req.query.before);
    if (Number.isFinite(before) && before > 0) {
      params.push(before);
      where += ` AND l.id < $${params.length}`;
    }
    const { rows } = await query(
      `SELECT l.id, l.actor_id, l.actor_email, l.actor_role, l.action, l.target_type, l.target_id,
              l.reason, l.details, l.created_at
       FROM staff_audit_log l WHERE ${where} ORDER BY l.id DESC LIMIT 100`,
      params,
    );
    res.json({ entries: rows });
  }),
);

// ----- статистика и настройки -----
platformRouter.get(
  '/staff/stats',
  requirePlatform('view_stats'),
  asyncHandler(async (_req, res) => {
    const { rows: [stats] } = await query(
      `SELECT
         (SELECT count(*)::int FROM users) AS users,
         (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days') AS users_new_7d,
         (SELECT count(*)::int FROM communities WHERE platform_status <> 'deleted') AS communities,
         (SELECT count(*)::int FROM communities WHERE platform_status = 'frozen') AS communities_frozen,
         (SELECT count(*)::int FROM communities WHERE platform_status = 'invites_hidden') AS communities_invites_hidden,
         (SELECT count(*)::int FROM communities WHERE platform_status = 'deleted' AND purged_at IS NULL) AS communities_deleted,
         (SELECT count(*)::int FROM messages WHERE created_at > now() - interval '7 days') AS messages_7d,
         (SELECT count(DISTINCT user_id)::int FROM messages WHERE created_at > now() - interval '7 days') AS writers_7d,
         (SELECT count(*)::int FROM platform_sanctions WHERE kind IN ('suspend', 'ban') AND revoked_at IS NULL
            AND (ends_at IS NULL OR ends_at > now())) AS blocked_users,
         (SELECT count(*)::int FROM platform_sanctions WHERE kind = 'mute' AND revoked_at IS NULL
            AND ends_at > now()) AS muted_users,
         (SELECT count(*)::int FROM users WHERE platform_role <> 'user') AS staff`,
    );
    res.json({ stats: { ...stats, ...(await platformQueueCounts()) } });
  }),
);

platformRouter.get(
  '/staff/settings',
  requirePlatform('manage_settings'),
  asyncHandler(async (_req, res) => {
    res.json({ settings: await getSettings() });
  }),
);

platformRouter.put(
  '/staff/settings',
  requirePlatform('manage_settings'),
  asyncHandler(async (req, res) => {
    const reason = requireReason(req.body?.reason);
    const changes = req.body?.settings ?? {};
    const clean = {};
    for (const [key, value] of Object.entries(changes)) {
      const spec = SETTINGS[key];
      if (!spec) throw new HttpError(400, 'unknown_setting', { key });
      if (spec.type === 'boolean' && typeof value !== 'boolean') throw new HttpError(400, 'invalid_setting', { key });
      if (spec.type === 'integer' && (!Number.isInteger(value) || value < spec.min || value > spec.max)) {
        throw new HttpError(400, 'invalid_setting', { key, min: spec.min, max: spec.max });
      }
      clean[key] = value;
    }
    if (Object.keys(clean).length === 0) throw new HttpError(400, 'no_changes');
    const before = await getSettings();
    await withTransaction(async (client) => {
      for (const [key, value] of Object.entries(clean)) {
        await client.query(
          `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(value), req.user.id],
        );
      }
      await audit(req.user, 'settings_changed', {
        targetType: 'settings', reason,
        details: Object.fromEntries(Object.keys(clean).map((k) => [k, { from: before[k], to: clean[k] }])),
      }, client);
    });
    res.json({ settings: await getSettings() });
  }),
);
