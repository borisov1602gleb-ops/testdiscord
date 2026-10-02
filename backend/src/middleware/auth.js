// Аутентификация по токену. Пароля в продукте нет: пользователь получает код
// на почту, а в обмен на него — JWT, который клиент присылает в заголовке
// Authorization. Гостевые сценарии работают вообще без токена (optionalAuth).
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { getStanding, blockError } from '../lib/platform.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  const payload = jwt.verify(token, config.jwtSecret);
  return { id: payload.sub, email: payload.email };
}

function readUser(req) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return verifyToken(header.slice('Bearer '.length));
  } catch {
    return null;
  }
}

// К пользователю из токена добавляется его положение на платформе: роль
// и действующие меры. Заблокированный дальше не проходит нигде, кроме
// маршрутов обжалования (allowBlocked) — так блокировка срабатывает сразу,
// даже если вкладка у человека открыта.
async function attachStanding(req, { allowBlocked = false } = {}) {
  const standing = await getStanding(req.user.id);
  req.user.platformRole = standing.role;
  req.user.mute = standing.mute;
  req.user.block = standing.block;
  if (standing.block && !allowBlocked) throw blockError(standing.block);
}

function authMiddleware({ required, allowBlocked = false }) {
  return (req, _res, next) => {
    req.user = readUser(req);
    if (!req.user) return next(required ? new HttpError(401, 'unauthorized') : undefined);
    return attachStanding(req, { allowBlocked }).then(() => next(), next);
  };
}

// Гостевые сценарии (превью инвайта, подключение к звонку по ссылке)
// работают без токена, поэтому авторизация здесь опциональна.
export const optionalAuth = authMiddleware({ required: false });
export const requireAuth = authMiddleware({ required: true });
// Только для экрана блокировки и подачи обжалования.
export const requireAuthAllowBlocked = authMiddleware({ required: true, allowBlocked: true });
