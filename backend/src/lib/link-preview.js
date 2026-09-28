// Превью ссылок: заголовок, описание и название сайта по адресу из
// сообщения.
//
// Главный риск — сервер идёт по чужой ссылке. Без защиты через превью
// можно было бы «постучаться» во внутреннюю сеть (базу, панель роутера,
// служебные адреса облака). Поэтому:
//  - только http и https и только стандартные порты;
//  - адрес сайта мы разрешаем в IP сами и отказываем внутренним адресам;
//    соединение идёт ровно на проверенный IP — подменить его между
//    проверкой и запросом (DNS rebinding) не выйдет;
//  - редиректы проходим вручную, каждый шаг проверяется заново;
//  - ограничены время, размер ответа и тип (только HTML);
//  - картинки с чужих сайтов не показываем: браузер каждого читателя
//    ходил бы на чужой сервер и светил там свой адрес.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const TIMEOUT_MS = 4000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const TEXT_MAX = 300;

export class PreviewBlockedError extends Error {}

// Внутренние и служебные диапазоны: сюда превью не ходит никогда.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['64:ff9b::', 96], ['2001:db8::', 32],
]) blocked.addSubnet(addr, prefix, 'ipv6');

export function isBlockedAddress(address) {
  const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
  if (!family) return true;
  // IPv4 внутри IPv6 (::ffff:127.0.0.1) проверяем как IPv4.
  const mapped = family === 'ipv6' && address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, family);
}

// Своя функция поиска адреса для http(s).request: соединение пойдёт на
// тот IP, который мы проверили.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    const safe = addresses.filter((a) => !isBlockedAddress(a.address));
    if (safe.length === 0 || safe.length !== addresses.length) {
      return callback(new PreviewBlockedError('blocked_address'));
    }
    if (options?.all) return callback(null, safe);
    return callback(null, safe[0].address, safe[0].family);
  });
}

export function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new PreviewBlockedError('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PreviewBlockedError('bad_protocol');
  if (url.username || url.password) throw new PreviewBlockedError('credentials_in_url');
  if (url.port && url.port !== '80' && url.port !== '443') throw new PreviewBlockedError('bad_port');
  // Адрес, записанный сразу IP, проверяем без DNS.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new PreviewBlockedError('blocked_address');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new PreviewBlockedError('blocked_address');
  return url;
}

function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'user-agent': 'CommunityLinkPreview/1.0',
        accept: 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url) });
      }
      const type = String(res.headers['content-type'] ?? '');
      if (res.statusCode !== 200 || !/text\/html|application\/xhtml/i.test(type)) {
        res.resume();
        return resolve({ html: null });
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          // Заголовок и мета-теги — в начале страницы; дальше не качаем.
          req.destroy();
          return resolve({ html: Buffer.concat(chunks).toString('utf8') });
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_MAX);
}

function meta(html, key) {
  // Атрибуты в meta бывают в любом порядке — ищем оба варианта.
  const escaped = key.replace(/[.:]/g, '\\$&');
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'));
  const value = a?.[1] ?? b?.[1];
  return value ? decode(value) : null;
}

export function parsePreview(html, url) {
  const title = meta(html, 'og:title') ?? meta(html, 'twitter:title')
    ?? (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)[1]) : null);
  if (!title) return null;
  return {
    url: url.toString(),
    title,
    description: meta(html, 'og:description') ?? meta(html, 'description'),
    site_name: meta(html, 'og:site_name') ?? url.hostname.replace(/^www\./, ''),
  };
}

const cache = new Map();

export async function getPreview(raw) {
  let url = checkUrl(raw);
  const key = url.toString();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const result = await fetchOnce(url);
      if (result.redirect) {
        url = checkUrl(result.redirect);
        continue;
      }
      value = result.html ? parsePreview(result.html, url) : null;
      break;
    }
  } catch (err) {
    if (err instanceof PreviewBlockedError) throw err;
    value = null; // сайт недоступен — просто без превью
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}
