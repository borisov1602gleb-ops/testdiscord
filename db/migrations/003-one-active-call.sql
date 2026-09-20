-- Один активный звонок на голосовой канал — правило продукта, которое до сих
-- пор держалось только на проверке в коде. При двух одновременных запросах
-- могли появиться две параллельные сессии в одном канале, и участники
-- оказались бы в разных комнатах LiveKit. Теперь это гарантирует база.
-- Сначала закрываем «лишние» незавершённые звонки, которые могли накопиться
-- до появления этого правила: оставляем самый свежий в каждом канале.
-- Без этого шага индекс просто не создался бы, и backend не поднялся бы
-- на уже работающей базе.
UPDATE calls c
SET ended_at = now()
WHERE c.ended_at IS NULL
  AND EXISTS (
    SELECT 1 FROM calls newer
    WHERE newer.channel_id = c.channel_id
      AND newer.ended_at IS NULL
      AND (newer.started_at, newer.id) > (c.started_at, c.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_call_per_channel
  ON calls (channel_id) WHERE ended_at IS NULL;
