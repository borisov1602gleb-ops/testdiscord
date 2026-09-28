// Вложения: картинки и файлы в сообщениях.
//
// Загрузка идёт сырым телом запроса, без сторонних библиотек разбора форм.
// Отдача — только по подписанной ссылке с ограниченным сроком жизни:
// картинку в <img> браузер запрашивает без заголовка авторизации, поэтому
// право на просмотр подтверждает подпись, выданная участнику сообщества.
//
// Главное здесь — безопасность. Файл прислал посторонний человек, и он не
// должен выполниться в браузере как страница:
//  - принимаются только типы из белого списка, SVG и HTML — никогда
//    (в них можно спрятать скрипт);
//  - отдаётся с тем типом, который мы проверили, и с запретом браузеру
//    угадывать тип по содержимому;
//  - всё, кроме картинок, отдаётся на скачивание, а не открывается;
//  - имя на диске — случайное, присланное имя в путь не попадает.
import { Router } from 'express';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';

export const attachmentsRouter = Router();

const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ALLOWED_TYPES = new Set([
  ...INLINE_TYPES,
  'application/pdf',
  'text/plain',
  'application/zip',
]);

function sign(id, expires) {
  // Подпись выводится из JWT_SECRET, но с отдельной «солью»: ключ для
  // токенов входа и ключ для ссылок на файлы не должны совпадать.
  return createHmac('sha256', `${config.jwtSecret}:attachments`)
    .update(`${id}.${expires}`)
    .digest('base64url');
}

// Ссылка на файл для участника, который уже прошёл проверку членства.
export function attachmentUrl(id) {
  const expires = Math.floor(Date.now() / 1000) + config.attachments.linkTtlSec;
  return `/attachments/${id}?exp=${expires}&sig=${sign(id, expires)}`;
}

// Описание вложения для клиента — одинаковое в истории и в новом сообщении.
export function describeAttachment(row) {
  if (!row?.attachment_id) return null;
  return {
    id: row.attachment_id,
    filename: row.attachment_filename,
    mime_type: row.attachment_mime,
    size_bytes: row.attachment_size,
    is_image: INLINE_TYPES.has(row.attachment_mime),
    url: attachmentUrl(row.attachment_id),
  };
}

function cleanFilename(raw) {
  // Для показа и для заголовка скачивания: без путей и управляющих
  // символов, разумной длины.
  const base = String(raw ?? '').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'file').slice(0, 120);
}

attachmentsRouter.post(
  '/',
  requireAuth,
  express.raw({ type: () => true, limit: config.attachments.maxBytes }),
  asyncHandler(async (req, res) => {
    const communityId = parseUuid(req.query.community_id, 'community_id');
    await requireMembership(req.user.id, communityId);

    const mimeType = String(req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(mimeType)) {
      throw new HttpError(415, 'unsupported_file_type', { allowed: [...ALLOWED_TYPES] });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(400, 'empty_file');
    }

    const filename = cleanFilename(req.query.filename);
    const { rows } = await query(
      `INSERT INTO attachments (community_id, uploader_id, filename, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, filename, mime_type, size_bytes`,
      [communityId, req.user.id, filename, mimeType, req.body.length],
    );
    const attachment = rows[0];

    await fs.mkdir(config.attachments.dir, { recursive: true });
    await fs.writeFile(path.join(config.attachments.dir, attachment.id), req.body);

    res.status(201).json({
      attachment: describeAttachment({
        attachment_id: attachment.id,
        attachment_filename: attachment.filename,
        attachment_mime: attachment.mime_type,
        attachment_size: attachment.size_bytes,
      }),
    });
  }),
);

attachmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseUuid(req.params.id, 'attachment_id');
    const expires = Number(req.query.exp);
    const given = String(req.query.sig ?? '');

    if (!Number.isFinite(expires) || expires < Date.now() / 1000) {
      throw new HttpError(403, 'link_expired');
    }
    // Сравнение подписей за постоянное время: иначе по скорости ответа
    // можно было бы подбирать подпись по символу.
    const expected = Buffer.from(sign(id, expires));
    const actual = Buffer.from(given);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new HttpError(403, 'bad_signature');
    }

    const { rows } = await query(
      'SELECT filename, mime_type FROM attachments WHERE id = $1',
      [id],
    );
    if (rows.length === 0) throw new HttpError(404, 'attachment_not_found');
    const { filename, mime_type: mimeType } = rows[0];

    let file;
    try {
      file = await fs.readFile(path.join(config.attachments.dir, id));
    } catch {
      throw new HttpError(404, 'attachment_not_found');
    }

    const disposition = INLINE_TYPES.has(mimeType) ? 'inline' : 'attachment';
    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(file.length),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Content-Type-Options': 'nosniff',
      // Даже если что-то пойдёт не так, файл открывается в песочнице без
      // права выполнять скрипты.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    });
    res.send(file);
  }),
);
