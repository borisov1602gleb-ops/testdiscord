// Обращения к API: подставляет токен, разбирает ответ и переводит коды
// ошибок backend в человеческий текст, который можно показать на экране.
import { store } from './store.js';

const MESSAGES = {
  invalid_email: 'Некорректный адрес почты',
  code_already_sent: 'Код уже отправлен, попробуйте чуть позже',
  invalid_or_expired_code: 'Неверный или просроченный код',
  email_and_code_required: 'Введите почту и код',
  not_a_community_member: 'Вы не участник этого сообщества',
  owner_only: 'Раздел доступен только владельцу сообщества',
  name_required: 'Название не может быть пустым',
  name_too_long: 'Название слишком длинное',
  invalid_channel_type: 'Канал бывает текстовым или голосовым',
  too_many_channels: 'Достигнут предел каналов в сообществе',
  invite_not_found: 'Приглашение не найдено',
  invite_expired: 'Срок приглашения истёк',
  invite_exhausted: 'Приглашение исчерпано',
  invite_mismatch: 'Приглашение не подходит к этому звонку',
  invite_id_required_for_guest: 'Без регистрации подключиться можно только по приглашению',
  call_not_found: 'Звонок не найден',
  call_ended: 'Звонок уже завершён',
  active_participation_not_found: 'Вы уже вышли из звонка',
  content_required: 'Сообщение не может быть пустым',
  content_too_long: 'Сообщение слишком длинное — максимум 2000 символов',
  payload_too_large: 'Слишком большой запрос',
  too_many_attempts: 'Слишком много попыток — запросите новый код',
  invalid_expires_at: 'Некорректная дата окончания',
  invalid_max_uses: 'Некорректное число использований',
  call_creation_conflict: 'Звонок уже создаётся — попробуйте ещё раз',
  unauthorized: 'Нужно войти заново',
};

export class ApiError extends Error {
  constructor(code, status, details) {
    super(MESSAGES[code] || code || 'Что-то пошло не так');
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && store.token) headers.authorization = `Bearer ${store.token}`;

  const res = await fetch(path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Токен протух или подписан другим ключом — это не поломка, а повод
    // спокойно отправить человека на вход. Роутер не импортируем: он сам
    // зависит от экранов, а те — от этого файла.
    if (res.status === 401 && store.isAuthenticated) {
      store.clearSession();
      location.hash = '#/login';
    }
    throw new ApiError(data.error, res.status, data.details);
  }
  return data;
}
