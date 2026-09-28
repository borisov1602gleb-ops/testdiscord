// Реалтайм-слой. Источник правды — по-прежнему HTTP-маршруты: сюда
// событие попадает уже после записи в базу, и если соединение оборвалось,
// ничего не теряется — клиент дочитает историю обычным запросом.
//
// Комнаты трёх видов:
//  - channel:<id>   — открытый сейчас канал, в него идут новые сообщения;
//  - community:<id> — всё сообщество: непрочитанные в других каналах,
//                     реакции, правки, отметки прочтения, кто в голосовом;
//  - user:<id>      — все вкладки одного человека. Через неё идут личные
//                     сообщения и исключение из сообщества.
//
// Здесь же — кто в сети и кто печатает. Оба знания живут только в памяти
// процесса: при нескольких копиях backend понадобится общий брокер (Redis).
import { Server } from 'socket.io';
import { query } from '../db.js';
import { verifyToken } from '../middleware/auth.js';
import { requireMembership, getChannel, requireChannelAccess, isChatChannel } from './access.js';
import { getProfile } from './users.js';

let io = null;
// user_id → сколько у человека открыто соединений (вкладок).
const onlineSockets = new Map();
// Не чаще раза в пару секунд на канал: иначе каждое нажатие клавиши
// превращалось бы в рассылку всем.
const TYPING_THROTTLE_MS = 2000;

export function isOnline(userId) {
  return onlineSockets.has(userId);
}

// Комнаты, куда уходят события канала: у канала сообщества — само
// сообщество и открытый канал, у личной переписки — оба собеседника.
export function channelRooms(channel) {
  if (channel.type === 'direct') return (channel.member_ids ?? []).map((id) => `user:${id}`);
  return [`channel:${channel.id}`, `community:${channel.community_id}`];
}

// Одному сокету Socket.IO не шлёт одно событие дважды, даже если он
// состоит сразу в нескольких комнатах из списка.
export function emitToChannel(channel, event, payload) {
  if (!io) return;
  const rooms = channelRooms(channel);
  if (rooms.length === 0) return;
  io.to(rooms).emit(event, payload);
}

export function emitToCommunity(communityId, event, payload) {
  io?.to(`community:${communityId}`).emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}

// О том, что человек зашёл или вышел, узнают те, кто может его видеть:
// сообщества, где он состоит, и собеседники по личной переписке.
async function broadcastPresence(userId, online) {
  const { rows } = await query(
    `SELECT 'community:' || community_id AS room FROM community_members WHERE user_id = $1
     UNION
     SELECT 'user:' || other.user_id
     FROM direct_members mine
     JOIN direct_members other ON other.channel_id = mine.channel_id AND other.user_id <> mine.user_id
     WHERE mine.user_id = $1`,
    [userId],
  );
  if (rows.length) io.to(rows.map((r) => r.room)).emit('presence', { user_id: userId, online });
}

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
    const userId = socket.data.user.id;
    socket.join(`user:${userId}`);
    socket.data.typingAt = new Map();

    const count = (onlineSockets.get(userId) ?? 0) + 1;
    onlineSockets.set(userId, count);
    if (count === 1) broadcastPresence(userId, true).catch(() => {});

    socket.on('disconnect', () => {
      const left = (onlineSockets.get(userId) ?? 1) - 1;
      if (left > 0) {
        onlineSockets.set(userId, left);
        return;
      }
      onlineSockets.delete(userId);
      broadcastPresence(userId, false).catch(() => {});
    });

    socket.on('join_channel', async (channelId, ack) => {
      try {
        const channel = await getChannel(channelId);
        await requireChannelAccess(userId, channel);
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
        await requireMembership(userId, communityId);
        socket.join(`community:${communityId}`);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    // «Печатает…». Доступ к каналу проверяется каждый раз: человека могли
    // исключить, пока вкладка была открыта.
    socket.on('typing', async (payload) => {
      try {
        const channelId = String(payload?.channel_id ?? '');
        const threadId = payload?.thread_id ? String(payload.thread_id) : null;
        const key = `${channelId}:${threadId ?? ''}`;
        const now = Date.now();
        if (now - (socket.data.typingAt.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
        socket.data.typingAt.set(key, now);

        const channel = await getChannel(channelId);
        if (!isChatChannel(channel)) return;
        await requireChannelAccess(userId, channel);
        const profile = await getProfile(userId);
        // socket.to — всем, кроме этой вкладки. Свои же другие вкладки
        // отсеивает клиент по user_id.
        socket.to(channelRooms(channel)).emit('typing', {
          channel_id: channel.id,
          thread_id: threadId,
          user_id: userId,
          name: profile?.public_name ?? '',
        });
      } catch {
        /* нет доступа или битый id — молча игнорируем */
      }
    });
  });

  return io;
}

// Исключённый участник перестаёт получать события сообщества сразу же.
export function evictFromCommunity(userId, communityId, channelIds) {
  if (!io) return;
  const rooms = [`community:${communityId}`, ...channelIds.map((id) => `channel:${id}`)];
  io.in(`user:${userId}`).socketsLeave(rooms);
  io.to(`user:${userId}`).emit('removed_from_community', { community_id: communityId });
}
