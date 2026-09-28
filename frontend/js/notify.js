// Уведомления браузера: всплывающее окно системы, когда вкладка свёрнута
// или открыт другой канал. Что уведомлять, решает экран сообщества по
// настройкам уровня (все / упоминания / ничего); здесь — только показ.
import { settings } from './settings.js';

export const notificationsSupported = () => typeof Notification !== 'undefined';

export function notificationState() {
  if (!notificationsSupported()) return 'unsupported';
  if (!settings.get('browserNotifications')) return 'off';
  return Notification.permission; // granted | denied | default
}

// Разрешение браузер спрашивает только в ответ на действие человека —
// поэтому вызывается из переключателя в настройках.
export async function enableNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission;
  settings.set({ browserNotifications: permission === 'granted' });
  return permission;
}

export function disableNotifications() {
  settings.set({ browserNotifications: false });
}

// Разметку в уведомлении не показываем — только текст.
export function plainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '[код]')
    .replace(/\*\*|~~|`/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, '$1$2')
    .slice(0, 160);
}

export function showNotification({ title, body, icon, tag, onClick }) {
  if (notificationState() !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: icon || '/assets/logo.png', tag, silent: true });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* в некоторых браузерах уведомления работают только через service worker */
  }
}
