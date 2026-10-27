/* ALIF Med — admin "Push update" receiver.
   Admin writes settings/appVersion = { version, mode: 'force' | 'prompt' }.
   - force : clear caches, re-download app files, reload immediately.
   - prompt: show an "Update available" banner; student chooses when.
   A device that has never seen a version just records it (no reload for new users). */
import { db } from './firebase-config.js';
import { doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const SEEN_KEY = 'atlas_app_version_seen_v1';
const MAX_ASSETS = 120;

/* Remove the cache-busting param added by a previous forced reload. */
try {
  const u = new URL(location.href);
  if (u.searchParams.has('_v')) {
    u.searchParams.delete('_v');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  }
} catch (_) {}

const getSeen = () => { try { return localStorage.getItem(SEEN_KEY); } catch (_) { return null; } };
const setSeen = v => { try { localStorage.setItem(SEEN_KEY, String(v)); } catch (_) {} };

/* Re-download every same-origin menus/*.js|css file (and what they import) with
   cache:'reload' so the browser's HTTP cache is overwritten with fresh copies. */
async function refetchAssets() {
  const seen = new Set();
  const queue = [];
  const add = p => {
    const url = new URL(p, location.origin + '/');
    if (url.origin !== location.origin || seen.has(url.pathname) || seen.size >= MAX_ASSETS) return;
    seen.add(url.pathname);
    queue.push(url.pathname);
  };
  const html = await (await fetch(location.pathname, { cache: 'reload' })).text();
  for (const m of html.matchAll(/(?:src|href)=["']\/?(menus\/[\w./-]+\.(?:js|css))["']/g)) add('/' + m[1]);
  while (queue.length) {
    const batch = queue.splice(0, 8);
    await Promise.all(batch.map(async path => {
      try {
        const res = await fetch(path, { cache: 'reload' });
        if (!res.ok || !path.endsWith('.js')) return;
        const base = path.replace(/[^/]+$/, '');
        for (const m of (await res.text()).matchAll(/["']\.\/([\w.-]+\.(?:js|css))["']/g)) add(base + m[1]);
      } catch (_) {}
    }));
  }
}

async function hardRefresh() {
  const now = String(Date.now());
  try { localStorage.setItem('atlas_cache_min_ts_v1', now); localStorage.setItem('atlas_cache_min_ts_q_v1', now); } catch (_) {}
  try { if (window.caches) await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch (_) {}
  try {
    if (navigator.serviceWorker) await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
  } catch (_) {}
  try { await Promise.race([refetchAssets(), new Promise(r => setTimeout(r, 8000))]); } catch (_) {}
  const u = new URL(location.href);
  u.searchParams.set('_v', now);
  location.replace(u.toString());
}

let bannerShown = false;
function showBanner(version) {
  if (bannerShown) return;
  bannerShown = true;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:99999;' +
    'display:flex;gap:10px;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:14px;' +
    'background:#1b1b1f;color:#fff;font:600 14px/1.3 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)';
  bar.innerHTML = '<span>A new version is available.</span><span style="display:flex;gap:8px">' +
    '<button type="button" data-later style="background:transparent;color:#bbb;border:0;font:inherit;padding:6px 8px">Later</button>' +
    '<button type="button" data-now style="background:#fff;color:#111;border:0;border-radius:10px;font:inherit;padding:8px 14px">Update</button></span>';
  bar.querySelector('[data-later]').onclick = () => bar.remove();
  bar.querySelector('[data-now]').onclick = () => { setSeen(version); hardRefresh(); };
  document.body.appendChild(bar);
}

if (db) {
  onSnapshot(doc(db, 'settings', 'appVersion'), snap => {
    if (!snap.exists()) return;
    const d = snap.data() || {};
    // Content stamps ride on this already-open listener => zero extra reads for cache invalidation.
    if (d.cv != null || d.cq != null) {
      window.__alifCV = { v: d.cv != null ? String(d.cv) : '', q: d.cq != null ? String(d.cq) : '', t: Date.now() };
      try { window.dispatchEvent(new Event('alif:cv')); } catch (_) {}
    }
    const version = d.version != null ? String(d.version) : '';
    if (!version) return;
    const seen = getSeen();
    if (seen === null) { setSeen(version); return; }   // first run on this device
    if (seen === version) return;                      // already up to date
    if (d.mode === 'force') { setSeen(version); hardRefresh(); }
    else showBanner(version);
  }, () => { /* permission-denied / offline: stay silent */ });
}
