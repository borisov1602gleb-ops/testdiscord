// Проверка превью ссылок без выхода в интернет: какие адреса считаются
// внутренними, какие ссылки отклоняются сразу и как разбирается страница.
import { isBlockedAddress, checkUrl, parsePreview, PreviewBlockedError } from '../src/lib/link-preview.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`);
  if (!ok) failed += 1;
}

for (const address of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254',
  '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', 'not-an-ip']) {
  check(`внутренний адрес ${address}`, isBlockedAddress(address), true);
}
for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) {
  check(`внешний адрес ${address}`, isBlockedAddress(address), false);
}

function rejects(raw) {
  try {
    checkUrl(raw);
    return false;
  } catch (err) {
    return err instanceof PreviewBlockedError;
  }
}
for (const raw of ['ftp://example.com/', 'javascript:alert(1)', 'http://localhost:80/', 'http://app.internal/',
  'http://[::ffff:7f00:1]/', 'http://0177.0.0.1/', 'https://example.com:22/', 'не ссылка']) {
  check(`отклоняется сразу: ${raw}`, rejects(raw), true);
}
check('обычная ссылка проходит проверку', rejects('https://example.com/page?x=1'), false);

const html = `<html><head>
  <title>Запасной &amp; заголовок</title>
  <meta content="Описание &quot;страницы&quot;" property="og:description">
  <meta property="og:title" content="Главный заголовок">
  <meta property="og:site_name" content="Пример">
</head></html>`;
check('разбор страницы', parsePreview(html, new URL('https://example.com/a')), {
  url: 'https://example.com/a',
  title: 'Главный заголовок',
  description: 'Описание "страницы"',
  site_name: 'Пример',
});
check('без og берётся <title>', parsePreview('<title>Просто &#1058;итул</title>', new URL('https://www.site.ru/')), {
  url: 'https://www.site.ru/',
  title: 'Просто Титул',
  description: null,
  site_name: 'site.ru',
});
check('без заголовка превью нет', parsePreview('<p>пусто</p>', new URL('https://x.ru/')), null);

if (failed) {
  console.log(`❌ Провалено: ${failed}`);
  process.exit(1);
}
console.log('✅ Превью ссылок: защита и разбор работают');
