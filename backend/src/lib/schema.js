// Приведение схемы базы к актуальному виду при старте.
//
// Все файлы в db/migrations и db/analytics-layers.sql написаны идемпотентно
// (IF NOT EXISTS / OR REPLACE), поэтому применяются при каждом запуске:
// обновил код — база уже готова, отдельный шаг «не забыть накатить миграцию»
// не нужен. Порядок — по имени файла, поэтому новые изменения нумеруются
// дальше: 004-…, 005-… .
//
// Ограничение подхода: миграция, которая не может быть идемпотентной
// (переименование колонки, перенос данных), сюда не годится — такую нужно
// применять руками и отмечать в README.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(srcDir, '..', '..', '..', 'db');

export async function applySchema() {
  const migrationsDir = path.join(dbDir, 'migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of files) {
    const sql = await fs.readFile(path.join(migrationsDir, name), 'utf8');
    await pool.query(sql);
  }

  // Слои аналитики — отдельно и без фатального исхода: если с витринами
  // что-то не так, это не повод не пускать людей в чат и звонки. Аналитика
  // тогда ответит ошибкой, и причина будет видна в логе.
  try {
    const layers = await fs.readFile(path.join(dbDir, 'analytics-layers.sql'), 'utf8');
    await pool.query(layers);
    return [...files, 'analytics-layers.sql'];
  } catch (err) {
    console.error('[schema] аналитические слои не применились:', err.message);
    return files;
  }
}
