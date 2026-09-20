// Профиль: что человек показывает другим. Остальные настройки (устройства,
// звуки) живут в браузере и на сервер не ходят — они ни на кого не влияют.
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getProfile } from '../lib/users.js';

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
