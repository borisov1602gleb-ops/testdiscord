// Реалтайм-слой чата: клиент подписывается на канал по WebSocket и получает
// новые сообщения. Источник правды — по-прежнему HTTP-маршрут /messages,
// сюда сообщение попадает уже после записи в базу.
import { Server } from 'socket.io';
import { verifyToken } from '../middleware/auth.js';
import { requireMembership, getChannel } from './access.js';

let io = null;

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.data.user = verifyToken(token);
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('join_channel', async (channelId, ack) => {
      try {
        const channel = await getChannel(channelId);
        await requireMembership(socket.data.user.id, channel.community_id);
        socket.join(`channel:${channel.id}`);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('leave_channel', (channelId) => {
      socket.leave(`channel:${channelId}`);
    });
  });

  return io;
}

export function emitMessage(channelId, message) {
  io?.to(`channel:${channelId}`).emit('message', message);
}
