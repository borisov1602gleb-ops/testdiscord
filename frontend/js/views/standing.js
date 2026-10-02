// Мои меры и обжалования. Для заблокированного это единственный доступный
// экран: причина, срок и форма обжалования. Остальные видят здесь историю
// мер (предупреждения, заглушения, удалённые сообщения, меры против своих
// сообществ) и обжалуют то, что ещё можно.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon } from '../dom.js';
import { navigate } from '../router.js';
import {
  loadPlatform, SANCTION_LABELS, APPEAL_STATUS_LABELS, untilText, formatDateTime, markSeen,
} from '../platform.js';

const APPEAL_MIN = 10;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

// Грустный логотип с замком — как в макете экрана блокировки. Лицо
// рисуется поверх нашего знака: тёмная плашка закрывает глаза, сверху —
// грустные брови, глаза, слеза и рот.
function sadLogo() {
  const face = svg('g', { transform: 'translate(60 74) scale(0.576) translate(-512 -470)' }, [
    svg('rect', { x: 512, y: 470, width: 236, height: 200, rx: 34, fill: '#05030d' }),
    svg('path', { d: 'M532 512 L598 486', stroke: 'url(#sadEye)', 'stroke-width': 20, 'stroke-linecap': 'round', fill: 'none' }),
    svg('path', { d: 'M662 486 L728 512', stroke: 'url(#sadEye)', 'stroke-width': 20, 'stroke-linecap': 'round', fill: 'none' }),
    svg('rect', { x: 545, y: 532, width: 54, height: 72, rx: 27, fill: 'url(#sadEye)' }),
    svg('rect', { x: 661, y: 532, width: 54, height: 72, rx: 27, fill: 'url(#sadEye)' }),
    svg('path', { d: 'M540 622 q-14 22 0 32 q14 -10 0 -32z', fill: '#7fb4ff' }),
    svg('path', { d: 'M584 668 Q630 628 676 668', stroke: 'url(#sadEye)', 'stroke-width': 18, 'stroke-linecap': 'round', fill: 'none' }),
  ]);
  const overlay = svg('svg', { viewBox: '0 0 256 256', class: 'block-logo-face', 'aria-hidden': 'true' }, [
    svg('defs', {}, [svg('linearGradient', { id: 'sadEye', x1: 0, y1: 0, x2: 0, y2: 1 }, [
      svg('stop', { offset: 0, 'stop-color': '#b65cff' }),
      svg('stop', { offset: 1, 'stop-color': '#4a3cff' }),
    ])]),
    face,
  ]);
  return el('div', { class: 'block-logo' }, [
    el('div', { class: 'block-logo-art' }, [
      el('img', { src: '/assets/logo.png', alt: '' }),
      overlay,
    ]),
    el('div', { class: 'block-lock' }, [icon('lock', 26)]),
  ]);
}

function daysWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

function termText(s) {
  if (!s.ends_at) return 'Бессрочно';
  const days = Math.max(1, Math.round((new Date(s.ends_at) - new Date(s.starts_at ?? s.created_at)) / 86_400_000));
  return `${days} ${daysWord(days)}`;
}

function unblockText(s) {
  if (!s.ends_at) return 'Только по апелляции';
  return new Date(s.ends_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    .replace(' в ', ', ');
}

// Экран блокировки — единственное, что видит заблокированный: причина,
// срок, когда снимется, и апелляция. Решение по апелляции принимает
// другой сотрудник, не тот, кто заблокировал.
function renderBlocked(state) {
  const main = state.sanctions.find((s) => s.id === state.block.id) ?? {
    ...state.block, active: true, can_appeal: false, appeal: null,
  };
  const permanent = main.kind === 'ban';
  const actionSlot = el('div', { class: 'block-action' });

  function showButton() {
    actionSlot.replaceChildren(el('button', {
      class: 'block-appeal-btn',
      type: 'button',
      onclick: showForm,
    }, [icon('scales', 22), 'Подать апелляцию']));
  }

  function showForm() {
    const text = el('textarea', {
      class: 'block-textarea',
      rows: '4',
      maxlength: '2000',
      placeholder: 'Опишите ситуацию: что произошло и почему решение стоит пересмотреть',
    });
    const error = el('p', { class: 'field-error' });
    const send = el('button', { class: 'block-send', type: 'button', disabled: '' }, [icon('send', 16), 'Отправить апелляцию']);
    text.addEventListener('input', () => {
      send.disabled = !text.value.trim();
    });
    send.addEventListener('click', async () => {
      error.textContent = '';
      if (text.value.trim().length < APPEAL_MIN) {
        error.textContent = 'Опишите подробнее — хотя бы пару предложений';
        return;
      }
      send.disabled = true;
      try {
        await api('/platform/appeals', { method: 'POST', body: { sanction_id: main.id, text: text.value } });
        showSent();
      } catch (err) {
        send.disabled = false;
        error.textContent = err.message;
      }
    });
    actionSlot.replaceChildren(el('div', { class: 'block-form' }, [
      el('label', { class: 'block-form-label', text: 'Почему блокировку стоит снять?' }),
      text,
      el('div', { class: 'block-form-actions' }, [
        el('button', { class: 'block-cancel', type: 'button', text: 'Отмена', onclick: showButton }),
        send,
      ]),
      error,
    ]));
    text.focus();
  }

  function showSent() {
    actionSlot.replaceChildren(el('div', { class: 'block-status is-sent' }, [
      icon('checkCircle', 20),
      el('span', { text: 'Апелляция отправлена. Её рассмотрит другой сотрудник — не тот, кто вас заблокировал. Ответ появится здесь же.' }),
    ]));
  }

  if (main.appeal?.status === 'pending') {
    actionSlot.append(el('div', { class: 'block-status is-sent' }, [
      icon('checkCircle', 20),
      el('div', {}, [
        el('p', { text: 'Апелляция на рассмотрении. Ответ появится здесь же.' }),
        el('p', { class: 'block-status-quote', text: `«${main.appeal.text}»` }),
      ]),
    ]));
  } else if (main.appeal?.status === 'rejected') {
    actionSlot.append(el('div', { class: 'block-status is-rejected' }, [
      icon('alert', 20),
      el('div', {}, [
        el('p', { text: 'Апелляция отклонена.' }),
        main.appeal.response && el('p', { class: 'block-status-quote', text: main.appeal.response }),
      ]),
    ]));
  } else if (main.can_appeal) {
    showButton();
  } else {
    actionSlot.append(el('p', { class: 'block-note', text: 'Срок подачи апелляции истёк.' }));
  }

  // Пока экран открыт, раз в полминуты проверяем, не сняли ли блокировку:
  // по апелляции или по сроку.
  const timer = setInterval(async () => {
    if (location.hash !== '#/blocked') return clearInterval(timer);
    const fresh = await loadPlatform().catch(() => null);
    if (fresh && !fresh.block) {
      clearInterval(timer);
      navigate('#/');
    }
  }, 30_000);

  mount(el('div', { class: 'blocked' }, [
    el('div', { class: 'blocked-frame' }, [
      el('div', { class: 'blocked-card' }, [
        sadLogo(),
        el('div', { class: 'blocked-heading' }, [
          el('p', { class: 'blocked-kicker', text: 'Доступ ограничен' }),
          el('h1', {
            class: 'blocked-title',
            text: permanent ? 'Ваш аккаунт заблокирован навсегда' : 'Вы заблокированы за нарушение правил платформы',
          }),
          el('p', {
            class: 'blocked-sub',
            text: 'Служба платформы ограничила доступ к сообществам, сообщениям, личной переписке и звонкам.',
          }),
        ]),
        el('div', { class: 'blocked-info' }, [
          el('div', { class: 'blocked-field' }, [
            el('span', { class: 'blocked-label', text: 'Причина' }),
            el('span', { class: 'blocked-reason', text: main.reason }),
          ]),
          el('div', { class: 'blocked-grid' }, [
            el('div', { class: 'blocked-field' }, [
              el('span', { class: 'blocked-label', text: 'Срок' }),
              el('span', { text: termText(main) }),
            ]),
            el('div', { class: 'blocked-field' }, [
              el('span', { class: 'blocked-label', text: 'Разблокировка' }),
              el('span', { text: unblockText(main) }),
            ]),
          ]),
        ]),
        actionSlot,
        el('div', { class: 'blocked-links' }, [
          el('button', { class: 'blocked-link', type: 'button', text: 'Проверить снова', onclick: () => navigate('#/') }),
          el('button', {
            class: 'blocked-link',
            type: 'button',
            text: 'Выйти из аккаунта',
            onclick: () => {
              clearInterval(timer);
              store.clearSession();
              navigate('#/login');
            },
          }),
        ]),
      ]),
    ]),
  ]));
}

function appealForm(sanction, onSent) {
  const text = el('textarea', {
    class: 'input appeal-text',
    rows: '4',
    maxlength: '2000',
    placeholder: 'Объясните, почему решение стоит пересмотреть. Его рассмотрит другой сотрудник, не тот, кто его принял.',
  });
  const error = el('p', { class: 'field-error' });
  const send = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: 'Отправить обжалование',
    onclick: async () => {
      error.textContent = '';
      if (text.value.trim().length < APPEAL_MIN) {
        error.textContent = 'Опишите подробнее — хотя бы пару предложений';
        return;
      }
      send.disabled = true;
      try {
        await api('/platform/appeals', { method: 'POST', body: { sanction_id: sanction.id, text: text.value } });
        await onSent();
      } catch (err) {
        send.disabled = false;
        error.textContent = err.message;
      }
    },
  });
  return el('div', { class: 'appeal-form' }, [
    el('label', { class: 'field-label', text: 'Обжалование' }),
    text,
    el('p', { class: 'field-hint', text: 'Подать можно один раз, в течение 30 дней. Ответ придёт сюда же.' }),
    el('div', { class: 'btn-row' }, [send]),
    error,
  ]);
}

function appealState(appeal) {
  return el('div', { class: `appeal-state is-${appeal.status}` }, [
    el('p', { class: 'appeal-state-title', text: `Обжалование ${APPEAL_STATUS_LABELS[appeal.status]}` }),
    el('p', { class: 'appeal-quote', text: appeal.text }),
    appeal.response && el('p', { class: 'appeal-response' }, [
      el('strong', { text: 'Ответ службы платформы: ' }),
      appeal.response,
    ]),
  ]);
}

function sanctionCard(s, refresh) {
  const where = s.community ? `Сообщество «${s.community.name}»` : null;
  const status = s.revoked_at
    ? `Снято ${formatDateTime(s.revoked_at)}${s.revoke_reason ? ` — ${s.revoke_reason}` : ''}`
    : ['mute', 'suspend', 'ban'].includes(s.kind)
      ? (s.active ? `Действует ${untilText(s.ends_at)}` : 'Срок истёк')
      : s.kind === 'warning' ? 'Предупреждение ничего не ограничивает' : 'Действует';
  return el('section', { class: `sanction-card${s.active ? ' is-active' : ''}` }, [
    el('div', { class: 'sanction-head' }, [
      icon(s.kind === 'warning' ? 'alert' : 'shield', 18),
      el('p', { class: 'sanction-title', text: SANCTION_LABELS[s.kind] }),
      el('span', { class: 'sanction-date', text: formatDateTime(s.created_at) }),
    ]),
    where && el('p', { class: 'row-note', text: where }),
    el('p', { class: 'sanction-reason' }, [el('strong', { text: 'Причина: ' }), s.reason]),
    el('p', { class: 'row-note', text: status }),
    s.final && el('p', { class: 'row-note', text: 'Удалено по требованию государственного органа — такое решение не обжалуется.' }),
    s.appeal ? appealState(s.appeal) : s.can_appeal && appealForm(s, refresh),
  ]);
}

export async function renderStanding({ blocked = false } = {}) {
  mount(el('div', { class: 'empty' }, [el('p', { class: 'empty-quiet', text: 'Загружаем…' })]));
  const state = await loadPlatform();
  const refresh = () => renderStanding({ blocked });

  // Человек увидел свои меры и ответы — уведомления над чатом гаснут.
  const unseen = state.sanctions.filter((s) => !s.seen
    || (s.appeal && s.appeal.status !== 'pending' && !s.appeal.response_seen)).map((s) => s.id);
  if (unseen.length) markSeen(unseen);

  if (blocked || state.block) {
    if (!state.block) return navigate('#/');
    return renderBlocked(state);
  }

  mount(
    el('div', { class: 'settings' }, [
      el('nav', { class: 'settings-nav' }, [
        el('p', { class: 'settings-kicker', text: 'Аккаунт' }),
        el('button', { class: 'set-nav', type: 'button', text: '← Назад', onclick: () => navigate('#/') }),
        el('button', { class: 'set-nav', type: 'button', text: 'Настройки', onclick: () => navigate('#/settings') }),
        el('button', { class: 'set-nav is-active', type: 'button', text: 'Меры и обжалования' }),
      ]),
      el('div', { class: 'settings-pane' }, [
        el('header', { class: 'settings-head' }, [
          el('h1', { class: 'settings-title', text: 'Меры и обжалования' }),
        ]),
        el('div', { class: 'settings-body' }, [
          el('p', { class: 'row-note', text: 'Решения службы платформы по вашему аккаунту, сообщениям и сообществам. Несогласны — обжалуйте: решение пересмотрит другой сотрудник.' }),
          state.mute && el('div', { class: 'platform-notice is-mute' }, [
            icon('shield', 16),
            el('p', { class: 'platform-notice-text', text: `Вы заглушены ${untilText(state.mute.ends_at)}: можно читать, но не писать. Причина: ${state.mute.reason}` }),
          ]),
          ...(state.sanctions.length
            ? state.sanctions.map((s) => sanctionCard(s, refresh))
            : [el('p', { class: 'empty-quiet', text: 'Мер нет — всё в порядке.' })]),
        ]),
      ]),
    ]),
  );
}
