// Вход по коду на почту в два шага. Если человек пришёл по приглашению,
// после входа он автоматически вступает в сообщество — чтобы не заставлять
// его возвращаться по ссылке ещё раз.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount } from '../dom.js';
import { navigate } from '../router.js';

export function renderLogin() {
  let step = 'email';
  let email = '';
  let devCode = null;
  let error = null;
  let busy = false;

  async function sendCode() {
    busy = true;
    error = null;
    draw();
    try {
      const res = await api('/auth/send-code', { method: 'POST', body: { email }, auth: false });
      devCode = res.dev_code ?? null;
      step = 'code';
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
      draw();
    }
  }

  async function verifyCode(code) {
    busy = true;
    error = null;
    draw();
    try {
      // anonymous_id передаётся всегда: если гость успел побыть в звонке,
      // backend привяжет его участие к новому user_id.
      const res = await api('/auth/verify-code', {
        method: 'POST',
        auth: false,
        body: { email, code, anonymous_id: store.anonymousId },
      });
      store.setSession(res.token, res.user);

      const inviteId = store.pendingInvite;
      if (inviteId) {
        store.pendingInvite = null;
        try {
          await api(`/invites/${inviteId}/join`, { method: 'POST' });
        } catch (joinErr) {
          console.warn('не удалось вступить в сообщество по приглашению:', joinErr.message);
        }
      }
      navigate('#/');
    } catch (err) {
      error = err.message;
      busy = false;
      draw();
    }
  }

  function draw() {
    // Кнопку переключаем напрямую: перерисовка на каждый символ увела бы фокус
    // из поля ввода.
    const submit = el('button', {
      text: busy ? 'Отправляем…' : 'Получить код',
      onclick: sendCode,
    });
    submit.disabled = busy || !email;

    const emailInput = el('input', {
      type: 'email',
      placeholder: 'you@example.com',
      value: email,
      autofocus: 'true',
      oninput: (e) => {
        email = e.target.value;
        submit.disabled = busy || !email;
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && email) sendCode();
      },
    });

    const codeInput = el('input', {
      type: 'text',
      inputmode: 'numeric',
      placeholder: '000000',
      maxlength: '6',
      autofocus: 'true',
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.target.value.length === 6) verifyCode(e.target.value);
      },
    });

    const card =
      step === 'email'
        ? el('div', { class: 'card' }, [
            el('h1', { text: 'Вход' }),
            el('p', { class: 'subtitle', text: 'Пришлём код на почту — пароль не нужен' }),
            el('div', { class: 'field' }, [el('label', { text: 'Почта' }), emailInput]),
            el('div', { class: 'actions' }, [submit]),
            error && el('p', { class: 'error', text: error }),
          ])
        : el('div', { class: 'card' }, [
            el('h1', { text: 'Код из письма' }),
            el('p', { class: 'subtitle', text: `Отправили на ${email}` }),
            el('div', { class: 'field' }, [el('label', { text: 'Код' }), codeInput]),
            el('div', { class: 'actions' }, [
              el('button', {
                text: busy ? 'Проверяем…' : 'Войти',
                disabled: busy ? 'true' : null,
                onclick: () => verifyCode(codeInput.value),
              }),
              el('button', {
                class: 'secondary',
                text: 'Изменить почту',
                onclick: () => {
                  step = 'email';
                  devCode = null;
                  error = null;
                  draw();
                },
              }),
            ]),
            devCode &&
              el('p', { class: 'hint' }, [
                'Почта на этапе MVP — заглушка, код: ',
                el('code', { text: devCode }),
              ]),
            error && el('p', { class: 'error', text: error }),
          ]);

    mount(el('div', { class: 'centered' }, [card]));
  }

  draw();
}
