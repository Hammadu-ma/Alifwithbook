/* ALIF Med — offline copies of books (PDF) and videos hosted in R2 (URLs like /api/r2?key=books/…).
   Files are kept in Cache Storage under their stable app URL (not the short-lived signed R2 link),
   so a saved book / video opens with no network at all. Links to other sites (YouTube, Drive…) cannot be saved. */
const CACHE = 'alif-offline-files-v1';
const MAX_BYTES = 450 * 1024 * 1024;

export const isR2 = u => /^(https?:\/\/[^/]+)?\/api\/r2\?key=/i.test(String(u || ''));
const abs = u => new URL(u, location.origin).href;
const has = () => 'caches' in window;
const open = () => caches.open(CACHE);

export async function isSaved(url) {
  if (!has() || !isR2(url)) return false;
  try { return !!(await (await open()).match(abs(url))); } catch (_) { return false; }
}

/* Blob URL of a saved file, or '' when it is not saved. */
export async function savedBlobUrl(url) {
  if (!has() || !isR2(url)) return '';
  try {
    const hit = await (await open()).match(abs(url));
    return hit ? URL.createObjectURL(await hit.blob()) : '';
  } catch (_) { return ''; }
}

const inflight = new Map();   // url -> Promise<Blob>

/* Download a file, keep it for offline use, and resolve with the Blob.
   onProgress(percent 0-100 | -1 when the size is unknown). */
export function saveFile(url, onProgress) {
  const k = abs(url);
  if (inflight.has(k)) return inflight.get(k);
  const job = (async () => {
    const r = await fetch(k, { credentials: 'omit' });
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
  if (!has() || !isR2(url)) return;
  try { await (await open()).delete(abs(url)); } catch (_) {}
}

export const sizeLabel = n => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
