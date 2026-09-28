// Совместная доска голосового канала: хранение элементов, их проверка и
// пропуск для гостей.
//
// Элемент приходит от браузера, поэтому проверяется строго: известный тип,
// числа — конечные и в разумных пределах, цвета — только из палитры,
// тексты — ограниченной длины. Всё, чего нет в описании типа,
// отбрасывается: в базу и другим участникам уходит только проверенное.
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { config } from '../config.js';

export const ELEMENT_TYPES = ['path', 'rect', 'ellipse', 'arrow', 'text', 'sticky', 'image'];
// Та же палитра, что в интерфейсе доски.
export const INK_COLORS = ['#e9e9ed', '#1b1d2e', '#b5abfc', '#8cb4ff', '#6fd3cf', '#8fd4a8', '#ecd38a', '#f4b68a', '#f5a19a'];
export const STICKY_COLORS = ['yellow', 'pink', 'green', 'blue', 'violet', 'orange'];
const MAX_ELEMENTS = 5000;
const MAX_POINTS = 4000;
const COORD = 1_000_000;
const MAX_TEXT = 2000;
// Кадр демонстрации экрана — JPEG, сжатый браузером до 1600 точек по
// длинной стороне. Картинки тяжёлые, поэтому их на доске немного.
const MAX_IMAGE_CHARS = 900_000;
const MAX_IMAGES = 30;
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export class BoardError extends Error {}

// ===== пропуск гостя =====
// Гость в звонке без учётной записи тоже рисует. Ему выдаётся отдельный
// токен, подписанный другим ключом: как токен входа он не сработает
// нигде, а годится только для доски одного канала.
const boardSecret = () => `${config.jwtSecret}:board`;

export function signBoardToken({ channelId, anonymousId }) {
  return jwt.sign({ scope: 'board', channel_id: channelId, anon: anonymousId }, boardSecret(), {
    expiresIn: '12h',
  });
}

export function verifyBoardToken(token) {
  const payload = jwt.verify(token, boardSecret());
  if (payload.scope !== 'board') throw new Error('bad_scope');
  return { channelId: payload.channel_id, anonymousId: payload.anon };
}

// ===== проверка элемента =====
function num(value, min = -COORD, max = COORD) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new BoardError('bad_number');
  return Math.round(n * 100) / 100;
}

function color(value, allowed = INK_COLORS) {
  if (!allowed.includes(value)) throw new BoardError('bad_color');
  return value;
}

function text(value, max = MAX_TEXT) {
  const s = String(value ?? '');
  if (s.length > max) throw new BoardError('text_too_long');
  return s;
}

// Сдвиг элемента при перетаскивании хранится отдельно от его геометрии:
// так двигать линию из тысячи точек — это поменять два числа.
function offset(data) {
  return { tx: num(data.tx ?? 0), ty: num(data.ty ?? 0) };
}

const SHAPES = {
  path(d) {
    if (!Array.isArray(d.points) || d.points.length < 2 || d.points.length % 2 !== 0) {
      throw new BoardError('bad_points');
    }
    if (d.points.length > MAX_POINTS * 2) throw new BoardError('too_many_points');
    return {
      points: d.points.map((p) => num(p)),
      color: color(d.color),
      width: num(d.width, 1, 40),
      ...offset(d),
    };
  },
  rect(d) {
    return {
      x: num(d.x), y: num(d.y), w: num(d.w), h: num(d.h),
      color: color(d.color), width: num(d.width, 1, 40), fill: d.fill === true, ...offset(d),
    };
  },
  ellipse(d) {
    return SHAPES.rect(d);
  },
  arrow(d) {
    return {
      x1: num(d.x1), y1: num(d.y1), x2: num(d.x2), y2: num(d.y2),
      color: color(d.color), width: num(d.width, 1, 40), ...offset(d),
    };
  },
  text(d) {
    return {
      x: num(d.x), y: num(d.y), text: text(d.text), color: color(d.color),
      size: num(d.size, 10, 120), w: num(d.w ?? 400, 40, 4000), ...offset(d),
    };
  },
  image(d) {
    const src = String(d.src ?? '');
    if (src.length > MAX_IMAGE_CHARS) throw new BoardError('image_too_big');
    if (!IMAGE_RE.test(src)) throw new BoardError('bad_image');
    return {
      x: num(d.x), y: num(d.y), w: num(d.w, 20, 20000), h: num(d.h, 20, 20000), src, ...offset(d),
    };
  },
  sticky(d) {
    return {
      x: num(d.x), y: num(d.y), w: num(d.w, 80, 800), h: num(d.h, 80, 800),
      text: text(d.text, 1000), color: color(d.color, STICKY_COLORS), ...offset(d),
    };
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cleanElement(raw) {
  if (!raw || typeof raw !== 'object') throw new BoardError('bad_element');
  if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) throw new BoardError('bad_id');
  if (!ELEMENT_TYPES.includes(raw.type)) throw new BoardError('bad_type');
  if (!raw.data || typeof raw.data !== 'object') throw new BoardError('bad_element');
  return {
    id: raw.id.toLowerCase(),
    type: raw.type,
    z: num(raw.z ?? 0, -1e15, 1e15),
    data: SHAPES[raw.type](raw.data),
  };
}

// ===== хранение =====
export async function getBoardId(channelId) {
  const { rows } = await query(
    `INSERT INTO boards (channel_id) VALUES ($1)
     ON CONFLICT (channel_id) DO UPDATE SET channel_id = EXCLUDED.channel_id
     RETURNING id`,
    [channelId],
  );
  return rows[0].id;
}

export async function listElements(boardId) {
  const { rows } = await query(
    `SELECT id, type, data, z, author_name
     FROM board_elements WHERE board_id = $1 ORDER BY z, updated_at`,
    [boardId],
  );
  return rows;
}

export async function saveElement(boardId, element, author) {
  if (element.type === 'image') {
    const { rows: [count] } = await query(
      `SELECT count(*)::int AS n FROM board_elements
       WHERE board_id = $1 AND type = 'image' AND id <> $2`,
      [boardId, element.id],
    );
    if (count.n >= MAX_IMAGES) throw new BoardError('too_many_images');
  }
  const { rows } = await query(
    `INSERT INTO board_elements (board_id, id, type, data, z, author_id, author_name)
     SELECT $1, $2, $3, $4, $5, $6, $7
     WHERE EXISTS (SELECT 1 FROM board_elements WHERE board_id = $1 AND id = $2)
        OR (SELECT count(*) FROM board_elements WHERE board_id = $1) < ${MAX_ELEMENTS}
     ON CONFLICT (board_id, id) DO UPDATE
       SET type = EXCLUDED.type, data = EXCLUDED.data, z = EXCLUDED.z, updated_at = now()
     RETURNING author_name`,
    [boardId, element.id, element.type, element.data, element.z, author.userId ?? null, author.name],
  );
  if (rows.length === 0) throw new BoardError('board_full');
  await query('UPDATE boards SET updated_at = now() WHERE id = $1', [boardId]);
  return { ...element, author_name: rows[0].author_name };
}

export async function deleteElements(boardId, ids) {
  const clean = ids.filter((id) => typeof id === 'string' && UUID_RE.test(id)).slice(0, 500);
  if (clean.length === 0) return [];
  const { rows } = await query(
    'DELETE FROM board_elements WHERE board_id = $1 AND id = ANY($2::uuid[]) RETURNING id',
    [boardId, clean],
  );
  return rows.map((r) => r.id);
}

export async function clearBoard(boardId) {
  await query('DELETE FROM board_elements WHERE board_id = $1', [boardId]);
}
