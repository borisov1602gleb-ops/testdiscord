// Совместная доска голосового канала — по мотивам Miro, FigJam, tldraw и
// Excalidraw: бесконечный холст, карандаш, фигуры, стрелки, текст,
// стикеры, ластик, курсоры участников, отмена действий и сохранение
// картинкой.
//
// Рисуется в SVG: фигуры — это элементы страницы, их легко выделять,
// двигать и стирать, а картинку для сохранения можно собрать без
// посторонних библиотек. Весь текст — через textContent.
import { el, icon, initial } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
// Та же палитра, что на сервере: другие цвета он не примет.
const INK = ['#e9e9ed', '#1b1d2e', '#b5abfc', '#8cb4ff', '#6fd3cf', '#8fd4a8', '#ecd38a', '#f4b68a', '#f5a19a'];
const STICKY = {
  yellow: '#fde68a', pink: '#fbcfe8', green: '#bbf7d0', blue: '#bfdbfe', violet: '#ddd6fe', orange: '#fed7aa',
};
const STICKY_TEXT = '#1f2433';
const WIDTHS = [2, 4, 8];
const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';
const BOARD_BG = '#1a1c2b';
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const DRAFT_EVERY_MS = 40;
const CURSOR_EVERY_MS = 50;

const TOOLS = [
  ['select', 'Выделить и двигать', 'V', 'cursor'],
  ['hand', 'Рука — двигать холст', 'H', 'hand'],
  ['pen', 'Карандаш', 'P', 'pencil'],
  ['rect', 'Прямоугольник', 'R', 'square'],
  ['ellipse', 'Круг', 'O', 'circle'],
  ['arrow', 'Стрелка', 'A', 'arrow'],
  ['text', 'Текст', 'T', 'text'],
  ['sticky', 'Стикер', 'S', 'sticky'],
  ['eraser', 'Ластик', 'E', 'eraser'],
];

// Маленькие иконки инструментов — геометрия прямо здесь, в сетке 20×20.
const TOOL_ICONS = {
  cursor: 'M5 3l10 6.5-4.3 1.2 2.6 4.8-1.8 1-2.6-4.8L5 15z',
  hand: 'M7 10V4.5a1.2 1.2 0 012.4 0V9m0-.5V3.5a1.2 1.2 0 012.4 0V9m0-.5V4.5a1.2 1.2 0 012.4 0V11c0 3.3-2.2 5.5-5 5.5-2 0-3.2-1-4.3-2.6L3.4 11a1.2 1.2 0 012-1.3L7 11.5',
  pencil: 'M13.5 3.5l3 3-9 9-3.8.8.8-3.8zM11.5 5.5l3 3',
  square: 'M4 4h12v12H4z',
  circle: 'M10 3.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13z',
  arrow: 'M4 16L16 4M9 4h7v7',
  text: 'M4.5 5V3.5h11V5M10 3.5v13M7.5 16.5h5',
  sticky: 'M4 3.5h12v8.5l-4.5 4.5H4zM11.5 16.5V12H16',
  eraser: 'M8 16.5h8M3.8 11.7l7-7a1.5 1.5 0 012.1 0l3.4 3.4a1.5 1.5 0 010 2.1L11 15.5H7.6z',
};

function toolIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', TOOL_ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, value);
  }
  return node;
}

// randomUUID есть только на https и localhost; по адресу в локальной сети
// собираем UUID сами.
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
  (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const round = (n) => Math.round(n * 100) / 100;

// Перенос текста по ширине: меряем слова тем же шрифтом, что на доске.
const measure = document.createElement('canvas').getContext('2d');
function wrapText(text, maxWidth, size, weight = 400) {
  measure.font = `${weight} ${size}px ${FONT}`;
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (measure.measureText(next).width <= maxWidth || !line.trim()) {
        // Слово длиннее строки режем по буквам.
        if (measure.measureText(next).width > maxWidth && !line.trim()) {
          let piece = '';
          for (const ch of word) {
            if (measure.measureText(piece + ch).width > maxWidth && piece) {
              lines.push(piece);
              piece = '';
            }
            piece += ch;
          }
          line = piece;
        } else {
          line = next;
        }
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// Плавная линия через середины отрезков — рука выглядит как рука, а не
// как ломаная.
function pathD(points) {
  if (points.length < 4) return `M${points[0]} ${points[1]}`;
  let d = `M${points[0]} ${points[1]}`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const mx = (points[i] + points[i + 2]) / 2;
    const my = (points[i + 1] + points[i + 3]) / 2;
    d += ` Q${points[i]} ${points[i + 1]} ${mx} ${my}`;
  }
  d += ` L${points[points.length - 2]} ${points[points.length - 1]}`;
  return d;
}

function box(d) {
  const x = Math.min(d.x, d.x + d.w);
  const y = Math.min(d.y, d.y + d.h);
  return { x, y, w: Math.abs(d.w), h: Math.abs(d.h) };
}

// Рисование одного элемента. Всё оформление — атрибутами, а не CSS: так
// картинка для сохранения выглядит так же, как на экране.
function renderElement(element) {
  const { type, data } = element;
  const g = svg('g', {
    'data-id': element.id,
    transform: data.tx || data.ty ? `translate(${data.tx || 0} ${data.ty || 0})` : null,
  });
  if (type === 'path') {
    const d = pathD(data.points);
    g.append(
      svg('path', { d, stroke: 'transparent', 'stroke-width': Math.max(14, data.width + 10), fill: 'none', 'stroke-linecap': 'round', class: 'board-hit' }),
      svg('path', { d, stroke: data.color, 'stroke-width': data.width, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    );
  } else if (type === 'rect' || type === 'ellipse') {
    const b = box(data);
    const common = {
      stroke: data.color,
      'stroke-width': data.width,
      fill: data.fill ? data.color : 'transparent',
      'fill-opacity': data.fill ? 0.18 : null,
    };
    g.append(type === 'rect'
      ? svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, ...common })
      : svg('ellipse', { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, ...common }));
  } else if (type === 'arrow') {
    const { x1, y1, x2, y2 } = data;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(10, data.width * 3.2);
    const left = [x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45)];
    const right = [x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45)];
    g.append(
      svg('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': Math.max(14, data.width + 10), class: 'board-hit' }),
      svg('line', { x1, y1, x2, y2, stroke: data.color, 'stroke-width': data.width, 'stroke-linecap': 'round' }),
      svg('path', {
        d: `M${left[0]} ${left[1]} L${x2} ${y2} L${right[0]} ${right[1]}`,
        stroke: data.color, 'stroke-width': data.width, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }),
    );
  } else if (type === 'text') {
    const lines = wrapText(data.text || ' ', data.w, data.size, 500);
    const text = svg('text', { x: data.x, y: data.y, fill: data.color, 'font-size': data.size, 'font-family': FONT, 'font-weight': 500 });
    lines.forEach((line, i) => {
      const span = svg('tspan', { x: data.x, dy: i === 0 ? data.size : data.size * 1.25 });
      span.textContent = line || ' ';
      text.append(span);
    });
    const height = Math.max(1, lines.length) * data.size * 1.25 + data.size * 0.3;
    g.append(svg('rect', { x: data.x - 4, y: data.y, width: data.w + 8, height, fill: 'transparent', class: 'board-hit' }), text);
  } else if (type === 'image') {
    // Кадр демонстрации: картинка с тонкой рамкой, поверх неё рисуют.
    g.append(
      svg('rect', { x: data.x - 1, y: data.y - 1, width: data.w + 2, height: data.h + 2, rx: 4, fill: '#0c0d18', stroke: '#3a3d55', 'stroke-width': 1 }),
      svg('image', { x: data.x, y: data.y, width: data.w, height: data.h, href: data.src, preserveAspectRatio: 'xMidYMid meet' }),
    );
  } else if (type === 'sticky') {
    const fill = STICKY[data.color] ?? STICKY.yellow;
    const size = 18;
    const pad = 16;
    const lines = wrapText(data.text || '', data.w - pad * 2, size, 500);
    g.append(
      svg('rect', { x: data.x + 3, y: data.y + 5, width: data.w, height: data.h, rx: 6, fill: '#000', 'fill-opacity': 0.25 }),
      svg('rect', { x: data.x, y: data.y, width: data.w, height: data.h, rx: 6, fill }),
    );
    const text = svg('text', { x: data.x + pad, y: data.y + pad, fill: STICKY_TEXT, 'font-size': size, 'font-family': FONT, 'font-weight': 500 });
    const maxLines = Math.max(1, Math.floor((data.h - pad * 2 - 16) / (size * 1.3)));
    lines.slice(0, maxLines).forEach((line, i) => {
      const span = svg('tspan', { x: data.x + pad, dy: i === 0 ? size : size * 1.3 });
      span.textContent = i === maxLines - 1 && lines.length > maxLines ? `${line}…` : line || ' ';
      text.append(span);
    });
    g.append(text);
    if (element.author_name) {
      const author = svg('text', {
        x: data.x + pad, y: data.y + data.h - 10, fill: STICKY_TEXT, 'fill-opacity': 0.55,
        'font-size': 11, 'font-family': FONT,
      });
      // Подпись автора — в одну строку по ширине стикера.
      const [first = '', ...rest] = wrapText(element.author_name, data.w - pad * 2 - 10, 11);
      author.textContent = rest.length ? `${first}…` : first;
      g.append(author);
    }
  }
  return g;
}

// channelId — чья доска; token — токен входа или гостевой пропуск.
// Кадр идущей демонстрации экрана звонок отдаёт через setFrameSource:
// функция возвращает { src, width, height }, кадр ложится на доску, и
// поверх него рисуют.
export function createBoard({ channelId, token, onClose }) {
  const elements = new Map();
  const drafts = new Map();
  const cursors = new Map();
  const view = { ox: 0, oy: 0, scale: 1 };
  let me = { id: 'me', name: 'Вы', color: INK[2] };
  let canClear = false;
  let tool = 'pen';
  let ink = INK[0];
  let width = WIDTHS[1];
  let stickyColor = 'yellow';
  let selected = null; // id выделенного элемента
  let action = null; // что делается сейчас указателем
  let spaceDown = false;
  let editing = null;
  let getFrame = null;
  const undoStack = [];
  const redoStack = [];

  // ===== соединение =====
  const socket = io({ auth: { token }, forceNew: true });
  const status = el('span', { class: 'board-status', text: 'Подключаемся…' });

  socket.on('connect', () => {
    socket.emit('board:join', channelId, (res) => {
      if (!res?.ok) {
        status.textContent = 'Нет доступа к доске';
        return;
      }
      me = res.me;
      canClear = res.can_clear;
      elements.clear();
      for (const element of res.elements) elements.set(element.id, element);
      status.textContent = '';
      drawAll();
      drawActions();
      if (elements.size && !fitted && viewport.clientWidth) fit();
    });
  });
  socket.on('disconnect', () => {
    status.textContent = 'Нет связи — переподключаемся…';
  });
  socket.on('board:upsert', ({ channel_id: cid, element }) => {
    if (cid !== channelId) return;
    elements.set(element.id, element);
    drafts.delete(element.id);
    drawElement(element.id);
    drawDraft(element.id);
  });
  socket.on('board:delete', ({ channel_id: cid, ids }) => {
    if (cid !== channelId) return;
    for (const id of ids) {
      elements.delete(id);
      drawElement(id);
      if (selected === id) select(null);
    }
  });
  // Черновик живёт, пока приходят обновления: если автор пропал на полпути,
  // через три секунды он исчезает, а элемент возвращается на место.
  const draftTimers = new Map();
  socket.on('board:draft', ({ channel_id: cid, element }) => {
    if (cid !== channelId) return;
    drafts.set(element.id, element);
    drawDraft(element.id);
    clearTimeout(draftTimers.get(element.id));
    draftTimers.set(element.id, setTimeout(() => {
      draftTimers.delete(element.id);
      drafts.delete(element.id);
      drawDraft(element.id);
    }, 3000));
  });
  socket.on('board:cleared', ({ channel_id: cid }) => {
    if (cid !== channelId) return;
    elements.clear();
    drafts.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    select(null);
    drawAll();
  });
  socket.on('board:cursor', (c) => {
    if (c.channel_id !== channelId || c.id === me.id) return;
    drawCursor(c);
  });
  let peers = [];
  socket.on('board:peers', ({ channel_id: cid, peers: list }) => {
    if (cid !== channelId) return;
    peers = list;
    drawActions();
  });

  function send(element) {
    socket.emit('board:upsert', { channel_id: channelId, element }, (res) => {
      if (res && !res.ok) status.textContent = res.error === 'board_full' ? 'Доска переполнена' : 'Не сохранилось';
    });
  }
  function sendDelete(ids) {
    socket.emit('board:delete', { channel_id: channelId, ids });
  }
  let lastDraft = 0;
  function sendDraft(element, force = false) {
    if (element.type === 'image') return;
    const now = Date.now();
    if (!force && now - lastDraft < DRAFT_EVERY_MS) return;
    lastDraft = now;
    socket.volatile.emit('board:draft', { channel_id: channelId, element });
  }
  let lastCursor = 0;
  function sendCursor(point) {
    const now = Date.now();
    if (now - lastCursor < CURSOR_EVERY_MS) return;
    lastCursor = now;
    socket.volatile.emit('board:cursor', { channel_id: channelId, x: round(point.x), y: round(point.y) });
  }

  // ===== разметка =====
  const world = svg('g');
  const layerElements = svg('g');
  const layerDrafts = svg('g', { opacity: '0.85' });
  const layerSelection = svg('g');
  world.append(layerElements, layerDrafts, layerSelection);
  const canvas = svg('svg', { class: 'board-svg' });
  canvas.append(world);
  const cursorLayer = el('div', { class: 'board-cursors' });
  const editor = el('textarea', { class: 'board-editor', spellcheck: 'false' });
  editor.hidden = true;
  const emptyHint = el('div', { class: 'board-empty' }, [
    el('p', { class: 'board-empty-title', text: 'Доска канала' }),
    el('p', {
      text: window.matchMedia?.('(pointer: coarse)').matches
        ? 'Выберите инструмент внизу и рисуйте пальцем. Двигать холст — инструментом «рука».'
        : 'P — карандаш, S — стикер, T — текст, A — стрелка. Колёсико — прокрутка, Ctrl + колёсико — масштаб, пробел — двигать холст.',
    }),
  ]);
  const viewport = el('div', { class: 'board-viewport', tabindex: '0' }, [canvas, cursorLayer, editor, emptyHint]);

  const toolButtons = new Map();
  const toolbar = el('div', { class: 'board-tools' }, TOOLS.map(([id, label, key, iconName]) => {
    const button = el('button', {
      class: 'board-tool',
      type: 'button',
      title: `${label} (${key})`,
      'aria-label': label,
      onclick: () => setTool(id),
    }, [toolIcon(iconName)]);
    toolButtons.set(id, button);
    return button;
  }));
  const styleBar = el('div', { class: 'board-style' });
  const actionsBar = el('div', { class: 'board-actions' });
  const zoomLabel = el('span', { class: 'board-zoom' });

  const node = el('div', { class: 'board' }, [viewport, toolbar, styleBar, actionsBar, status]);

  function drawTools() {
    for (const [id, button] of toolButtons) button.classList.toggle('is-active', id === tool);
    viewport.dataset.tool = tool;
    if (tool === 'sticky') {
      styleBar.replaceChildren(...Object.entries(STICKY).map(([name, fill]) =>
        el('button', {
          class: `board-swatch${stickyColor === name ? ' is-active' : ''}`,
          type: 'button',
          title: 'Цвет стикера',
          style: `background:${fill}`,
          onclick: () => {
            stickyColor = name;
            drawTools();
          },
        })));
    } else {
      styleBar.replaceChildren(
        ...INK.map((color) => el('button', {
          class: `board-swatch${ink === color ? ' is-active' : ''}`,
          type: 'button',
          title: 'Цвет',
          style: `background:${color}`,
          onclick: () => {
            ink = color;
            recolorSelection();
            drawTools();
          },
        })),
        el('span', { class: 'board-sep' }),
        ...WIDTHS.map((w) => el('button', {
          class: `board-width${width === w ? ' is-active' : ''}`,
          type: 'button',
          title: `Толщина ${w}`,
          onclick: () => {
            width = w;
            drawTools();
          },
        }, [el('span', { style: `height:${w}px` })])),
      );
    }
  }

  function actionButton(label, content, onclick, disabled = false) {
    return el('button', { class: 'board-action', type: 'button', title: label, 'aria-label': label, disabled: disabled ? 'true' : null, onclick }, content);
  }

  function drawActions() {
    zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
    actionsBar.replaceChildren(...[
      el('div', { class: 'board-peers', title: peers.map((p) => p.name).join(', ') }, peers.slice(0, 5).map((p) =>
        el('span', { class: 'board-peer', style: `background:${p.color}`, text: initial(p.name) }))),
      actionButton('Отменить (Ctrl+Z)', [el('span', { text: '↶' })], undo, undoStack.length === 0),
      actionButton('Вернуть (Ctrl+Shift+Z)', [el('span', { text: '↷' })], redo, redoStack.length === 0),
      el('span', { class: 'board-sep' }),
      actionButton('Мельче', [el('span', { text: '−' })], () => zoomBy(1 / 1.2)),
      zoomLabel,
      actionButton('Крупнее', [el('span', { text: '+' })], () => zoomBy(1.2)),
      actionButton('Показать всё', [el('span', { text: '⤢' })], fit),
      el('span', { class: 'board-sep' }),
      getFrame && actionButton('Положить кадр демонстрации на доску', [icon('share', 15), el('span', { text: 'Кадр' })], addFrame),
      actionButton('Сохранить картинкой', [el('span', { text: 'PNG' })], exportPng),
      canClear && actionButton('Очистить доску', [icon('trash', 15)], clearAll),
      onClose && actionButton('Закрыть доску', [icon('close', 15)], onClose),
    ].filter(Boolean));
  }

  // ===== вид: сдвиг и масштаб =====
  let fitted = false;
  function applyView() {
    world.setAttribute('transform', `translate(${view.ox} ${view.oy}) scale(${view.scale})`);
    const grid = 24 * view.scale;
    viewport.style.backgroundSize = `${grid}px ${grid}px`;
    viewport.style.backgroundPosition = `${view.ox}px ${view.oy}px`;
    zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
    for (const cursor of cursors.values()) placeCursor(cursor);
    if (editing) placeEditor();
  }

  function zoomAt(factor, sx, sy) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const k = next / view.scale;
    view.ox = sx - (sx - view.ox) * k;
    view.oy = sy - (sy - view.oy) * k;
    view.scale = next;
    applyView();
  }

  function zoomBy(factor) {
    const rect = viewport.getBoundingClientRect();
    zoomAt(factor, rect.width / 2, rect.height / 2);
  }

  // «Показать всё»: все элементы в кадре с полями.
  function fit() {
    const rect = viewport.getBoundingClientRect();
    if (!elements.size || !rect.width) {
      view.ox = rect.width / 2;
      view.oy = rect.height / 2;
      view.scale = 1;
      applyView();
      return;
    }
    const b = layerElements.getBBox();
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
      Math.min((rect.width - 120) / Math.max(b.width, 1), (rect.height - 160) / Math.max(b.height, 1), 1.5)));
    view.scale = scale;
    view.ox = rect.width / 2 - (b.x + b.width / 2) * scale;
    view.oy = rect.height / 2 - (b.y + b.height / 2) * scale;
    fitted = true;
    applyView();
  }

  function toWorld(event) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - view.ox) / view.scale,
      y: (event.clientY - rect.top - view.oy) / view.scale,
    };
  }

  // ===== рисование элементов =====
  const rendered = new Map();
  const draftNodes = new Map();

  function drawElement(id) {
    rendered.get(id)?.remove();
    rendered.delete(id);
    const element = elements.get(id);
    if (element) {
      const g = renderElement(element);
      rendered.set(id, g);
      // Порядок слоёв — по z: новое поверх старого у всех одинаково.
      const after = [...elements.values()]
        .filter((e) => e.z > element.z && rendered.has(e.id))
        .sort((a, b) => a.z - b.z)[0];
      layerElements.insertBefore(g, after ? rendered.get(after.id) : null);
    }
    if (selected === id) drawSelection();
    emptyHint.hidden = elements.size > 0 || drafts.size > 0;
  }

  // Черновик поверх готового элемента (его двигают или правят текст) —
  // сам элемент на это время прячем, чтобы не было двойника.
  function drawDraft(id) {
    draftNodes.get(id)?.remove();
    draftNodes.delete(id);
    const draft = drafts.get(id);
    if (draft) {
      const g = renderElement(draft);
      draftNodes.set(id, g);
      layerDrafts.append(g);
    }
    if (editing?.element.id !== id) {
      if (draft) rendered.get(id)?.setAttribute('opacity', '0');
      else rendered.get(id)?.removeAttribute('opacity');
    }
    emptyHint.hidden = elements.size > 0 || drafts.size > 0;
  }

  function drawAll() {
    layerElements.replaceChildren();
    layerDrafts.replaceChildren();
    rendered.clear();
    draftNodes.clear();
    [...elements.values()].sort((a, b) => a.z - b.z).forEach((e) => {
      const g = renderElement(e);
      rendered.set(e.id, g);
      layerElements.append(g);
    });
    drawSelection();
    emptyHint.hidden = elements.size > 0;
  }

  function select(id) {
    selected = id;
    drawSelection();
  }

  function drawSelection() {
    layerSelection.replaceChildren();
    const g = selected && rendered.get(selected);
    if (!g) return;
    const b = g.getBBox();
    const t = elements.get(selected).data;
    layerSelection.append(svg('rect', {
      x: b.x + (t.tx || 0) - 6, y: b.y + (t.ty || 0) - 6, width: b.width + 12, height: b.height + 12,
      rx: 6, fill: 'none', stroke: '#b5abfc', 'stroke-width': 1.5 / view.scale, 'stroke-dasharray': `${5 / view.scale} ${4 / view.scale}`,
    }));
  }

  // ===== действия и отмена =====
  function commit(element, previous) {
    elements.set(element.id, element);
    drawElement(element.id);
    send(element);
    undoStack.push(previous ? { kind: 'update', before: previous, after: element } : { kind: 'add', element });
    redoStack.length = 0;
    drawActions();
  }

  function removeElements(ids, record = true) {
    const removed = ids.map((id) => elements.get(id)).filter(Boolean);
    if (!removed.length) return;
    for (const e of removed) {
      elements.delete(e.id);
      drawElement(e.id);
    }
    if (removed.some((e) => e.id === selected)) select(null);
    sendDelete(removed.map((e) => e.id));
    if (record) {
      undoStack.push({ kind: 'delete', elements: removed });
      redoStack.length = 0;
      drawActions();
    }
  }

  function apply(op, direction) {
    const put = (e) => {
      elements.set(e.id, e);
      drawElement(e.id);
      send(e);
    };
    if (op.kind === 'add') {
      if (direction === 'undo') removeElements([op.element.id], false);
      else put(op.element);
    } else if (op.kind === 'delete') {
      if (direction === 'undo') op.elements.forEach(put);
      else removeElements(op.elements.map((e) => e.id), false);
    } else if (op.kind === 'update') {
      put(direction === 'undo' ? op.before : op.after);
    }
  }

  function undo() {
    const op = undoStack.pop();
    if (!op) return;
    apply(op, 'undo');
    redoStack.push(op);
    drawActions();
  }

  function redo() {
    const op = redoStack.pop();
    if (!op) return;
    apply(op, 'redo');
    undoStack.push(op);
    drawActions();
  }

  function clearAll() {
    if (!window.confirm('Стереть всё с доски? Это увидят все участники.')) return;
    socket.emit('board:clear', { channel_id: channelId });
  }

  function recolorSelection() {
    const element = selected && elements.get(selected);
    if (!element || !('color' in element.data) || element.type === 'sticky') return;
    commit({ ...element, data: { ...element.data, color: ink } }, element);
  }

  // Кадр демонстрации ложится справа от того, что уже нарисовано (на пустой
  // доске — в центр), и под все рисунки: стрелки и стикеры поверх него
  // остаются видны.
  async function addFrame() {
    const frame = await getFrame?.().catch(() => null);
    if (!frame) {
      status.textContent = 'Демонстрации экрана сейчас нет';
      setTimeout(() => { status.textContent = ''; }, 2500);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const w = Math.min(frame.width, 720);
    const h = (w * frame.height) / frame.width;
    let x;
    let y;
    if (elements.size) {
      const b = layerElements.getBBox();
      x = b.x + b.width + 60;
      y = b.y;
    } else {
      x = (rect.width / 2 - view.ox) / view.scale - w / 2;
      y = (rect.height / 2 - view.oy) / view.scale - h / 2;
    }
    const minZ = Math.min(Date.now(), ...[...elements.values()].map((e) => e.z));
    const element = newElement('image', { x: round(x), y: round(y), w: round(w), h: round(h), src: frame.src, tx: 0, ty: 0 });
    element.z = minZ - 1;
    commit(element);
    fit();
    setTool('pen');
  }

  const newElement = (type, data) => ({
    id: uuid(),
    type,
    z: Date.now() + Math.random(),
    data,
    author_name: me.name,
  });

  // ===== редактор текста и стикеров =====
  function placeEditor() {
    const { element } = editing;
    const d = element.data;
    const sticky = element.type === 'sticky';
    const x = (d.x + (d.tx || 0)) * view.scale + view.ox;
    const y = (d.y + (d.ty || 0)) * view.scale + view.oy;
    const w = (sticky ? d.w : d.w + 8) * view.scale;
    Object.assign(editor.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: sticky ? `${d.h * view.scale}px` : `${Math.max(1.6, (d.text.split('\n').length + 0.6) * 1.25) * d.size * view.scale}px`,
      fontSize: `${(sticky ? 18 : d.size) * view.scale}px`,
      padding: sticky ? `${16 * view.scale}px` : '0',
      color: sticky ? STICKY_TEXT : d.color,
      background: sticky ? STICKY[d.color] : 'transparent',
    });
  }

  function startEditing(element, previous = null) {
    finishEditing();
    editing = { element: { ...element, data: { ...element.data } }, previous };
    editor.value = element.data.text;
    editor.hidden = false;
    editor.classList.toggle('is-sticky', element.type === 'sticky');
    rendered.get(element.id)?.setAttribute('opacity', '0');
    placeEditor();
    // Фокус сразу: первая буква, набранная сразу после щелчка, не теряется.
    // Запасной вариант — на следующем такте, если браузер перехватил фокус.
    editor.focus();
    setTimeout(() => {
      if (editing && document.activeElement !== editor) editor.focus();
    }, 0);
  }

  function finishEditing() {
    if (!editing) return;
    const { element, previous } = editing;
    editing = null;
    editor.hidden = true;
    rendered.get(element.id)?.removeAttribute('opacity');
    const text = editor.value.replace(/\s+$/, '');
    // Пустой текст — это «передумал»; пустой стикер оставляем: его часто
    // клеят как метку цвета.
    if (!text && element.type === 'text') {
      if (elements.has(element.id)) removeElements([element.id]);
      return;
    }
    if (previous && previous.data.text === text) {
      drawElement(element.id);
      return;
    }
    commit({ ...element, data: { ...element.data, text } }, previous);
  }

  editor.addEventListener('input', () => {
    if (!editing) return;
    editing.element.data.text = editor.value;
    if (editing.element.type === 'text') placeEditor();
    sendDraft(editing.element);
  });
  editor.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      finishEditing();
      viewport.focus();
    }
  });
  editor.addEventListener('blur', finishEditing);

  // ===== указатель =====
  function hitAt(event) {
    for (const target of document.elementsFromPoint(event.clientX, event.clientY)) {
      const g = target.closest?.('[data-id]');
      if (g && layerElements.contains(g)) return g.getAttribute('data-id');
    }
    return null;
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (event.target === editor) return;
    finishEditing();
    viewport.focus();
    const point = toWorld(event);
    const panning = tool === 'hand' || spaceDown || event.button === 1;
    if (panning) {
      action = { kind: 'pan', sx: event.clientX, sy: event.clientY, ox: view.ox, oy: view.oy };
      viewport.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;

    if (tool === 'select') {
      const id = hitAt(event);
      select(id);
      if (id) {
        const element = elements.get(id);
        action = { kind: 'move', id, start: point, before: element, tx: element.data.tx || 0, ty: element.data.ty || 0 };
        viewport.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (tool === 'eraser') {
      action = { kind: 'erase', ids: new Set() };
      const id = hitAt(event);
      if (id) eraseLive(id);
      return;
    }
    if (tool === 'text' || tool === 'sticky') {
      // Иначе браузер после щелчка переведёт фокус с редактора на холст.
      event.preventDefault();
    }
    if (tool === 'text') {
      const element = newElement('text', { x: round(point.x), y: round(point.y - 12), text: '', color: ink, size: 24, w: 360, tx: 0, ty: 0 });
      elements.set(element.id, element);
      drawElement(element.id);
      startEditing(element);
      return;
    }
    if (tool === 'sticky') {
      const element = newElement('sticky', { x: round(point.x - 100), y: round(point.y - 100), w: 200, h: 200, text: '', color: stickyColor, tx: 0, ty: 0 });
      commit(element);
      startEditing(element, element);
      return;
    }

    let element;
    if (tool === 'pen') element = newElement('path', { points: [round(point.x), round(point.y)], color: ink, width, tx: 0, ty: 0 });
    if (tool === 'rect' || tool === 'ellipse') {
      element = newElement(tool, { x: round(point.x), y: round(point.y), w: 0, h: 0, color: ink, width, fill: false, tx: 0, ty: 0 });
    }
    if (tool === 'arrow') {
      element = newElement('arrow', { x1: round(point.x), y1: round(point.y), x2: round(point.x), y2: round(point.y), color: ink, width, tx: 0, ty: 0 });
    }
    if (!element) return;
    action = { kind: 'draw', element };
    viewport.setPointerCapture(event.pointerId);
  });

  function eraseLive(id) {
    if (!action || action.ids.has(id)) return;
    action.ids.add(id);
    rendered.get(id)?.setAttribute('opacity', '0.2');
  }

  viewport.addEventListener('pointermove', (event) => {
    const point = toWorld(event);
    sendCursor(point);
    if (!action) return;
    if (action.kind === 'pan') {
      view.ox = action.ox + event.clientX - action.sx;
      view.oy = action.oy + event.clientY - action.sy;
      applyView();
      return;
    }
    if (action.kind === 'erase') {
      const id = hitAt(event);
      if (id) eraseLive(id);
      return;
    }
    if (action.kind === 'move') {
      const element = elements.get(action.id);
      if (!element) return;
      const moved = {
        ...element,
        data: { ...element.data, tx: round(action.tx + point.x - action.start.x), ty: round(action.ty + point.y - action.start.y) },
      };
      elements.set(moved.id, moved);
      drawElement(moved.id);
      sendDraft(moved);
      action.moved = moved;
      return;
    }
    if (action.kind === 'draw') {
      const { element } = action;
      const d = element.data;
      if (element.type === 'path') {
        const lx = d.points[d.points.length - 2];
        const ly = d.points[d.points.length - 1];
        if (Math.hypot(point.x - lx, point.y - ly) < 1.5 / view.scale || d.points.length >= 7998) return;
        d.points.push(round(point.x), round(point.y));
      } else if (element.type === 'arrow') {
        d.x2 = round(point.x);
        d.y2 = round(point.y);
      } else {
        d.w = round(point.x - d.x);
        d.h = round(point.y - d.y);
        if (event.shiftKey) d.h = Math.sign(d.h || 1) * Math.abs(d.w);
      }
      drafts.set(element.id, element);
      drawDraft(element.id);
      sendDraft(element);
    }
  });

  function endPointer() {
    if (!action) return;
    const current = action;
    action = null;
    if (current.kind === 'erase') {
      if (current.ids.size) removeElements([...current.ids]);
      return;
    }
    if (current.kind === 'move') {
      if (current.moved) commit(current.moved, current.before);
      return;
    }
    if (current.kind === 'draw') {
      const { element } = current;
      drafts.delete(element.id);
      drawDraft(element.id);
      const d = element.data;
      // Случайный щелчок фигурой — не фигура.
      const tiny = element.type === 'path'
        ? d.points.length < 4
        : element.type === 'arrow'
          ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4
          : Math.abs(d.w) < 4 && Math.abs(d.h) < 4;
      if (tiny && element.type !== 'path') return;
      if (element.type === 'path' && d.points.length < 4) d.points.push(d.points[0] + 0.5, d.points[1] + 0.5);
      commit(element);
    }
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  viewport.addEventListener('dblclick', (event) => {
    const id = hitAt(event);
    const element = id && elements.get(id);
    if (element && (element.type === 'text' || element.type === 'sticky')) startEditing(element, element);
  });

  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    } else {
      view.ox -= event.deltaX;
      view.oy -= event.deltaY;
      applyView();
    }
  }, { passive: false });

  const KEYS = Object.fromEntries(TOOLS.map(([id, , key]) => [key.toLowerCase(), id]));
  viewport.addEventListener('keydown', (event) => {
    if (editing) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === ' ') {
      spaceDown = true;
      viewport.classList.add('is-panning');
      event.preventDefault();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault();
      removeElements([selected]);
      return;
    }
    if (event.key === 'Escape') {
      select(null);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && KEYS[key]) setTool(KEYS[key]);
  });
  viewport.addEventListener('keyup', (event) => {
    if (event.key === ' ') {
      spaceDown = false;
      viewport.classList.remove('is-panning');
    }
  });

  function setTool(next) {
    tool = next;
    if (tool !== 'select') select(null);
    drawTools();
    viewport.focus();
  }

  // ===== курсоры участников =====
  function placeCursor(cursor) {
    cursor.node.style.transform = `translate(${cursor.x * view.scale + view.ox}px, ${cursor.y * view.scale + view.oy}px)`;
  }

  function drawCursor(c) {
    let cursor = cursors.get(c.id);
    if (!cursor) {
      const arrow = svg('svg', { width: 18, height: 18, viewBox: '0 0 18 18' });
      arrow.append(svg('path', { d: 'M2 2l13 5.5-5.6 1.6L7.8 15z', fill: c.color, stroke: '#101223', 'stroke-width': 1.2 }));
      const nodeC = el('div', { class: 'board-cursor' }, [arrow, el('span', { class: 'board-cursor-name', text: c.name, style: `background:${c.color}` })]);
      cursor = { node: nodeC };
      cursors.set(c.id, cursor);
      cursorLayer.append(nodeC);
    }
    cursor.x = c.x;
    cursor.y = c.y;
    cursor.node.hidden = false;
    placeCursor(cursor);
    clearTimeout(cursor.timer);
    cursor.timer = setTimeout(() => {
      cursor.node.hidden = true;
    }, 4000);
  }

  // ===== сохранение картинкой =====
  function exportPng() {
    if (!elements.size) return;
    const b = layerElements.getBBox();
    const pad = 40;
    const scale = Math.min(2, 4000 / Math.max(b.width + pad * 2, b.height + pad * 2));
    const out = svg('svg', {
      xmlns: SVG_NS,
      width: Math.round((b.width + pad * 2) * scale),
      height: Math.round((b.height + pad * 2) * scale),
      viewBox: `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`,
    });
    out.append(svg('rect', { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, fill: BOARD_BG }));
    out.append(layerElements.cloneNode(true));
    const source = new XMLSerializer().serializeToString(out);
    const image = new Image();
    image.onload = () => {
      const c = document.createElement('canvas');
      c.width = out.getAttribute('width');
      c.height = out.getAttribute('height');
      c.getContext('2d').drawImage(image, 0, 0);
      c.toBlob((blob) => {
        const link = el('a', { href: URL.createObjectURL(blob), download: `board-${new Date().toISOString().slice(0, 10)}.png`, hidden: '' });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      });
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  }

  // Размер окна поменялся — холст остаётся на месте; при первом показе
  // центрируем начало координат.
  let centered = false;
  const resize = new ResizeObserver(() => {
    if (fitted || centered || !viewport.clientWidth) return;
    if (elements.size) fit();
    else {
      view.ox = viewport.clientWidth / 2;
      view.oy = viewport.clientHeight / 2;
      centered = true;
      applyView();
    }
  });
  resize.observe(viewport);

  drawTools();
  drawActions();
  applyView();

  return {
    node,
    focus: () => viewport.focus(),
    setFrameSource(fn) {
      if (getFrame === fn) return;
      getFrame = fn;
      drawActions();
    },
    destroy() {
      resize.disconnect();
      draftTimers.forEach(clearTimeout);
      socket.emit('board:leave', channelId);
      socket.disconnect();
    },
  };
}
