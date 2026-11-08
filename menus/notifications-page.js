/* ALIF Med — full-screen Notifications page (opened from the bell next to the profile avatar).
   * Top: switch to turn message notifications on / off for this device.
   * Below: announcements sent by the admin (Firestore `notifications`, newest first, last 30),
     with unread highlighting. One small query, cached for 5 minutes and kept for offline. */
import { db } from './cloud-sync.js';
import { collection, getDocs, query, orderBy, limit } from './runtime-ext.js';
import { enableNotifications, notificationStatus } from './notification-manager.js';
import { showToast } from './ui-feedback.js';
import { pushModalState, popModalState } from './modal-backbutton.js';
import { lockBodyScroll, unlockBodyScroll } from './cache.js';

const CACHE_KEY = 'alif_notifs_v1', SEEN_KEY = 'alif_notif_seen_v1', TTL = 5 * 60 * 1000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } };
const setJ = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

export function cachedItems() { const c = getJ(CACHE_KEY, null); return c && Array.isArray(c.items) ? c.items : []; }
export const seenMs = () => Number(getJ(SEEN_KEY, 0)) || 0;
export const unreadCount = () => { const s = seenMs(); return cachedItems().filter(i => i.ms > s).length; };

/* Fresh list (cache first unless force; falls back to the cache when offline). */
export async function loadNotifications(force) {
  const c = getJ(CACHE_KEY, null);
  if (c && !force && Date.now() - (c.t || 0) < TTL) return c.items;
  try {
    const snap = await getDocs(query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(30)));
    const items = snap.docs.map(d => {
      const x = d.data() || {};
      const ms = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
      return { id: d.id, title: x.title || '', body: x.body || '', url: x.url || '', ms };
    });
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

function statusText(s) {
  return s === 'on' ? 'You will get chat messages on this device.'
    : s === 'denied' ? 'Blocked by your browser. Allow notifications for this site in settings, then switch on.'
    : s === 'unsupported' ? 'Not available here. On iPhone, add ALIF to your Home Screen first.'
    : 'Switch on to get chat messages on this device.';
}

function itemHtml(i, seen) {
  const link = i.url && i.url !== '/';
  return `<${link ? 'button type="button"' : 'div'} class="nf-item${i.ms > seen ? ' unread' : ''}" ${link ? `data-url="${esc(i.url)}"` : ''}>
    <span class="nf-ic"><i class="fa-solid fa-bullhorn"></i></span>
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
      <div class="nf-device">
        <span class="nf-dev-ic"><i class="fa-solid fa-bell"></i></span>
        <span class="nf-dev-tx"><b>Notifications on this device</b><span id="nfStatus"></span></span>
        <span class="toggle-switch"><input type="checkbox" id="nfToggle"><span class="ts-track"></span></span>
      </div>
      <div class="nf-sec">Announcements</div>
      <div id="nfList"></div>
    </div>`;
  document.body.appendChild(screen);
  screen.querySelector('.pf-back').addEventListener('click', close);
  const tg = screen.querySelector('#nfToggle');
  tg.addEventListener('change', async () => {
    tg.disabled = true;
    try {
      if (tg.checked) { await enableNotifications(); showToast('Notifications are on'); }
      else { if (window.__alifPushBeforeSignOut) await window.__alifPushBeforeSignOut(); showToast('Notifications are off on this device'); }
    } catch (e) {
      showToast(e.message || 'Could not change notifications', { icon: 'fa-solid fa-circle-exclamation', duration: 6000 });
    } finally { tg.disabled = false; syncDevice(); window.__alifBell && window.__alifBell.refresh(); }
  });
  screen.querySelector('#nfList').addEventListener('click', e => {
    const b = e.target.closest('[data-url]'); if (!b) return;
    const u = b.dataset.url;
    if (/^https?:\/\//i.test(u) && new URL(u).origin !== location.origin) window.open(u, '_blank', 'noopener');
    else { close(); try { const p = new URL(u, location.origin); if (p.pathname + p.search !== location.pathname + location.search) location.assign(p.href); } catch (_) {} }
  });
}

function syncDevice() {
  let s = 'unsupported'; try { s = notificationStatus(); } catch (_) {}
  const tg = screen.querySelector('#nfToggle');
  tg.checked = s === 'on';
  tg.disabled = s === 'unsupported' || s === 'denied';
  screen.querySelector('#nfStatus').textContent = statusText(s);
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
      : '<div class="nf-empty"><i class="fa-regular fa-bell"></i><p>No announcements yet.</p><small>Messages from your admins will appear here.</small></div>';
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
  syncDevice();
  fill(false);
}

function close() {
  if (!isOpen || !screen) return;
  isOpen = false;
  screen.classList.remove('open');
  unlockBodyScroll(); popModalState(close);
  hideTimer = setTimeout(() => { if (!isOpen) screen.classList.add('hidden'); }, 300);
}

window.__alifNotifPage = { open: openNotificationsPage, unread: unreadCount, load: loadNotifications };
