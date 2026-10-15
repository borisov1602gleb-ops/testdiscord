// Статус человека: режим присутствия (в сети, отошёл, не беспокоить,
// невидимка) и подпись с эмодзи и сроком. Здесь же — свой режим и подпись,
// окно их выбора и слежение за бездействием: после 10 минут без мыши и
// клавиатуры вкладка сообщает серверу, что человек «отошёл».
import { api } from './api.js';
import { el, showModal } from './dom.js';

export const PRESENCE_LABELS = {
  online: 'В сети',
  away: 'Отошёл',
  dnd: 'Не беспокоить',
  invisible: 'Невидимка',
  offline: 'Не в сети',
};

const MODE_HINTS = {
  online: 'Видно, что вы здесь',
  away: 'Как будто отошли от компьютера',
  dnd: 'Без звуков и уведомлений, кроме личных сообщений',
  invisible: 'Для всех — «не в сети», но вы всё видите',
};

const QUICK_EMOJI = ['🎓', '💼', '🏠', '🚗', '☕', '🍔', '🤒', '🎧', '🎮', '📚'];
const IDLE_AFTER_MS = 10 * 60 * 1000;
const STATUS_TEXT_MAX = 80;

// Свой режим и подпись: читаются при открытии экрана и меняются событием
// my_presence (в том числе из соседней вкладки).
let mine = { mode: 'online', status: null };
const listeners = new Set();

export function myPresence() {
  return mine;
}

export function setMyPresence(next) {
  mine = { mode: next.mode ?? mine.mode, status: next.status === undefined ? mine.status : next.status };
  for (const fn of listeners) fn(mine);
}

export function onMyPresence(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadMyPresence() {
  try {
    const { user } = await api('/users/me');
    setMyPresence({ mode: user.presence_mode ?? 'online', status: user.status ?? null });
  } catch {
    /* останется «в сети» */
  }
}

// «Не беспокоить»: звуки и уведомления только о личных сообщениях.
export function isDoNotDisturb() {
  return mine.mode === 'dnd';
}

// Подпись истекла, пока экран был открыт, — не показываем.
export function liveStatus(status) {
  if (!status) return null;
  if (status.expires_at && Date.parse(status.expires_at) <= Date.now()) return null;
  return status.text || status.emoji ? status : null;
}

export function statusText(status) {
  const s = liveStatus(status);
  return s ? [s.emoji, s.text].filter(Boolean).join(' ') : '';
}

// Строка под именем: подпись, а если её нет — режим.
export function presenceLine(presence, status) {
  return statusText(status) || PRESENCE_LABELS[presence ?? 'offline'];
}

// Класс точки на аватарке.
export function presenceClass(presence) {
  if (presence === 'online') return ' is-online';
  if (presence === 'away') return ' is-away';
  if (presence === 'dnd') return ' is-dnd';
  return '';
}

// ===== бездействие =====

// Следит за мышью, клавиатурой и тем, видна ли вкладка. Возвращает функцию
// отписки. report(idle) зовётся только при смене состояния.
export function watchIdle(report) {
  let idle = false;
  let timer = null;
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      report(true);
    }, IDLE_AFTER_MS);
  }
  function onActivity() {
    if (document.hidden) return;
    if (idle) {
      idle = false;
      report(false);
    }
    arm();
  }
  const events = ['mousemove', 'keydown', 'pointerdown', 'wheel', 'touchstart', 'visibilitychange'];
  for (const name of events) window.addEventListener(name, onActivity, { passive: true });
  arm();
  return () => {
    clearTimeout(timer);
    for (const name of events) window.removeEventListener(name, onActivity);
  };
}

// ===== окно статуса =====

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 0);
  return d;
}

const EXPIRY_OPTIONS = [
  ['never', 'Не сбрасывать'],
  ['30m', '30 минут'],
  ['1h', '1 час'],
  ['4h', '4 часа'],
  ['today', 'До конца дня'],
];

function expiryFor(choice) {
  const minutes = { '30m': 30, '1h': 60, '4h': 240 }[choice];
  if (minutes) return new Date(Date.now() + minutes * 60_000).toISOString();
  if (choice === 'today') return endOfToday().toISOString();
  return null;
}

export function showStatusModal() {
  let mode = mine.mode;
  const current = liveStatus(mine.status);
  const emoji = el('input', {
    class: 'input status-emoji-input', type: 'text', maxlength: '8', value: current?.emoji ?? '', placeholder: '🙂', 'aria-label': 'Эмодзи',
  });
  const text = el('input', {
    class: 'input', type: 'text', maxlength: String(STATUS_TEXT_MAX), value: current?.text ?? '', placeholder: 'Например, на парах до 15:00',
  });
  const expiry = el('select', { class: 'select' }, EXPIRY_OPTIONS.map(([id, label]) => el('option', { value: id, text: label })));
  const error = el('p', { class: 'field-error' });

  const modes = el('div', { class: 'status-modes' });
  function drawModes() {
    modes.replaceChildren(...['online', 'away', 'dnd', 'invisible'].map((id) => el('button', {
      class: `status-mode${mode === id ? ' is-active' : ''}`,
      type: 'button',
      onclick: () => {
        mode = id;
        drawModes();
      },
    }, [
      el('span', { class: `status-dot is-${id}` }),
      el('span', { class: 'status-mode-texts' }, [
        el('span', { class: 'status-mode-name', text: PRESENCE_LABELS[id] }),
        el('span', { class: 'status-mode-hint', text: MODE_HINTS[id] }),
      ]),
    ])));
  }
  drawModes();

  async function save(clear = false) {
    error.textContent = '';
    try {
      const body = { mode };
      if (clear) Object.assign(body, { text: '', emoji: '' });
      else Object.assign(body, { text: text.value.trim(), emoji: emoji.value.trim(), expires_at: expiryFor(expiry.value) });
      const { user } = await api('/users/me/status', { method: 'PUT', body });
      setMyPresence({ mode: user.presence_mode, status: user.status });
      scrim.remove();
    } catch (err) {
      error.textContent = err.message;
    }
  }

  const scrim = showModal(el('form', { class: 'modal status-modal', onsubmit: (e) => (e.preventDefault(), save()) }, [
    el('h2', { class: 'modal-title', text: 'Статус' }),
    modes,
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Подпись — видна в списке участников и в личке' }),
      el('div', { class: 'status-text-row' }, [emoji, text]),
      el('div', { class: 'status-quick' }, QUICK_EMOJI.map((e) => el('button', {
        class: 'status-quick-pick', type: 'button', text: e, onclick: () => (emoji.value = e),
      }))),
    ]),
    el('div', { class: 'field' }, [el('span', { class: 'field-label', text: 'Сбросить подпись через' }), expiry]),
    el('div', { class: 'modal-actions' }, [
      current && el('button', { class: 'btn btn-ghost', type: 'button', text: 'Очистить подпись', onclick: () => save(true) }),
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Отмена', onclick: () => scrim.remove() }),
      el('button', { class: 'btn btn-primary', type: 'submit', text: 'Сохранить' }),
    ]),
    error,
  ]));
  text.focus();
}
