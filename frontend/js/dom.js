// Весь пользовательский контент попадает в DOM через textContent,
// innerHTML не используется нигде — иначе имя сообщества или текст
// сообщения стали бы вектором XSS.
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

export function mount(...children) {
  const app = document.getElementById('app');
  app.replaceChildren(...children);
}

export function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Первая буква для кружка-аватара.
export function initial(value) {
  return (value ?? '?').trim().slice(0, 1) || '?';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Иконки из макета. Держим их описанием, а не строкой разметки, чтобы
// не заводить innerHTML ради картинки.
const ICONS = {
  mark: {
    box: 16,
    shapes: [
      ['circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', 'stroke-width': 1.3 }],
      ['circle', { cx: 8, cy: 8, r: 2.2, fill: 'currentColor' }],
    ],
  },
  plus: {
    box: 24,
    shapes: [
      ['path', { d: 'M12 5v14M5 12h14', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }],
    ],
  },
  speaker: {
    box: 16,
    shapes: [
      ['path', { d: 'M3 6h2.4L9 3.2v9.6L5.4 10H3z', fill: 'currentColor' }],
      ['path', { d: 'M11.4 5.6a3.4 3.4 0 010 4.8', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round' }],
    ],
  },
  alert: {
    box: 18,
    shapes: [
      ['circle', { cx: 9, cy: 9, r: 7.2, stroke: 'currentColor', 'stroke-width': 1.3 }],
      ['path', { d: 'M9 5.4v4.2', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }],
      ['circle', { cx: 9, cy: 12.4, r: 0.9, fill: 'currentColor' }],
    ],
  },
};

export function icon(name, size) {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  const px = size ?? spec.box;
  svg.setAttribute('width', px);
  svg.setAttribute('height', px);
  svg.setAttribute('viewBox', `0 0 ${spec.box} ${spec.box}`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  for (const [tag, attrs] of spec.shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}
