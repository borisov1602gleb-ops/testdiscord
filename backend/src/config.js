// Единственное место, где читаются переменные окружения. Значения по
// умолчанию рассчитаны на локальную разработку; в проде задаются снаружи.
import { fileURLToPath } from 'node:url';

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5432/community',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  eventSource: process.env.EVENT_SOURCE || 'backend',
  attachments: {
    // Куда складывать файлы. Вне репозитория и вне раздачи статики: наружу
    // файл отдаётся только через маршрут с проверкой подписи.
    // fileURLToPath, а не .pathname: на Windows .pathname даёт «/C:/…»,
    // и такой путь файловая система не понимает.
    dir: process.env.UPLOADS_DIR || fileURLToPath(new URL('../uploads', import.meta.url)),
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024),
    // Ссылка на файл живёт ограниченное время: утёкшая ссылка перестаёт
    // работать сама.
    linkTtlSec: Number(process.env.ATTACHMENT_LINK_TTL_SEC || 2 * 60 * 60),
  },
  etl: {
    // Как часто пересобираются аналитические слои. 0 выключает
    // автозапуск — тогда остаётся ручной `npm run etl` и кнопка
    // «Обновить» на экране аналитики.
    intervalSec: Number(process.env.ETL_INTERVAL_SEC ?? 300),
  },
  loginCode: {
    ttlSec: Number(process.env.LOGIN_CODE_TTL_SEC || 600),
    resendCooldownSec: Number(process.env.LOGIN_CODE_COOLDOWN_SEC || 60),
    // На этапе MVP письма не отправляются, код печатается в лог SMTP-заглушки.
    // Возврат кода в HTTP-ответе нужен только для локальных e2e-прогонов.
    exposeInResponse: process.env.EXPOSE_DEV_CODE === 'true',
  },
  livekit: {
    url: process.env.LIVEKIT_URL || 'ws://localhost:7880',
    apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
    apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
  },
};
