// Проверка реалтайм-доставки сообщений по WebSocket:
// участник подписывается на канал и должен получить сообщение,
// отправленное другим участником через POST /messages.
import { io } from 'socket.io-client';

const API = process.env.API || 'http://localhost:3000';
const stamp = Date.now();

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function login(email) {
  const { dev_code: code } = await api('/auth/send-code', { method: 'POST', body: { email } });
  return api('/auth/verify-code', { method: 'POST', body: { email, code } });
}

const owner = await login(`ws-owner-${stamp}@example.com`);
const community = await api('/communities', {
  method: 'POST',
  token: owner.token,
  body: { name: `WS ${stamp}` },
});
const textChannel = community.channels.find((c) => c.type === 'text');

const socket = io(API, { auth: { token: owner.token } });
await new Promise((resolve, reject) => {
  socket.on('connect', resolve);
  socket.on('connect_error', reject);
});
const ack = await socket.emitWithAck('join_channel', textChannel.id);
if (!ack.ok) throw new Error(`join_channel failed: ${ack.error}`);

const received = new Promise((resolve, reject) => {
  socket.once('message', resolve);
  setTimeout(() => reject(new Error('сообщение не пришло по WebSocket за 5 сек')), 5000);
});

await api('/messages', {
  method: 'POST',
  token: owner.token,
  body: { channel_id: textChannel.id, content: 'realtime ping' },
});

const message = await received;
if (message.content !== 'realtime ping') throw new Error(`неожиданное содержимое: ${message.content}`);
console.log('✅ WebSocket доставил сообщение:', {
  id: message.id,
  channel_id: message.channel_id,
  content: message.content,
});

function waitFor(sock, event, match, what) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      if (!match(payload)) return;
      sock.off(event, handler);
      resolve(payload);
    };
    sock.on(event, handler);
    setTimeout(() => reject(new Error(`${what}: не пришло за 5 сек`)), 5000);
  });
}

// Второй участник: «в сети» и «печатает…» должны доходить до владельца.
const member = await login(`ws-member-${stamp}@example.com`);
const { invite } = await api('/invites', {
  method: 'POST', token: owner.token, body: { community_id: community.community.id },
});
await api(`/invites/${invite.id}/join`, { method: 'POST', token: member.token, body: {} });
await socket.emitWithAck('join_community', community.community.id);

const cameOnline = waitFor(socket, 'presence', (p) => p.user_id === member.user.id && p.online, 'presence online');
const memberSocket = io(API, { auth: { token: member.token } });
await cameOnline;
console.log('✅ Владелец увидел, что участник в сети');

const typing = waitFor(socket, 'typing', (p) => p.user_id === member.user.id, 'typing');
memberSocket.emit('typing', { channel_id: textChannel.id });
const typingEvent = await typing;
if (typingEvent.channel_id !== textChannel.id) throw new Error('typing пришёл не для того канала');
console.log('✅ «Печатает…» дошло до владельца');

const wentOffline = waitFor(socket, 'presence', (p) => p.user_id === member.user.id && !p.online, 'presence offline');
memberSocket.close();
await wentOffline;
console.log('✅ Владелец увидел, что участник вышел');

// Посторонний не может слать «печатает» в чужой канал.
const outsider = await login(`ws-outsider-${stamp}@example.com`);
const outsiderSocket = io(API, { auth: { token: outsider.token } });
await new Promise((resolve) => outsiderSocket.on('connect', resolve));
let leaked = false;
const leakHandler = (p) => { if (p.user_id === outsider.user.id) leaked = true; };
socket.on('typing', leakHandler);
outsiderSocket.emit('typing', { channel_id: textChannel.id });
await new Promise((resolve) => setTimeout(resolve, 800));
socket.off('typing', leakHandler);
outsiderSocket.close();
if (leaked) throw new Error('посторонний смог отправить «печатает» в чужой канал');
console.log('✅ Посторонний не может слать «печатает» в чужой канал');

// Неавторизованное подключение должно отклоняться.
const anonSocket = io(API, { auth: {} });
const rejected = await new Promise((resolve) => {
  anonSocket.on('connect_error', (err) => resolve(err.message));
  anonSocket.on('connect', () => resolve(null));
});
if (rejected !== 'unauthorized') throw new Error(`подключение без токена не отклонено: ${rejected}`);
console.log('✅ Подключение без токена отклонено');

// ===== закрытый канал =====
// Участник без доступа не получает сообщений закрытого канала даже через
// комнату сообщества.
const { channel: privateChannel } = await api(`/communities/${community.community.id}/channels`, {
  method: 'POST', token: owner.token, body: { name: 'совет', type: 'text', is_private: true },
});
const member2 = io(API, { auth: { token: member.token } });
await new Promise((resolve) => member2.on('connect', resolve));
await member2.emitWithAck('join_community', community.community.id);
const privateJoin = await member2.emitWithAck('join_channel', privateChannel.id);
if (privateJoin.ok) throw new Error('участник без доступа вошёл в комнату закрытого канала');
let privateLeak = false;
const privateHandler = (m) => { if (m.channel_id === privateChannel.id) privateLeak = true; };
member2.on('message', privateHandler);
member2.on('unread', privateHandler);
const ownerGot = waitFor(socket, 'message', (m) => m.channel_id === privateChannel.id, 'сообщение закрытого канала владельцу');
await socket.emitWithAck('join_channel', privateChannel.id);
await api('/messages', { method: 'POST', token: owner.token, body: { channel_id: privateChannel.id, content: 'секрет' } });
await ownerGot;
await new Promise((resolve) => setTimeout(resolve, 800));
if (privateLeak) throw new Error('сообщение закрытого канала ушло участнику без доступа');
console.log('✅ Закрытый канал: сообщение дошло до владельца и не дошло до участника без доступа');

// ===== доска голосового канала =====
const voice = community.channels.find((c) => c.type === 'voice');
const ownerBoard = await socket.emitWithAck('board:join', voice.id);
if (!ownerBoard.ok || !Array.isArray(ownerBoard.elements) || !ownerBoard.can_clear) {
  throw new Error(`владелец не вошёл на доску: ${JSON.stringify(ownerBoard)}`);
}
const memberBoard = await member2.emitWithAck('board:join', voice.id);
if (!memberBoard.ok || memberBoard.can_clear) throw new Error(`участник на доске: ${JSON.stringify(memberBoard)}`);
console.log('✅ Доска: владелец и участник вошли, очищать может только владелец');

const stickyId = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const gotSticky = waitFor(member2, 'board:upsert', (p) => p.element.id === stickyId, 'стикер участнику');
const saved = await socket.emitWithAck('board:upsert', {
  channel_id: voice.id,
  element: { id: stickyId, type: 'sticky', z: 1, data: { x: 10, y: 20, w: 200, h: 200, text: 'Идея', color: 'yellow', evil: '<script>' } },
});
if (!saved.ok) throw new Error(`стикер не сохранился: ${saved.error}`);
const sticky = await gotSticky;
if (sticky.element.data.text !== 'Идея' || 'evil' in sticky.element.data) throw new Error('стикер дошёл не в том виде');
console.log('✅ Стикер сохранён и дошёл до участника, лишние поля отброшены');

for (const [what, element] of [
  ['чужой цвет', { id: '7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b', type: 'rect', data: { x: 0, y: 0, w: 5, h: 5, color: 'red', width: 2 } }],
  ['неизвестный тип', { id: '7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5c', type: 'iframe', data: {} }],
  ['координаты вне холста', { id: '7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5d', type: 'arrow', data: { x1: 0, y1: 0, x2: 1e9, y2: 0, color: '#e9e9ed', width: 2 } }],
  ['картинка не картинка', { id: '7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5e', type: 'image', data: { x: 0, y: 0, w: 100, h: 100, src: 'data:text/html;base64,PHNjcmlwdD4=' } }],
  ['плохой id', { id: 'not-a-uuid', type: 'rect', data: { x: 0, y: 0, w: 5, h: 5, color: '#e9e9ed', width: 2 } }],
]) {
  const res = await socket.emitWithAck('board:upsert', { channel_id: voice.id, element });
  if (res.ok) throw new Error(`доска приняла кривой элемент: ${what}`);
}
console.log('✅ Доска отклоняет кривые элементы (цвет, тип, координаты, картинка, id)');

const frame = await socket.emitWithAck('board:upsert', {
  channel_id: voice.id,
  element: {
    id: '8f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b', type: 'image', z: 0,
    data: { x: 0, y: 0, w: 160, h: 90, src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
  },
});
if (!frame.ok) throw new Error(`кадр демонстрации не сохранился: ${frame.error}`);
console.log('✅ Кадр демонстрации (картинка) сохраняется на доске');

const draftId = '9f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const gotDraft = waitFor(socket, 'board:draft', (p) => p.element.id === draftId, 'черновик владельцу');
member2.emit('board:draft', {
  channel_id: voice.id,
  element: { id: draftId, type: 'path', data: { points: [0, 0, 10, 10, 20, 5], color: '#8cb4ff', width: 4 } },
});
await gotDraft;
const gotCursor = waitFor(socket, 'board:cursor', (p) => p.id === member.user.id, 'курсор владельцу');
member2.emit('board:cursor', { channel_id: voice.id, x: 42, y: 17 });
const cursor = await gotCursor;
if (cursor.x !== 42 || !cursor.color || !cursor.name) throw new Error('курсор дошёл без координат или имени');
console.log('✅ Черновик линии и курсор участника доходят вживую');

const memberClear = await member2.emitWithAck('board:clear', { channel_id: voice.id });
if (memberClear.ok) throw new Error('участник очистил доску');
const rejoin = await member2.emitWithAck('board:join', voice.id);
if (!rejoin.elements.some((e) => e.id === stickyId)) throw new Error('стикер не сохранился между входами');
console.log('✅ Участник не может очистить доску; элементы сохраняются между входами');

const outsiderBoardSocket = io(API, { auth: { token: outsider.token } });
await new Promise((resolve) => outsiderBoardSocket.on('connect', resolve));
const outsiderJoin = await outsiderBoardSocket.emitWithAck('board:join', voice.id);
const outsiderUpsert = await outsiderBoardSocket.emitWithAck('board:upsert', {
  channel_id: voice.id,
  element: { id: 'af1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b', type: 'rect', data: { x: 0, y: 0, w: 5, h: 5, color: '#e9e9ed', width: 2 } },
});
outsiderBoardSocket.close();
if (outsiderJoin.ok || outsiderUpsert.ok) throw new Error('посторонний попал на доску');
console.log('✅ Посторонний не может войти на доску и рисовать на ней');

const { channel: privateVoice } = await api(`/communities/${community.community.id}/channels`, {
  method: 'POST', token: owner.token, body: { name: 'штаб', type: 'voice', is_private: true },
});
const privateBoard = await member2.emitWithAck('board:join', privateVoice.id);
if (privateBoard.ok) throw new Error('участник без доступа вошёл на доску закрытого голосового');
console.log('✅ Доска закрытого голосового канала недоступна без доступа к каналу');

// ===== гость из звонка по ссылке =====
const anonymousId = crypto.randomUUID();
const guestInvite = (await api('/invites', {
  method: 'POST', token: owner.token, body: { community_id: community.community.id },
})).invite;
const { call } = await api('/calls', {
  method: 'POST', body: { channel_id: voice.id, invite_id: guestInvite.id, anonymous_id: anonymousId },
});
const joined = await api(`/calls/${call.id}/join`, {
  method: 'POST', body: { invite_id: guestInvite.id, anonymous_id: anonymousId },
});
const guestToken = joined.board?.guest_token;
if (!guestToken || joined.board.channel_id !== voice.id) throw new Error('гость не получил пропуск на доску');
const asLogin = await fetch(`${API}/users/me`, { headers: { authorization: `Bearer ${guestToken}` } });
if (asLogin.status !== 401) throw new Error(`пропуск на доску сработал как вход: ${asLogin.status}`);
const guest = io(API, { auth: { token: guestToken } });
await new Promise((resolve, reject) => {
  guest.on('connect', resolve);
  guest.on('connect_error', reject);
});
const guestJoin = await guest.emitWithAck('board:join', voice.id);
if (!guestJoin.ok || guestJoin.me.name !== 'Гость') throw new Error(`гость не вошёл на доску: ${JSON.stringify(guestJoin)}`);
const guestPen = await guest.emitWithAck('board:upsert', {
  channel_id: voice.id,
  element: { id: 'bf1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b', type: 'path', data: { points: [0, 0, 5, 5], color: '#f5a19a', width: 2 } },
});
if (!guestPen.ok) throw new Error(`гость не смог рисовать: ${guestPen.error}`);
const guestOther = await guest.emitWithAck('board:join', privateVoice.id);
const guestClear = await guest.emitWithAck('board:clear', { channel_id: voice.id });
const guestChannel = await Promise.race([
  guest.emitWithAck('join_channel', textChannel.id),
  new Promise((resolve) => setTimeout(() => resolve('no-answer'), 800)),
]);
if (guestOther.ok || guestClear.ok || guestChannel !== 'no-answer') {
  throw new Error('гостевой пропуск открыл что-то кроме своей доски');
}
await api(`/calls/${call.id}/leave`, { method: 'POST', body: { anonymous_id: anonymousId } });
const afterLeave = await guest.emitWithAck('board:join', voice.id);
guest.close();
if (afterLeave.ok) throw new Error('гость вошёл на доску после выхода из звонка');
console.log('✅ Гость рисует на доске своего звонка, но не видит чужих досок, не очищает и не читает чат');
console.log('✅ После выхода из звонка гостевой пропуск на доску больше не действует');

const cleared = waitFor(member2, 'board:cleared', (p) => p.channel_id === voice.id, 'очистка доски');
const ownerClear = await socket.emitWithAck('board:clear', { channel_id: voice.id });
if (!ownerClear.ok) throw new Error('владелец не смог очистить доску');
await cleared;
console.log('✅ Владелец очистил доску, участник увидел это сразу');

member2.close();
socket.close();
anonSocket.close();
process.exit(0);
