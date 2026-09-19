// Аналитический лог продукта: единственная точка записи событий в слой
// Bronze (таблица events_bronze). Все шесть событий из спецификации
// проходят через logEvent — см. раздел «Аналитика» в README.
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';

export const EVENT_TYPES = {
  INVITE_LINK_OPENED: 'invite_link_opened',
  CALL_JOINED: 'call_joined',
  REGISTRATION_COMPLETED: 'registration_completed',
  COMMUNITY_JOINED: 'community_joined',
  MESSAGE_SENT: 'message_sent',
  CALL_PARTICIPATED: 'call_participated',
};

// Bronze-принцип (раздел 6.3): содержимое payload не валидируется и не
// отбрасывается, фиксируем как есть. Функция сама генерирует event_id и
// timestamp, чтобы они гарантированно присутствовали в каждом событии.
export async function logEvent(type, payload = {}, source = config.eventSource) {
  const eventId = randomUUID();
  const timestamp = new Date().toISOString();
  const fullPayload = { event_id: eventId, timestamp, ...payload };

  try {
    await query(
      `INSERT INTO events_bronze (event_id, event_type, payload, received_at, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, type, fullPayload, timestamp, source],
    );
  } catch (err) {
    // Сбой аналитического логирования не должен ломать пользовательский сценарий.
    console.error(`[events] failed to log ${type}:`, err.message);
  }

  return fullPayload;
}
