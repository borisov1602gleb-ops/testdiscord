import { HttpError } from './http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, 'invalid_uuid', { field });
  }
  return value;
}
