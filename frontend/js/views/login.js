// Вход по коду на почту в два шага. Если человек пришёл по приглашению,
// после входа он автоматически вступает в сообщество — чтобы не заставлять
// его возвращаться по ссылке ещё раз.
import { api } from '../api.js';
import { store } from '../store.js';
import { el, mount, icon } from '../dom.js';
import { navigate } from '../router.js';

export function renderLogin() {
  let step = 'email';
  let email = '';
  let devCode = null;
  let error = null;
  let busy = false;

  async function sendCode() {
    if (busy || !email) return;
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
    if (busy) return;
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

  function drawEmailStep() {
    // Кнопку переключаем напрямую: перерисовка на каждый символ увела бы фокус
    // из поля ввода.
    const submit = el('button', {
      class: 'btn btn-primary btn-block',
      type: 'submit',
      text: busy ? 'Отправляем…' : 'Получить код',
    });
    submit.disabled = busy || !email;

    const input = el('input', {
      class: 'input',
      id: 'login-email',
      type: 'email',
      placeholder: 'you@example.com',
      value: email,
      autofocus: 'true',
      oninput: (e) => {
        email = e.target.value;
        submit.disabled = busy || !email;
      },
    });

    return el('form', { class: 'auth-card', onsubmit: (e) => (e.preventDefault(), sendCode()) }, [
      el('div', { class: 'auth-mark' }, [icon('mark', 14), el('span', { text: 'Сообщества' })]),
      el('h1', { class: 'auth-title', text: 'Вход' }),
      el('p', { class: 'auth-sub', text: 'Пришлём код на почту — пароль не нужен' }),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: 'login-email', text: 'Почта' }),
        input,
      ]),
      el('p', { class: 'field-error', text: error ?? ' ' }),
      submit,
    ]);
  }

  function drawCodeStep() {
    const input = el('input', {
      class: 'input input-code',
      id: 'login-code',
      type: 'text',
      inputmode: 'numeric',
      maxlength: '6',
      placeholder: '······',
      autofocus: 'true',
    });

    return el(
      'form',
      { class: 'auth-card', onsubmit: (e) => (e.preventDefault(), verifyCode(input.value)) },
      [
        el('h1', { class: 'auth-title', text: 'Код из письма' }),
        el('p', { class: 'auth-sub', text: `Отправили на ${email}` }),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', for: 'login-code', text: 'Код' }),
          input,
        ]),
        el('p', { class: 'field-error', text: error ?? ' ' }),
        el('button', {
          class: 'btn btn-primary btn-block',
          type: 'submit',
          text: busy ? 'Проверяем…' : 'Войти',
        }),
        el('button', {
          class: 'btn btn-secondary btn-block',
          type: 'button',
          text: 'Изменить почту',
          onclick: () => {
            step = 'email';
            devCode = null;
            error = null;
            draw();
          },
        }),
        devCode &&
          el('p', { class: 'field-hint' }, [
            'Почта на этапе MVP — заглушка, код: ',
            el('code', { text: devCode }),
          ]),
      ],
    );
  }

  function draw() {
    mount(el('div', { class: 'auth' }, [step === 'email' ? drawEmailStep() : drawCodeStep()]));
  }

  draw();
}
