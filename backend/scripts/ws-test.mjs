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

socket.close();
anonSocket.close();
process.exit(0);
