// Свои эмодзи и стикеры сообщества. Загружают владелец и модераторы,
// пользуются все участники — в сообщениях («:котик:»), реакциях и
// стикерами. В других сообществах и в личке их нет: это бонус участникам.
//
// Удаление мягкое: в старых сообщениях стикер превращается в «стикер
// удалён», а эмодзи — обратно в текст «:имя:».
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, requireReadRole } from '../lib/access.js';
import { requireNotMuted } from '../lib/platform.js';
import { parseUuid } from '../lib/validate.js';
import { emitToCommunity } from '../lib/realtime.js';
import { attachmentUrl } from '../lib/signed-urls.js';
import { PUBLIC_NAME_SQL } from '../lib/users.js';
import { rawBody, contentTypeOf, saveUpload, IMAGE_TYPES } from './attachments.js';

export const emojisRouter = Router();

export const EMOJI_LIMITS = {
  emoji: { max: 50, maxBytes: 256 * 1024 },
  sticker: { max: 30, maxBytes: 512 * 1024 },
};
// Имя — то, что пишут между двоеточиями: буквы, цифры и подчёркивание.
export const EMOJI_NAME_RE = /^[\p{L}\p{N}_]{2,32}$/u;

export function describeEmoji(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: attachmentUrl(row.attachment_id),
    created_at: row.created_at,
    created_by_name: row.created_by_name ?? null,
  };
}

export async function listEmojis(communityId) {
  const { rows } = await query(
    `SELECT e.id, e.kind, e.name, e.attachment_id, e.created_at, ${PUBLIC_NAME_SQL} AS created_by_name
     FROM community_emojis e LEFT JOIN users u ON u.id = e.created_by
     WHERE e.community_id = $1 AND e.deleted_at IS NULL
     ORDER BY e.created_at`,
    [communityId],
  );
  const all = rows.map(describeEmoji);
  return { emojis: all.filter((e) => e.kind === 'emoji'), stickers: all.filter((e) => e.kind === 'sticker') };
}

// Живой эмодзи сообщества по имени — для реакций «:имя:».
export async function findEmoji(communityId, name) {
  const { rows } = await query(
    `SELECT id FROM community_emojis
     WHERE community_id = $1 AND kind = 'emoji' AND lower(name) = lower($2) AND deleted_at IS NULL`,
    [communityId, name],
  );
  return rows[0] ?? null;
}

export function announceEmojis(communityId) {
  emitToCommunity(communityId, 'emojis_updated', { community_id: communityId });
}

emojisRouter.get(
  '/:id/emojis',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    await requireReadRole(req.user.id, communityId);
    res.json({ ...(await listEmojis(communityId)), limits: EMOJI_LIMITS });
  }),
);

// Загрузка: картинка сырым телом, вид и имя — в адресе
// (?kind=emoji&name=котик). Анимированный GIF тоже подходит.
emojisRouter.post(
  '/:id/emojis',
  requireAuth,
  rawBody(EMOJI_LIMITS.sticker.maxBytes),
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const kind = String(req.query.kind ?? 'emoji');
    if (!EMOJI_LIMITS[kind]) throw new HttpError(400, 'invalid_emoji_kind');
    const name = String(req.query.name ?? '').trim().toLowerCase();
    if (!EMOJI_NAME_RE.test(name)) throw new HttpError(400, 'invalid_emoji_name');
    requireNotMuted(req.user);
    await requirePermission(req.user.id, communityId, 'manage_emojis');

    const mimeType = contentTypeOf(req);
    if (!IMAGE_TYPES.has(mimeType)) throw new HttpError(415, 'unsupported_file_type', { allowed: [...IMAGE_TYPES] });
    const limit = EMOJI_LIMITS[kind];
    if (!Buffer.isBuffer(req.body) || req.body.length > limit.maxBytes) {
      throw new HttpError(413, 'file_too_large', { max_bytes: limit.maxBytes });
    }
    const { rows: [{ total }] } = await query(
      `SELECT count(*)::int AS total FROM community_emojis
       WHERE community_id = $1 AND kind = $2 AND deleted_at IS NULL`,
      [communityId, kind],
    );
    if (total >= limit.max) throw new HttpError(409, 'too_many_emojis', { max: limit.max });
    if (await nameTaken(communityId, kind, name)) throw new HttpError(409, 'emoji_exists');

    const file = await saveUpload({
      buffer: req.body, mimeType, filename: `${kind}-${name}`, uploaderId: req.user.id, communityId,
    });
    let row;
    try {
      ({ rows: [row] } = await query(
        `INSERT INTO community_emojis (community_id, kind, name, attachment_id, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, kind, name, attachment_id, created_at`,
        [communityId, kind, name, file.id, req.user.id],
      ));
    } catch (err) {
      // Двое загрузили одно имя одновременно — держит уникальный индекс.
      if (err.code === '23505') throw new HttpError(409, 'emoji_exists');
      throw err;
    }
    announceEmojis(communityId);
    res.status(201).json({ emoji: describeEmoji(row) });
  }),
);

async function nameTaken(communityId, kind, name) {
  const { rows } = await query(
    `SELECT 1 FROM community_emojis
     WHERE community_id = $1 AND kind = $2 AND lower(name) = lower($3) AND deleted_at IS NULL`,
    [communityId, kind, name],
  );
  return rows.length > 0;
}

emojisRouter.delete(
  '/:id/emojis/:emojiId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.params.id, 'community_id');
    const emojiId = parseUuid(req.params.emojiId, 'emoji_id');
    await requirePermission(req.user.id, communityId, 'manage_emojis');
    const { rowCount } = await query(
      `UPDATE community_emojis SET deleted_at = now(), deleted_by = $3
       WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL`,
      [emojiId, communityId, req.user.id],
    );
    if (rowCount === 0) throw new HttpError(404, 'emoji_not_found');
    announceEmojis(communityId);
    res.status(204).end();
  }),
);
