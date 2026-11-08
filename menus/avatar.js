/* ALIF Med — profile photos, stored in Cloudflare R2 through /api/r2.
   The photo is cropped to a 256px square JPEG in the browser (about 20-40 KB), uploaded with a short-lived
   signed URL, and its address is saved on the student's chatProfiles document so classmates see it in the
   chat lists. The student's own copy is cached in localStorage. */
import { getStoredStudent, getAuthUser } from './auth.js';
import { db } from './cloud-sync.js';
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot } from './runtime-ext.js';

const KEY = sid => 'alif_avatar_v2_' + sid;
const TTL = 3 * 60 * 1000;      // short: a change made on another device shows up within minutes
const SIZE = 256;

const sidOf = () => { const s = getStoredStudent(); return (s && (s.id || s.docId)) || ''; };
const read = sid => { try { return JSON.parse(localStorage.getItem(KEY(sid))) || null; } catch (_) { return null; } };
const write = (sid, v) => { try { localStorage.setItem(KEY(sid), JSON.stringify({ ...v, t: Date.now() })); } catch (_) {} };

/* { url, key } of the signed-in student's photo, or null. Cached; refreshed from Firestore at most every 12 h. */
export function ownAvatar() {
  const sid = sidOf();
  const c = sid && read(sid);
  return c && c.url ? c : null;
}

export async function loadOwnAvatar(force) {
  const sid = sidOf();
  if (!sid || !db) return null;
  const c = read(sid);
  if (c && !force && Date.now() - (c.t || 0) < TTL) return c.url ? c : null;
  try {
    const snap = await getDoc(doc(db, 'chatProfiles', sid));
    const d = snap.exists() ? snap.data() : {};
    write(sid, { url: d.avatarUrl || '', key: d.avatarKey || '' });
  } catch (_) { /* offline: keep whatever is cached */ }
  const r = read(sid);
  return r && r.url ? r : null;
}

async function token() {
  const u = getAuthUser();
  if (!u) throw new Error('Please sign in first.');
  return u.getIdToken();
}
async function api(body) {
  const r = await fetch('/api/r2', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Photo service error (${r.status})`);
  return d;
}

/* centre-crop to a square and re-encode as a small JPEG */
function toSquareJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const cv = document.createElement('canvas');
        cv.width = cv.height = SIZE;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
        cv.toBlob(b => (b ? resolve(b) : reject(new Error('Could not read that image.'))), 'image/jpeg', 0.86);
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a supported image.')); };
    img.src = url;
  });
}

async function saveProfile(sid, url, key) {
  await setDoc(doc(db, 'chatProfiles', sid), { studentId: sid, avatarUrl: url, avatarKey: key, updatedAt: serverTimestamp() }, { merge: true });
}

export async function setOwnAvatar(file) {
  const sid = sidOf();
  if (!sid) throw new Error('Please sign in first.');
  if (!file || !/^image\//.test(file.type || '')) throw new Error('Choose an image file.');
  const blob = await toSquareJpeg(file);
  const prev = read(sid);
  const sig = await api({ action: 'avatar-upload', size: blob.size });
  const put = await fetch(sig.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob })
    .catch(() => { throw new Error('Upload blocked. The R2 bucket CORS policy must include this site (see R2_SETUP.md).'); });
  if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
  await saveProfile(sid, sig.url, sig.key);
  write(sid, { url: sig.url, key: sig.key });
  if (prev && prev.key && prev.key !== sig.key) api({ action: 'avatar-delete', key: prev.key }).catch(() => {});
  applyOwnAvatar();
  return sig.url;
}

export async function removeOwnAvatar() {
  const sid = sidOf();
  if (!sid) return;
  const prev = read(sid);
  await saveProfile(sid, '', '');
  write(sid, { url: '', key: '' });
  if (prev && prev.key) api({ action: 'avatar-delete', key: prev.key }).catch(() => {});
  applyOwnAvatar();
}

/* <img> that fills a round avatar box (used inside .pr-avatar / .pf-avatar) */
export const avatarImg = (url, cls = 'av-photo') => (url ? `<img class="${cls}" src="${String(url).replace(/"/g, '&quot;')}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '');

/* Swap the header profile icons for the student's photo (or restore the icon). */
export function applyOwnAvatar() {
  const a = ownAvatar();
  hydrateAvatars();
  ['homeProfileBtn', 'profileBtn'].forEach(id => {
    const b = document.getElementById(id);
    if (!b || b.classList.contains('signup-btn')) return;
    const has = b.querySelector('img.av-photo');
    if (a) {
      if (has && has.getAttribute('src') === a.url) return;
      b.classList.add('has-photo');
      b.innerHTML = avatarImg(a.url, 'av-photo');
    } else if (has || b.classList.contains('has-photo')) {
      b.classList.remove('has-photo');
      b.innerHTML = '<i class="fa-solid fa-user"></i>';
    }
  });
}


/* ---- everyone else's photo (and your own) wherever an avatar slot is rendered ----
   Templates drop in <img data-av-sid="studentId" hidden>; this fills it from a small cache of
   chatProfiles photos (30 min, stale copy shown instantly, refreshed in the background, batched). */
const PEER_KEY = 'alif_peer_av_v1', PEER_TTL = 30 * 60 * 1000;
let peers = {};
try { peers = JSON.parse(localStorage.getItem(PEER_KEY)) || {}; } catch (_) {}
const asked = new Set(), pending = new Set();
let fetchTimer = 0, hydTimer = 0;
const savePeers = () => { try { const k = Object.keys(peers); if (k.length > 400) k.sort((a, b) => peers[a].t - peers[b].t).slice(0, k.length - 400).forEach(x => delete peers[x]); localStorage.setItem(PEER_KEY, JSON.stringify(peers)); } catch (_) {} };

export function avatarOf(sid) {
  if (!sid) return '';
  if (sid === sidOf()) { const a = ownAvatar(); return a ? a.url : ''; }
  return (peers[sid] && peers[sid].u) || '';
}
/* feed photos we already know (e.g. from the classmates query) so no extra reads are needed */
export function primeAvatars(list) {
  (list || []).forEach(x => { const id = x && (x.studentId || x.id); if (id && typeof x.avatarUrl === 'string') peers[id] = { u: x.avatarUrl, t: Date.now() }; });
  savePeers();
}
async function fetchPeers() {
  fetchTimer = 0;
  const ids = [...pending].slice(0, 40); ids.forEach(i => pending.delete(i));
  if (!ids.length || !db) return;
  await Promise.all(ids.map(async id => {
    try { const sn = await getDoc(doc(db, 'chatProfiles', id)); peers[id] = { u: (sn.exists() && sn.data().avatarUrl) || '', t: Date.now() }; } catch (_) {}
  }));
  savePeers(); hydrateAvatars();
  if (pending.size) fetchTimer = setTimeout(fetchPeers, 300);
}
export function hydrateAvatars(root) {
  try {
    (root || document).querySelectorAll('img[data-av-sid]').forEach(img => {
      const sid = img.dataset.avSid, u = avatarOf(sid);
      if (sid && sid !== sidOf()) {
        const p = peers[sid];
        if ((!p || Date.now() - p.t > PEER_TTL) && !asked.has(sid)) { asked.add(sid); pending.add(sid); if (!fetchTimer) fetchTimer = setTimeout(fetchPeers, 120); }
      }
      if (u) { if (img.getAttribute('src') !== u) img.src = u; img.hidden = false; } else { img.hidden = true; }
    });
  } catch (_) {}
}
function watchDom() {
  try {
    new MutationObserver(() => { if (!hydTimer) hydTimer = setTimeout(() => { hydTimer = 0; hydrateAvatars(); }, 150); })
      .observe(document.body, { childList: true, subtree: true });
    hydrateAvatars();
  } catch (_) {}
}

/* hydrate the header once the student is known (login can finish after page load) */
let liveSid = '', liveOff = null;
/* One tiny listener on the student's own profile doc: a photo changed anywhere shows here at once. */
function goLive() {
  const sid = sidOf();
  if (!sid || !db || sid === liveSid) return;
  try { liveOff && liveOff(); } catch (_) {}
  liveSid = sid;
  try {
    liveOff = onSnapshot(doc(db, 'chatProfiles', sid), snap => {
      if (snap.metadata.fromCache && !navigator.onLine) return;
      const d = snap.exists() ? snap.data() : {};
      const c = read(sid);
      if (!c || c.url !== (d.avatarUrl || '')) { write(sid, { url: d.avatarUrl || '', key: d.avatarKey || '' }); applyOwnAvatar(); }
      else write(sid, c);
    }, () => {});
  } catch (_) {}
}
let tries = 0, watching = false;
function boot() {
  try {
    if (!watching && document.body) { watching = true; watchDom(); }
    applyOwnAvatar();
    if (sidOf()) { goLive(); loadOwnAvatar().then(applyOwnAvatar).catch(() => {}); }
  } catch (_) { /* never let a photo problem touch the app */ }
  if (++tries < 12) setTimeout(boot, tries < 4 ? 1500 : 5000);
}
// NOT run at import time: this module is part of an import cycle with auth.js, so its imports may not be ready yet.
setTimeout(boot, 800);
window.addEventListener('focus', () => { try { applyOwnAvatar(); if (sidOf()) loadOwnAvatar().then(applyOwnAvatar).catch(() => {}); } catch (_) {} });
window.__alifAvatar = { hydrateAvatars, primeAvatars, avatarOf, applyOwnAvatar, loadOwnAvatar, setOwnAvatar, removeOwnAvatar, ownAvatar };
