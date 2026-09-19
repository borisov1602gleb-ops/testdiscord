// Состояние, которое переживает перезагрузку страницы: токен, пользователь,
// гостевой идентификатор, приглашение, по которому пришли, и текущий звонок.
// Всё хранится в localStorage браузера.
const KEYS = {
  token: 'token',
  user: 'user',
  anonymousId: 'anonymous_id',
  pendingInvite: 'pending_invite',
  activeCall: 'active_call',
};

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  if (value == null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}

export const store = {
  get token() {
    return read(KEYS.token);
  },
  get user() {
    return read(KEYS.user);
  },
  get isAuthenticated() {
    return Boolean(read(KEYS.token));
  },
  setSession(token, user) {
    write(KEYS.token, token);
    write(KEYS.user, user);
  },
  clearSession() {
    write(KEYS.token, null);
    write(KEYS.user, null);
    write(KEYS.activeCall, null);
  },
  // Гостевой идентификатор живёт до регистрации: по нему участие в звонке
  // привязывается к user_id (edge case 12.4 спецификации).
  get anonymousId() {
    let id = read(KEYS.anonymousId);
    if (!id) {
      id = crypto.randomUUID();
      write(KEYS.anonymousId, id);
    }
    return id;
  },
  get pendingInvite() {
    return read(KEYS.pendingInvite);
  },
  set pendingInvite(value) {
    write(KEYS.pendingInvite, value);
  },
  get activeCall() {
    return read(KEYS.activeCall);
  },
  set activeCall(value) {
    write(KEYS.activeCall, value);
  },
};
