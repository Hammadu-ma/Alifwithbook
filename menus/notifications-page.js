/* ALIF Med — full-screen Notifications page (opened from the bell next to the profile avatar).
   * The on/off switch lives in Profile → Message notifications.
   * Below: announcements sent by the admin (Firestore `notifications`, newest first, last 30),
     with unread highlighting. One small query, cached for 5 minutes and kept for offline. */
import { db } from './cloud-sync.js';
import { collection, getDocs, query, orderBy, limit, where } from './runtime-ext.js';
import { getAuthUser } from './auth.js';
import { pushModalState, popModalState } from './modal-backbutton.js';
import { lockBodyScroll, unlockBodyScroll } from './cache.js';

const CACHE_KEY = 'alif_notifs_v1', SEEN_KEY = 'alif_notif_seen_v1', TTL = 5 * 60 * 1000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } };
const setJ = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

export function cachedItems() { const c = getJ(CACHE_KEY, null); return c && Array.isArray(c.items) ? c.items : []; }
export const seenMs = () => Number(getJ(SEEN_KEY, 0)) || 0;
export const unreadCount = () => { const s = seenMs(); return cachedItems().filter(i => i.ms > s).length; };

/* Fresh list (cache first unless force; falls back to the cache when offline).
   Two small sources, merged newest-first:
     notifications      — broadcasts to everyone (admin → Notifications)
     userNotifications  — messages meant for this student only: segments and automatic ones (payment, access) */
async function personal(uid) {
  const out = [];
  const months = []; const d = new Date();
  for (let i = 0; i < 2; i++) { months.push(new Date(d.getFullYear(), d.getMonth() - i, 1).toISOString().slice(0, 7)); }
  const map = x => { const v = x.data() || {}; return { id: 'u' + x.id, title: v.title || '', body: v.body || '', url: v.url || '', kind: v.kind || '', ms: v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : 0 }; };
  try {
    const snaps = await Promise.all(months.map(ym => getDocs(query(collection(db, 'userNotifications'), where('uids', 'array-contains', uid), where('ym', '==', ym)))));
    snaps.forEach(sn => sn.docs.forEach(x => out.push(map(x))));
  } catch (_) {
    try { (await getDocs(query(collection(db, 'userNotifications'), where('uids', 'array-contains', uid), limit(40)))).docs.forEach(x => out.push(map(x))); } catch (__) {}
  }
  return out;
}

export async function loadNotifications(force) {
  const c = getJ(CACHE_KEY, null);
  if (c && !force && Date.now() - (c.t || 0) < TTL) return c.items;
  try {
    const u = getAuthUser();
    const [snap, mine] = await Promise.all([
      getDocs(query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(30))),
      u && !u.isAnonymous ? personal(u.uid) : Promise.resolve([])
    ]);
    const items = snap.docs.map(d => {
      const x = d.data() || {};
      const ms = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
      return { id: d.id, title: x.title || '', body: x.body || '', url: x.url || '', ms };
    }).concat(mine).sort((a, b) => b.ms - a.ms).slice(0, 40);
    setJ(CACHE_KEY, { t: Date.now(), items });
    return items;
  } catch (e) {
    if (c && c.items) return c.items;
    throw e;
  }
}

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24); if (d < 7) return d + ' d ago';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: ms < Date.now() - 300 * 864e5 ? 'numeric' : undefined });
}

let screen = null, isOpen = false, hideTimer = 0;

const ICON = { 'payment-submitted': 'fa-receipt', 'payment-approved': 'fa-circle-check', 'payment-rejected': 'fa-circle-xmark', 'access-granted': 'fa-lock-open', 'access-revoked': 'fa-lock' };
function itemHtml(i, seen) {
  const link = i.url && i.url !== '/';
  return `<${link ? 'button type="button"' : 'div'} class="nf-item${i.ms > seen ? ' unread' : ''}" ${link ? `data-url="${esc(i.url)}"` : ''}>
    <span class="nf-ic"><i class="fa-solid ${ICON[i.kind] || 'fa-bullhorn'}"></i></span>
    <span class="nf-tx"><b>${esc(i.title)}</b><span class="nf-body">${esc(i.body)}</span><small>${esc(ago(i.ms))}</small></span>
    ${link ? '<i class="fa-solid fa-chevron-right nf-go"></i>' : ''}
  </${link ? 'button' : 'div'}>`;
}

function build() {
  screen = document.createElement('div');
  screen.className = 'pf-subscreen nf-screen hidden';
  screen.innerHTML = `
    <div class="pf-topbar"><button type="button" class="pf-back" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
      <div class="pf-topbar-title">Notifications</div><span class="pf-topbar-spacer"></span></div>
    <div class="nf-main">
      <div class="nf-sec">Announcements</div>
      <div id="nfList"></div>
    </div>`;
  document.body.appendChild(screen);
  screen.querySelector('.pf-back').addEventListener('click', close);
  screen.querySelector('#nfList').addEventListener('click', e => {
    const b = e.target.closest('[data-url]'); if (!b) return;
    const u = b.dataset.url;
    if (/^https?:\/\//i.test(u) && new URL(u).origin !== location.origin) window.open(u, '_blank', 'noopener');
    else { close(); try { const p = new URL(u, location.origin); if (p.pathname + p.search !== location.pathname + location.search) location.assign(p.href); } catch (_) {} }
  });
}

async function fill(force) {
  const list = screen.querySelector('#nfList');
  const seen = seenMs();
  const have = cachedItems();
  list.innerHTML = have.length ? have.map(i => itemHtml(i, seen)).join('') : '<div class="nf-skel"></div><div class="nf-skel"></div><div class="nf-skel"></div>';
  try {
    const items = await loadNotifications(force);
    if (!isOpen) return;
    list.innerHTML = items.length ? items.map(i => itemHtml(i, seen)).join('')
      : '<div class="nf-empty"><i class="fa-regular fa-bell"></i><p>No announcements yet.</p><small>Messages from your admins will appear here. Turn notifications on in Profile.</small></div>';
    const max = items.reduce((m, i) => Math.max(m, i.ms), 0);
    if (max) { setJ(SEEN_KEY, max); window.__alifBell && window.__alifBell.refresh(); }
  } catch (e) {
    if (!isOpen) return;
    if (!have.length) list.innerHTML = '<div class="nf-empty"><i class="fa-solid fa-wifi"></i><p>Could not load announcements.</p><button type="button" class="nf-retry">Try again</button></div>';
    const r = list.querySelector('.nf-retry'); if (r) r.addEventListener('click', () => fill(true));
  }
}

export function openNotificationsPage() {
  if (isOpen) return;
  if (!screen) build();
  isOpen = true;
  clearTimeout(hideTimer);
  screen.classList.remove('hidden'); screen.scrollTop = 0;
  lockBodyScroll(); pushModalState(close);
  requestAnimationFrame(() => requestAnimationFrame(() => screen.classList.add('open')));
  fill(false);
}

function close() {
  if (!isOpen || !screen) return;
  isOpen = false;
  screen.classList.remove('open');
  unlockBodyScroll(); popModalState(close);
  hideTimer = setTimeout(() => { if (!isOpen) screen.classList.add('hidden'); }, 300);
}

/* push notification tapped → /?notifications=1 */
try { if (new URLSearchParams(location.search).get('notifications') === '1') { history.replaceState(null, '', location.pathname); setTimeout(() => { try { openNotificationsPage(); } catch (_) {} }, 1800); } } catch (_) {}

window.__alifNotifPage = { open: openNotificationsPage, unread: unreadCount, load: loadNotifications };
