/* ALIF Med — offline copies of books (PDF) and videos.
   Saved: files hosted in R2 (URLs like /api/r2?key=…) and direct media files (.mp4 .webm .ogg .ogv .mov .m4v).
   NOT saved: YouTube, Vimeo, Google Drive and other embedded platforms — those can only be watched online.
   Files are kept in Cache Storage under their stable app URL (not the short-lived signed R2 link),
   so a saved book / video opens with no network at all. A small list of video details (title, lecturer, …)
   is kept in localStorage so the Downloads page can show saved videos while offline. */
const CACHE = 'alif-offline-files-v1';
const META_KEY = 'alif_offline_meta_v1';
const MAX_BYTES = 450 * 1024 * 1024;

export const isR2 = u => /^(https?:\/\/[^/]+)?\/api\/r2\?key=/i.test(String(u || ''));
const abs = u => new URL(u, location.origin).href;
const has = () => 'caches' in window;
const open = () => caches.open(CACHE);

/* Direct media only; embedded / streaming platforms are excluded. */
const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|vimeo\.com|drive\.google\.com)$/i;
export const isDownloadableMedia = u => {
  try {
    const x = new URL(String(u || ''), location.origin);
    if (!/^https?:$/.test(x.protocol)) return false;
    if (BLOCKED_HOSTS.test(x.hostname)) return false;
    return isR2(x.href) || /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(x.pathname);
  } catch (_) { return false; }
};

/* ---- details of saved videos (for the Downloads page) ---- */
const readMeta = () => { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (_) { return {}; } };
const writeMeta = m => { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (_) {} };
export const videoMeta = (v, thumb) => ({
  kind: 'video', id: v.id, title: v.title || 'Video', lecturer: v.lecturer || '', subjectId: v.subjectId || '',
  moduleId: v.moduleId || '', duration: v.duration || '', thumb: thumb || ''
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

/* Every saved video that has details recorded, newest first: [{ url, size, savedAt, title, … }]. */
export async function listSaved() {
  if (!has()) return [];
  try {
    const c = await open(), meta = readMeta(), out = [];
    for (const req of await c.keys()) {
      const m = meta[req.url];
      if (!m || m.kind !== 'video') continue;
      const hit = await c.match(req);
      out.push({ ...m, url: req.url, size: hit ? Number(hit.headers.get('Content-Length')) || 0 : 0 });
    }
    return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch (_) { return []; }
}

const inflight = new Map();   // url -> Promise<Blob>

/* Download a file, keep it for offline use, and resolve with the Blob.
   onProgress(percent 0-100 | -1 when the size is unknown). */
export function saveFile(url, onProgress) {
  const k = abs(url);
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
    if (has()) {
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

export async function removeAllVideos() {
  const items = await listSaved();
  for (const x of items) await removeFile(x.url);
  return items.length;
}

export const sizeLabel = n => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
