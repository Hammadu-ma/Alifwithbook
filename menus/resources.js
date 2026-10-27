/* ========================================================================
   ALIF Med — AResources
   ------------------------------------------------------------------------
   Bottom-nav tab with two sections:

     ABooks   root: module cards  ->  module: books (optional subject filter)
     AVideos  root: module cards  ->  module: [All | Lecturers] tabs
                                         All       = every video (subject filter)
                                         Lecturers = lecturer cards -> that lecturer's videos

   Data (public-read Firestore collections, admin-written):
     books/{id}   title, author, description, moduleId, subjectId?, sourceType,
                  fileUrl, thumbUrl?, order, active, universityId, createdAt
     videos/{id}  title, description, moduleId, subjectId?, lecturer, lecturerTitle?,
                  lecturerPhoto?, sourceType, videoUrl, thumbUrl?, duration?, order,
                  active, universityId, createdAt

   Caching reuses the app's content-version mechanism (loaders.js): lists are served
   from cache and only re-downloaded after the admin publishes a change.
   ======================================================================== */
import { getStoredStudent } from './auth.js';
import { setActiveNavTab, updateBottomNavVisibility } from './bottom-nav.js';
import { forceUnlockBodyScroll, lockBodyScroll } from './cache.js';
import { closeChatScreen } from './class-chat.js';
import { db } from './cloud-sync.js';
import { homeScreen, pickerScreen } from './gate-screen.js';
import { triggerLockResponse } from './home-screen.js';
import { cacheState, escapeHtml as esc, getCachedWithTTL, setCachedWithTTL } from './loaders.js';
import { getEffectiveLockMessage, isResourceLocked } from './lock.js';
import { popModalState, pushModalState } from './modal-backbutton.js';
import { loadModules, loadSubjects } from './onboarding-tour.js';
import {
  ACTIVE_UNIVERSITY_ID, initials, moduleColorFor, moduleIcon,
  modulesScreenEl, subjectColorFor, subjectsScreenEl, universitiesScreenEl
} from './picker-screen.js';
import { progressScreen } from './progress-page.js';
import { pushAppState } from './progress-rings.js';
import { collection, getDocs } from './runtime-ext.js';

const $ = id => document.getElementById(id);
const screen = $('resourcesScreen');
const elHead = $('resHead');
const elBack = $('resBackBtn');
const elTitle = $('resTitle');
const elSub = $('resSub');
const elBrandIcon = $('resBrandIcon');
const elLayoutBtn = $('resLayoutBtn');
const elTabs = $('resTabs');
const elPills = $('resPills');
const elMain = $('resMain');
const elSheet = $('resSheet');
const elPlayer = $('resPlayer');
const elReader = $('resReader');

/* ---------------------------------------------------------------- state */
const LS_LAYOUT = 'alif_res_layout_v1';
let layout = 'grid';
try { layout = localStorage.getItem(LS_LAYOUT) === 'list' ? 'list' : 'grid'; } catch (_) {}

let MODS = [];
let SUBJ = [];
let BOOKS = [];
let VIDEOS = [];
let loaded = { mods: false, books: false, videos: false };
let loadFailed = false;

const ROOT = { tab: 'books', view: 'root', moduleId: null, vtab: 'all', lecturer: null };
let nav = { ...ROOT };
let subjectId = 'all';   // transient filters (not kept in history)
let query = '';

const snap = () => ({ tab: nav.tab, view: nav.view, moduleId: nav.moduleId, vtab: nav.vtab, lecturer: nav.lecturer });
const isOpen = () => screen && !screen.classList.contains('hidden');

/* -------------------------------------------------------------- helpers */
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}
function driveId(u) {
  const m = String(u || '').match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{10,})/i);
  return m ? m[1] : '';
}
function ytId(u) {
  const m = String(u || '').match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([\w-]{11})/i);
  return m ? m[1] : '';
}
function vimeoParts(u) {
  const m = String(u || '').match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([\w]+))?/i);
  return m ? { id: m[1], h: m[2] || '' } : null;
}
/* Image URL for a thumbnail: understands Google Drive share links. */
function thumbSrc(u) {
  const url = safeUrl(u);
  if (!url) return '';
  const d = driveId(url);
  return d ? `https://drive.google.com/thumbnail?id=${d}&sz=w640` : url;
}
function videoThumb(v) {
  const t = thumbSrc(v.thumbUrl);
  if (t) return t;
  const y = ytId(v.videoUrl);
  return y ? `https://i.ytimg.com/vi/${y}/hqdefault.jpg` : '';
}
function fileExt(u) {
  const m = String(u || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}
function bookTypeLabel(b) {
  const e = fileExt(b.fileName || b.fileUrl);
  if (e === 'pdf') return 'PDF';
  if (/^docx?$/.test(e)) return 'DOC';
  if (/^pptx?$/.test(e)) return 'PPT';
  if (/^xlsx?$/.test(e)) return 'XLS';
  if (e === 'epub') return 'EPUB';
  if (driveId(b.fileUrl)) return 'DRIVE';
  return b.sourceType === 'upload' ? 'FILE' : 'LINK';
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (!n) return '';
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const subjectName = id => (SUBJ.find(s => s.id === id) || {}).name || '';
const moduleById = id => MODS.find(m => m.id === id) || null;
const isNew = it => it.createdMs && Date.now() - it.createdMs < 14 * 864e5;
function accentFor(id) { try { return moduleColorFor(id); } catch (_) { return 'var(--artery)'; } }
function iconFor(m) { try { return moduleIcon(m.name); } catch (_) { return 'fa-solid fa-book-medical'; } }

/* --------------------------------------------------------------- loading */
function mapDoc(d) {
  const x = d.data();
  const ts = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : (Number(x.createdAt) || 0);
  const { createdAt, updatedAt, ...rest } = x;
  return { id: d.id, ...rest, createdMs: ts };
}
const sortItems = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (b.createdMs || 0) - (a.createdMs || 0) || String(a.title || '').localeCompare(String(b.title || ''));

function loadList(name, assign) {
  const key = `atlas_res_${name}_${ACTIVE_UNIVERSITY_ID}`;
  const cached = getCachedWithTTL(key);
  if (cached) assign(cached.data);
  if (cached && cacheState(cached) === 'fresh') return Promise.resolve();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { if (!cached) loadFailed = true; return Promise.resolve(); }
  return getDocs(collection(db, name)).then(res => {
    const list = res.docs.map(mapDoc)
      .filter(x => x.active !== false && (x.universityId || 'jimma') === ACTIVE_UNIVERSITY_ID)
      .sort(sortItems);
    if (!cached || JSON.stringify(cached.data) !== JSON.stringify(list)) assign(list);
    setCachedWithTTL(key, list);
  }).catch(() => { if (!cached) loadFailed = true; });
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; if (isOpen()) render(); });
}

function ensureData() {
  loadFailed = false;
  const pMods = new Promise(res => {
    const set = list => { MODS = list || []; loaded.mods = true; queueRender(); };
    loadModules(set, set, () => { loaded.mods = true; loadFailed = !MODS.length; res(); }, true);
    // loaders call back immediately when a fresh cache exists; give network misses a moment, then resolve
    setTimeout(res, 1500);
  });
  const pSubj = new Promise(res => {
    const set = list => { SUBJ = list || []; queueRender(); };
    loadSubjects(set, set, () => {}, true);
    setTimeout(res, 1500);
  });
  const pBooks = loadList('books', l => { BOOKS = l; queueRender(); }).then(() => { loaded.books = true; });
  const pVids = loadList('videos', l => { VIDEOS = l; queueRender(); }).then(() => { loaded.videos = true; });
  Promise.all([pMods, pSubj, pBooks, pVids]).then(queueRender);
}
window.addEventListener('atlas:content-updated', () => { if (isOpen()) ensureData(); });

/* --------------------------------------------------------------- opening */
function hideSiblings() {
  [homeScreen, pickerScreen, progressScreen, modulesScreenEl, subjectsScreenEl, universitiesScreenEl]
    .forEach(el => el && el.classList.add('hidden'));
}

export function openResources({ skipHistory = false } = {}) {
  const student = getStoredStudent();
  if (!student) return;
  hideSiblings();
  closeChatScreen();
  screen.classList.remove('hidden');
  setActiveNavTab('resources');
  updateBottomNavVisibility();
  forceUnlockBodyScroll();
  lockBodyScroll();

  if (skipHistory) {
    const rv = history.state && history.state.rv;
    nav = rv ? { ...ROOT, ...rv } : { ...ROOT, tab: nav.tab };
  } else {
    nav = { ...ROOT, tab: nav.tab };
    if (history.state && history.state.appState === 'resources') history.replaceState({ appState: 'resources', rv: snap() }, '', '');
    else pushAppState('resources');
  }
  subjectId = 'all';
  query = '';
  render();
  screen.scrollTop = 0;
  ensureData();
}

export function closeResources() {
  closeReader();
  closeSheet();
  closePlayer();
  screen.classList.add('hidden');
}

function go(next, { push = false } = {}) {
  nav = { ...nav, ...next };
  subjectId = 'all';
  query = '';
  try { history[push ? 'pushState' : 'replaceState']({ appState: 'resources', rv: snap() }, '', ''); } catch (_) {}
  render();
  screen.scrollTop = 0;
}

function goBack() {
  if (nav.view === 'root') return;
  if (history.state && history.state.rv && history.state.rv.view !== 'root') { history.back(); return; }
  go(nav.view === 'lecturer' ? { view: 'module', lecturer: null, vtab: 'lect' } : { ...ROOT, tab: nav.tab });
}

/* ------------------------------------------------------------- rendering */
function render() {
  if (!isOpen()) return;
  // A module that no longer exists (deleted / other university) -> back to the root.
  if (nav.view !== 'root' && loaded.mods && !moduleById(nav.moduleId)) nav = { ...ROOT, tab: nav.tab };
  renderHead();
  renderMain();
}

function tabsHtml(items, active) {
  const idx = Math.max(0, items.findIndex(t => t.key === active));
  return `<div class="res-tabs-in" data-n="${items.length}" data-idx="${idx}" style="--n:${items.length};--idx:${idx}">
    ${items.map(t => `<button type="button" class="res-tab${t.key === active ? ' active' : ''}" data-tab="${t.key}" role="tab" aria-selected="${t.key === active}">
      <i class="${t.icon}"></i><span>${t.label}</span>${t.count != null ? `<em>${t.count}</em>` : ''}</button>`).join('')}
    <span class="res-tab-ind"></span></div>`;
}

function itemsIn(list, moduleId) { return list.filter(x => x.moduleId === moduleId); }

function subjectPillsHtml(items) {
  const counts = new Map();
  items.forEach(i => { if (i.subjectId && subjectName(i.subjectId)) counts.set(i.subjectId, (counts.get(i.subjectId) || 0) + 1); });
  if (!counts.size) return '';
  const pills = [`<button type="button" class="res-pill${subjectId === 'all' ? ' active' : ''}" data-subject="all">All<em>${items.length}</em></button>`];
  [...counts.entries()].forEach(([id, n]) => {
    pills.push(`<button type="button" class="res-pill${subjectId === id ? ' active' : ''}" data-subject="${esc(id)}"><span class="dot" style="background:${subjectColorFor(id)}"></span>${esc(subjectName(id))}<em>${n}</em></button>`);
  });
  return pills.join('');
}

let lastTabs = {};
function renderHead() {
  const m = nav.view === 'root' ? null : moduleById(nav.moduleId);
  const isBooks = nav.tab === 'books';
  elLayoutBtn.innerHTML = `<i class="fa-solid ${layout === 'grid' ? 'fa-list' : 'fa-table-cells'}"></i>`;
  elLayoutBtn.title = layout === 'grid' ? 'Switch to list' : 'Switch to grid';
  elBack.classList.toggle('hidden', nav.view === 'root');
  elHead.classList.toggle('compact', nav.view !== 'root');

  let tabs = '', pills = '';
  if (nav.view === 'root') {
    elBrandIcon.className = 'fa-solid fa-book-open';
    elTitle.textContent = 'AResources';
    elSub.textContent = 'Books and lectures for every module';
    tabs = tabsHtml([
      { key: 'books', icon: 'fa-solid fa-book', label: 'ABooks', count: loaded.books ? BOOKS.length : null },
      { key: 'videos', icon: 'fa-solid fa-play', label: 'AVideos', count: loaded.videos ? VIDEOS.length : null }
    ], nav.tab);
  } else if (nav.view === 'module') {
    elBrandIcon.className = isBooks ? 'fa-solid fa-book' : 'fa-solid fa-play';
    elTitle.textContent = m ? m.name : (isBooks ? 'ABooks' : 'AVideos');
    if (isBooks) {
      const n = itemsIn(BOOKS, nav.moduleId).length;
      elSub.textContent = `ABooks · ${plural(n, 'book')}`;
      pills = subjectPillsHtml(itemsIn(BOOKS, nav.moduleId));
    } else {
      const vids = itemsIn(VIDEOS, nav.moduleId);
      elSub.textContent = `AVideos · ${plural(vids.length, 'video')}`;
      tabs = tabsHtml([
        { key: 'all', icon: 'fa-solid fa-play', label: 'All', count: vids.length },
        { key: 'lect', icon: 'fa-solid fa-user-graduate', label: 'Lecturers', count: groupLecturers(vids).length }
      ], nav.vtab);
      if (nav.vtab === 'all') pills = subjectPillsHtml(vids);
    }
  } else { // lecturer
    const g = groupLecturers(itemsIn(VIDEOS, nav.moduleId)).find(x => x.key === nav.lecturer);
    elBrandIcon.className = 'fa-solid fa-user-graduate';
    elTitle.textContent = g ? g.name : 'Lecturer';
    elSub.textContent = `${m ? m.name + ' · ' : ''}${plural(g ? g.videos.length : 0, 'video')}`;
  }
  elTabs.innerHTML = tabs;
  elTabs.classList.toggle('hidden', !tabs);
  const inner = elTabs.firstElementChild;
  if (inner) {   // slide the underline from the previous tab instead of jumping
    const group = nav.view + ':' + nav.tab, n = +inner.dataset.n, idx = +inner.dataset.idx;
    if (lastTabs.group === group && lastTabs.n === n && lastTabs.idx !== idx) {
      inner.style.setProperty('--idx', lastTabs.idx);
      requestAnimationFrame(() => requestAnimationFrame(() => inner.style.setProperty('--idx', idx)));
    }
    lastTabs = { group, n, idx };
  }
  elPills.innerHTML = pills;
  elPills.classList.toggle('hidden', !pills);
}

function skeleton(kind) {
  const n = kind === 'video' ? 4 : 6;
  return `<div class="res-grid res-grid-${kind}">${Array.from({ length: n }).map(() => `
    <div class="res-sk"><div class="res-sk-cover"></div><div class="res-sk-line" style="width:70%"></div><div class="res-sk-line" style="width:40%"></div></div>`).join('')}</div>`;
}

function emptyHtml(icon, title, text) {
  return `<div class="res-empty"><div class="res-empty-ico"><i class="${icon}"></i></div><h4>${esc(title)}</h4><p>${esc(text)}</p></div>`;
}

function renderMain() {
  const isBooks = nav.tab === 'books';
  elMain.className = `res-main lay-${layout}`;
  if (loadFailed && !MODS.length) {
    elMain.innerHTML = emptyHtml('fa-solid fa-signal', 'Couldn’t load resources', 'Check your connection and try again.');
    return;
  }
  if (nav.view === 'root') { renderRoot(isBooks); return; }

  const m = moduleById(nav.moduleId);
  if (!m) { elMain.innerHTML = skeleton(isBooks ? 'book' : 'video'); return; }

  if (nav.view === 'lecturer') {
    elMain.innerHTML = '<div id="resList"></div>';
    renderList();
    return;
  }
  if (!isBooks && nav.vtab === 'lect') {
    elMain.innerHTML = '<div id="resList"></div>';
    renderList();
    return;
  }
  elMain.innerHTML = `
    <label class="res-search"><i class="fa-solid fa-magnifying-glass"></i>
      <input id="resSearch" type="search" inputmode="search" autocomplete="off" placeholder="${isBooks ? 'Search books or authors…' : 'Search videos or lecturers…'}" value="${esc(query)}"></label>
    <div id="resList"></div>`;
  renderList();
}

/* root: module cards */
function moduleCoverUrl(m, list, thumbKey) {
  const own = thumbSrc(m.thumbUrl || m.imageUrl || m.image);
  if (own) return own;
  for (const it of itemsIn(list, m.id)) {
    const t = thumbKey === 'video' ? videoThumb(it) : thumbSrc(it.thumbUrl);
    if (t) return t;
  }
  return '';
}

function renderRoot(isBooks) {
  const student = getStoredStudent();
  const list = isBooks ? BOOKS : VIDEOS;
  const dataReady = loaded.mods && (isBooks ? loaded.books : loaded.videos);
  if (!dataReady && !MODS.length) { elMain.innerHTML = skeleton('module'); return; }
  if (!MODS.length) { elMain.innerHTML = emptyHtml('fa-solid fa-layer-group', 'No modules yet', 'Modules will appear here once they are added.'); return; }

  const rows = MODS.map((m, i) => {
    const items = itemsIn(list, m.id);
    const subs = new Set(items.map(x => x.subjectId).filter(Boolean)).size;
    return { m, i, n: items.length, subs, locked: isResourceLocked(m, student, 'module') };
  });
  const rank = r => (r.n ? (r.locked ? 1 : 0) : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.i - b.i);

  const total = list.length;
  const word = isBooks ? 'book' : 'video';
  const lead = `<p class="res-lead">${total
    ? `Choose a module to browse its ${isBooks ? 'books' : 'lectures'} <span>· ${plural(total, word)} available</span>`
    : (dataReady ? `No ${isBooks ? 'books' : 'videos'} have been added yet — check back soon.` : 'Loading…')}</p>`;

  elMain.innerHTML = lead + `<div class="res-grid res-grid-module">${rows.map((r, idx) => {
    const cover = moduleCoverUrl(r.m, list, isBooks ? 'book' : 'video');
    const meta = r.n
      ? `${plural(r.n, word)}${r.subs ? ` · ${plural(r.subs, 'subject')}` : ''}`
      : 'Coming soon';
    return `<button type="button" class="res-mod${r.locked ? ' locked' : ''}${r.n ? '' : ' empty'}" data-mid="${esc(r.m.id)}" style="--accent:${accentFor(r.m.id)};--i:${Math.min(idx, 14)}">
      <div class="res-mod-cover">
        ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <i class="${iconFor(r.m)} res-mod-glyph"></i>
        ${r.n ? `<span class="res-mod-count"><i class="fa-solid ${isBooks ? 'fa-book' : 'fa-play'}"></i>${r.n}</span>` : ''}
        ${r.locked ? '<span class="res-lock"><i class="fa-solid fa-lock"></i></span>' : ''}
      </div>
      <div class="res-mod-body">
        <div class="res-mod-name">${esc(r.m.name || 'Module')}</div>
        <div class="res-mod-meta">${esc(meta)}</div>
      </div>
      <i class="fa-solid fa-chevron-right res-mod-chev"></i>
    </button>`;
  }).join('')}</div>`;
}

/* module / lecturer content list (re-rendered on search) */
function groupLecturers(vids) {
  const map = new Map();
  vids.forEach(v => {
    const name = String(v.lecturer || '').trim() || 'Unknown lecturer';
    const key = norm(name);
    if (!map.has(key)) map.set(key, { key, name, photo: '', title: '', videos: [] });
    const g = map.get(key);
    g.videos.push(v);
    if (!g.photo && safeUrl(v.lecturerPhoto)) g.photo = v.lecturerPhoto;
    if (!g.title && v.lecturerTitle) g.title = v.lecturerTitle;
  });
  return [...map.values()].sort((a, b) => b.videos.length - a.videos.length || a.name.localeCompare(b.name));
}

function bookCard(b, i) {
  const t = thumbSrc(b.thumbUrl);
  const sub = subjectName(b.subjectId);
  const color = b.subjectId ? subjectColorFor(b.subjectId) : accentFor(b.moduleId);
  return `<button type="button" class="res-book" data-id="${esc(b.id)}" style="--accent:${color};--i:${Math.min(i, 14)}">
    <div class="res-book-cover">
      ${t ? `<img src="${esc(t)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="res-book-gen"><i class="fa-solid fa-book-medical"></i><span>${esc(b.title || '')}</span></div>
      <span class="res-type">${bookTypeLabel(b)}</span>
      ${isNew(b) ? '<span class="res-new">NEW</span>' : ''}
    </div>
    <div class="res-book-body">
      <div class="res-book-title">${esc(b.title || 'Untitled')}</div>
      ${b.author ? `<div class="res-book-author">${esc(b.author)}</div>` : ''}
      ${sub ? `<span class="res-tag"><span class="dot"></span>${esc(sub)}</span>` : ''}
      ${b.description ? `<div class="res-book-desc">${esc(b.description)}</div>` : ''}
    </div>
  </button>`;
}

function videoCard(v, i, { showLecturer = true } = {}) {
  const t = videoThumb(v);
  const sub = subjectName(v.subjectId);
  const color = v.subjectId ? subjectColorFor(v.subjectId) : accentFor(v.moduleId);
  return `<button type="button" class="res-vid" data-id="${esc(v.id)}" style="--accent:${color};--i:${Math.min(i, 14)}">
    <div class="res-vid-thumb">
      ${t ? `<img src="${esc(t)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="res-vid-gen"><i class="fa-solid fa-photo-video"></i></div>
      <span class="res-vid-play"><i class="fa-solid fa-play"></i></span>
      ${v.duration ? `<span class="res-vid-dur">${esc(v.duration)}</span>` : ''}
      ${isNew(v) ? '<span class="res-new">NEW</span>' : ''}
    </div>
    <div class="res-vid-body">
      <div class="res-vid-title">${esc(v.title || 'Untitled')}</div>
      ${showLecturer && v.lecturer ? `<div class="res-vid-lect"><span class="res-av sm">${safeUrl(v.lecturerPhoto) ? `<img src="${esc(thumbSrc(v.lecturerPhoto))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(v.lecturer))}</span><span>${esc(v.lecturer)}</span></div>` : ''}
      ${sub ? `<span class="res-tag"><span class="dot"></span>${esc(sub)}</span>` : ''}
      ${v.description ? `<div class="res-vid-desc">${esc(v.description)}</div>` : ''}
    </div>
  </button>`;
}

function lecturerCard(g, i) {
  return `<button type="button" class="res-lect" data-lect="${esc(g.key)}" style="--i:${Math.min(i, 14)}">
    <span class="res-av lg">${g.photo ? `<img src="${esc(thumbSrc(g.photo))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<b>${esc(initials(g.name))}</b></span>
    <div class="res-lect-body">
      <div class="res-lect-name">${esc(g.name)}</div>
      ${g.title ? `<div class="res-lect-role">${esc(g.title)}</div>` : ''}
      <div class="res-lect-count"><i class="fa-solid fa-play"></i>${plural(g.videos.length, 'video')}</div>
    </div>
    <i class="fa-solid fa-chevron-right res-mod-chev"></i>
  </button>`;
}

const matches = (it, q, fields) => !q || fields.some(f => norm(it[f]).includes(q));

function renderList({ animate = true } = {}) {
  const host = $('resList');
  if (!host) return;
  host.classList.toggle('noanim', !animate);
  const isBooks = nav.tab === 'books';
  const q = norm(query);
  const ready = isBooks ? loaded.books : loaded.videos;
  if (!ready && !(isBooks ? BOOKS : VIDEOS).length) { host.innerHTML = skeleton(isBooks ? 'book' : 'video'); return; }

  if (isBooks) {
    let items = itemsIn(BOOKS, nav.moduleId);
    if (subjectId !== 'all') items = items.filter(b => b.subjectId === subjectId);
    items = items.filter(b => matches(b, q, ['title', 'author', 'description']));
    host.innerHTML = items.length
      ? `<div class="res-grid res-grid-book">${items.map(bookCard).join('')}</div>`
      : (q || subjectId !== 'all'
        ? emptyHtml('fa-solid fa-magnifying-glass', 'No books found', 'Try a different search or subject.')
        : emptyHtml('fa-solid fa-book', 'No books yet', 'Books for this module will appear here.'));
    return;
  }

  const vids = itemsIn(VIDEOS, nav.moduleId);
  if (nav.view === 'lecturer') {
    const g = groupLecturers(vids).find(x => x.key === nav.lecturer);
    const items = g ? g.videos : [];
    host.innerHTML = items.length
      ? `<div class="res-grid res-grid-video">${items.map((v, i) => videoCard(v, i, { showLecturer: false })).join('')}</div>`
      : emptyHtml('fa-solid fa-play', 'No videos', 'This lecturer has no videos in this module yet.');
    return;
  }
  if (nav.vtab === 'lect') {
    const groups = groupLecturers(vids);
    host.innerHTML = groups.length
      ? `<p class="res-lead">${plural(groups.length, 'lecturer')} <span>· tap one to see their videos</span></p><div class="res-grid res-grid-lect">${groups.map(lecturerCard).join('')}</div>`
      : emptyHtml('fa-solid fa-user-graduate', 'No lecturers yet', 'Lecturers appear here once videos are added.');
    return;
  }
  let items = vids;
  if (subjectId !== 'all') items = items.filter(v => v.subjectId === subjectId);
  items = items.filter(v => matches(v, q, ['title', 'lecturer', 'description']));
  host.innerHTML = items.length
    ? `<div class="res-grid res-grid-video">${items.map((v, i) => videoCard(v, i)).join('')}</div>`
    : (q || subjectId !== 'all'
      ? emptyHtml('fa-solid fa-magnifying-glass', 'No videos found', 'Try a different search or subject.')
      : emptyHtml('fa-solid fa-play', 'No videos yet', 'Videos for this module will appear here.'));
}

/* --------------------------------------------------------------- events */
screen.addEventListener('error', e => {   // broken thumbnails fall back to the generated cover
  const t = e.target;
  if (t && t.tagName === 'IMG') t.remove();
}, true);

elBack.addEventListener('click', goBack);
elLayoutBtn.addEventListener('click', () => {
  layout = layout === 'grid' ? 'list' : 'grid';
  try { localStorage.setItem(LS_LAYOUT, layout); } catch (_) {}
  render();
});

elHead.addEventListener('click', e => {
  const tab = e.target.closest('.res-tab');
  if (tab) {
    const key = tab.dataset.tab;
    if (nav.view === 'root') { if (key !== nav.tab) go({ tab: key }); }
    else if (nav.view === 'module' && nav.tab === 'videos') { if (key !== nav.vtab) go({ vtab: key }); }
    return;
  }
  const pill = e.target.closest('.res-pill');
  if (pill) {
    subjectId = pill.dataset.subject || 'all';
    elPills.querySelectorAll('.res-pill').forEach(p => p.classList.toggle('active', p === pill));
    pill.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    renderList({ animate: false });
  }
});

elMain.addEventListener('input', e => {
  if (e.target && e.target.id === 'resSearch') { query = e.target.value; renderList({ animate: false }); }
});

elMain.addEventListener('click', e => {
  const mod = e.target.closest('.res-mod');
  if (mod) {
    const m = moduleById(mod.dataset.mid);
    if (!m) return;
    const student = getStoredStudent();
    if (isResourceLocked(m, student, 'module')) {
      triggerLockResponse(mod, getEffectiveLockMessage(m, 'modules', student) || 'This module is locked for you');
      return;
    }
    if (mod.classList.contains('empty')) {
      mod.classList.remove('shake'); void mod.offsetWidth; mod.classList.add('shake');
      setTimeout(() => mod.classList.remove('shake'), 500);
      return;
    }
    go({ view: 'module', moduleId: m.id, vtab: 'all', lecturer: null }, { push: true });
    return;
  }
  const lect = e.target.closest('.res-lect');
  if (lect) { go({ view: 'lecturer', lecturer: lect.dataset.lect }, { push: true }); return; }
  const book = e.target.closest('.res-book');
  if (book) { const b = BOOKS.find(x => x.id === book.dataset.id); if (b) openBook(b); return; }
  const vid = e.target.closest('.res-vid');
  if (vid) { const v = VIDEOS.find(x => x.id === vid.dataset.id); if (v) openVideo(v); }
});

/* ---------------------------------------------------- book detail sheet */
function openBook(b) {
  const url = safeUrl(b.fileUrl);
  const m = moduleById(b.moduleId);
  const sub = subjectName(b.subjectId);
  const t = thumbSrc(b.thumbUrl);
  const size = fmtSize(b.fileSize);
  elSheet.innerHTML = `
    <div class="res-sheet-card" role="dialog" aria-modal="true" aria-label="${esc(b.title || 'Book')}" style="--accent:${b.subjectId ? subjectColorFor(b.subjectId) : accentFor(b.moduleId)}">
      <button type="button" class="res-sheet-x" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      <div class="res-sheet-cover res-book-cover">
        ${t ? `<img src="${esc(t)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div class="res-book-gen"><i class="fa-solid fa-book-medical"></i><span>${esc(b.title || '')}</span></div>
      </div>
      <div class="res-sheet-info">
        <div class="res-sheet-tags">
          ${m ? `<span class="res-chip"><i class="fa-solid fa-layer-group"></i>${esc(m.name)}</span>` : ''}
          ${sub ? `<span class="res-chip"><i class="fa-solid fa-tag"></i>${esc(sub)}</span>` : ''}
          <span class="res-chip solid">${bookTypeLabel(b)}${size ? ' · ' + size : ''}</span>
        </div>
        <h3>${esc(b.title || 'Untitled')}</h3>
        ${b.author ? `<div class="res-sheet-by">by ${esc(b.author)}</div>` : ''}
        ${b.description ? `<p class="res-sheet-desc">${esc(b.description)}</p>` : ''}
        ${url
          ? `<button type="button" class="res-btn" data-read="${esc(b.id)}"><i class="fa-solid fa-book-open"></i><span>Read now</span></button>`
          : '<div class="res-sheet-note">This book’s link isn’t available yet.</div>'}
      </div>
    </div>`;
  showOverlay(elSheet, closeSheet);
}
function closeSheet() { hideOverlay(elSheet, closeSheet); }


/* ------------------------------------------------------------ book reader */
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
let pdfjsP = null, readerToken = 0, readerPdf = null, readerIO = null, readerIO2 = null;

function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsP) pdfjsP = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = PDFJS + '/pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + '/pdf.worker.min.js'; res(window.pdfjsLib); };
    sc.onerror = () => { pdfjsP = null; rej(new Error('pdf.js failed to load')); };
    document.head.appendChild(sc);
  });
  return pdfjsP;
}

function readerPlan(b) {
  const url = safeUrl(b.fileUrl);
  if (!url) return { kind: 'none' };
  const d = driveId(url);
  if (d) return { kind: 'iframe', src: `https://drive.google.com/file/d/${d}/preview`, url };
  const ext = fileExt(b.fileName || url);
  if (ext === 'pdf' || (b.sourceType === 'upload' && !ext)) return { kind: 'pdf', url };
  if (/^(docx?|pptx?|xlsx?|rtf|odt|odp|ods)$/.test(ext)) return { kind: 'iframe', src: `https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(url)}`, url };
  if (ext === 'epub') return { kind: 'unsupported' };
  return { kind: 'iframe', src: url, url, loose: true };
}

function openReader(b) {
  const plan = readerPlan(b);
  const token = ++readerToken;
  const body = plan.kind === 'pdf'
    ? '<div class="res-reader-body" id="rdBody"><div class="res-reader-msg"><i class="fa-solid fa-hourglass-half"></i><p>Opening book…</p></div></div>'
    : plan.kind === 'iframe'
      ? `<div class="res-reader-body frame"><iframe src="${esc(plan.src)}" title="${esc(b.title || 'Book')}" referrerpolicy="no-referrer"></iframe></div>${plan.loose ? '<div class="res-reader-foot">If the page stays blank, its host doesn’t allow reading inside the app.</div>' : ''}`
      : `<div class="res-reader-body"><div class="res-reader-msg"><i class="fa-solid fa-book"></i><p>${plan.kind === 'unsupported' ? 'EPUB books can’t be read in the app yet.' : 'This book’s link isn’t available yet.'}</p></div></div>`;
  elReader.innerHTML = `
    <div class="res-reader-card" role="dialog" aria-modal="true" aria-label="${esc(b.title || 'Book')}">
      <div class="res-reader-bar">
        <div class="res-reader-name">${esc(b.title || 'Book')}</div>
        ${plan.kind === 'pdf' ? '<span class="res-reader-pg" id="rdPg"></span><button type="button" class="res-sheet-x static" data-zoom="-1" aria-label="Zoom out"><i class="fa-solid fa-minus"></i></button><button type="button" class="res-sheet-x static" data-zoom="1" aria-label="Zoom in"><i class="fa-solid fa-plus"></i></button>' : ''}
        <button type="button" class="res-sheet-x static" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      ${body}
    </div>`;
  showOverlay(elReader, closeReader);
  if (plan.kind === 'pdf') renderPdf(plan, b, token);
}

function closeReader() {
  readerToken++;
  if (readerIO) readerIO.disconnect();
  if (readerIO2) readerIO2.disconnect();
  readerIO = readerIO2 = null;
  if (readerPdf) { try { readerPdf.destroy(); } catch (_) {} readerPdf = null; }
  hideOverlay(elReader, closeReader);
}

async function renderPdf(plan, b, token) {
  const body = $('rdBody');
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ url: plan.url }).promise;
    if (token !== readerToken) { pdf.destroy(); return; }
    readerPdf = pdf;
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    const ratio = vp.height / vp.width;
    body.innerHTML = '<div class="res-pages" id="rdPages"></div>';
    const wrap = $('rdPages');
    let zoom = 1;
    for (let i = 1; i <= pdf.numPages; i++) {
      const d = document.createElement('div');
      d.className = 'res-pg'; d.dataset.n = i; d.style.aspectRatio = `1 / ${ratio}`;
      wrap.appendChild(d);
    }
    const pg = $('rdPg'); if (pg) pg.textContent = `1 / ${pdf.numPages}`;
    const draw = async d => {
      if (d.dataset.busy || d.querySelector('canvas')) return;
      d.dataset.busy = '1';
      try {
        const page = await pdf.getPage(+d.dataset.n);
        if (token !== readerToken) return;
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const v = page.getViewport({ scale: (d.clientWidth / base.width) * dpr });
        const c = document.createElement('canvas');
        c.width = v.width; c.height = v.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
        if (token === readerToken) { d.appendChild(c); d.style.aspectRatio = `${c.width} / ${c.height}`; }
      } catch (_) {} finally { delete d.dataset.busy; }
    };
    readerIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) draw(e.target); }), { root: body, rootMargin: '900px 0px' });
    readerIO2 = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && pg) pg.textContent = `${e.target.dataset.n} / ${pdf.numPages}`; }), { root: body, threshold: 0.5 });
    wrap.querySelectorAll('.res-pg').forEach(d => { readerIO.observe(d); readerIO2.observe(d); });
    elReader.onclick = e => {
      const z = e.target.closest('[data-zoom]');
      if (z) {
        zoom = Math.min(3, Math.max(1, zoom + (+z.dataset.zoom) * 0.5));
        wrap.style.width = zoom * 100 + '%';
        wrap.querySelectorAll('.res-pg').forEach(d => { d.querySelector('canvas')?.remove(); readerIO.unobserve(d); readerIO.observe(d); });
        return;
      }
      if (e.target === elReader || e.target.closest('[data-close]')) closeReader();
    };
  } catch (err) {
    if (token !== readerToken) return;
    // CORS-blocked or unreadable PDF: fall back to an embedded viewer, still inside the app
    body.classList.add('frame');
    body.innerHTML = `<iframe src="https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(plan.url)}" title="${esc(b.title || 'Book')}" referrerpolicy="no-referrer"></iframe>`;
  }
}

/* ------------------------------------------------------------ video player */
function parseVideo(u, b) {
  const url = safeUrl(u);
  if (!url) return { kind: 'none' };
  const y = ytId(url);
  if (y) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${y}?autoplay=1&rel=0&modestbranding=1&playsinline=1`, url };
  const vm = vimeoParts(url);
  if (vm) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vm.id}?autoplay=1${vm.h ? '&h=' + vm.h : ''}`, url };
  const d = driveId(url);
  if (d) return { kind: 'iframe', src: `https://drive.google.com/file/d/${d}/preview`, url };
  const ext = fileExt(url);
  if (b && b.sourceType === 'upload' || /^(mp4|webm|ogg|ogv|mov|m4v)$/.test(ext)) return { kind: 'file', src: url, url };
  return { kind: 'iframe', src: url, url, loose: true };   // unknown host: try embedding it in the player
}

function openVideo(v) {
  const info = parseVideo(v.videoUrl, v);
  const t = videoThumb(v);
  let stage;
  if (info.kind === 'iframe') {
    stage = `<iframe src="${esc(info.src)}" title="${esc(v.title || 'Video')}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  } else if (info.kind === 'file') {
    stage = `<video src="${esc(info.src)}" controls autoplay playsinline controlsList="nodownload" ${t ? `poster="${esc(t)}"` : ''}></video>`;
  } else {
    stage = `<div class="res-player-fallback">${t ? `<img src="${esc(t)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div><i class="fa-solid fa-play"></i><p>This video’s link isn’t available yet.</p></div></div>`;
  }
  const sub = subjectName(v.subjectId);
  elPlayer.innerHTML = `
    <div class="res-player-card" role="dialog" aria-modal="true" aria-label="${esc(v.title || 'Video')}">
      <div class="res-player-bar"><div class="res-player-name">${esc(v.title || 'Video')}</div>
        <button type="button" class="res-sheet-x static" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="res-stage">${stage}</div>
      <div class="res-player-info">
        <h3>${esc(v.title || 'Untitled')}</h3>
        <div class="res-player-meta">
          ${v.lecturer ? `<span class="res-vid-lect"><span class="res-av sm">${safeUrl(v.lecturerPhoto) ? `<img src="${esc(thumbSrc(v.lecturerPhoto))}" alt="" referrerpolicy="no-referrer">` : esc(initials(v.lecturer))}</span><span>${esc(v.lecturer)}</span></span>` : ''}
          ${sub ? `<span class="res-chip"><i class="fa-solid fa-tag"></i>${esc(sub)}</span>` : ''}
          ${v.duration ? `<span class="res-chip"><i class="fa-solid fa-clock"></i>${esc(v.duration)}</span>` : ''}
        </div>
        ${v.description ? `<p class="res-sheet-desc">${esc(v.description)}</p>` : ''}
        ${info.loose ? '<p class="res-sheet-note">If the video stays blank, its host doesn’t allow playing inside the app — ask your admin to re-add it as a YouTube, Vimeo, Drive or uploaded video.</p>' : ''}
      </div>
    </div>`;
  showOverlay(elPlayer, closePlayer);
}
function closePlayer() { hideOverlay(elPlayer, closePlayer); }

/* if anything else takes over the screen, tear down the sheet / player (stops playback) */
new MutationObserver(() => { if (!isOpen()) { closeReader(); closeSheet(); closePlayer(); } })
  .observe(screen, { attributes: true, attributeFilter: ['class'] });

/* shared overlay plumbing (back button / Esc / backdrop all close it) */
function showOverlay(el, closer) {
  const was = el.classList.contains('show');
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.classList.add('show');
  if (!was) pushModalState(closer);
}
function hideOverlay(el, closer) {
  if (!el || !el.classList.contains('show')) return;
  el.classList.remove('show');
  el.classList.add('hidden');
  el.innerHTML = '';          // also stops any playing iframe / <video>
  popModalState(closer);
}
[[elSheet, closeSheet], [elPlayer, closePlayer], [elReader, closeReader]].forEach(([el, closer]) => {
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) closer(); });
});
elSheet.addEventListener('click', e => {
  const r = e.target.closest('[data-read]');
  if (r) { const b = BOOKS.find(x => x.id === r.dataset.read); if (b) openReader(b); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (elReader.classList.contains('show')) closeReader();
  else if (elPlayer.classList.contains('show')) closePlayer();
  else if (elSheet.classList.contains('show')) closeSheet();
});
