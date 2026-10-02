// Демо-данные для проверки ролей платформы руками: аккаунты на каждую
// роль, сообщество с перепиской, жалобы, блокировка с поданным
// обжалованием, заглушённый человек и замороженное сообщество.
//
// Запуск (backend при этом может работать или нет):
//   node backend/scripts/seed-demo.mjs
// На Windows — так: .\start.ps1 -Demo
//
// Входить — по почте из списка ниже; код покажется прямо на экране входа
// (EXPOSE_DEV_CODE=true). Повторный запуск ничего не дублирует.
import { pool, waitForDatabase } from '../src/db.js';
import { applySchema } from '../src/lib/schema.js';
import { audit } from '../src/lib/platform.js';

const PEOPLE = [
  ['super@test.ru', 'Суперадмин Сергей', 'superadmin'],
  ['admin@test.ru', 'Администратор Алина', 'admin'],
  ['admin2@test.ru', 'Администратор Олег', 'admin'],
  ['moder@test.ru', 'Модератор Марк', 'moderator'],
  ['anna@test.ru', 'Анна', 'user'],
  ['boris@test.ru', 'Борис', 'user'],
  ['vera@test.ru', 'Вера', 'user'],
  ['petr@test.ru', 'Пётр', 'user'],
  ['kirill@test.ru', 'Кирилл', 'user'],
];

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];

await waitForDatabase();
await applySchema();

const existing = await one("SELECT id FROM users WHERE email = 'super@test.ru'");
if (existing) {
  console.log('Демо-данные уже есть — можно входить. Почты: ' + PEOPLE.map(([e]) => e).join(', '));
  await pool.end();
  process.exit(0);
}

const users = {};
for (const [email, name, role] of PEOPLE) {
  const row = await one(
    `INSERT INTO users (email, display_name, hide_email, registration_source, platform_role)
     VALUES ($1, $2, true, 'demo_seed', $3)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, platform_role = EXCLUDED.platform_role
     RETURNING id, email, platform_role`,
    [email, name, role],
  );
  users[email.split('@')[0]] = { ...row, name, platformRole: role };
}
const { super: sup, admin, admin2, moder, anna, boris, vera, petr, kirill } = users;

async function community(name, owner, members) {
  const c = await one('INSERT INTO communities (name, owner_id) VALUES ($1, $2) RETURNING id', [name, owner.id]);
  await q("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner')", [c.id, owner.id]);
  for (const [m, role] of members) {
    await q('INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, $3)', [c.id, m.id, role]);
  }
  const text = await one(
    "INSERT INTO channels (community_id, name, type) VALUES ($1, 'general', 'text') RETURNING id", [c.id],
  );
  await q("INSERT INTO channels (community_id, name, type) VALUES ($1, 'General Voice', 'voice')", [c.id]);
  await q('INSERT INTO invites (community_id, created_by) VALUES ($1, $2)', [c.id, owner.id]);
  return { id: c.id, text: text.id };
}

let minute = 0;
async function say(channelId, who, content) {
  minute += 1;
  return one(
    `INSERT INTO messages (channel_id, user_id, content, created_at)
     VALUES ($1, $2, $3, now() - interval '3 hours' + make_interval(mins => $4)) RETURNING id`,
    [channelId, who.id, content, minute],
  );
}

// ===== сообщества =====
const team = await community('Команда проекта', anna, [[boris, 'moderator'], [vera, 'member'], [petr, 'member'], [moder, 'member']]);
const money = await community('Быстрые деньги', kirill, [[anna, 'member'], [petr, 'member']]);

await say(team.text, anna, 'Всем привет! Это демо-сообщество для проверки ролей платформы.');
await say(team.text, boris, 'Привет! Макет главной будет к пятнице.');
await say(team.text, anna, 'Отлично, тогда в пятницу созвон.');
const veraSpam1 = await say(team.text, vera, 'Купите курс по ссылке, только сегодня скидка 90%!!!');
await say(team.text, boris, 'Вера, тут не место для рекламы.');
const veraSpam2 = await say(team.text, vera, 'Пишите мне в личку — расскажу, как заработать за день');
await say(team.text, petr, 'Да что вы все, нормальная тема');
const petrRude = await say(team.text, petr, 'Борис, ты вообще молчи, тебя никто не спрашивал');
await say(team.text, anna, 'Пётр, давай без грубостей.');
const veraSpam3 = await say(team.text, vera, 'Последний шанс купить курс!');

await say(money.text, kirill, 'Удвоим ваши вложения за неделю. Переводите на карту.');
await say(money.text, kirill, 'Гарантия 100%, отзывы в профиле.');
await say(money.text, anna, 'Это похоже на мошенничество.');

// Личка Веры и Бориса.
const dmKey = [vera.id, boris.id].sort().join(':');
const dm = await one(
  "INSERT INTO channels (community_id, name, type, direct_key) VALUES (NULL, '', 'direct', $1) RETURNING id", [dmKey],
);
await q('INSERT INTO direct_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)', [dm.id, vera.id, boris.id]);
await say(dm.id, vera, 'Борис, переведи мне 5000, потом верну вдвое больше');
const dmScam = await say(dm.id, vera, 'Если не переведёшь — расскажу всем, что ты мне должен');

// ===== жалобы =====
async function platformReport(fields) {
  return one(
    `INSERT INTO platform_reports (target_type, message_id, target_user_id, community_id, reporter_id, source, reason, comment, status, escalated_by, escalated_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - make_interval(mins => $12)) RETURNING id`,
    [fields.type, fields.message ?? null, fields.target ?? null, fields.community ?? null, fields.reporter.id,
      fields.source ?? 'user', fields.reason, fields.comment ?? null, fields.status ?? 'open',
      fields.escalatedBy?.id ?? null, fields.escalatedBy ? new Date() : null, fields.ago ?? 30],
  );
}
await platformReport({ type: 'message', message: veraSpam2.id, target: vera.id, community: team.id, reporter: boris, reason: 'spam', comment: 'Зовёт в личку «заработать»', ago: 50 });
await platformReport({ type: 'message', message: dmScam.id, target: vera.id, reporter: boris, reason: 'illegal', comment: 'Вымогает деньги в личке', ago: 40 });
await platformReport({ type: 'message', message: petrRude.id, target: petr.id, community: team.id, reporter: boris, reason: 'abuse', ago: 35 });
await platformReport({ type: 'community', target: kirill.id, community: money.id, reporter: anna, reason: 'illegal', comment: 'Финансовая пирамида, просят переводить деньги', status: 'escalated', escalatedBy: moder, ago: 120 });
// Жалоба внутри сообщества — для модераторов сообщества.
await q(
  "INSERT INTO message_reports (message_id, community_id, reporter_id, reason, comment) VALUES ($1, $2, $3, 'spam', 'опять реклама')",
  [veraSpam3.id, team.id, anna.id],
);

// ===== меры =====
async function sanction(fields) {
  return one(
    `INSERT INTO platform_sanctions (user_id, kind, message_id, community_id, reason, issued_by, issued_by_role, ends_at, created_at, starts_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(hours => $9), now() - make_interval(hours => $9)) RETURNING id`,
    [fields.user.id, fields.kind, fields.message ?? null, fields.community ?? null, fields.reason,
      fields.by.id, fields.by.platformRole, fields.endsAt ?? null, fields.hoursAgo ?? 2],
  );
}
const days = (n) => new Date(Date.now() + n * 86_400_000);

// Вера: удалённое сообщение, предупреждение и блокировка на неделю —
// апелляцию она может подать прямо с экрана блокировки.
await q('UPDATE messages SET deleted_at = now(), platform_removed_at = now() WHERE id = $1', [veraSpam1.id]);
await sanction({ user: vera, kind: 'message_removed', message: veraSpam1.id, community: team.id, reason: 'Реклама', by: moder, hoursAgo: 3 });
await sanction({ user: vera, kind: 'warning', reason: 'Реклама в сообществах запрещена', by: moder, hoursAgo: 3 });
await sanction({ user: vera, kind: 'suspend', reason: 'Повторная реклама после предупреждения', by: admin, endsAt: days(7), hoursAgo: 1 });

// Пётр: заглушён на сутки за грубость.
await sanction({ user: petr, kind: 'mute', reason: 'Грубость в адрес участников', by: moder, endsAt: days(1), hoursAgo: 1 });

// «Быстрые деньги»: заморожено администратором.
await q("UPDATE communities SET platform_status = 'frozen', platform_status_at = now() WHERE id = $1", [money.id]);
const moneyFreeze = await sanction({ user: kirill, kind: 'community_frozen', community: money.id, reason: 'Признаки финансовой пирамиды — до проверки', by: admin, hoursAgo: 2 });
// Кирилл уже подал обжалование — оно ждёт решения в панели.
await q(
  'INSERT INTO platform_appeals (sanction_id, user_id, text, created_at) VALUES ($1, $2, $3, now() - interval \'40 minutes\')',
  [moneyFreeze.id, kirill.id, 'Мы не пирамида, а клуб инвесторов. Готовы показать документы — прошу разморозить сообщество.'],
);

// ===== журнал =====
const actor = (u) => ({ id: u.id, email: u.email, platformRole: u.platformRole });
await audit(actor(sup), 'role_changed', { targetType: 'user', targetId: admin.id, reason: 'Набор команды', details: { from: 'user', to: 'admin' } });
await audit(actor(sup), 'role_changed', { targetType: 'user', targetId: admin2.id, reason: 'Набор команды', details: { from: 'user', to: 'admin' } });
await audit(actor(admin), 'role_changed', { targetType: 'user', targetId: moder.id, reason: 'Набор команды', details: { from: 'user', to: 'moderator' } });
await audit(actor(moder), 'message_removed', { targetType: 'message', targetId: veraSpam1.id, reason: 'Реклама' });
await audit(actor(moder), 'user_warning', { targetType: 'user', targetId: vera.id, reason: 'Реклама в сообществах запрещена' });
await audit(actor(moder), 'user_mute', { targetType: 'user', targetId: petr.id, reason: 'Грубость в адрес участников', details: { days: 1 } });
await audit(actor(moder), 'report_escalated', { targetType: 'community', targetId: money.id, reason: 'Нужна проверка администратором' });
await audit(actor(admin), 'user_suspend', { targetType: 'user', targetId: vera.id, reason: 'Повторная реклама после предупреждения', details: { days: 7 } });
await audit(actor(admin), 'community_frozen', { targetType: 'community', targetId: money.id, reason: 'Признаки финансовой пирамиды — до проверки' });

await pool.end();
console.log(`
Демо-данные созданы. Вход — по почте, код покажется на экране входа.

  super@test.ru   — суперадминистратор (всё, включая настройки и выгрузку)
  admin@test.ru   — администратор (блокировки, сообщества, обжалования)
  admin2@test.ru  — второй администратор (рассматривает обжалования на решения Алины)
  moder@test.ru   — модератор платформы (жалобы, предупреждения, заглушения)
  anna@test.ru    — Анна, владелец «Команды проекта»
  boris@test.ru   — Борис, модератор «Команды проекта»
  vera@test.ru    — Вера, заблокирована на неделю (может подать апелляцию)
  petr@test.ru    — Пётр, заглушён на сутки
  kirill@test.ru  — Кирилл, его сообщество «Быстрые деньги» заморожено, обжалование подано
`);
