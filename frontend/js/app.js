// Точка входа клиента: запускает роутер и ловит необработанные сбои, чтобы
// вместо пустого экрана человек видел понятное сообщение.
import { render } from './router.js';
import { el, mount } from './dom.js';

window.addEventListener('unhandledrejection', (event) => {
  // Истёкшая сессия и блокировка — не сбой: api.js уже увёл человека на
  // вход или на экран блокировки, показывать поверх «что-то сломалось»
  // незачем.
  if (event.reason?.status === 401 || event.reason?.code === 'account_blocked') {
    event.preventDefault();
    return;
  }
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

// Вход хранится один на адрес сайта: если в соседней вкладке вошли под
// другим аккаунтом или вышли, эта вкладка иначе продолжала бы показывать
// прежнего человека, а запросы слала бы уже от нового. Перерисовываемся
// сразу, чтобы было видно, чей вход сейчас действует.
window.addEventListener('storage', (event) => {
  if (event.key !== 'token' && event.key !== null) return;
  location.hash = '#/';
  location.reload();
});

render();
