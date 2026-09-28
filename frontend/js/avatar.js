// Аватарки: картинка, если она есть, иначе первая буква имени. И
// подготовка картинки к загрузке: браузер сам обрезает её до квадрата
// и уменьшает до 256×256 — на сервер уходит несколько десятков килобайт,
// а не фотография с телефона на 8 мегабайт.
import { el, initial } from './dom.js';
import { uploadFile } from './api.js';

const AVATAR_SIZE = 256;

export function avatarNode(name, url, className, extra = {}) {
  return el('span', { class: `${className}${url ? ' has-image' : ''}`, ...extra }, [
    url ? el('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }) : initial(name),
  ]);
}

async function toSquareBlob(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  canvas.getContext('2d').drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, AVATAR_SIZE, AVATAR_SIZE,
  );
  bitmap.close?.();
  const webp = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (webp && webp.type === 'image/webp') return webp;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Выбрать файл, ужать и загрузить. path — куда (/users/me/avatar или
// /communities/:id/avatar). Возвращает ответ сервера или null, если
// человек передумал.
export function pickAndUploadAvatar(path) {
  return new Promise((resolve, reject) => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      try {
        const blob = await toSquareBlob(file);
        resolve(await uploadFile(path, blob));
      } catch (err) {
        reject(err);
      }
    });
    input.click();
  });
}
