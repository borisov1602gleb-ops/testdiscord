// Аналитика сообщества — видит только владелец. Цифры приходят из витрин
// слоя Gold: страница ничего не считает сама, она только показывает.
// Одиночные показатели показываем плитками, а не графиками: столбик из
// одного значения ничего не добавляет к самому числу.
import { api } from '../api.js';
import { el, mount } from '../dom.js';
import { navigate } from '../router.js';

export async function renderAnalytics(communityId) {
  mount(el('div', { class: 'empty' }, [el('p', { class: 'empty-quiet', text: 'Считаем…' })]));

  let data;
  let community;
  try {
    [data, { community }] = await Promise.all([
      api(`/communities/${communityId}/analytics`),
      api(`/communities/${communityId}`),
    ]);
  } catch (err) {
    return mount(
      el('div', { class: 'empty' }, [
        el('h1', { class: 'empty-title', text: 'Аналитика недоступна' }),
        el('p', {
          class: 'empty-sub',
          text: err.code === 'owner_only' ? 'Её видит только владелец сообщества' : err.message,
        }),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: 'К каналам',
          onclick: () => navigate(`#/c/${communityId}`),
        }),
      ]),
    );
  }

  const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

  const tile = (label, value, note) =>
    el('div', { class: 'tile' }, [
      el('span', { class: 'tile-label', text: label }),
      el('span', { class: 'tile-value', text: value }),
      note && el('span', { class: 'tile-note', text: note }),
    ]);

  const formatSeconds = (seconds) => {
    if (!seconds) return '—';
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes} мин ${seconds % 60} сек` : `${seconds} сек`;
  };

  const formatMoment = (iso) => {
    if (!iso) return 'ещё не считалась';
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return sameDay ? `сегодня в ${time}` : `${date.toLocaleDateString('ru-RU')}, ${time}`;
  };

  // ===== воронка =====
  // Шаги вложенные: каждый следующий считается только среди прошедших
  // предыдущий. Столбики одного цвета — величину несёт длина полосы,
  // а не краска.
  const funnelSteps = [
    { label: 'Открыли приглашение', value: data.funnel.opened },
    { label: 'Зашли в звонок', value: data.funnel.joined_call },
    { label: 'Вступили в сообщество', value: data.funnel.joined_community },
  ];
  const funnelMax = Math.max(...funnelSteps.map((step) => step.value), 1);

  const funnelChart = el(
    'div',
    { class: 'funnel' },
    funnelSteps.flatMap((step, index) => {
      const previous = index > 0 ? funnelSteps[index - 1].value : null;
      const conversion = previous != null ? percent(step.value, previous) : null;
      return [
        el('div', { class: 'funnel-row' }, [
          el('span', { class: 'funnel-label', text: step.label }),
          el('div', { class: 'funnel-track' }, [
            el('div', {
              class: 'funnel-bar',
              style: `width:${Math.max((step.value / funnelMax) * 100, step.value > 0 ? 4 : 0)}%`,
            }),
          ]),
          el('span', { class: 'funnel-value', text: String(step.value) }),
        ]),
        conversion != null &&
          el('span', {
            class: 'funnel-step',
            text: `${conversion}% от предыдущего шага`,
          }),
      ];
    }),
  );

  // ===== активность по дням =====
  // Два показателя — два отдельных графика, чтобы не совмещать разные
  // величины на одной оси.
  function dayChart(title, key) {
    const max = Math.max(...data.daily.map((row) => row[key]), 1);
    const hasData = data.daily.some((row) => row[key] > 0);

    return el('div', { class: 'chart' }, [
      el('p', { class: 'chart-title', text: title }),
      hasData
        ? el(
            'div',
            { class: 'columns' },
            data.daily.map((row) => {
              const day = new Date(row.day);
              const label = day.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
              return el(
                'div',
                { class: 'column', title: `${label}: ${row[key]}` },
                [
                  el('div', { class: 'column-track' }, [
                    el('div', {
                      class: 'column-bar',
                      style: `height:${row[key] > 0 ? Math.max((row[key] / max) * 100, 6) : 0}%`,
                    }),
                  ]),
                  el('span', { class: 'column-label', text: label.slice(0, 2) }),
                ],
              );
            }),
          )
        : el('p', { class: 'chart-empty', text: 'За две недели данных нет' }),
      hasData && el('p', { class: 'chart-axis', text: `Максимум за день: ${max}` }),
    ]);
  }

  const activationPercent = percent(data.activation.activated, data.activation.joined);
  const retentionPercent = percent(data.retention.returned, data.retention.eligible);
  const retention30Percent = percent(data.retention.returned_30, data.retention.eligible_30);
  const errorPercent = percent(data.errors.failed, data.errors.total);
  const departures = data.departures ?? { total: 0, early: 0, removed: 0, joined: 0, early_days: 7 };
  const earlyLeavePercent = percent(departures.early, departures.joined);

  // Пересчёт по кнопке: ждать расписания, чтобы увидеть в статистике
  // только что отправленное сообщение, неудобно.
  const refreshButton = el('button', {
    class: 'btn btn-secondary btn-sm',
    type: 'button',
    text: 'Пересчитать',
    onclick: async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Считаем…';
      try {
        await api(`/communities/${communityId}/analytics/refresh`, { method: 'POST', body: {} });
      } finally {
        renderAnalytics(communityId);
      }
    },
  });

  const freshness = data.freshness ?? {};
  const freshnessNote = [
    `Данные на ${formatMoment(freshness.last_run_at)}`,
    freshness.pending_rows ? `в очереди событий: ${freshness.pending_rows}` : null,
    freshness.rejected_rows ? `отклонено при очистке: ${freshness.rejected_rows}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  mount(
    el('div', { class: 'settings' }, [
      el('nav', { class: 'settings-nav' }, [
        el('p', { class: 'settings-kicker', text: 'Сообщество' }),
        el('button', {
          class: 'set-nav',
          type: 'button',
          text: '← К каналам',
          onclick: () => navigate(`#/c/${communityId}`),
        }),
        el('button', { class: 'set-nav is-active', type: 'button', text: 'Аналитика' }),
      ]),

      el('div', { class: 'settings-pane' }, [
        el('header', { class: 'settings-head' }, [
          el('h1', { class: 'settings-title', text: `Аналитика — ${community.name}` }),
          refreshButton,
        ]),

        el('div', { class: 'settings-body analytics' }, [
          el('p', { class: 'chart-axis', text: freshnessNote }),

          el('div', { class: 'tiles' }, [
            tile(
              'Вовлечены на этой неделе',
              String(data.wecu.engaged),
              `из ${data.wecu.active} активных · порог: ${data.wecu.thresholds.messages} сообщений или ${data.wecu.thresholds.seconds / 60} мин в звонке` +
                (data.wecu.messages_per_active != null
                  ? ` · ${data.wecu.messages_per_active} сообщений на активного`
                  : ''),
            ),
            tile(
              'Активация',
              activationPercent != null ? `${activationPercent}%` : '—',
              activationPercent != null
                ? `${data.activation.activated} из ${data.activation.joined} вступивших — в первые сутки`
                : 'Пока никто не вступал',
            ),
            tile(
              'Возвращаются на 7-й день',
              retentionPercent != null ? `${retentionPercent}%` : '—',
              retentionPercent != null
                ? `${data.retention.returned} из ${data.retention.eligible}`
                : 'Нужны вступления старше недели',
            ),
            tile(
              'Возвращаются на 30-й день',
              retention30Percent != null ? `${retention30Percent}%` : '—',
              retention30Percent != null
                ? `${data.retention.returned_30} из ${data.retention.eligible_30}`
                : 'Нужны вступления старше месяца',
            ),
            tile(
              `Ушли в первые ${departures.early_days} дней`,
              earlyLeavePercent != null ? `${earlyLeavePercent}%` : '—',
              departures.joined > 0
                ? `${departures.early} из ${departures.joined} вступивших · всего ушло ${departures.total}${departures.removed ? `, из них исключено ${departures.removed}` : ''}`
                : 'Пока никто не вступал',
            ),
            tile(
              'Ошибки подключения',
              errorPercent != null ? `${errorPercent}%` : '—',
              errorPercent != null
                ? `${data.errors.failed} неудачных из ${data.errors.total} попыток`
                : 'Попыток ещё не было',
            ),
          ]),

          el('section', { class: 'settings-section' }, [
            el('p', { class: 'settings-kicker', text: 'Воронка приглашения' }),
            funnelChart,
            el('p', {
              class: 'chart-axis',
              text:
                `Считается по людям: гость и он же после регистрации — один человек. ` +
                `Из открывших ссылку зарегистрировались: ${data.funnel.registered}. ` +
                `Всего вступивших, включая пришедших мимо ссылки: ${data.funnel.joined_total}.`,
            }),
          ]),

          el('section', { class: 'settings-section' }, [
            el('p', { class: 'settings-kicker', text: 'Активность за две недели' }),
            dayChart('Сообщения по дням', 'messages'),
            dayChart('Участия в звонках по дням', 'calls'),
          ]),

          el('section', { class: 'settings-section' }, [
            el('p', { class: 'settings-kicker', text: 'Кто активен: текст и звонки' }),
            dayChart('Людей писало по дням', 'text_people'),
            dayChart('Людей звонило по дням', 'voice_people'),
            el('p', {
              class: 'chart-axis',
              text: 'Два драйвера North Star из задания считаются раздельно: один и тот же человек может писать, но не звонить, и наоборот.',
            }),
          ]),

          el('section', { class: 'settings-section' }, [
            el('p', { class: 'settings-kicker', text: 'Звонки и сообщество' }),
            el('div', { class: 'tiles' }, [
              tile('Участников', String(data.totals.members)),
              tile('Сообщений всего', String(data.totals.messages)),
              tile(
                'Средний звонок',
                formatSeconds(data.durations.average),
                `медиана ${formatSeconds(data.durations.median)}`,
              ),
              tile(
                'Длинные звонки',
                formatSeconds(data.durations.p90),
                `90-й перцентиль · 75-й: ${formatSeconds(data.durations.p75)}`,
              ),
              tile(
                'Самый долгий',
                formatSeconds(data.durations.longest),
                `участий: ${data.durations.participations}`,
              ),
            ]),
          ]),

          el('section', { class: 'settings-section' }, [
            el('p', { class: 'settings-kicker', text: 'Как это считается' }),
            el('p', {
              class: 'chart-axis',
              text:
                'Сырой лог (Bronze) очищается в слой Silver: разбираются типы, ' +
                'отбрасываются дубли, гость склеивается с пользователем. Из него ' +
                'собираются витрины (Gold), которые и показаны выше. События, не ' +
                'прошедшие проверку, не теряются — они лежат отдельно с причиной.',
            }),
            el('p', {
              class: 'chart-axis',
              text:
                'Что стоит помнить: минуты гостей в звонках не учитываются — ' +
                'событие участия пишется только для зарегистрированных; владелец не ' +
                'входит в активацию и возврат, потому что он не вступал; границы ' +
                'суток — по времени сервера.',
            }),
          ]),
        ]),
      ]),
    ]),
  );
}
