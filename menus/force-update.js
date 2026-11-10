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
  if (!document.getElementById('alifUpdCss')) {
    const st = document.createElement('style');
    st.id = 'alifUpdCss';
    st.textContent = `
.alif-upd{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 68px);z-index:99999;width:min(360px,calc(100vw - 24px));
  display:flex;align-items:center;gap:12px;padding:10px 10px 10px 14px;border-radius:18px;
  background:color-mix(in srgb,var(--card,#fff) 92%,transparent);color:var(--ink,#111);
  border:1px solid var(--card-border,rgba(0,0,0,.08));box-shadow:0 14px 34px -14px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.06);
  -webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);
  font:600 13.5px/1.25 Inter,system-ui,sans-serif;transform:translate(-50%,-14px);opacity:0;
  transition:transform .4s cubic-bezier(.2,.9,.3,1.1),opacity .3s ease}
.alif-upd.in{transform:translate(-50%,0);opacity:1}
.alif-upd.out{transform:translate(-50%,-14px);opacity:0}
.alif-upd-ic{width:30px;height:30px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:var(--primary-soft,rgba(0,112,243,.1));color:var(--primary,#0070f3);position:relative}
.alif-upd-ic svg{width:16px;height:16px}
.alif-upd-tx{flex:1;min-width:0}
.alif-upd-tx small{display:block;font-weight:500;opacity:.6;font-size:11.5px;margin-top:1px}
.alif-upd-btn{border:0;border-radius:999px;padding:8px 15px;font:inherit;font-weight:700;cursor:pointer;background:var(--primary,#0070f3);color:#fff;transition:transform .15s,opacity .2s}
.alif-upd-btn:active{transform:scale(.95)}
.alif-upd-x{border:0;background:transparent;color:inherit;opacity:.5;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:16px;line-height:1}
.alif-upd.busy .alif-upd-btn,.alif-upd.busy .alif-upd-x{display:none}
.alif-upd.busy .alif-upd-ic::after{content:'';position:absolute;inset:-4px;border-radius:50%;
  border:2px solid transparent;border-top-color:var(--primary,#0070f3);border-right-color:color-mix(in srgb,var(--primary,#0070f3) 35%,transparent);
  animation:alifUpdSpin 1.4s cubic-bezier(.5,.1,.5,.9) infinite;opacity:.85}
.alif-upd.busy .alif-upd-ic svg{animation:alifUpdPulse 1.8s ease-in-out infinite}
@keyframes alifUpdSpin{to{transform:rotate(360deg)}}
@keyframes alifUpdPulse{50%{opacity:.45;transform:scale(.88)}}
@media (prefers-reduced-motion:reduce){.alif-upd,.alif-upd *{animation-duration:3s!important;transition:none!important}}`;
    document.head.appendChild(st);
  }
  const bar = document.createElement('div');
  bar.className = 'alif-upd';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span class="alif-upd-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></span>' +
    '<span class="alif-upd-tx"><span data-t>New update available</span><small data-s>Refresh to get the latest</small></span>' +
    '<button type="button" class="alif-upd-btn" data-now>Refresh</button><button type="button" class="alif-upd-x" data-later aria-label="Later">&times;</button>';
  bar.querySelector('[data-later]').onclick = () => { bar.classList.remove('in'); bar.classList.add('out'); setTimeout(() => bar.remove(), 350); };
  bar.querySelector('[data-now]').onclick = () => {
    setSeen(version);
    bar.classList.add('busy');
    bar.querySelector('[data-t]').textContent = 'Updating…';
    bar.querySelector('[data-s]').textContent = 'Just a moment';
    hardRefresh();
  };
  document.body.appendChild(bar);
  requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('in')));
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
    if (d.cf != null) window.__alifCF = String(d.cf);   // complaint-flag stamp: tells question-complaint.js its cached flags are out of date
    const version = d.version != null ? String(d.version) : '';
    if (!version) return;
    const seen = getSeen();
    if (seen === null) { setSeen(version); return; }   // first run on this device
    if (seen === version) return;                      // already up to date
    if (d.mode === 'force') { setSeen(version); hardRefresh(); }
    else showBanner(version);
  }, () => { /* permission-denied / offline: stay silent */ });
}
