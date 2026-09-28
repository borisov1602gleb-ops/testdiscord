// Превью ссылок для чата. Вся защита от запросов во внутреннюю сеть —
// в lib/link-preview.js; здесь — вход только для вошедших и ограничение
// частоты, чтобы сервер нельзя было превратить в «качалку» чужих сайтов.
import { Router } from 'express';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getPreview, PreviewBlockedError } from '../lib/link-preview.js';

export const previewsRouter = Router();

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 60;
const hits = new Map(); // user_id → { start, count }

function rateLimit(userId) {
  const now = Date.now();
  const entry = hits.get(userId);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(userId, { start: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > MAX_PER_WINDOW) throw new HttpError(429, 'too_many_previews');
}

previewsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    rateLimit(req.user.id);
    try {
      res.json({ preview: await getPreview(req.query.url) });
    } catch (err) {
      if (err instanceof PreviewBlockedError) throw new HttpError(400, 'url_not_allowed', { why: err.message });
      throw err;
    }
  }),
);
