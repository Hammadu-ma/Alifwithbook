/* ALIF Med — offline copies of books (PDF) and videos.
   Saved: files hosted in R2 (URLs like /api/r2?key=…) and direct media files (.mp4 .webm .ogg .ogv .mov .m4v).
   NOT saved: YouTube, Vimeo, Google Drive and other embedded platforms — those can only be watched online.
   Files are kept in Cache Storage under their stable app URL (not the short-lived signed R2 link),
   so a saved book / video opens with no network at all. A small list of video details (title, lecturer, …)
   is kept in localStorage so the Downloads page can show saved videos while offline. */
import { getStoredStudent } from './auth.js';
/* Everything saved here belongs to the signed-in account: the cache and the details list are named after the
   student, other accounts' copies (and the old shared copies) are deleted, and nothing works while signed out. */
const BASE = 'alif-offline-files-v2', META_BASE = 'alif_offline_meta_v2', OWNER_KEY = 'alif_cache_owner_v1';
const owner = () => { try { const u = getStoredStudent(); return String((u && (u.id || u.docId)) || ''); } catch (_) { return ''; } };
const cacheName = () => BASE + ':' + owner();
let purged = '';
function purgeOthers() {
  const me = owner();
  if (!me || purged === me) return;
  purged = me;
  try {
    if ('caches' in window) caches.keys().then(ks => ks.forEach(k => {
      if ((k === 'alif-offline-files-v1') || (k.indexOf(BASE + ':') === 0 && k !== cacheName())) caches.delete(k);
    })).catch(() => {});
    localStorage.removeItem('alif_offline_meta_v1');
    Object.keys(localStorage).forEach(k => { if (k.indexOf(META_BASE + ':') === 0 && k !== META_BASE + ':' + me) localStorage.removeItem(k); });
    /* quiz question banks are kept per device by the content cache — start clean when the account changes */
    if (localStorage.getItem(OWNER_KEY) !== me) {
      Object.keys(localStorage).forEach(k => { if (/^atlas_(questions|quizzes)_/.test(k)) localStorage.removeItem(k); });
      localStorage.setItem(OWNER_KEY, me);
    }
  } catch (_) {}
}
const MAX_BYTES = 450 * 1024 * 1024;

export const isR2 = u => /^(https?:\/\/[^/]+)?\/api\/r2\?key=/i.test(String(u || ''));
const abs = u => new URL(u, location.origin).href;
const has = () => { if (!owner()) return false; purgeOthers(); return 'caches' in window; };
const open = () => caches.open(cacheName());

/* Direct media only; embedded / streaming platforms are excluded. */
const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|vimeo\.com|drive\.google\.com)$/i;
export const isDownloadableMedia = u => {
  try {
    const x = new URL(String(u || ''), location.origin);
    if (!/^https?:$/.test(x.protocol)) return false;
    if (BLOCKED_HOSTS.test(x.hostname)) return false;
    return isR2(x.href) || /\.(mp4|webm|ogg|ogv|mov|m4v|pdf)$/i.test(x.pathname);
  } catch (_) { return false; }
};

/* ---- details of saved videos and books (for the Downloads page) ---- */
const metaKey = () => META_BASE + ':' + owner();
const readMeta = () => { if (!owner()) return {}; try { return JSON.parse(localStorage.getItem(metaKey()) || '{}') || {}; } catch (_) { return {}; } };
const writeMeta = m => { try { localStorage.setItem(metaKey(), JSON.stringify(m)); } catch (_) {} };
export const videoMeta = (v, thumb) => ({
  kind: 'video', id: v.id, title: v.title || 'Video', lecturer: v.lecturer || '', subjectId: v.subjectId || '',
  moduleId: v.moduleId || '', duration: v.duration || '', thumb: thumb || ''
});
export const bookMeta = (b, thumb) => ({
  kind: 'book', id: b.id, title: b.title || 'Book', author: b.author || '', subjectId: b.subjectId || '',
  moduleId: b.moduleId || '', thumb: thumb || '', src: b.fileUrl || ''
});
export function setMeta(url, meta) {
  if (!isDownloadableMedia(url)) return;
  const m = readMeta();
  m[abs(url)] = { ...meta, savedAt: (m[abs(url)] && m[abs(url)].savedAt) || Date.now() };
  writeMeta(m);
}

export async function isSaved(url) {
  if (!has() || !isDownloadableMedia(url)) return false;
  try { return !!(await (await open()).match(abs(url))); } catch (_) { return false; }
}

/* Blob URL of a saved file, or '' when it is not saved. */
export async function savedBlobUrl(url) {
  if (!has() || !isDownloadableMedia(url)) return '';
  try {
    const hit = await (await open()).match(abs(url));
    return hit ? URL.createObjectURL(await hit.blob()) : '';
  } catch (_) { return ''; }
}

/* Every saved video / book that has details recorded, newest first: [{ kind, url, size, savedAt, title, … }]. */
export async function listSaved() {
  if (!has()) return [];
  try {
    const c = await open(), meta = readMeta(), out = [];
    for (const req of await c.keys()) {
      const m = meta[req.url];
      if (!m || (m.kind !== 'video' && m.kind !== 'book')) continue;
      const hit = await c.match(req);
      out.push({ ...m, url: req.url, size: hit ? Number(hit.headers.get('Content-Length')) || 0 : 0 });
    }
    return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch (_) { return []; }
}

const inflight = new Map();   // url -> Promise<Blob>

/* Download a file, keep it for offline use, and resolve with the Blob.
   onProgress(percent 0-100 | -1 when the size is unknown). */
export function saveFile(url, onProgress, opts) {
  const k = abs(url), persist = !(opts && opts.persist === false);
  if (inflight.has(k)) return inflight.get(k);
  const job = (async () => {
    let r;
    try { r = await fetch(k, { credentials: 'omit' }); }
    catch (_) { throw new Error(navigator.onLine === false ? 'No internet connection.' : 'This host does not allow saving this file.'); }
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    const total = Number(r.headers.get('content-length')) || 0;
    if (total > MAX_BYTES) throw new Error('This file is too large to save offline.');
    const type = r.headers.get('content-type') || 'application/octet-stream';
    let blob;
    if (r.body && r.body.getReader) {
      const rd = r.body.getReader(), parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value); got += value.length;
        if (got > MAX_BYTES) { try { rd.cancel(); } catch (_) {} throw new Error('This file is too large to save offline.'); }
        if (onProgress) onProgress(total ? Math.min(99, Math.round(got / total * 100)) : -1);
      }
      blob = new Blob(parts, { type });
    } else blob = await r.blob();
    if (has() && persist) {
      try {
        await (await open()).put(k, new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(blob.size) } }));
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      } catch (_) { /* storage full: still usable this session, just not saved */ }
    }
    if (onProgress) onProgress(100);
    return blob;
  })();
  inflight.set(k, job);
  const done = () => inflight.delete(k);
  job.then(done, done);
  return job;
}

export async function removeFile(url) {
  if (!has() || !isDownloadableMedia(url)) return;
  try { await (await open()).delete(abs(url)); } catch (_) {}
  const m = readMeta();
  if (m[abs(url)]) { delete m[abs(url)]; writeMeta(m); }
}

export async function removeAllDownloads() {
  const items = await listSaved();
  for (const x of items) await removeFile(x.url);
  return items.length;
}

export const sizeLabel = n => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

export const removeAllVideos = removeAllDownloads;

/* ---- quizzes for offline: kept in the normal content cache (not listed under Downloads) ---- */
export async function cacheQuizzesOffline(quizzes, onProgress, { fresh } = {}) {
  if (!owner()) throw new Error('Sign in first.');
  purgeOthers();
  const { loadQuestions } = await import('./onboarding-tour.js');
  let ok = 0, fail = 0, i = 0;
  for (const q of quizzes) {
    i++;
    try {
      if (fresh) localStorage.removeItem(`atlas_questions_${q.subjectId}_${q.id}`);
      await loadQuestions(q.subjectId, q.id);
      ok++;
    } catch (_) { fail++; }
    if (onProgress) onProgress(i, quizzes.length);
  }
  try { localStorage.setItem('alif_quiz_offline_' + owner(), JSON.stringify({ at: Date.now(), n: ok })); } catch (_) {}
  return { ok, fail };
}
export function quizOfflineInfo() {
  try { return JSON.parse(localStorage.getItem('alif_quiz_offline_' + owner()) || 'null'); } catch (_) { return null; }
}
export function clearQuizOffline() {
  try {
    Object.keys(localStorage).forEach(k => { if (/^atlas_questions_/.test(k) || k === 'alif_quiz_offline_' + owner()) localStorage.removeItem(k); });
  } catch (_) {}
}
