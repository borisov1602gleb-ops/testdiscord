// Проверка службы платформы: роли и их иерархия, жалобы, меры,
// обжалования, состояние сообществ, журнал, настройки и выгрузка.
//
// Нужен запущенный backend с EXPOSE_DEV_CODE=true и доступ к той же базе
// (DATABASE_URL): первого суперадминистратора скрипт назначает прямо в
// базе — так же, как это делает настройка сервера SUPERADMIN_EMAILS.
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';

const API = process.env.API || 'http://localhost:3000';
const stamp = Date.now();
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed += 1;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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
  const email = `pl-${name}-${stamp}@example.com`;
  const { dev_code: code } = await must('/auth/send-code', { method: 'POST', body: { email } });
  const { token, user } = await must('/auth/verify-code', { method: 'POST', body: { email, code } });
  return { token, id: user.id, email };
}

const st = (r) => r.status;

// ===== люди =====
const sup = await login('super');
// Первый суперадминистратор — из настроек сервера; здесь — прямо в базе,
// до первого запроса с его токеном.
await pool.query("UPDATE users SET platform_role = 'superadmin' WHERE id = $1", [sup.id]);
const adm = await login('admin');
const mod = await login('moder');
const anna = await login('anna');
const boris = await login('boris');
const vera = await login('vera');
const outsider = await login('outsider');

console.log('--- роли ---');
const supMe = await must('/platform/me', { token: sup.token });
check('суперадминистратор видит свою роль', supMe.role === 'superadmin');
check('у него есть право назначать администраторов', supMe.permissions.includes('manage_admins'));
const annaMe = await must('/platform/me', { token: anna.token });
check('обычный пользователь — user без прав', annaMe.role === 'user' && annaMe.permissions.length === 0);
check('обычному закрыта панель жалоб', st(await api('/platform/staff/reports', { token: anna.token })) === 403);

check('суперадмин назначает администратора', st(await api(`/platform/staff/users/${adm.id}/role`, {
  method: 'PATCH', token: sup.token, body: { role: 'admin', reason: 'набор команды' },
})) === 200);
check('администратор назначает модератора', st(await api(`/platform/staff/users/${mod.id}/role`, {
  method: 'PATCH', token: adm.token, body: { role: 'moderator', reason: 'набор команды' },
})) === 200);
check('без причины роль не меняется', st(await api(`/platform/staff/users/${mod.id}/role`, {
  method: 'PATCH', token: adm.token, body: { role: 'moderator' },
})) === 400);
check('администратор не назначает администраторов', st(await api(`/platform/staff/users/${anna.id}/role`, {
  method: 'PATCH', token: adm.token, body: { role: 'admin', reason: 'x' },
})) === 403);
check('модератор не назначает никого', st(await api(`/platform/staff/users/${anna.id}/role`, {
  method: 'PATCH', token: mod.token, body: { role: 'moderator', reason: 'x' },
})) === 403);
check('суперадминистратора через интерфейс не назначить', st(await api(`/platform/staff/users/${anna.id}/role`, {
  method: 'PATCH', token: sup.token, body: { role: 'superadmin', reason: 'x' },
})) === 400);
check('свою роль не поменять', st(await api(`/platform/staff/users/${adm.id}/role`, {
  method: 'PATCH', token: adm.token, body: { role: 'user', reason: 'x' },
})) === 400);

// ===== сообщество и нарушения =====
const { community, channels } = await must('/communities', { method: 'POST', token: anna.token, body: { name: `Платформа ${stamp}` } });
const text = channels.find((c) => c.type === 'text');
const voice = channels.find((c) => c.type === 'voice');
const { invite } = await must('/invites', { method: 'POST', token: anna.token, body: { community_id: community.id } });
for (const p of [boris, vera]) await must(`/invites/${invite.id}/join`, { method: 'POST', token: p.token, body: {} });
const post = (who, content) => must('/messages', { method: 'POST', token: who.token, body: { channel_id: text.id, content } })
  .then((r) => r.message);
for (let i = 1; i <= 7; i += 1) await post(i % 2 ? anna : boris, `Обычное сообщение ${i}`);
const spam = await post(vera, 'Купите курс по ссылке!!!');
const spam2 = await post(vera, 'Ещё реклама');
const spam3 = await post(vera, 'И ещё реклама');
const { conversation } = await must('/direct', { method: 'POST', token: vera.token, body: { user_id: boris.id } });
const dm = (await must('/messages', { method: 'POST', token: vera.token, body: { channel_id: conversation.id, content: 'Переведи мне денег' } })).message;

console.log('--- жалобы в службу платформы ---');
const report = (who, body) => api('/platform/reports', { method: 'POST', token: who.token, body });
check('жалоба на сообщение принята', st(await report(boris, { target_type: 'message', target_id: spam.id, reason: 'spam', comment: 'реклама' })) === 201);
check('повтор той же жалобы ничего не добавляет', st(await report(boris, { target_type: 'message', target_id: spam.id, reason: 'spam' })) === 200);
check('жалоба на сообщение в личке теперь возможна', st(await report(boris, { target_type: 'message', target_id: dm.id, reason: 'abuse' })) === 201);
check('на своё сообщение — нельзя', st(await report(vera, { target_type: 'message', target_id: spam.id, reason: 'spam' })) === 400);
check('на чужую ленту, которой не видишь, — нельзя', st(await report(outsider, { target_type: 'message', target_id: spam.id, reason: 'spam' })) === 403);
check('жалоба на человека', st(await report(boris, { target_type: 'user', target_id: vera.id, reason: 'abuse' })) === 201);
check('на незнакомого — нельзя', st(await report(outsider, { target_type: 'user', target_id: vera.id, reason: 'abuse' })) === 404);
check('жалоба на сообщество от участника', st(await report(boris, { target_type: 'community', target_id: community.id, reason: 'other' })) === 201);
check('неизвестная причина', st(await report(boris, { target_type: 'user', target_id: vera.id, reason: 'boring' })) === 400);

const { reports: openReports } = await must('/platform/staff/reports?status=open', { token: mod.token });
const spamReport = openReports.find((r) => r.message?.id === spam.id);
check('модератор видит жалобу в очереди', Boolean(spamReport));
const detail = await must(`/platform/staff/reports/${spamReport.id}`, { token: mod.token });
check('контекст: сообщение и до пяти перед ним', detail.context.length === 6 && detail.context.at(-1).reported);
const { rows: viewed } = await pool.query(
  "SELECT 1 FROM staff_audit_log WHERE action = 'view_report_context' AND target_id = $1 AND actor_id = $2",
  [spamReport.id, mod.id],
);
check('просмотр контекста записан в журнал', viewed.length === 1);

console.log('--- удаление сообщений ---');
check('модератор удаляет сообщение из жалобы', st(await api(`/platform/staff/messages/${spam.id}/remove`, {
  method: 'POST', token: mod.token, body: { reason: 'спам', report_id: spamReport.id },
})) === 200);
const feed = (await must(`/messages?channel_id=${text.id}`, { token: boris.token })).messages;
const removed = feed.find((m) => m.id === spam.id);
check('у всех — «удалено модерацией платформы»', removed?.deleted && removed?.removed_by_platform && removed.content === '');
const { rows: [kept] } = await pool.query('SELECT content FROM messages WHERE id = $1', [spam.id]);
check('текст хранится для обжалования', kept.content === 'Купите курс по ссылке!!!');
check('модератор не удаляет без жалобы', st(await api(`/platform/staff/messages/${spam2.id}/remove`, {
  method: 'POST', token: mod.token, body: { reason: 'x' },
})) === 403);
check('администратор удаляет по ссылке, по требованию госоргана', st(await api(`/platform/staff/messages/${spam2.id}/remove`, {
  method: 'POST', token: adm.token, body: { reason: 'предписание № 1', final: true },
})) === 200);
check('удаление без причины не проходит', st(await api(`/platform/staff/messages/${spam3.id}/remove`, {
  method: 'POST', token: adm.token, body: {},
})) === 400);

console.log('--- меры против людей ---');
const sanction = (who, target, body) => api(`/platform/staff/users/${target.id}/sanctions`, { method: 'POST', token: who.token, body });
check('модератор предупреждает', st(await sanction(mod, vera, { kind: 'warning', reason: 'реклама' })) === 201);
const muteRes = await sanction(mod, vera, { kind: 'mute', days: 1, reason: 'реклама снова' });
check('модератор заглушает на день', st(muteRes) === 201);
check('заглушённый не пишет', (await api('/messages', { method: 'POST', token: vera.token, body: { channel_id: text.id, content: 'а я всё равно' } })).data?.error === 'account_muted');
check('и не ставит реакции', st(await api(`/messages/${feed[0].id}/reactions`, { method: 'PUT', token: vera.token, body: { emoji: '👍' } })) === 403);
check('но читает', st(await api(`/messages?channel_id=${text.id}`, { token: vera.token })) === 200);
const { call } = await must('/calls', { method: 'POST', token: vera.token, body: { channel_id: voice.id } });
const joined = await must(`/calls/${call.id}/join`, { method: 'POST', token: vera.token, body: {} });
const grant = JSON.parse(Buffer.from(joined.livekit.token.split('.')[1], 'base64url').toString()).video;
check('в звонке слушает, но не говорит', grant.canPublish === false && grant.canSubscribe === true);
await must(`/calls/${call.id}/leave`, { method: 'POST', token: vera.token, body: {} });
check('модератор не блокирует', st(await sanction(mod, vera, { kind: 'suspend', days: 7, reason: 'x' })) === 403);
check('неверный срок', st(await sanction(adm, vera, { kind: 'suspend', days: 3, reason: 'x' })) === 400);
check('модератор не наказывает администратора', (await sanction(mod, adm, { kind: 'warning', reason: 'x' })).data?.error === 'target_outranks_you');
check('администратор не наказывает суперадмина', st(await sanction(adm, sup, { kind: 'warning', reason: 'x' })) === 403);
check('себя наказать нельзя', st(await sanction(adm, adm, { kind: 'warning', reason: 'x' })) === 400);

const veraSocket = io(API, { auth: { token: vera.token }, reconnection: false });
await new Promise((resolve) => veraSocket.on('connect', resolve));
const kicked = new Promise((resolve) => veraSocket.on('disconnect', () => resolve(true)));
const suspendRes = await sanction(adm, vera, { kind: 'suspend', days: 7, reason: 'систематический спам' });
check('администратор блокирует на неделю', st(suspendRes) === 201);
check('открытая вкладка сразу отключается', await Promise.race([kicked, new Promise((r) => setTimeout(() => r(false), 3000))]));
const blockedRes = await api('/communities', { token: vera.token });
check('заблокированный никуда не проходит', blockedRes.status === 403 && blockedRes.data.error === 'account_blocked'
  && blockedRes.data.details.reason === 'систематический спам');
const veraMe = await must('/platform/me', { token: vera.token });
check('но видит экран блокировки с причиной и сроком', veraMe.block?.kind === 'suspend' && Boolean(veraMe.block.ends_at));
const rejected = await new Promise((resolve) => {
  const s = io(API, { auth: { token: vera.token }, reconnection: false });
  s.on('connect_error', (err) => { s.close(); resolve(err.message); });
  s.on('connect', () => { s.close(); resolve('connected'); });
});
check('и не подключается к реалтайму', rejected === 'account_blocked');

console.log('--- обжалования ---');
const sanctionsOf = async (who) => (await must('/platform/me', { token: who.token })).sanctions;
let vs = await sanctionsOf(vera);
const suspendS = vs.find((s) => s.kind === 'suspend');
const warningS = vs.find((s) => s.kind === 'warning');
const removedS = vs.find((s) => s.kind === 'message_removed' && s.message_id === spam.id);
const finalS = vs.find((s) => s.kind === 'message_removed' && s.message_id === spam2.id);
const muteS = vs.find((s) => s.kind === 'mute');
const appeal = (who, body) => api('/platform/appeals', { method: 'POST', token: who.token, body });
check('слишком короткое обжалование', st(await appeal(vera, { sanction_id: suspendS.id, text: 'нет' })) === 400);
check('заблокированный подаёт обжалование', st(await appeal(vera, { sanction_id: suspendS.id, text: 'Это была не реклама, а ссылка на наш же курс' })) === 201);
check('второй раз — нельзя', st(await appeal(vera, { sanction_id: suspendS.id, text: 'Ну пожалуйста, разблокируйте' })) === 409);
check('предупреждение не обжалуется', st(await appeal(vera, { sanction_id: warningS.id, text: 'Не согласна с предупреждением' })) === 400);
check('удаление по требованию госоргана не обжалуется', st(await appeal(vera, { sanction_id: finalS.id, text: 'Верните моё сообщение' })) === 409);
check('чужую меру не обжаловать', st(await appeal(boris, { sanction_id: muteS.id, text: 'Заступаюсь за Веру' })) === 404);

let { appeals } = await must('/platform/staff/appeals', { token: adm.token });
let suspendAppeal = appeals.find((a) => a.sanction.id === suspendS.id);
check('наказавший администратор не рассматривает своё', suspendAppeal && !suspendAppeal.can_review && suspendAppeal.cannot_review_reason === 'own_decision');
check('и сервер это не пропускает', (await api(`/platform/staff/appeals/${suspendAppeal.id}/decide`, {
  method: 'POST', token: adm.token, body: { decision: 'accept', response: 'ок' },
})).data?.error === 'own_decision');
check('модератор обжалования не рассматривает', st(await api('/platform/staff/appeals', { token: mod.token })) === 403);
check('ответ обязателен', st(await api(`/platform/staff/appeals/${suspendAppeal.id}/decide`, {
  method: 'POST', token: sup.token, body: { decision: 'accept' },
})) === 400);
check('суперадмин удовлетворяет', st(await api(`/platform/staff/appeals/${suspendAppeal.id}/decide`, {
  method: 'POST', token: sup.token, body: { decision: 'accept', response: 'Похоже на ошибку, снимаем блокировку' },
})) === 200);
check('блокировка снята сразу', st(await api('/communities', { token: vera.token })) === 200);

check('обжалование удаления сообщения', st(await appeal(vera, { sanction_id: removedS.id, text: 'Это был анонс нашего собственного мероприятия' })) === 201);
check('обжалование заглушения', st(await appeal(vera, { sanction_id: muteS.id, text: 'Я больше не буду, снимите заглушение' })) === 201);
({ appeals } = await must('/platform/staff/appeals', { token: adm.token }));
const removedAppeal = appeals.find((a) => a.sanction.id === removedS.id);
const muteAppeal = appeals.find((a) => a.sanction.id === muteS.id);
check('администратор рассматривает решение модератора', removedAppeal?.can_review && muteAppeal?.can_review);
check('удовлетворено — сообщение вернулось', st(await api(`/platform/staff/appeals/${removedAppeal.id}/decide`, {
  method: 'POST', token: adm.token, body: { decision: 'accept', response: 'Удалено по ошибке' },
})) === 200);
const back = (await must(`/messages?channel_id=${text.id}`, { token: boris.token })).messages.find((m) => m.id === spam.id);
check('текст снова виден', back && !back.deleted && back.content === 'Купите курс по ссылке!!!');
check('отказ с ответом', st(await api(`/platform/staff/appeals/${muteAppeal.id}/decide`, {
  method: 'POST', token: adm.token, body: { decision: 'reject', response: 'Нарушение подтверждено, заглушение остаётся' },
})) === 200);
vs = await sanctionsOf(vera);
const muteAfter = vs.find((s) => s.id === muteS.id);
check('человек видит отказ и ответ', muteAfter.appeal.status === 'rejected' && muteAfter.appeal.response.includes('остаётся') && muteAfter.active);
check('заглушение по-прежнему действует', (await api('/messages', { method: 'POST', token: vera.token, body: { channel_id: text.id, content: 'x' } })).data?.error === 'account_muted');
check('модератор снимает свою меру', st(await api(`/platform/staff/sanctions/${muteS.id}/revoke`, {
  method: 'POST', token: mod.token, body: { reason: 'договорились' },
})) === 200);
check('и Вера снова пишет', st(await api('/messages', { method: 'POST', token: vera.token, body: { channel_id: text.id, content: 'Спасибо, больше не буду' } })) === 201);
check('модератор не снимает чужую меру', st(await api(`/platform/staff/sanctions/${finalS.id}/revoke`, {
  method: 'POST', token: mod.token, body: { reason: 'x' },
})) === 403);
check('удаление по требованию госоргана не снимается', (await api(`/platform/staff/sanctions/${finalS.id}/revoke`, {
  method: 'POST', token: sup.token, body: { reason: 'x' },
})).data?.error === 'final_decision');

console.log('--- сообщества ---');
const setStatus = (who, status, reason = 'проверка') => api(`/platform/staff/communities/${community.id}/status`, {
  method: 'POST', token: who.token, body: { status, reason },
});
check('модератор не трогает сообщества', st(await setStatus(mod, 'frozen')) === 403);
check('администратор замораживает', st(await setStatus(adm, 'frozen', 'массовый спам')) === 200);
check('в замороженном не пишут', (await api('/messages', { method: 'POST', token: anna.token, body: { channel_id: text.id, content: 'x' } })).data?.error === 'community_frozen');
check('но читают', st(await api(`/messages?channel_id=${text.id}`, { token: anna.token })) === 200);
check('новых приглашений нет', (await api('/invites', { method: 'POST', token: anna.token, body: { community_id: community.id } })).data?.error === 'invites_disabled');
check('звонков тоже', (await api('/calls', { method: 'POST', token: boris.token, body: { channel_id: voice.id } })).data?.error === 'community_frozen');
check('и каналы не создаются', (await api(`/communities/${community.id}/channels`, { method: 'POST', token: anna.token, body: { name: 'x', type: 'text' } })).data?.error === 'community_frozen');
const preview = await must(`/invites/${invite.id}`);
check('ссылка показывает, что не работает', preview.valid === false && preview.restricted === true);
const annaS = (await sanctionsOf(anna)).find((s) => s.kind === 'community_frozen');
check('владелец видит меру и может обжаловать', annaS?.can_appeal === true && annaS.community?.id === community.id);
check('владелец обжалует', st(await appeal(anna, { sanction_id: annaS.id, text: 'Спамера уже убрали, разморозьте' })) === 201);
({ appeals } = await must('/platform/staff/appeals', { token: sup.token }));
const freezeAppeal = appeals.find((a) => a.sanction.id === annaS.id);
check('суперадмин удовлетворяет — сообщество разморожено', st(await api(`/platform/staff/appeals/${freezeAppeal.id}/decide`, {
  method: 'POST', token: sup.token, body: { decision: 'accept', response: 'Принято' },
})) === 200 && st(await api('/messages', { method: 'POST', token: anna.token, body: { channel_id: text.id, content: 'Мы снова работаем' } })) === 201);

check('администратор скрывает приглашения', st(await setStatus(adm, 'invites_hidden')) === 200);
check('по старой ссылке не вступить', (await api(`/invites/${invite.id}/join`, { method: 'POST', token: outsider.token, body: {} })).data?.error === 'invites_disabled');
check('гостю в звонок тоже нельзя', (await api('/calls', { method: 'POST', body: { channel_id: voice.id, invite_id: invite.id, anonymous_id: 'guest-x' } })).data?.error === 'invites_disabled');
check('писать внутри можно', st(await api('/messages', { method: 'POST', token: anna.token, body: { channel_id: text.id, content: 'Внутри всё работает' } })) === 201);
check('администратор не удаляет сообщество', st(await setStatus(adm, 'deleted')) === 403);
check('суперадмин удаляет', st(await setStatus(sup, 'deleted', 'запрещённая деятельность')) === 200);
check('сообщество пропало из списка', !(await must('/communities', { token: boris.token })).communities.some((c) => c.id === community.id));
check('и не открывается', st(await api(`/communities/${community.id}`, { token: anna.token })) === 404);
check('ссылка как будто не существует', st(await api(`/invites/${invite.id}`)) === 404);
check('суперадмин восстанавливает', st(await setStatus(sup, 'active', 'ошибка')) === 200
  && (await must('/communities', { token: boris.token })).communities.some((c) => c.id === community.id));

console.log('--- передача жалобы из сообщества и выше ---');
const spam4 = await post(vera, 'Подпишитесь на канал!!!');
await must(`/messages/${spam4.id}/report`, { method: 'POST', token: boris.token, body: { reason: 'spam', comment: 'опять' } });
check('модератор сообщества передаёт жалобу платформе', st(await api(`/communities/${community.id}/reports/${spam4.id}/escalate`, {
  method: 'POST', token: anna.token, body: { comment: 'Вера спамит постоянно' },
})) === 200);
const escalated = (await must('/platform/staff/reports?status=open', { token: mod.token })).reports.find((r) => r.message?.id === spam4.id);
check('жалоба появилась у платформы с пометкой «из сообщества»', escalated?.source === 'community' && escalated.comment.includes('спамит'));
check('у сообщества она закрыта как переданная', (await must(`/communities/${community.id}/reports`, { token: anna.token })).open_count === 0);
check('модератор платформы передаёт выше', st(await api(`/platform/staff/reports/${escalated.id}/escalate`, {
  method: 'POST', token: mod.token, body: { reason: 'нужна блокировка' },
})) === 200);
check('отклонить переданное выше модератор не может', st(await api(`/platform/staff/reports/${escalated.id}/dismiss`, {
  method: 'POST', token: mod.token, body: { reason: 'x' },
})) === 403);
check('администратор закрывает', st(await api(`/platform/staff/reports/${escalated.id}/resolve`, {
  method: 'POST', token: adm.token, body: { reason: 'приняты меры' },
})) === 200);

console.log('--- журнал ---');
const auditOf = async (who) => (await must('/platform/staff/audit', { token: who.token })).entries;
const modAudit = await auditOf(mod);
check('модератор видит только свои действия', modAudit.length > 0 && modAudit.every((e) => e.actor_id === mod.id));
const admAudit = await auditOf(adm);
check('администратор — свои и модераторов', admAudit.every((e) => e.actor_id === adm.id || e.actor_role === 'moderator')
  && admAudit.some((e) => e.actor_id === mod.id));
const supAudit = await auditOf(sup);
check('суперадмин — все', supAudit.some((e) => e.actor_id === sup.id) && supAudit.some((e) => e.actor_id === adm.id));
check('у каждой записи есть причина или это просмотр', supAudit.filter((e) => e.actor_id && !e.action.startsWith('view_')).every((e) => e.reason));
let tamper = 'allowed';
try {
  await pool.query('UPDATE staff_audit_log SET reason = $1 WHERE id = $2', ['подделка', supAudit[0].id]);
} catch (err) {
  tamper = err.message;
}
check('журнал нельзя исправить даже напрямую в базе', tamper.includes('нельзя'));
try {
  await pool.query('DELETE FROM staff_audit_log WHERE id = $1', [supAudit[0].id]);
  tamper = 'allowed';
} catch (err) {
  tamper = err.message;
}
check('и нельзя удалить', tamper.includes('нельзя'));

console.log('--- настройки, статистика, выгрузка, вечная блокировка ---');
check('администратору настройки закрыты', st(await api('/platform/staff/settings', { token: adm.token })) === 403);
check('суперадмин закрывает регистрацию', st(await api('/platform/staff/settings', {
  method: 'PUT', token: sup.token, body: { settings: { registration_open: false }, reason: 'наплыв спамеров' },
})) === 200);
const newbie = `pl-newbie-${stamp}@example.com`;
const { dev_code: newbieCode } = await must('/auth/send-code', { method: 'POST', body: { email: newbie } });
check('новичок не регистрируется', (await api('/auth/verify-code', { method: 'POST', body: { email: newbie, code: newbieCode } })).data?.error === 'registration_closed');
check('а старые входят', st(await api('/communities', { token: boris.token })) === 200);
check('неверное значение настройки', st(await api('/platform/staff/settings', {
  method: 'PUT', token: sup.token, body: { settings: { max_invites_per_day: -1 }, reason: 'x' },
})) === 400);
await must('/platform/staff/settings', {
  method: 'PUT', token: sup.token, body: { settings: { registration_open: true }, reason: 'снова открыта' },
});
const stats = (await must('/platform/staff/stats', { token: adm.token })).stats;
check('статистика платформы', stats.users > 0 && stats.communities > 0 && 'pending_appeals' in stats);
check('модератору статистика закрыта', st(await api('/platform/staff/stats', { token: mod.token })) === 403);
check('выгрузка — только суперадмину', st(await api(`/platform/staff/users/${vera.id}/export`, {
  method: 'POST', token: adm.token, body: { authority: 'x', request_number: '1', reason: 'x' },
})) === 403);
check('без основания не выгрузить', st(await api(`/platform/staff/users/${vera.id}/export`, {
  method: 'POST', token: sup.token, body: { reason: 'x' },
})) === 400);
const exported = await must(`/platform/staff/users/${vera.id}/export`, {
  method: 'POST', token: sup.token, body: { authority: 'Следственный отдел', request_number: '42/2026', reason: 'официальный запрос' },
});
check('выгрузка содержит сообщения и меры', exported.messages.length >= 5 && exported.sanctions.length >= 5 && exported.basis.request_number === '42/2026');
check('ban: вечная блокировка', st(await sanction(adm, outsider, { kind: 'ban', reason: 'мошенничество' })) === 201);
const outsiderMe = await must('/platform/me', { token: outsider.token });
check('бессрочно', outsiderMe.block?.kind === 'ban' && outsiderMe.block.ends_at === null);
// Повторная отправка кода ограничена минутой — для теста старый код убираем.
await pool.query('DELETE FROM login_codes WHERE email = $1', [outsider.email]);
const { dev_code: again } = await must('/auth/send-code', { method: 'POST', body: { email: outsider.email } });
const relogin = await must('/auth/verify-code', { method: 'POST', body: { email: outsider.email, code: again } });
check('повторный вход по той же почте — снова экран блокировки', (await api('/communities', { token: relogin.token })).data?.error === 'account_blocked');

veraSocket.close();
await pool.end();
console.log();
if (failed) {
  console.log(`❌ Провалено проверок: ${failed}`);
  process.exit(1);
}
console.log('✅ Служба платформы работает как задумано');
process.exit(0);
