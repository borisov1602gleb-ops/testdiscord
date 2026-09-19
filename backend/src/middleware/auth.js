import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

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

// Гостевые сценарии (превью инвайта, подключение к звонку по ссылке)
// работают без токена, поэтому авторизация здесь опциональна.
export function optionalAuth(req, _res, next) {
  req.user = readUser(req);
  next();
}

export function requireAuth(req, _res, next) {
  req.user = readUser(req);
  if (!req.user) return next(new HttpError(401, 'unauthorized'));
  return next();
}
