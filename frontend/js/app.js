// Точка входа клиента: запускает роутер и ловит необработанные сбои, чтобы
// вместо пустого экрана человек видел понятное сообщение.
import { render } from './router.js';
import { el, mount } from './dom.js';

window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason);
  mount(
    el('div', { class: 'centered' }, [
      el('div', { class: 'card' }, [
        el('h1', { text: 'Что-то сломалось' }),
        el('p', { class: 'subtitle', text: event.reason?.message ?? 'Неизвестная ошибка' }),
        el('div', { class: 'actions' }, [
          el('button', { text: 'На главную', onclick: () => location.replace('#/') }),
        ]),
      ]),
    ]),
  );
});

render();
