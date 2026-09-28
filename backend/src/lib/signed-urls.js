// Подписанные ссылки на файлы. Картинку в <img> браузер запрашивает без
// заголовка авторизации, поэтому право на просмотр подтверждает подпись,
// выданная тому, кто уже прошёл проверку доступа.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Ссылка живёт от двух до трёх часов и не меняется в пределах часа:
// так браузер кэширует картинки и аватарки, а не качает их заново при
// каждой перерисовке списка.
const LINK_BUCKET_SEC = 60 * 60;

function sign(id, expires) {
  // Подпись выводится из JWT_SECRET, но с отдельной «солью»: ключ для
  // токенов входа и ключ для ссылок на файлы не должны совпадать.
  return createHmac('sha256', `${config.jwtSecret}:attachments`)
    .update(`${id}.${expires}`)
    .digest('base64url');
}

export function attachmentUrl(id) {
  const bucket = Math.floor(Date.now() / 1000 / LINK_BUCKET_SEC) * LINK_BUCKET_SEC;
  const expires = bucket + Math.max(config.attachments.linkTtlSec, LINK_BUCKET_SEC) + LINK_BUCKET_SEC;
  return `/attachments/${id}?exp=${expires}&sig=${sign(id, expires)}`;
}

export function avatarUrl(id) {
  return id ? attachmentUrl(id) : null;
}

// Проверка подписи за постоянное время: иначе по скорости ответа можно
// было бы подбирать подпись по символу.
export function verifySignature(id, expires, given) {
  const expected = Buffer.from(sign(id, expires));
  const actual = Buffer.from(String(given ?? ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
