import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pool, waitForDatabase } from './db.js';
import { errorHandler } from './lib/http.js';
import { initRealtime } from './lib/realtime.js';
import { authRouter } from './routes/auth.js';
import { communitiesRouter } from './routes/communities.js';
import { invitesRouter } from './routes/invites.js';
import { callsRouter } from './routes/calls.js';
import { messagesRouter } from './routes/messages.js';

export const app = express();
app.use(cors());
app.use(express.json());

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
app.use('/communities', communitiesRouter);
app.use('/invites', invitesRouter);
app.use('/calls', callsRouter);
app.use('/messages', messagesRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.use(errorHandler);

const server = http.createServer(app);
initRealtime(server);

await waitForDatabase();
server.listen(config.port, () => {
  console.log(`[backend] listening on :${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
