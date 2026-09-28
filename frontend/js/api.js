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
  not_allowed: 'У вашей роли нет на это прав',
  cannot_remove_equal_or_higher: 'Исключить можно только того, кто младше по роли',
  owner_cannot_leave: 'Владелец не может покинуть своё сообщество',
  member_not_found: 'Участник не найден',
  invalid_role: 'Такой роли нет',
  tag_exists: 'Тег с таким названием уже есть',
  tag_not_found: 'Тег не найден',
  too_many_tags: 'Достигнут предел тегов в сообществе',
  too_many_member_tags: 'Не больше пяти тегов на человека',
  invalid_tag_color: 'Выберите цвет из палитры',
  invalid_tags: 'Теги не подходят к этому сообществу',
  pin_not_allowed: 'Закреплять может владелец или модератор',
  cannot_pin_thread_message: 'Сообщение из треда закрепить нельзя',
  too_many_pins: 'В канале уже много закреплённых — открепите старые',
  invalid_thread: 'Этот тред недоступен',
  thread_not_found: 'Тред не найден',
  query_too_short: 'Введите хотя бы два символа',
  query_too_long: 'Слишком длинный запрос',
  cannot_message_yourself: 'Написать самому себе нельзя',
  no_shared_community: 'Написать можно только тому, с кем у вас общее сообщество',
  not_a_conversation_member: 'Это чужая переписка',
  conversation_not_found: 'Переписка не найдена',
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
  channel_is_not_text: 'Писать можно только в текстовый канал',
  message_not_found: 'Сообщение не найдено',
  message_deleted: 'Сообщение уже удалено',
  not_message_author: 'Это можно сделать только со своим сообщением',
  invalid_reply: 'Сообщение, на которое вы отвечаете, недоступно',
  invalid_attachment: 'Файл не удалось прикрепить — загрузите его заново',
  invalid_reaction: 'Такой реакции нет',
  invalid_mentions: 'Не удалось разобрать упоминания',
  too_many_mentions: 'Слишком много упоминаний в одном сообщении',
  unsupported_file_type: 'Такой тип файла не поддерживается: подойдут картинки, PDF, текст и ZIP',
  empty_file: 'Файл пустой',
  file_too_large: 'Файл больше 10 МБ',
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

  return readResponse(res);
}

// Файл уходит сырым телом, а не JSON: так не нужно ни кодировать его
// в base64 (плюс треть к размеру), ни тащить библиотеку разбора форм.
export async function uploadFile(path, file) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${store.token}`,
      'content-type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  return readResponse(res, { tooLarge: 'file_too_large' });
}

async function readResponse(res, { tooLarge } = {}) {
  // No-content ответы (удаление) тела не имеют — это не ошибка.
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    // Токен протух или подписан другим ключом — это не поломка, а повод
    // спокойно отправить человека на вход. Роутер не импортируем: он сам
    // зависит от экранов, а те — от этого файла.
    if (res.status === 401 && store.isAuthenticated) {
      store.clearSession();
      location.hash = '#/login';
    }
    const code = res.status === 413 && tooLarge ? tooLarge : data.error;
    throw new ApiError(code, res.status, data.details);
  }
  return data;
}
