// Работа с ошибками HTTP: HttpError для ожидаемых ситуаций (их текст уходит
// клиенту), asyncHandler — чтобы отказ промиса в маршруте не остался
// незамеченным, errorHandler — единый ответ вместо падения процесса.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Ошибки разбора тела запроса приходят из express.json(): слишком большой
  // или битый JSON — это ошибка клиента, а не сбой сервера.
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
  console.error('[error]', err);
  return res.status(500).json({ error: 'internal_error' });
}
