// Настройки. Профиль (имя, скрытие почты) хранится на сервере — его видят
// другие участники. Устройства и звуки остаются в браузере: они касаются
// только этого компьютера.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon, initial } from '../dom.js';
import { navigate } from '../router.js';
import { settings, listDevices, playChime } from '../settings.js';

const SECTIONS = [
  { id: 'account', group: 'Пользователь', title: 'Моя учётная запись', icon: 'profile' },
  { id: 'privacy', group: 'Пользователь', title: 'Приватность', icon: 'shield' },
  { id: 'devices', group: 'Пользователь', title: 'Устройства', icon: 'devices', soon: true },
  { id: 'media', group: 'Приложение', title: 'Голос и видео', icon: 'mic' },
  { id: 'sounds', group: 'Приложение', title: 'Уведомления', icon: 'bell' },
  { id: 'language', group: 'Приложение', title: 'Язык', icon: 'translate', soon: true },
];

export async function renderSettings() {
  let active = 'account';
  let profile = null;
  let devices = { microphones: [], cameras: [], speakers: [] };

  const pane = el('div', { class: 'settings-body' });
  const title = el('h1', { class: 'settings-title' });

  try {
    ({ user: profile } = await api('/users/me'));
  } catch (err) {
    return mount(
      el('div', { class: 'empty' }, [
        el('h1', { class: 'empty-title', text: 'Не удалось открыть настройки' }),
        el('p', { class: 'empty-sub', text: err.message }),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: 'Назад',
          onclick: () => navigate('#/'),
        }),
      ]),
    );
  }

  function logout() {
    store.clearSession();
    navigate('#/login');
  }

  // ===== разделы =====

  function accountSection() {
    const nameInput = el('input', {
      class: 'input',
      id: 'display-name',
      type: 'text',
      maxlength: '40',
      placeholder: 'Как вас называть',
      value: profile.display_name ?? '',
    });
    const saved = el('p', { class: 'saved-note' });
    const headAvatar = el('div', { class: 'user-avatar', text: initial(profile.public_name) });
    const headName = el('span', { class: 'row-title', text: profile.public_name });

    async function save() {
      saved.textContent = '';
      try {
        ({ user: profile } = await api('/users/me', {
          method: 'PATCH',
          body: { display_name: nameInput.value },
        }));
        // Имя показывается в плашке профиля и в звонке, поэтому обновляем
        // и сохранённую копию профиля в браузере.
        store.setSession(store.token, profile);
        headAvatar.textContent = initial(profile.public_name);
        headName.textContent = profile.public_name;
        saved.textContent = 'Сохранено';
      } catch (err) {
        saved.className = 'field-error';
        saved.textContent = err.message;
      }
    }

    return [
      el('div', { class: 'settings-row' }, [
        headAvatar,
        el('div', { class: 'user-texts' }, [headName, el('span', { class: 'row-note', text: profile.email })]),
      ]),
      el('section', { class: 'settings-section' }, [
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', for: 'display-name', text: 'Отображаемое имя' }),
          nameInput,
          el('p', {
            class: 'field-hint',
            text: 'Его увидят в чате и в звонке. Если оставить пустым, будет видна почта.',
          }),
        ]),
        el('div', { class: 'btn-row', style: 'justify-content:flex-start' }, [
          el('button', { class: 'btn btn-primary', type: 'button', text: 'Сохранить', onclick: save }),
        ]),
        saved,
      ]),
      el('section', { class: 'settings-section' }, [
        el('p', { class: 'settings-kicker', text: 'Вход' }),
        soonRow('idcard', 'Вход через Госуслуги', 'Пока недоступно'),
        soonRow('lock', 'Двухфакторная защита', 'Пока недоступно'),
      ]),
    ];
  }

  function privacySection() {
    const saved = el('p', { class: 'saved-note' });
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = profile.hide_email;
    checkbox.addEventListener('change', async () => {
      saved.textContent = '';
      try {
        ({ user: profile } = await api('/users/me', {
          method: 'PATCH',
          body: { hide_email: checkbox.checked },
        }));
        store.setSession(store.token, profile);
        saved.textContent = 'Сохранено';
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        saved.className = 'field-error';
        saved.textContent = err.message;
      }
    });

    return [
      el('section', { class: 'settings-section' }, [
        el('label', { class: 'check' }, [
          checkbox,
          el('span', {}, [
            el('span', { class: 'row-title', text: 'Не показывать мою почту другим' }),
            el('span', {
              class: 'row-note',
              text: 'Вместо почты участники увидят имя, а если оно не задано — просто «Участник».',
            }),
          ]),
        ]),
        saved,
      ]),
    ];
  }

  function mediaSection() {
    const current = settings.all;

    const pick = (label, id, list, value, key) => {
      const select = el(
        'select',
        {
          class: 'select',
          id,
          onchange: (e) => settings.set({ [key]: e.target.value }),
        },
        [
          el('option', { value: '', text: 'По умолчанию' }),
          ...list.map((device) =>
            el('option', { value: device.id, text: device.label }),
          ),
        ],
      );
      select.value = list.some((device) => device.id === value) ? value : '';
      return el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: id, text: label }),
        select,
      ]);
    };

    const joinMuted = el('input', { type: 'checkbox' });
    joinMuted.checked = current.joinMuted;
    joinMuted.addEventListener('change', () => settings.set({ joinMuted: joinMuted.checked }));

    return [
      el('section', { class: 'settings-section' }, [
        pick('Микрофон', 'mic-device', devices.microphones, current.micDeviceId, 'micDeviceId'),
        pick('Камера', 'cam-device', devices.cameras, current.cameraDeviceId, 'cameraDeviceId'),
        devices.speakers.length > 0 &&
          pick('Динамики', 'spk-device', devices.speakers, current.speakerDeviceId, 'speakerDeviceId'),
        el('p', {
          class: 'field-hint',
          text: 'Устройства применяются при следующем входе в звонок.',
        }),
      ]),
      el('section', { class: 'settings-section' }, [
        el('label', { class: 'check' }, [
          joinMuted,
          el('span', {}, [
            el('span', { class: 'row-title', text: 'Входить в звонок с выключенным микрофоном' }),
            el('span', { class: 'row-note', text: 'Удобно, если вокруг шумно.' }),
          ]),
        ]),
      ]),
    ];
  }

  function soundsSection() {
    const current = settings.all;

    const toggle = (key, label, note) => {
      const input = el('input', { type: 'checkbox' });
      input.checked = current[key];
      input.addEventListener('change', () => {
        settings.set({ [key]: input.checked });
        if (input.checked) playChime(key === 'soundOnMessage' ? 'message' : 'join');
      });
      return el('label', { class: 'check' }, [
        input,
        el('span', {}, [
          el('span', { class: 'row-title', text: label }),
          el('span', { class: 'row-note', text: note }),
        ]),
      ]);
    };

    return [
      el('section', { class: 'settings-section' }, [
        toggle('soundOnMessage', 'Звук нового сообщения', 'Только когда вкладка не активна.'),
        toggle('soundOnJoin', 'Звук входа в звонок', 'Когда кто-то присоединяется к вашему звонку.'),
        el('div', { class: 'btn-row', style: 'justify-content:flex-start' }, [
          el('button', {
            class: 'btn btn-secondary',
            type: 'button',
            text: 'Проверить звук',
            onclick: () => playChime('message'),
          }),
        ]),
      ]),
    ];
  }

  function soonRow(iconName, label, note) {
    return el('div', { class: 'settings-row' }, [
      icon(iconName, 20),
      el('div', { class: 'user-texts' }, [
        el('span', { class: 'row-title', text: label }),
        el('span', { class: 'row-note', text: note }),
      ]),
      el('span', { class: 'set-soon', text: 'скоро' }),
    ]);
  }

  function soonSection(text) {
    return [el('p', { class: 'empty-sub', text })];
  }

  function draw() {
    const section = SECTIONS.find((item) => item.id === active);
    title.textContent = section.title;

    const content = {
      account: accountSection,
      privacy: privacySection,
      media: mediaSection,
      sounds: soundsSection,
      devices: () => soonSection('Список входов и выход со всех устройств появятся позже.'),
      language: () => soonSection('Пока интерфейс только на русском.'),
    }[active]();

    pane.replaceChildren(...content.filter(Boolean));
  }

  const navItems = [];
  let lastGroup = null;
  for (const section of SECTIONS) {
    if (section.group !== lastGroup) {
      navItems.push(el('p', { class: 'settings-kicker', text: section.group }));
      lastGroup = section.group;
    }
    navItems.push(
      el(
        'button',
        {
          class: `set-nav${section.id === active ? ' is-active' : ''}`,
          type: 'button',
          onclick: (e) => {
            active = section.id;
            e.currentTarget
              .closest('.settings-nav')
              .querySelectorAll('.set-nav')
              .forEach((node) => node.classList.remove('is-active'));
            e.currentTarget.classList.add('is-active');
            draw();
          },
        },
        [
          icon(section.icon, 16),
          el('span', { text: section.title }),
          section.soon && el('span', { class: 'set-soon', text: 'скоро' }),
        ],
      ),
    );
  }

  navItems.push(
    el('div', { style: 'margin-top:auto' }),
    el(
      'button',
      { class: 'set-nav menu-danger', type: 'button', onclick: logout },
      [icon('signOut', 16), el('span', { text: 'Выйти из аккаунта' })],
    ),
  );

  mount(
    el('div', { class: 'settings' }, [
      el('nav', { class: 'settings-nav' }, navItems),
      el('div', { class: 'settings-pane' }, [
        el('header', { class: 'settings-head' }, [
          title,
          el(
            'button',
            {
              class: 'btn btn-ghost',
              type: 'button',
              onclick: () => history.back(),
            },
            [icon('close', 16), 'Закрыть'],
          ),
        ]),
        pane,
      ]),
    ]),
  );

  draw();

  // Список устройств подтягиваем отдельно: он требует разрешения браузера,
  // и ждать его до показа экрана незачем.
  listDevices()
    .then((found) => {
      devices = found;
      if (active === 'media') draw();
    })
    .catch(() => {});
}
