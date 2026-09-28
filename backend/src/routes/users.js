// Профиль: что человек показывает другим. Остальные настройки (устройства,
// звуки) живут в браузере и на сервер не ходят — они ни на кого не влияют.
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getProfile } from '../lib/users.js';
import { requireMembership, getChannel, requireChannelAccess } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';
import { rawBody, contentTypeOf, saveUpload, IMAGE_TYPES } from './attachments.js';

export const usersRouter = Router();

usersRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await getProfile(req.user.id);
    if (!profile) throw new HttpError(404, 'user_not_found');
    res.json({ user: profile });
  }),
);

usersRouter.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { display_name: displayName, hide_email: hideEmail } = req.body ?? {};

    if (displayName !== undefined) {
      if (typeof displayName !== 'string') throw new HttpError(400, 'invalid_display_name');
      if (displayName.trim().length > 40) throw new HttpError(400, 'display_name_too_long');
    }
    if (hideEmail !== undefined && typeof hideEmail !== 'boolean') {
      throw new HttpError(400, 'invalid_hide_email');
    }

    await query(
      `UPDATE users
       SET display_name = COALESCE($2, display_name),
           hide_email = COALESCE($3, hide_email)
       WHERE id = $1`,
      [req.user.id, displayName === undefined ? null : displayName.trim(), hideEmail ?? null],
    );

    res.json({ user: await getProfile(req.user.id) });
  }),
);

// Аватарка. Браузер заранее ужимает картинку до квадрата 256×256, поэтому
// лимит небольшой: большой файл — признак того, что его прислали в обход
// интерфейса.
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

usersRouter.post(
  '/me/avatar',
  requireAuth,
  rawBody(AVATAR_MAX_BYTES),
  asyncHandler(async (req, res) => {
    const mimeType = contentTypeOf(req);
    if (!IMAGE_TYPES.has(mimeType)) {
      throw new HttpError(415, 'unsupported_file_type', { allowed: [...IMAGE_TYPES] });
    }
    const file = await saveUpload({
      buffer: req.body,
      mimeType,
      filename: 'avatar',
      uploaderId: req.user.id,
    });
    await query('UPDATE users SET avatar_id = $2 WHERE id = $1', [req.user.id, file.id]);
    res.json({ user: await getProfile(req.user.id) });
  }),
);

usersRouter.delete(
  '/me/avatar',
  requireAuth,
  asyncHandler(async (req, res) => {
    await query('UPDATE users SET avatar_id = NULL WHERE id = $1', [req.user.id]);
    res.json({ user: await getProfile(req.user.id) });
  }),
);

// ===== уведомления =====
// Уровень для канала или сообщества: all — о каждом сообщении, mentions —
// только упоминания и личные, none — тишина. default — убрать свою
// настройку и вернуться к значению по умолчанию.
const NOTIFY_LEVELS = ['all', 'mentions', 'none'];

usersRouter.get(
  '/me/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT target_type, target_id, level FROM notification_settings WHERE user_id = $1',
      [req.user.id],
    );
    res.json({ settings: rows });
  }),
);

usersRouter.put(
  '/me/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const targetType = String(req.body?.target_type ?? '');
    const level = String(req.body?.level ?? '');
    if (targetType !== 'channel' && targetType !== 'community') throw new HttpError(400, 'invalid_target');
    if (level !== 'default' && !NOTIFY_LEVELS.includes(level)) throw new HttpError(400, 'invalid_level');
    const targetId = parseUuid(req.body?.target_id, 'target_id');

    // Настраивать можно только то, к чему есть доступ: иначе по ответу
    // можно было бы проверять, существует ли чужой закрытый канал.
    if (targetType === 'channel') await requireChannelAccess(req.user.id, await getChannel(targetId));
    else await requireMembership(req.user.id, targetId);

    if (level === 'default') {
      await query(
        'DELETE FROM notification_settings WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
        [req.user.id, targetType, targetId],
      );
    } else {
      await query(
        `INSERT INTO notification_settings (user_id, target_type, target_id, level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, target_type, target_id)
         DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
        [req.user.id, targetType, targetId, level],
      );
    }
    res.json({ target_type: targetType, target_id: targetId, level });
  }),
);
