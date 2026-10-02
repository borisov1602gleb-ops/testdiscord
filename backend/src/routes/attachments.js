// Вложения: картинки, файлы и голосовые сообщения в чате, а также
// аватарки людей и сообществ.
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
//  - всё, кроме картинок и звука, отдаётся на скачивание, а не открывается;
//  - имя на диске — случайное, присланное имя в путь не попадает.
import { Router } from 'express';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db.js';
import { config } from '../config.js';
import { attachmentUrl, avatarUrl, verifySignature } from '../lib/signed-urls.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireNotMuted } from '../lib/platform.js';
import { requireMembership, getChannel, requireChannelAccess, isChatChannel, requireChannelWritable } from '../lib/access.js';
import { parseUuid } from '../lib/validate.js';

export const attachmentsRouter = Router();

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Голосовые: то, что пишет MediaRecorder в разных браузерах (Chrome и
// Firefox — webm/ogg, Safari — mp4), плюс обычный mp3.
const AUDIO_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']);
const ALLOWED_TYPES = new Set([
  ...IMAGE_TYPES,
  ...AUDIO_TYPES,
  'application/pdf',
  'text/plain',
  'application/zip',
]);
// Голосовое длиннее десяти минут — это уже не сообщение.
const MAX_AUDIO_MS = 10 * 60 * 1000;
export { attachmentUrl, avatarUrl };

// Описание вложения для клиента — одинаковое в истории и в новом сообщении.
export function describeAttachment(row) {
  if (!row?.attachment_id) return null;
  return {
    id: row.attachment_id,
    filename: row.attachment_filename,
    mime_type: row.attachment_mime,
    size_bytes: row.attachment_size,
    is_image: IMAGE_TYPES.has(row.attachment_mime),
    is_audio: AUDIO_TYPES.has(row.attachment_mime),
    duration_ms: row.attachment_duration ?? null,
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

export function contentTypeOf(req) {
  return String(req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

// Сырое тело запроса с лимитом — общее для вложений и аватарок.
export function rawBody(limit) {
  return express.raw({ type: () => true, limit });
}

// Записать загруженный файл: строка в базе и файл на диске под случайным
// именем. Проверки типа и размера — на вызывающем.
export async function saveUpload({ buffer, mimeType, filename, uploaderId, communityId = null, channelId = null, durationMs = null }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(400, 'empty_file');
  const { rows } = await query(
    `INSERT INTO attachments (community_id, channel_id, uploader_id, filename, mime_type, size_bytes, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, filename, mime_type, size_bytes, duration_ms`,
    [communityId, channelId, uploaderId, cleanFilename(filename), mimeType, buffer.length, durationMs],
  );
  await fs.mkdir(config.attachments.dir, { recursive: true });
  await fs.writeFile(path.join(config.attachments.dir, rows[0].id), buffer);
  return rows[0];
}

attachmentsRouter.post(
  '/',
  requireAuth,
  rawBody(config.attachments.maxBytes),
  asyncHandler(async (req, res) => {
    // Файл загружается в канал (в том числе в личную переписку). Старый
    // способ — в сообщество целиком — оставлен для совместимости.
    requireNotMuted(req.user);
    let communityId = null;
    let channelId = null;
    if (req.query.channel_id) {
      const channel = await getChannel(parseUuid(req.query.channel_id, 'channel_id'));
      if (!isChatChannel(channel)) throw new HttpError(400, 'channel_is_not_text');
      await requireChannelAccess(req.user.id, channel);
      requireChannelWritable(channel);
      channelId = channel.id;
      communityId = channel.community_id;
    } else {
      communityId = parseUuid(req.query.community_id, 'community_id');
      await requireMembership(req.user.id, communityId);
    }

    const mimeType = contentTypeOf(req);
    if (!ALLOWED_TYPES.has(mimeType)) {
      throw new HttpError(415, 'unsupported_file_type', { allowed: [...ALLOWED_TYPES] });
    }

    let durationMs = null;
    if (AUDIO_TYPES.has(mimeType) && req.query.duration_ms !== undefined) {
      durationMs = Number(req.query.duration_ms);
      if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_AUDIO_MS) {
        throw new HttpError(400, 'invalid_duration', { max_ms: MAX_AUDIO_MS });
      }
    }

    const attachment = await saveUpload({
      buffer: req.body,
      mimeType,
      filename: req.query.filename,
      uploaderId: req.user.id,
      communityId,
      channelId,
      durationMs,
    });

    res.status(201).json({
      attachment: describeAttachment({
        attachment_id: attachment.id,
        attachment_filename: attachment.filename,
        attachment_mime: attachment.mime_type,
        attachment_size: attachment.size_bytes,
        attachment_duration: attachment.duration_ms,
      }),
    });
  }),
);

attachmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res, next) => {
    const id = parseUuid(req.params.id, 'attachment_id');
    const expires = Number(req.query.exp);
    const given = String(req.query.sig ?? '');

    if (!Number.isFinite(expires) || expires < Date.now() / 1000) {
      throw new HttpError(403, 'link_expired');
    }
    if (!verifySignature(id, expires, given)) throw new HttpError(403, 'bad_signature');

    const { rows } = await query(
      'SELECT filename, mime_type FROM attachments WHERE id = $1',
      [id],
    );
    if (rows.length === 0) throw new HttpError(404, 'attachment_not_found');
    const { filename, mime_type: mimeType } = rows[0];

    const filePath = path.resolve(config.attachments.dir, id);
    try {
      await fs.access(filePath);
    } catch {
      throw new HttpError(404, 'attachment_not_found');
    }

    const inline = IMAGE_TYPES.has(mimeType) || AUDIO_TYPES.has(mimeType);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Content-Type-Options': 'nosniff',
      // Даже если что-то пойдёт не так, файл открывается в песочнице без
      // права выполнять скрипты.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    });
    // sendFile умеет отдавать файл кусками (Range): без этого в голосовом
    // нельзя перемотать на середину.
    res.sendFile(filePath, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  }),
);
