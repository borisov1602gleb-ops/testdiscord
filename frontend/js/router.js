import { store } from './store.js';
import { renderLogin } from './views/login.js';
import { renderHome, disconnectRealtime } from './views/home.js';
import { renderInvite } from './views/invite.js';
import { renderCall } from './views/call.js';

const routes = [
  { pattern: /^#\/login$/, open: true, view: () => renderLogin() },
  { pattern: /^#\/invite\/([\w-]+)$/, open: true, view: (id) => renderInvite(id) },
  { pattern: /^#\/call\/([\w-]+)$/, open: true, view: (id) => renderCall(id) },
  { pattern: /^#\/c\/([\w-]+)$/, view: (id) => renderHome(id) },
  { pattern: /^#\/?$/, view: () => renderHome(null) },
];

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

export function render() {
  const hash = location.hash || '#/';
  disconnectRealtime();

  for (const route of routes) {
    const match = hash.match(route.pattern);
    if (!match) continue;
    if (!route.open && !store.isAuthenticated) return navigate('#/login');
    return route.view(...match.slice(1));
  }
  return navigate('#/');
}

window.addEventListener('hashchange', render);
