// Доска по WebSocket: вход на доску, рисование, удаление, «черновики»
// (линия, которую человек ещё тянет, видна всем сразу), курсоры и список
// тех, кто сейчас на доске.
//
// Готовые элементы сохраняются в базу и рассылаются остальным; черновики и
// курсоры — только рассылаются: их много, и они живут доли секунды.
import { query } from '../db.js';
import { getChannel, requireChannelAccess, hasPermission } from './access.js';
import { getProfile } from './users.js';
import {
  cleanElement, getBoardId, listElements, saveElement, deleteElements, clearBoard, BoardError,
} from './boards.js';

const room = (channelId) => `board:${channelId}`;
// Сколько событий в секунду принимаем от одной вкладки. Рисование линии
// шлёт черновик раз в 40 мс, курсор — раз в 50 мс; с запасом.
const LIMITS = { draft: 40, cursor: 40, upsert: 30, delete: 10 };
// Цвет курсора закрепляется за человеком: одинаковый у всех участников.
const CURSOR_COLORS = ['#b5abfc', '#8cb4ff', '#6fd3cf', '#8fd4a8', '#ecd38a', '#f4b68a', '#f5a19a', '#f5aad4'];

function colorFor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

function limited(socket, kind) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = socket.data.boardRate ??= {};
  if (bucket.second !== now) {
    bucket.second = now;
    bucket.counts = {};
  }
  bucket.counts[kind] = (bucket.counts[kind] ?? 0) + 1;
  return bucket.counts[kind] > LIMITS[kind];
}

async function emitPeers(io, channelId) {
  const sockets = await io.in(room(channelId)).fetchSockets();
  const peers = new Map();
  for (const s of sockets) {
    const who = s.data.boardWho;
    if (who && !peers.has(who.id)) peers.set(who.id, who);
  }
  io.to(room(channelId)).emit('board:peers', { channel_id: channelId, peers: [...peers.values()] });
}

export function registerBoardHandlers(io, socket) {
  socket.data.boards = new Map(); // channel_id → { boardId, role }

  // Событие принимается, только если вкладка вошла на эту доску и всё ещё
  // в её комнате (исключённого из сообщества из комнаты выводят).
  function entryFor(channelId) {
    const entry = socket.data.boards.get(channelId);
    return entry && socket.rooms.has(room(channelId)) ? entry : null;
  }

  socket.on('board:join', async (channelId, ack) => {
    try {
      const channel = await getChannel(String(channelId ?? ''));
      if (channel.type !== 'voice') throw new BoardError('not_a_voice_channel');
      let role;
      let who;
      if (socket.data.user) {
        role = await requireChannelAccess(socket.data.user.id, channel);
        const profile = await getProfile(socket.data.user.id);
        // Имя видят все на доске, в том числе гости по ссылке, поэтому от
        // почты остаётся только часть до собаки — как на плитках звонка.
        const name = (profile?.public_name ?? '').split('@')[0].slice(0, 60);
        who = { id: socket.data.user.id, name: name || 'Участник' };
      } else {
        // Гость — только на доску того канала, в звонок которого вошёл,
        // пока он в этом звонке и пока канал не стал закрытым.
        const guest = socket.data.guest;
        if (guest.channelId !== channel.id || channel.is_private) throw new BoardError('forbidden');
        const { rows } = await query(
          `SELECT 1 FROM call_participants cp JOIN calls c ON c.id = cp.call_id
           WHERE c.channel_id = $1 AND c.ended_at IS NULL
             AND cp.anonymous_id = $2 AND cp.left_at IS NULL LIMIT 1`,
          [channel.id, String(guest.anonymousId)],
        );
        if (rows.length === 0) throw new BoardError('not_in_call');
        role = 'guest';
        who = { id: `guest:${guest.anonymousId}`, name: 'Гость' };
      }
      who.color = colorFor(who.id);
      socket.data.boardWho = who;

      const boardId = await getBoardId(channel.id);
      socket.data.boards.set(channel.id, { boardId, role, name: who.name, userId: socket.data.user?.id ?? null });
      socket.join(room(channel.id));
      ack?.({
        ok: true,
        me: who,
        elements: await listElements(boardId),
        can_clear: hasPermission(role, 'delete_any_message'),
      });
      await emitPeers(io, channel.id);
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });

  socket.on('board:leave', async (channelId) => {
    socket.leave(room(channelId));
    socket.data.boards.delete(channelId);
    await emitPeers(io, channelId).catch(() => {});
  });

  socket.on('disconnecting', () => {
    const joined = [...socket.data.boards.keys()];
    // После отключения комнаты уже не видны — список пересчитываем чуть позже.
    setTimeout(() => joined.forEach((id) => emitPeers(io, id).catch(() => {})), 50);
  });

  socket.on('board:upsert', async (payload, ack) => {
    try {
      const channelId = String(payload?.channel_id ?? '');
      const entry = entryFor(channelId);
      if (!entry || limited(socket, 'upsert')) throw new BoardError('forbidden');
      const element = cleanElement(payload.element);
      const saved = await saveElement(entry.boardId, element, { userId: entry.userId, name: entry.name });
      socket.to(room(channelId)).emit('board:upsert', { channel_id: channelId, element: saved });
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ ok: false, error: err instanceof BoardError ? err.message : 'failed' });
    }
  });

  socket.on('board:delete', async (payload, ack) => {
    try {
      const channelId = String(payload?.channel_id ?? '');
      const entry = entryFor(channelId);
      if (!entry || limited(socket, 'delete') || !Array.isArray(payload.ids)) throw new BoardError('forbidden');
      const ids = await deleteElements(entry.boardId, payload.ids);
      if (ids.length) socket.to(room(channelId)).emit('board:delete', { channel_id: channelId, ids });
      ack?.({ ok: true, ids });
    } catch (err) {
      ack?.({ ok: false, error: err instanceof BoardError ? err.message : 'failed' });
    }
  });

  // Черновик — то, что человек рисует прямо сейчас. Не сохраняется, но
  // проверяется так же строго: другим уходит только чистый элемент.
  socket.on('board:draft', (payload) => {
    try {
      const channelId = String(payload?.channel_id ?? '');
      if (!entryFor(channelId) || limited(socket, 'draft')) return;
      // Картинку черновиком не гоняем: она тяжёлая, её просто сохраняют.
      if (payload.element?.type === 'image') return;
      const element = cleanElement(payload.element);
      socket.to(room(channelId)).volatile.emit('board:draft', { channel_id: channelId, element });
    } catch {
      /* кривой черновик просто не рассылаем */
    }
  });

  socket.on('board:cursor', (payload) => {
    const channelId = String(payload?.channel_id ?? '');
    if (!entryFor(channelId) || limited(socket, 'cursor')) return;
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return;
    socket.to(room(channelId)).volatile.emit('board:cursor', {
      channel_id: channelId,
      ...socket.data.boardWho,
      x,
      y,
    });
  });

  // Очистить доску целиком могут владелец и модераторы: одним нажатием
  // стирается работа всех.
  socket.on('board:clear', async (payload, ack) => {
    try {
      const channelId = String(payload?.channel_id ?? '');
      const entry = entryFor(channelId);
      if (!entry || !hasPermission(entry.role, 'delete_any_message')) throw new BoardError('forbidden');
      await clearBoard(entry.boardId);
      io.to(room(channelId)).emit('board:cleared', { channel_id: channelId });
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });
}
