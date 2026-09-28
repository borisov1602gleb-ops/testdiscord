// Профиль: что человек показывает другим. Остальные настройки (устройства,
// звуки) живут в браузере и на сервер не ходят — они ни на кого не влияют.
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getProfile } from '../lib/users.js';
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
