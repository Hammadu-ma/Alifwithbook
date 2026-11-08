/* ALIF Med — notification bell next to the profile avatar (Home and Exams headers).
   Tap: turn message notifications on for this device, see their state, or turn them off.
   No work is done at import time (import cycles with auth.js) — everything starts from a timer. */
import { getAuthUser } from './auth.js';
import { notificationStatus } from './notification-manager.js';
import { openNotificationsPage, unreadCount, loadNotifications } from './notifications-page.js';

const HOSTS = [['homeProfileBtn', 'homeBellBtn'], ['profileBtn', 'bellBtn']];
let pop = null;

const status = () => { try { return notificationStatus(); } catch (_) { return 'unsupported'; } };
const signedIn = () => { try { const u = getAuthUser(); return !!(u && !u.isAnonymous); } catch (_) { return false; } };

function paint(btn) {
  const s = status();
  const on = s === 'on';
  const n = unreadCount();
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.style.display = signedIn() ? 'flex' : 'none';
  btn.innerHTML = `<i class="fa-${on || n ? 'solid' : 'regular'} fa-bell${s === 'denied' && !n ? '-slash' : ''}"></i>${n ? `<span class="bell-count">${n > 9 ? '9+' : n}</span>` : '<span class="bell-dot"></span>'}`;
  btn.setAttribute('aria-label', n ? `${n} unread notifications` : 'Notifications');
}

function ensure() {
  HOSTS.forEach(([hostId, bellId]) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    let btn = document.getElementById(bellId);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.id = bellId; btn.className = 'bell-btn';
      btn.addEventListener('click', openNotificationsPage);
      host.parentNode.insertBefore(btn, host);
    }
    paint(btn);
  });
}
function refresh() { try { ensure(); } catch (_) {} }
let lastLoad = 0;
function pull() {   // cached for 5 minutes inside loadNotifications, so this stays cheap
  if (!signedIn() || Date.now() - lastLoad < 60000) return;
  lastLoad = Date.now();
  loadNotifications(false).then(refresh).catch(() => {});
}

let n = 0;
(function tick() { refresh(); pull(); if (++n < 40) setTimeout(tick, n < 6 ? 1200 : 5000); })();
setTimeout(refresh, 800);
window.addEventListener('focus', () => { refresh(); pull(); });
window.__alifBell = { refresh };
