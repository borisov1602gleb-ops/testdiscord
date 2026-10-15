// События сообщества в интерфейсе: список ближайших и прошедших встреч,
// ответы «пойду / может быть / не пойду», форма создания и правки,
// плашка «Сегодня в 19:00 — созвон» над чатом и всплывающие напоминания.
import { api } from './api.js';
import { el, icon, showModal } from './dom.js';

const ANSWERS = [
  ['going', 'Пойду'],
  ['maybe', 'Может быть'],
  ['no', 'Не пойду'],
];
const DURATIONS = [[30, '30 минут'], [60, '1 час'], [90, '1,5 часа'], [120, '2 часа'], [180, '3 часа'], [0, 'Без окончания']];

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function dayLabel(date) {
  const today = new Date();
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(date) - start(today)) / 86_400_000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
}

// «Сегодня в 19:00–20:00», «чт, 16 октября в 19:00».
export function eventWhen(event) {
  const starts = new Date(event.starts_at);
  const ends = event.ends_at ? new Date(event.ends_at) : null;
  const sameDay = ends && ends.toDateString() === starts.toDateString();
  return `${dayLabel(starts)} в ${clock(starts)}${sameDay ? `–${clock(ends)}` : ''}`;
}

export function isToday(event) {
  return new Date(event.starts_at).toDateString() === new Date().toDateString();
}

// Что показать над чатом: идущая встреча или ближайшая сегодняшняя.
export function bannerEvent(events) {
  return events.find((e) => e.live) ?? events.find((e) => isToday(e) && Date.parse(e.starts_at) > Date.now()) ?? null;
}

function peopleWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'человек';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'человека';
  return 'человек';
}

// ===== карточка события =====

// ctx: { communityId, canManage, canAnswer, voiceChannels, onJoin(event), reload() }
export function eventCard(event, ctx, { past = false } = {}) {
  const where = event.channel
    ? el('span', { class: 'event-where' }, [icon('speaker', 14), event.channel.name])
    : event.location_text && el('span', { class: 'event-where' }, [icon('pin', 14), event.location_text]);

  const answers = !past && ctx.canAnswer && el('div', { class: 'event-answers' }, ANSWERS.map(([answer, label]) => el('button', {
    class: `event-answer${event.my_answer === answer ? ' is-active' : ''}`,
    type: 'button',
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/communities/${ctx.communityId}/events/${event.id}/rsvp`, {
          method: 'PUT',
          // Повторное нажатие на свой ответ — снять ответ.
          body: { answer: event.my_answer === answer ? null : answer },
        });
        ctx.reload();
      } catch (err) {
        alert(err.message);
      }
    },
  }, [label])));

  const going = event.people.filter((p) => p.answer === 'going');
  const maybe = event.people.filter((p) => p.answer === 'maybe');
  const counts = [
    `Пойдут: ${event.counts.going}`,
    event.counts.maybe ? `может быть: ${event.counts.maybe}` : '',
    event.counts.no ? `не пойдут: ${event.counts.no}` : '',
  ].filter(Boolean).join(' · ');

  const manage = !past && ctx.canManage && el('div', { class: 'event-manage' }, [
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Изменить', onclick: () => showEventForm(ctx, event) }),
    cancelButton(event, ctx),
  ]);

  return el('article', { class: `event-card${event.live ? ' is-live' : ''}${past ? ' is-past' : ''}` }, [
    el('div', { class: 'event-head' }, [
      el('span', { class: 'event-date' }, [
        el('span', { class: 'event-day', text: String(new Date(event.starts_at).getDate()) }),
        el('span', { class: 'event-month', text: new Date(event.starts_at).toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '') }),
      ]),
      el('div', { class: 'event-main' }, [
        el('p', { class: 'event-title' }, [
          event.title,
          event.live && el('span', { class: 'event-live', text: 'идёт сейчас' }),
        ]),
        el('p', { class: 'event-when' }, [
          eventWhen(event),
          event.repeat_weekly && el('span', { class: 'event-repeat', text: ' · каждую неделю' }),
        ]),
        where,
      ]),
    ]),
    event.description && el('p', { class: 'event-desc', text: event.description }),
    past
      ? attendanceLine(event)
      : el('p', { class: 'event-counts', title: [...going, ...maybe].map((p) => p.name).join(', ') }, [counts]),
    !past && going.length > 0 && el('p', { class: 'event-people', text: going.slice(0, 8).map((p) => p.name).join(', ') + (going.length > 8 ? ` и ещё ${going.length - 8}` : '') }),
    answers,
    !past && event.channel && (event.live || startsWithin(event, 15)) &&
      el('button', { class: 'btn btn-primary btn-sm event-join', type: 'button', text: 'Зайти в звонок', onclick: () => ctx.onJoin(event) }),
    manage,
  ]);
}

function startsWithin(event, minutes) {
  const left = Date.parse(event.starts_at) - Date.now();
  return left > 0 && left <= minutes * 60_000;
}

function attendanceLine(event) {
  const said = `Собирались: ${event.counts.going}`;
  if (!event.attendance) return el('p', { class: 'event-counts', text: said });
  const { came, going_came: goingCame } = event.attendance;
  return el('p', { class: 'event-counts event-attendance' }, [
    el('b', { text: `Пришли в звонок: ${came} ${peopleWord(came)}` }),
    ` · ${said}, из них пришли ${goingCame}`,
  ]);
}

function cancelButton(event, ctx) {
  let armed = false;
  const button = el('button', {
    class: 'btn btn-ghost btn-sm event-cancel',
    type: 'button',
    text: 'Отменить',
    onclick: async () => {
      if (!armed) {
        armed = true;
        button.textContent = event.repeat_weekly ? 'Отменить и повторы?' : 'Точно отменить?';
        setTimeout(() => {
          armed = false;
          if (button.isConnected) button.textContent = 'Отменить';
        }, 4000);
        return;
      }
      button.disabled = true;
      try {
        await api(`/communities/${ctx.communityId}/events/${event.id}`, { method: 'DELETE' });
        ctx.reload();
      } catch (err) {
        button.disabled = false;
        button.textContent = err.message;
      }
    },
  });
  return button;
}

// ===== панель «События» =====

export function eventsPanel(ctx) {
  let scope = 'upcoming';
  const list = el('div', { class: 'panel-list' }, [el('p', { class: 'panel-empty', text: 'Загружаем…' })]);
  const tabs = el('div', { class: 'event-tabs' });
  const createButton = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '+ Событие', onclick: () => showEventForm(ctx) });
  createButton.hidden = !ctx.canManage;

  function drawTabs() {
    tabs.replaceChildren(...[['upcoming', 'Ближайшие'], ['past', 'Прошедшие']].map(([id, label]) => el('button', {
      class: `event-tab${scope === id ? ' is-active' : ''}`,
      type: 'button',
      text: label,
      onclick: () => {
        scope = id;
        drawTabs();
        load();
      },
    })));
  }

  async function load() {
    try {
      const data = await api(`/communities/${ctx.communityId}/events${scope === 'past' ? '?scope=past' : ''}`);
      createButton.hidden = !data.can_manage;
      list.replaceChildren(...(data.events.length
        ? data.events.map((e) => eventCard(e, ctx, { past: scope === 'past' }))
        : [el('p', { class: 'panel-empty', text: scope === 'past'
          ? 'Прошедших встреч пока нет'
          : data.can_manage ? 'Ближайших событий нет. Создайте первое — участники смогут ответить, придут ли.' : 'Ближайших событий нет' })]));
    } catch (err) {
      list.replaceChildren(el('p', { class: 'panel-empty', text: err.message }));
    }
  }

  drawTabs();
  load();
  return {
    node: el('div', { class: 'panel-body' }, [el('div', { class: 'event-toolbar' }, [tabs, createButton]), list]),
    reload: load,
  };
}

// ===== форма =====

function toDateInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function showEventForm(ctx, event = null) {
  // Новое событие — по умолчанию завтра в 19:00.
  const start = event ? new Date(event.starts_at) : (() => {
    const d = new Date(Date.now() + 86_400_000);
    d.setHours(19, 0, 0, 0);
    return d;
  })();
  const duration = event?.ends_at ? Math.round((Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60_000) : event ? 0 : 60;

  const title = el('input', { class: 'input', id: 'event-title', type: 'text', maxlength: '100', value: event?.title ?? '', placeholder: 'Например, созвон по проекту' });
  const description = el('textarea', { class: 'input', id: 'event-desc', rows: '3', maxlength: '1000', placeholder: 'О чём встреча — по желанию' });
  description.value = event?.description ?? '';
  const date = el('input', { class: 'input', id: 'event-date', type: 'date', value: toDateInput(start) });
  const time = el('input', { class: 'input', id: 'event-time', type: 'time', value: clock(start) });
  const length = el('select', { class: 'select', id: 'event-length' }, DURATIONS.map(([min, label]) => el('option', { value: String(min), text: label })));
  length.value = DURATIONS.some(([m]) => m === duration) ? String(duration) : '60';
  const place = el('select', { class: 'select', id: 'event-place' }, [
    ...ctx.voiceChannels.map((c) => el('option', { value: c.id, text: `Голосовой канал: ${c.name}` })),
    el('option', { value: '', text: 'Вне платформы' }),
  ]);
  place.value = event ? (event.channel?.id ?? '') : (ctx.voiceChannels[0]?.id ?? '');
  const locationText = el('input', { class: 'input', id: 'event-location', type: 'text', maxlength: '200', value: event?.location_text ?? '', placeholder: 'Адрес или ссылка — по желанию' });
  const locationField = el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'event-location', text: 'Где именно' }), locationText]);
  const syncPlace = () => (locationField.hidden = Boolean(place.value));
  place.addEventListener('change', syncPlace);
  syncPlace();
  const weekly = el('input', { type: 'checkbox' });
  weekly.checked = Boolean(event?.repeat_weekly);
  const error = el('p', { class: 'field-error' });

  async function save() {
    error.textContent = '';
    if (!title.value.trim()) return (error.textContent = 'Укажите название');
    const startsAt = new Date(`${date.value}T${time.value}`);
    if (Number.isNaN(startsAt.getTime())) return (error.textContent = 'Укажите дату и время');
    const minutes = Number(length.value);
    const body = {
      title: title.value.trim(),
      description: description.value.trim(),
      starts_at: startsAt.toISOString(),
      ends_at: minutes ? new Date(startsAt.getTime() + minutes * 60_000).toISOString() : null,
      channel_id: place.value || null,
      location_text: place.value ? '' : locationText.value.trim(),
      repeat_weekly: weekly.checked,
    };
    try {
      await api(`/communities/${ctx.communityId}/events${event ? `/${event.id}` : ''}`, { method: event ? 'PATCH' : 'POST', body });
      scrim.remove();
      ctx.reload();
    } catch (err) {
      error.textContent = err.message;
    }
  }

  const scrim = showModal(el('form', { class: 'modal event-form', onsubmit: (e) => (e.preventDefault(), save()) }, [
    el('h2', { class: 'modal-title', text: event ? 'Изменить событие' : 'Новое событие' }),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'event-title', text: 'Название' }), title]),
    el('div', { class: 'event-form-row' }, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'event-date', text: 'Дата' }), date]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'event-time', text: 'Время' }), time]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'event-length', text: 'Длительность' }), length]),
    ]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'event-place', text: 'Место' }), place]),
    locationField,
    el('div', { class: 'field' }, [el('label', { class: 'field-label', for: 'event-desc', text: 'Описание' }), description]),
    el('label', { class: 'check' }, [weekly, el('span', { text: 'Повторять каждую неделю — следующая встреча появится, когда начнётся эта' })]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-secondary', type: 'button', text: 'Отмена', onclick: () => scrim.remove() }),
      el('button', { class: 'btn btn-primary', type: 'submit', text: event ? 'Сохранить' : 'Создать' }),
    ]),
    error,
  ]));
  title.focus();
}

// ===== напоминание =====

const REMINDER_TITLES = {
  soon: 'Скоро начнётся',
  start: 'Начинается',
  cancelled: 'Событие отменено',
};

// Всплывающая карточка в углу экрана: через 30 секунд исчезает сама.
export function showReminderToast(payload, { onJoin, onOpen }) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const close = () => toast.remove();
  const toast = el('div', { class: `toast event-toast is-${payload.kind}` }, [
    el('span', { class: 'toast-icon' }, [icon('calendar', 18)]),
    el('div', { class: 'toast-texts' }, [
      el('p', { class: 'toast-kicker', text: `${REMINDER_TITLES[payload.kind] ?? 'Событие'} · ${payload.community_name}` }),
      el('p', { class: 'toast-title', text: payload.title }),
      payload.kind !== 'cancelled' && el('p', {
        class: 'toast-note',
        text: [eventWhen(payload), payload.channel_name && `голосовой канал ${payload.channel_name}`].filter(Boolean).join(' · '),
      }),
      el('div', { class: 'toast-actions' }, [
        payload.kind !== 'cancelled' && payload.channel_id &&
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Зайти', onclick: () => (close(), onJoin(payload)) }),
        payload.kind !== 'cancelled' &&
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Подробнее', onclick: () => (close(), onOpen(payload)) }),
      ]),
    ]),
    el('button', { class: 'panel-close', type: 'button', 'aria-label': 'Закрыть', onclick: close }, [icon('close', 14)]),
  ]);
  host.append(toast);
  setTimeout(close, 30_000);
  return toast;
}
