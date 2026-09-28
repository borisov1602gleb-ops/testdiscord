// Оформление текста сообщений: **жирный**, *курсив*, ~~зачёркнутый~~,
// `код`, блоки ```кода```, кликабельные ссылки и упоминания.
//
// Разметка собирается из DOM-узлов, текст вставляется только через
// textContent — innerHTML не используется, поэтому «оформить» сообщение
// скриптом нельзя. Ссылки — только http и https.
import { el } from './dom.js';

const LETTER_OR_DIGIT = '[\\p{L}\\p{N}]';
const MAX_DEPTH = 3;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Ссылка заканчивается до знаков препинания в конце: «смотри https://x.ru.»
function trimUrl(raw) {
  let url = raw.replace(/[.,:;!?'"»]+$/, '');
  // Закрывающая скобка — часть ссылки, только если в ней есть открывающая.
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1);
  }
  return url;
}

export function safeHref(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// Первая ссылка в тексте — для превью. В коде ссылки не ищем.
export function firstLink(text) {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  const match = withoutCode.match(/https?:\/\/[^\s<>"']+/);
  return match ? safeHref(trimUrl(match[0])) : null;
}

function rules(ctx) {
  const list = [
    {
      re: /https?:\/\/[^\s<>"']+/,
      render: (m) => {
        const text = trimUrl(m[0]);
        const href = safeHref(text);
        // Отрезанный хвост (точка, скобка) возвращаем текстом.
        const tail = m[0].slice(text.length);
        const link = href
          ? el('a', { class: 'msg-link', href, target: '_blank', rel: 'noopener noreferrer nofollow', text })
          : text;
        return tail ? [link, tail] : [link];
      },
    },
    {
      re: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/,
      render: (m, depth) => [el('strong', {}, spans(m[1], ctx, depth + 1))],
    },
    {
      re: /~~(?=\S)([\s\S]+?)(?<=\S)~~/,
      render: (m, depth) => [el('s', {}, spans(m[1], ctx, depth + 1))],
    },
    {
      // Курсив — *так* или _так_, но не внутри слова: snake_case остаётся
      // как есть.
      re: new RegExp(`(?<![\\p{L}\\p{N}*_])([*_])(?=\\S)([\\s\\S]+?)(?<=\\S)\\1(?![\\p{L}\\p{N}*_])`, 'u'),
      render: (m, depth) => [el('em', {}, spans(m[2], ctx, depth + 1))],
    },
  ];
  if (ctx.tokens.length) {
    const alternatives = ctx.tokens.map((t) => escapeRegExp(t.token)).join('|');
    list.push({
      re: new RegExp(`(?:${alternatives})(?!${LETTER_OR_DIGIT})`, 'u'),
      render: (m) => {
        const token = ctx.tokens.find((t) => t.token === m[0]);
        return [el('span', { class: token.className, text: m[0] })];
      },
    });
  }
  return list;
}

// Обычный текст: ищем самое раннее совпадение любого правила, всё до
// него — просто текст.
function spans(text, ctx, depth = 0) {
  if (depth > MAX_DEPTH) return [text];
  const out = [];
  let rest = text;
  const list = rules(ctx);
  while (rest) {
    let best = null;
    for (const rule of list) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
    out.push(...best.rule.render(best.m, depth));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

function inline(text, ctx) {
  const out = [];
  text.split(/`([^`\n]+)`/).forEach((part, i) => {
    if (i % 2 === 1) out.push(el('code', { class: 'msg-code', text: part }));
    else if (part) out.push(...spans(part, ctx));
  });
  return out;
}

// mentions — [{ token: '@Имя', className }]: упоминания людей и тегов.
export function renderRich(text, { mentions = [] } = {}) {
  const ctx = { tokens: [...mentions].sort((a, b) => b.token.length - a.token.length) };
  const out = [];
  text.split(/```([\s\S]*?)```/).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(el('pre', { class: 'msg-code-block' }, [el('code', { text: part.replace(/^\n/, '') })]));
    } else if (part) {
      out.push(...inline(part, ctx));
    }
  });
  return out;
}
