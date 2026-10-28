/* Shared helpers for the AResources modules (no app state in here). */
import { escapeHtml } from './loaders.js';

export const esc = escapeHtml;
export const $ = id => document.getElementById(id);
export const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}
export function driveId(u) {
  const m = String(u || '').match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{10,})/i);
  return m ? m[1] : '';
}
export function ytId(u) {
  const m = String(u || '').match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([\w-]{11})/i);
  return m ? m[1] : '';
}
export function vimeoParts(u) {
  const m = String(u || '').match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([\w]+))?/i);
  return m ? { id: m[1], h: m[2] || '' } : null;
}
export function fileExt(u) {
  const m = String(u || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}
/* Image URL for a thumbnail: understands Google Drive share links. */
export function thumbSrc(u) {
  const url = safeUrl(u);
  if (!url) return '';
  const d = driveId(url);
  return d ? `https://drive.google.com/thumbnail?id=${d}&sz=w640` : url;
}
export function videoThumb(v) {
  const t = thumbSrc(v.thumbUrl);
  if (t) return t;
  const y = ytId(v.videoUrl);
  return y ? `https://i.ytimg.com/vi/${y}/hqdefault.jpg` : '';
}
/* Question / option text may contain HTML from the admin editor: reduce to safe plain text. */
export function plain(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  return (t.content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
