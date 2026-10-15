// Проверка статусов, своих эмодзи и стикеров, событий и напоминаний.
//
// Нужен запущенный backend с EXPOSE_DEV_CODE=true и EVENT_SWEEP_SEC=2
// (иначе напоминания придётся ждать по полминуты) и доступ к той же базе
// (DATABASE_URL): часть состояний (истёкшая подпись, прошедшая встреча,
// звонок) проще подготовить прямо в базе.
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';

const API = process.env.API || 'http://localhost:3000';
const stamp = Date.now();
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed += 1;
}

async function api(path, { method = 'GET', token, body, raw, type } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': type ?? 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function must(path, opts) {
  const r = await api(path, opts);
  if (r.status >= 400) throw new Error(`${opts?.method ?? 'GET'} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

async function login(name) {
  const email = `cf-${name}-${stamp}@example.com`;
  const { dev_code: code } = await must('/auth/send-code', { method: 'POST', body: { email } });
  const { token, user } = await must('/auth/verify-code', { method: 'POST', body: { email, code } });
  return { token, id: user.id, email };
}

const st = (r) => r.status;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(who) {
  const socket = io(API, { auth: { token: who.token }, transports: ['websocket'] });
  const seen = [];
  socket.onAny((event, payload) => seen.push({ event, payload }));
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve({ socket, seen }));
    socket.on('connect_error', reject);
  });
}

// Ждём событие, подходящее под условие (из уже пришедших — тоже).
async function waitFor(conn, event, test = () => true, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = conn.seen.find((e) => e.event === event && test(e.payload));
    if (hit) return hit.payload;
    await sleep(100);
  }
  return null;
}

// Картинка 1×1 PNG — для эмодзи и стикеров.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ===== люди и сообщество =====
const anna = await login('anna');     // владелец
const boris = await login('boris');   // модератор
const vera = await login('vera');     // участник
const outsider = await login('outsider');
const muted = await login('muted');
// Заглушённый — до первого его запроса, чтобы мера попала в проверку.
await pool.query(
  `INSERT INTO platform_sanctions (user_id, kind, reason, issued_by_role, ends_at)
   VALUES ($1, 'mute', 'тест', 'superadmin', now() + interval '1 day')`,
  [muted.id],
);
const admin = await login('admin');
await pool.query("UPDATE users SET platform_role = 'admin' WHERE id = $1", [admin.id]);

const { community, channels } = await must('/communities', { method: 'POST', token: anna.token, body: { name: `Общение ${stamp}` } });
const text = channels.find((c) => c.type === 'text');
const voice = channels.find((c) => c.type === 'voice');
const { invite } = await must('/invites', { method: 'POST', token: anna.token, body: { community_id: community.id } });
for (const p of [boris, vera, muted]) await must(`/invites/${invite.id}/join`, { method: 'POST', token: p.token, body: {} });
await must(`/communities/${community.id}/members/${boris.id}`, { method: 'PATCH', token: anna.token, body: { role: 'moderator' } });
const { community: other } = await must('/communities', { method: 'POST', token: outsider.token, body: { name: `Чужое ${stamp}` } });

const membersOf = async (who = anna) => (await must(`/communities/${community.id}/members`, { token: who.token })).members;
const memberOf = async (id) => (await membersOf()).find((m) => m.id === id);

// ===== статусы =====
console.log('--- статусы ---');
const annaConn = await connect(anna);
await must(`/communities/${community.id}`, { token: anna.token });
await annaConn.socket.emitWithAck('join_community', community.id);
const me0 = (await must('/users/me', { token: vera.token })).user;
check('по умолчанию — «в сети», подписи нет', me0.presence_mode === 'online' && me0.status === null);
const setStatus = (who, body) => api('/users/me/status', { method: 'PUT', token: who.token, body });
check('неизвестный режим', st(await setStatus(vera, { mode: 'busy' })) === 400);
check('подпись длиннее 80 символов', st(await setStatus(vera, { text: 'а'.repeat(81) })) === 400);
check('в поле эмодзи — не буквы', st(await setStatus(vera, { text: 'x', emoji: 'abc' })) === 400);
check('срок в прошлом', st(await setStatus(vera, { text: 'x', expires_at: new Date(Date.now() - 1000).toISOString() })) === 400);
check('срок дальше месяца', st(await setStatus(vera, { text: 'x', expires_at: new Date(Date.now() + 40 * 86_400_000).toISOString() })) === 400);

const veraConn = await connect(vera);
check('зашла — остальные видят «в сети»', Boolean(await waitFor(annaConn, 'presence', (p) => p.user_id === vera.id && p.presence === 'online')));
check('в списке участников — online', (await memberOf(vera.id))?.presence === 'online');

annaConn.seen.length = 0;
const dnd = await setStatus(vera, { mode: 'dnd' });
check('режим «не беспокоить» сохранён', st(dnd) === 200 && dnd.data.user.presence_mode === 'dnd');
check('остальные сразу видят «не беспокоить»', Boolean(await waitFor(annaConn, 'presence', (p) => p.user_id === vera.id && p.presence === 'dnd' && p.online === true)));
check('свои вкладки получают свой режим', Boolean(await waitFor(veraConn, 'my_presence', (p) => p.mode === 'dnd')));

annaConn.seen.length = 0;
const until = new Date(Date.now() + 3_600_000).toISOString();
const withText = await setStatus(vera, { text: 'на парах до 15:00', emoji: '🎓', expires_at: until });
check('подпись с эмодзи и сроком', st(withText) === 200 && withText.data.user.status?.text === 'на парах до 15:00' && withText.data.user.status.emoji === '🎓');
check('подпись приходит остальным', Boolean(await waitFor(annaConn, 'presence', (p) => p.user_id === vera.id && p.status?.text === 'на парах до 15:00')));
check('подпись видна в списке участников', (await memberOf(vera.id))?.status?.emoji === '🎓');
check('смена режима подпись не трогает', (await setStatus(vera, { mode: 'online' })).data.user.status?.text === 'на парах до 15:00');

annaConn.seen.length = 0;
await setStatus(vera, { mode: 'invisible' });
check('невидимка для остальных — «не в сети»', Boolean(await waitFor(annaConn, 'presence', (p) => p.user_id === vera.id && p.presence === 'offline' && p.online === false)));
const invisibleRow = await memberOf(vera.id);
check('и в списке участников тоже', invisibleRow?.online === false && invisibleRow.presence === 'offline');
check('а себе — «невидимка»', (await must('/users/me', { token: vera.token })).user.presence_mode === 'invisible');

await setStatus(vera, { mode: 'online' });
annaConn.seen.length = 0;
veraConn.socket.emit('activity', { idle: true });
check('10 минут без активности — «отошёл»', Boolean(await waitFor(annaConn, 'presence', (p) => p.user_id === vera.id && p.presence === 'away')));
veraConn.socket.emit('activity', { idle: false });
check('вернулась — снова «в сети»', Boolean(await waitFor(annaConn, 'presence', (p) => p.user_id === vera.id && p.presence === 'online')));

await pool.query("UPDATE users SET status_expires_at = now() - interval '1 minute' WHERE id = $1", [vera.id]);
check('истёкшая подпись не показывается', (await memberOf(vera.id))?.status === null);
await must('/direct', { method: 'POST', token: anna.token, body: { user_id: vera.id } });
await setStatus(vera, { text: 'в отпуске', emoji: '🌴' });
const conv = (await must('/direct', { token: anna.token })).conversations.find((c) => c.user.id === vera.id);
check('в личке видны режим и подпись собеседника', conv?.user.presence === 'online' && conv.user.status?.text === 'в отпуске');
check('заглушённый подпись не меняет', (await setStatus(muted, { text: 'реклама тут' })).data?.error === 'account_muted');
check('но режим — может', st(await setStatus(muted, { mode: 'dnd' })) === 200);
check('очистить подпись', (await setStatus(vera, { text: '', emoji: '' })).data.user.status === null);

// ===== эмодзи и стикеры =====
console.log('--- эмодзи и стикеры ---');
const upload = (who, kind, name, body = PNG, type = 'image/png', cid = community.id) => api(
  `/communities/${cid}/emojis?kind=${kind}&name=${encodeURIComponent(name)}`,
  { method: 'POST', token: who.token, raw: body, type },
);
check('участник эмодзи не загружает', st(await upload(vera, 'emoji', 'кот')) === 403);
const cat = await upload(boris, 'emoji', 'Кот');
check('модератор загружает эмодзи (имя — строчными)', st(cat) === 201 && cat.data.emoji.name === 'кот' && cat.data.emoji.url.startsWith('/attachments/'));
check('то же имя второй раз — нельзя', (await upload(anna, 'emoji', 'КОТ')).data?.error === 'emoji_exists');
check('имя с пробелом — нельзя', st(await upload(boris, 'emoji', 'два слова')) === 400);
check('имя из одной буквы — нельзя', st(await upload(boris, 'emoji', 'к')) === 400);
check('не картинка — нельзя', st(await upload(boris, 'emoji', 'текст', Buffer.from('hello'), 'text/plain')) === 415);
check('эмодзи больше 256 КБ — нельзя', st(await upload(boris, 'emoji', 'большой', Buffer.alloc(300 * 1024, 1))) === 413);
check('неизвестный вид', st(await upload(boris, 'gif', 'кот2')) === 400);
const hi = await upload(anna, 'sticker', 'привет');
check('владелец загружает стикер', st(hi) === 201 && hi.data.emoji.kind === 'sticker');
check('стикер может называться как эмодзи', st(await upload(anna, 'sticker', 'кот')) === 201);
check('заглушённому не загрузить', (await upload(muted, 'emoji', 'спам')).data?.error === 'account_muted');
const list = await must(`/communities/${community.id}/emojis`, { token: vera.token });
check('участник видит эмодзи и стикеры', list.emojis.length === 1 && list.stickers.length === 2 && list.limits.emoji.max === 50);
check('посторонний — нет', st(await api(`/communities/${community.id}/emojis`, { token: outsider.token })) === 403);
const otherSticker = (await upload(outsider, 'sticker', 'чужой', PNG, 'image/png', other.id)).data.emoji;

const post = (who, body) => api('/messages', { method: 'POST', token: who.token, body: { channel_id: text.id, ...body } });
const plain = (await post(vera, { content: 'Привет :кот: !' })).data.message;
check('эмодзи в тексте — просто «:кот:»', plain.content === 'Привет :кот: !');
const react = (who, emoji, id = plain.id) => api(`/messages/${id}/reactions`, { method: 'PUT', token: who.token, body: { emoji } });
const r1 = await react(vera, ':кот:');
check('реакция своим эмодзи', st(r1) === 200 && r1.data.reactions.some((r) => r.emoji === ':кот:' && r.count === 1));
check('стандартные реакции идут первыми', (await react(anna, '👍')).data.reactions[0].emoji === '👍');
const r2 = await react(vera, ':Кот:');
check('«:Кот:» — та же реакция, второе нажатие снимает', !r2.data.reactions.some((r) => r.emoji === ':кот:'));
check('несуществующий эмодзи — нельзя', st(await react(vera, ':пёс:')) === 400);
check('стикер как реакция — нельзя', st(await react(vera, ':привет:')) === 400);
check('произвольный текст — нельзя', st(await react(vera, 'лол')) === 400);
const dmMessage = (await must('/messages', { method: 'POST', token: anna.token, body: { channel_id: conv.id, content: 'привет' } })).message;
check('в личке своих эмодзи нет', st(await react(vera, ':кот:', dmMessage.id)) === 400);

const stickerMsg = await post(vera, { sticker_id: hi.data.emoji.id });
check('стикер отправляется сообщением', st(stickerMsg) === 201 && stickerMsg.data.message.sticker?.url && stickerMsg.data.message.content === '');
check('стикер с текстом — нельзя', (await post(vera, { sticker_id: hi.data.emoji.id, content: 'и текст' })).data?.error === 'sticker_must_be_alone');
check('чужой стикер — нельзя', (await post(vera, { sticker_id: otherSticker.id })).data?.error === 'invalid_sticker');
check('эмодзи вместо стикера — нельзя', (await post(vera, { sticker_id: cat.data.emoji.id })).data?.error === 'invalid_sticker');
check('стикер в личку — нельзя', (await api('/messages', { method: 'POST', token: anna.token, body: { channel_id: conv.id, sticker_id: hi.data.emoji.id } })).data?.error === 'invalid_sticker');
check('стикер не правится', st(await api(`/messages/${stickerMsg.data.message.id}`, { method: 'PATCH', token: vera.token, body: { content: 'x' } })) === 400);
check('участник не удаляет эмодзи', st(await api(`/communities/${community.id}/emojis/${hi.data.emoji.id}`, { method: 'DELETE', token: vera.token })) === 403);
check('модератор удаляет стикер', st(await api(`/communities/${community.id}/emojis/${hi.data.emoji.id}`, { method: 'DELETE', token: boris.token })) === 204);
const feed = (await must(`/messages?channel_id=${text.id}`, { token: anna.token })).messages;
const gone = feed.find((m) => m.id === stickerMsg.data.message.id);
check('в старом сообщении — «стикер удалён»', gone?.sticker?.removed === true && gone.sticker.url === null);
check('удалённый стикер больше не отправить', (await post(vera, { sticker_id: hi.data.emoji.id })).data?.error === 'invalid_sticker');
check('имя освобождается после удаления', st(await upload(anna, 'sticker', 'привет')) === 201);

await pool.query("UPDATE communities SET platform_status = 'frozen' WHERE id = $1", [community.id]);
check('в замороженном сообществе не загрузить', (await upload(boris, 'emoji', 'лёд')).data?.error === 'community_frozen');
await pool.query("UPDATE communities SET platform_status = 'active' WHERE id = $1", [community.id]);

const staffRemove = (body) => api(`/platform/staff/communities/${community.id}/emojis/${cat.data.emoji.id}/remove`, { method: 'POST', token: admin.token, body });
check('служба платформы видит эмодзи в карточке сообщества', (await must(`/platform/staff/communities/${community.id}`, { token: admin.token })).emojis.some((e) => e.id === cat.data.emoji.id));
check('без причины служба не убирает', st(await staffRemove({})) === 400);
check('модератор сообщества не пользуется маршрутом службы', st(await api(`/platform/staff/communities/${community.id}/emojis/${cat.data.emoji.id}/remove`, { method: 'POST', token: boris.token, body: { reason: 'x' } })) === 403);
check('служба убирает эмодзи', st(await staffRemove({ reason: 'оскорбительная картинка' })) === 200);
const { rows: emojiAudit } = await pool.query(
  "SELECT reason FROM staff_audit_log WHERE action = 'community_emoji_removed' AND target_id = $1", [community.id],
);
check('решение — в журнале', emojiAudit[0]?.reason === 'оскорбительная картинка');
check('эмодзи пропал у всех', (await must(`/communities/${community.id}/emojis`, { token: vera.token })).emojis.length === 0);
check('реакцию им больше не поставить', st(await react(vera, ':кот:')) === 400);

// ===== события =====
console.log('--- события ---');
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const createEvent = (who, body) => api(`/communities/${community.id}/events`, { method: 'POST', token: who.token, body });
check('участник событие не создаёт', st(await createEvent(vera, { title: 'x', starts_at: inHours(2) })) === 403);
check('без названия — нельзя', st(await createEvent(boris, { starts_at: inHours(2) })) === 400);
check('в прошлом — нельзя', (await createEvent(boris, { title: 'x', starts_at: inHours(-1) })).data?.error === 'event_in_past');
check('конец раньше начала — нельзя', st(await createEvent(boris, { title: 'x', starts_at: inHours(2), ends_at: inHours(1) })) === 400);
check('место — только голосовой канал этого сообщества', (await createEvent(boris, { title: 'x', starts_at: inHours(2), channel_id: text.id })).data?.error === 'invalid_event_channel');
const created = await createEvent(boris, {
  title: 'Созвон по макету', description: 'Обсуждаем главную', starts_at: inHours(3), ends_at: inHours(4),
  channel_id: voice.id, repeat_weekly: true,
});
check('модератор создаёт событие в голосовом канале', st(created) === 201 && created.data.event.channel?.id === voice.id && created.data.event.repeat_weekly);
const eventId = created.data.event.id;
const upcomingFor = (who) => must(`/communities/${community.id}/events`, { token: who.token });
const veraView = await upcomingFor(vera);
check('участник видит ближайшие события', veraView.events.some((e) => e.id === eventId) && veraView.can_manage === false);
check('модератор может управлять', (await upcomingFor(boris)).can_manage === true);
check('посторонний не видит', st(await api(`/communities/${community.id}/events`, { token: outsider.token })) === 403);

const rsvp = (who, answer, id = eventId) => api(`/communities/${community.id}/events/${id}/rsvp`, { method: 'PUT', token: who.token, body: { answer } });
const going = await rsvp(vera, 'going');
check('«Пойду»', st(going) === 200 && going.data.event.my_answer === 'going' && going.data.event.counts.going === 1);
await rsvp(anna, 'maybe');
const noAnswer = await rsvp(muted, 'no');
check('счётчики ответов', noAnswer.data.event.counts.going === 1 && noAnswer.data.event.counts.maybe === 1 && noAnswer.data.event.counts.no === 1);
check('в списке людей — без отказавшихся', noAnswer.data.event.people.length === 2);
check('непонятный ответ', st(await rsvp(vera, 'yes')) === 400);
check('посторонний не отвечает', st(await rsvp(outsider, 'going')) === 403);
check('ответ можно убрать', (await rsvp(muted, null)).data.event.counts.no === 0);

check('участник не правит событие', st(await api(`/communities/${community.id}/events/${eventId}`, { method: 'PATCH', token: vera.token, body: { title: 'x' } })) === 403);
const edited = await api(`/communities/${community.id}/events/${eventId}`, { method: 'PATCH', token: boris.token, body: { title: 'Созвон по макету v2' } });
check('модератор переименовывает', edited.data?.event?.title === 'Созвон по макету v2' && edited.data.event.counts.going === 1);

// Напоминания: за 15 минут и в момент начала.
const soonEvent = (await createEvent(boris, { title: 'Скоро', starts_at: inHours(0.15), channel_id: voice.id, repeat_weekly: true })).data.event;
await rsvp(vera, 'going', soonEvent.id);
const soonHit = await waitFor(veraConn, 'event_reminder', (p) => p.id === soonEvent.id && p.kind === 'soon', 10000);
check('за 15 минут — напоминание ответившим «пойду»', Boolean(soonHit) && soonHit.channel_id === voice.id && soonHit.community_name.startsWith('Общение'));
check('не ответившим — не приходит', !annaConn.seen.some((e) => e.event === 'event_reminder' && e.payload.id === soonEvent.id));
await pool.query("UPDATE community_events SET starts_at = now() - interval '1 minute', ends_at = NULL WHERE id = $1", [soonEvent.id]);
check('в момент начала — второе напоминание', Boolean(await waitFor(veraConn, 'event_reminder', (p) => p.id === soonEvent.id && p.kind === 'start', 10000)));
check('всему сообществу — «события обновились»', Boolean(await waitFor(annaConn, 'events_updated', (p) => p.community_id === community.id, 5000)));
const series = await pool.query('SELECT starts_at FROM community_events WHERE series_id = $1 ORDER BY starts_at', [soonEvent.series_id]);
check('повтор: следующая встреча через неделю', series.rows.length === 2
  && Math.abs(new Date(series.rows[1].starts_at) - new Date(series.rows[0].starts_at) - 7 * 86_400_000) < 1000);
const live = (await upcomingFor(vera)).events.find((e) => e.id === soonEvent.id);
check('идущая встреча отмечена «идёт сейчас»', live?.live === true);
await sleep(2500);
check('повтор создаётся один раз', (await pool.query('SELECT 1 FROM community_events WHERE series_id = $1', [soonEvent.series_id])).rows.length === 2);

// Явка: встреча прошла, в звонке были двое, один из них отвечал «пойду».
const { rows: [pastEvent] } = await pool.query(
  `INSERT INTO community_events (community_id, series_id, title, starts_at, ends_at, channel_id, created_by, reminded_soon_at, reminded_start_at)
   VALUES ($1, gen_random_uuid(), 'Прошлый созвон', now() - interval '3 hours', now() - interval '2 hours', $2, $3, now(), now()) RETURNING id`,
  [community.id, voice.id, boris.id],
);
await pool.query("INSERT INTO event_rsvps (event_id, user_id, answer) VALUES ($1, $2, 'going'), ($1, $3, 'going')", [pastEvent.id, vera.id, anna.id]);
const { rows: [pastCall] } = await pool.query(
  "INSERT INTO calls (channel_id, started_at, ended_at) VALUES ($1, now() - interval '3 hours', now() - interval '2 hours') RETURNING id", [voice.id],
);
await pool.query(
  `INSERT INTO call_participants (call_id, user_id, joined_at, left_at) VALUES
   ($1, $2, now() - interval '170 minutes', now() - interval '130 minutes'),
   ($1, $3, now() - interval '150 minutes', now() - interval '125 minutes'),
   ($1, $4, now() - interval '5 hours', now() - interval '4 hours')`,
  [pastCall.id, vera.id, boris.id, muted.id],
);
const past = await must(`/communities/${community.id}/events?scope=past`, { token: anna.token });
const pastRow = past.events.find((e) => e.id === pastEvent.id);
check('явка прошедшей встречи: пришли двое, из «пойду» — один', pastRow?.attendance?.came === 2 && pastRow.attendance.going_came === 1);
check('на прошедшую встречу ответить нельзя', (await rsvp(vera, 'going', pastEvent.id)).data?.error === 'event_ended');

// Отмена.
veraConn.seen.length = 0;
check('участник не отменяет', st(await api(`/communities/${community.id}/events/${eventId}`, { method: 'DELETE', token: vera.token })) === 403);
check('модератор отменяет', st(await api(`/communities/${community.id}/events/${eventId}`, { method: 'DELETE', token: boris.token })) === 204);
check('собиравшимся приходит «отменено»', Boolean(await waitFor(veraConn, 'event_reminder', (p) => p.id === eventId && p.kind === 'cancelled')));
check('отменённого нет в списке', !(await upcomingFor(vera)).events.some((e) => e.id === eventId));
check('на отменённое не ответить', st(await rsvp(vera, 'going')) === 410);

// Проверяющий от платформы видит, но не отвечает.
await must(`/platform/staff/communities/${community.id}/inspect`, { method: 'POST', token: admin.token, body: { reason: 'проверка событий' } });
check('проверяющий видит события', st(await api(`/communities/${community.id}/events`, { token: admin.token })) === 200);
check('но не отвечает', st(await rsvp(admin, 'going', soonEvent.id)) === 403);
await pool.query("UPDATE communities SET platform_status = 'frozen' WHERE id = $1", [community.id]);
check('в замороженном событие не создать', (await createEvent(boris, { title: 'x', starts_at: inHours(2) })).data?.error === 'community_frozen');
await pool.query("UPDATE communities SET platform_status = 'active' WHERE id = $1", [community.id]);

// ===== окно предупреждения =====
console.log('--- предупреждения ---');
const warn = (reason) => must(`/platform/staff/users/${vera.id}/sanctions`, { method: 'POST', token: admin.token, body: { kind: 'warning', reason } });
await warn('Реклама в общем чате');
await warn('Опять реклама');
const veraMe = await must('/platform/me', { token: vera.token });
const warnings = veraMe.sanctions.filter((x) => x.kind === 'warning');
check('у предупреждения — номер за 90 дней', warnings.map((w) => w.warning_number).sort().join(',') === '1,2' && warnings[0].warning_window_days === 90);
check('кто вынес — ролью, без имени', warnings[0].issued_by_role === 'admin' && !('issued_by' in warnings[0]));
check('новые предупреждения не просмотрены', warnings.every((w) => w.seen === false));
await must('/platform/me/seen', { method: 'POST', token: vera.token, body: { sanction_ids: [warnings[0].id] } });
check('«Понятно» отмечает просмотренным', (await must('/platform/me', { token: vera.token })).sanctions.find((x) => x.id === warnings[0].id).seen === true);

annaConn.socket.close();
veraConn.socket.close();
await pool.end();
console.log();
if (failed) {
  console.log(`❌ Провалено проверок: ${failed}`);
  process.exit(1);
}
console.log('✅ Статусы, эмодзи, стикеры, события и предупреждения работают как задумано');
process.exit(0);
