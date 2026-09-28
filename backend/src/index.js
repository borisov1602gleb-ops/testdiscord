// Точка входа backend: собирает Express-приложение из маршрутов, поднимает
// WebSocket поверх того же HTTP-сервера и отдаёт статику веб-клиента.
// Один процесс обслуживает и API, и интерфейс — отдельный веб-сервер не нужен.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pool, waitForDatabase } from './db.js';
import { errorHandler } from './lib/http.js';
import { initRealtime } from './lib/realtime.js';
import { applySchema } from './lib/schema.js';
import { startEtlScheduler } from './etl/index.js';
import { startCallSweeper } from './lib/call-sweeper.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { communitiesRouter } from './routes/communities.js';
import { analyticsRouter } from './routes/analytics.js';
import { invitesRouter } from './routes/invites.js';
import { callsRouter } from './routes/calls.js';
import { messagesRouter } from './routes/messages.js';
import { channelsRouter } from './routes/channels.js';
import { directRouter } from './routes/direct.js';
import { attachmentsRouter } from './routes/attachments.js';
import { moderationRouter } from './routes/moderation.js';
import { pollsRouter } from './routes/polls.js';
import { previewsRouter } from './routes/previews.js';

export const app = express();
// На этапе MVP клиент и API живут на одном адресе, поэтому cors() открыт
// целиком. В проде список источников нужно сузить до своего домена.
app.use(cors());
// Явный лимит тела JSON: сообщения ограничены 2000 символами, поэтому
// больше 100 КБ присылать нечего. Файлы идут отдельным маршрутом
// /attachments со своим лимитом и в JSON не попадают.
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// Клиент и SDK LiveKit отдаются тем же сервером — отдельный веб-сервер
// и сборка на этапе MVP не нужны.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
app.use(
  '/vendor',
  express.static(path.join(srcDir, '..', 'node_modules', 'livekit-client', 'dist')),
);
app.use(express.static(path.join(srcDir, '..', '..', 'frontend')));

app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/communities', analyticsRouter);
app.use('/communities', communitiesRouter);
app.use('/communities', moderationRouter);
app.use('/invites', invitesRouter);
app.use('/calls', callsRouter);
app.use('/messages', messagesRouter);
app.use('/channels', channelsRouter);
app.use('/direct', directRouter);
app.use('/attachments', attachmentsRouter);
app.use('/polls', pollsRouter);
app.use('/link-preview', previewsRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.use(errorHandler);

const server = http.createServer(app);
initRealtime(server);

await waitForDatabase();
// Идемпотентные миграции и таблицы слоёв применяются при старте, поэтому
// обновление кода не требует отдельного шага «накатить миграцию».
await applySchema();
server.listen(config.port, () => {
  console.log(`[backend] listening on :${config.port}`);
  startEtlScheduler();
  startCallSweeper();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
