// Роли и теги участников: подписи, цвета и проверка прав в интерфейсе.
// Права приходят с сервера списком (permissions) — интерфейс по нему
// только решает, какие кнопки показывать. Проверяет всё равно сервер.
import { el } from './dom.js';

export const ROLE_LABELS = { owner: 'Владелец', moderator: 'Модератор', member: 'Участник' };

// Та же палитра, что на сервере: другие цвета он не примет.
export const TAG_COLORS = [
  { id: 'violet', label: 'Фиолетовый' },
  { id: 'blue', label: 'Синий' },
  { id: 'teal', label: 'Бирюзовый' },
  { id: 'green', label: 'Зелёный' },
  { id: 'yellow', label: 'Жёлтый' },
  { id: 'orange', label: 'Оранжевый' },
  { id: 'red', label: 'Красный' },
  { id: 'pink', label: 'Розовый' },
];

export const MAX_TAGS_PER_MEMBER = 5;

export function can(permissions, permission) {
  return Array.isArray(permissions) && permissions.includes(permission);
}

// Цвет подставляется классом, а не стилем: значение из данных не должно
// попадать в CSS напрямую.
function colorClass(color) {
  return TAG_COLORS.some((c) => c.id === color) ? `tag-${color}` : 'tag-violet';
}

export function tagChip(tag, { small = false, onclick, active, title } = {}) {
  const className = `tag-chip ${colorClass(tag.color)}${small ? ' tag-small' : ''}${active ? ' is-active' : ''}`;
  return onclick
    ? el('button', { class: className, type: 'button', text: tag.name, title, onclick })
    : el('span', { class: className, text: tag.name, title });
}

// Значок роли показываем только у тех, у кого она особая: у рядового
// участника подпись «Участник» рядом с каждым именем — шум.
export function roleBadge(role, { small = false } = {}) {
  if (role !== 'owner' && role !== 'moderator') return null;
  return el('span', {
    class: `role-mark role-${role}${small ? ' role-small' : ''}`,
    text: ROLE_LABELS[role],
  });
}
