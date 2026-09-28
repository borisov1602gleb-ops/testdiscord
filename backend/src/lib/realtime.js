// Реалтайм-слой. Источник правды — по-прежнему HTTP-маршруты: сюда
// событие попадает уже после записи в базу, и если соединение оборвалось,
// ничего не теряется — клиент дочитает историю обычным запросом.
//
// Комнаты трёх видов:
//  - channel:<id>   — открытый сейчас канал, в него идут новые сообщения;
//  - community:<id> — всё сообщество: непрочитанные в других каналах,
//                     реакции, правки, отметки прочтения, кто в голосовом;
//  - user:<id>      — все вкладки одного человека. Нужна, чтобы при
//                     исключении из сообщества закрыть ему доступ сразу,
//                     а не после перезагрузки страницы.
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
    socket.join(`user:${socket.data.user.id}`);

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

    socket.on('join_community', async (communityId, ack) => {
      try {
        await requireMembership(socket.data.user.id, communityId);
        socket.join(`community:${communityId}`);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });
  });

  return io;
}

// Новое сообщение: и тем, кто смотрит канал, и всему сообществу — для
// счётчиков непрочитанного. Socket.IO сам не шлёт одно событие дважды
// сокету, который состоит в обеих комнатах.
export function emitMessage(channelId, communityId, message) {
  if (!io) return;
  let target = io.to(`channel:${channelId}`);
  if (communityId) target = target.to(`community:${communityId}`);
  target.emit('message', message);
}

export function emitToCommunity(communityId, event, payload) {
  io?.to(`community:${communityId}`).emit(event, payload);
}

// Исключённый участник перестаёт получать события сообщества сразу же.
export function evictFromCommunity(userId, communityId, channelIds) {
  if (!io) return;
  const rooms = [`community:${communityId}`, ...channelIds.map((id) => `channel:${id}`)];
  io.in(`user:${userId}`).socketsLeave(rooms);
  io.to(`user:${userId}`).emit('removed_from_community', { community_id: communityId });
}
