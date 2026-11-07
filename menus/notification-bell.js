/* ALIF Med — notification bell next to the profile avatar (Home and Exams headers).
   Tap: turn message notifications on for this device, see their state, or turn them off.
   No work is done at import time (import cycles with auth.js) — everything starts from a timer. */
import { getAuthUser } from './auth.js';
import { enableNotifications, notificationStatus } from './notification-manager.js';
import { showToast } from './ui-feedback.js';

const HOSTS = [['homeProfileBtn', 'homeBellBtn'], ['profileBtn', 'bellBtn']];
let pop = null;

const status = () => { try { return notificationStatus(); } catch (_) { return 'unsupported'; } };
const signedIn = () => { try { const u = getAuthUser(); return !!(u && !u.isAnonymous); } catch (_) { return false; } };

function paint(btn) {
  const s = status();
  const on = s === 'on';
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.style.display = signedIn() ? 'flex' : 'none';
  btn.innerHTML = `<i class="fa-${on ? 'solid' : 'regular'} fa-bell${s === 'denied' ? '-slash' : ''}"></i><span class="bell-dot"></span>`;
  btn.setAttribute('aria-label', on ? 'Notifications are on' : 'Turn on notifications');
}

function closePop() { if (pop) { pop.remove(); pop = null; document.removeEventListener('click', outside, true); } }
function outside(e) { if (pop && !pop.contains(e.target) && !e.target.closest('.bell-btn')) closePop(); }

function openPop(btn, html, actions) {
  closePop();
  pop = document.createElement('div');
  pop.className = 'bell-pop';
  pop.innerHTML = `<div class="bell-pop-t">${html}</div>${actions.map((a, i) => `<button type="button" class="bell-pop-b ${a.cls || ''}" data-i="${i}">${a.label}</button>`).join('')}`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
  pop.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) actions[+b.dataset.i].run(); });
  setTimeout(() => document.addEventListener('click', outside, true), 0);
}

async function turnOn(btn) {
  btn.classList.add('busy');
  try { await enableNotifications(); showToast('Notifications are on'); }
  catch (e) { showToast(e.message || 'Could not turn on notifications', { icon: 'fa-solid fa-circle-exclamation', duration: 6000 }); }
  finally { btn.classList.remove('busy'); refresh(); }
}

async function turnOff(btn) {
  closePop();
  try { if (window.__alifPushBeforeSignOut) await window.__alifPushBeforeSignOut(); showToast('Notifications are off on this device'); }
  catch (_) { /* ignore */ }
  refresh();
}

function onTap(btn) {
  const s = status();
  if (s === 'on') {
    openPop(btn, '<b>Notifications are on</b><br>You will get new chat messages on this device.', [{ label: 'Turn off', cls: 'danger', run: () => turnOff(btn) }]);
  } else if (s === 'denied') {
    openPop(btn, '<b>Notifications are blocked</b><br>Allow them for this site in your browser or phone settings, then tap the bell again.', [{ label: 'Got it', run: closePop }]);
  } else if (s === 'unsupported') {
    openPop(btn, '<b>Not available here</b><br>On iPhone, add ALIF to your Home Screen first, then open it from there.', [{ label: 'Got it', run: closePop }]);
  } else turnOn(btn);
}

function ensure() {
  HOSTS.forEach(([hostId, bellId]) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    let btn = document.getElementById(bellId);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.id = bellId; btn.className = 'bell-btn';
      btn.addEventListener('click', () => onTap(btn));
      host.parentNode.insertBefore(btn, host);
    }
    paint(btn);
  });
}
function refresh() { try { ensure(); } catch (_) {} }

let n = 0;
(function tick() { refresh(); if (++n < 40) setTimeout(tick, n < 6 ? 1200 : 5000); })();
setTimeout(refresh, 800);
window.addEventListener('focus', refresh);
window.__alifBell = { refresh };
