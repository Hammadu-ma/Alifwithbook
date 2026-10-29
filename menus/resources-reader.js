/* ========================================================================
   ALIF Med — In-app book reader
   ------------------------------------------------------------------------
   PDFs are drawn natively with pdf.js:
     · Paper / Sepia / Night reading themes
     · Scroll or single-page layout (swipe, tap the edges, arrow keys)
     · Zoom, jump-to-page, page slider, resume where you stopped
     · Contents (PDF outline), bookmarks, full-text search
     · Toolbars hide while you read; screen stays awake
   Nothing here can send the student out of the app: there are no links, and
   every embedded viewer is sandboxed without pop-ups or top-level navigation.
   ======================================================================== */
import { driveId, esc, fileExt, safeUrl } from './resources-util.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
export const SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-forms';   // no popups, no top navigation
let pdfjsP = null;

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

export function readerPlan(b) {
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

/* ------------------------------------------------------------- icons */
const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>',
  aa: '<svg viewBox="0 0 24 24" fill="currentColor"><text x="1" y="18" font-size="17" font-weight="800" font-family="Georgia,serif">A</text><text x="13" y="18" font-size="11" font-weight="800" font-family="Georgia,serif">a</text></svg>',
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z"/></svg>',
  markOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  scroll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9.5 8h5M9.5 12h5M9.5 16h3"/></svg>',
  pages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="8" height="14" rx="1.6"/><rect x="13" y="5" width="8" height="14" rx="1.6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>'
};

/* ------------------------------------------------------------- prefs */
const PREF_KEY = 'alif_rd_prefs_v1';
const DEF = { theme: 'paper', mode: 'scroll', zoom: 1 };
const loadPrefs = () => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(PREF_KEY)) || {}) }; } catch (_) { return { ...DEF }; } };
const savePrefs = p => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (_) {} };
const getJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
const setJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

/* sandboxed iframe markup (can never open a pop-out / new tab) */
export const frameHtml = (src, title) => `<iframe src="${esc(src)}" title="${esc(title)}" sandbox="${SANDBOX}" referrerpolicy="no-referrer"></iframe>`;

/* opts: { back: bool (compact, inside the video panel), onClose } -> { destroy() } */
export function mountReader(host, b, { back = false, onClose } = {}) {
  const plan = readerPlan(b);
  const compact = back;
  const key = String(b.id || b.fileUrl || b.title);
  const KEY_POS = 'alif_rd_pos_' + key, KEY_BM = 'alif_rd_bm_' + key;
  const prefs = loadPrefs();

  const topBtn = (act, icon, label) => `<button type="button" class="rd-btn" data-act="${act}" aria-label="${label}">${icon}</button>`;
  const lead = back ? topBtn('close', I.back, 'Back') : topBtn('close', I.close, 'Close');
  const titleHtml = `<div class="rd-title"><b>${esc(b.title || 'Book')}</b>${b.author ? `<span>${esc(b.author)}</span>` : ''}</div>`;

  /* ------------------------------------------------ non-PDF kinds */
  if (plan.kind !== 'pdf') {
    const body = plan.kind === 'iframe'
      ? `<div class="rd-frame">${frameHtml(plan.src, b.title || 'Book')}<div class="rd-frame-guard"></div></div>${plan.loose ? '<div class="rd-note">If the page stays blank, its host doesn’t allow reading inside the app.</div>' : ''}`
      : `<div class="rd-msg"><div class="rd-msg-ico"><i class="fa-solid fa-book"></i></div><p>${plan.kind === 'unsupported' ? 'EPUB books can’t be read in the app yet.' : 'This book’s link isn’t available yet.'}</p></div>`;
    host.innerHTML = `<div class="rd plain${compact ? ' in-panel' : ''}" data-theme="paper"><div class="rd-top">${lead}${titleHtml}</div>${body}</div>`;
    const onC = e => { if (e.target.closest('a[href]')) e.preventDefault(); else if (e.target.closest('[data-act=close]') && onClose) onClose(); };
    host.addEventListener('click', onC);
    return { destroy() { host.removeEventListener('click', onC); } };
  }

  /* ------------------------------------------------ PDF reader */
  host.innerHTML = `
    <div class="rd${compact ? ' in-panel' : ''}" data-theme="${esc(prefs.theme)}" data-rd>
      <div class="rd-top">
        ${lead}
        ${titleHtml}
        <div class="rd-chip" role="button" tabindex="0" data-act="jump" aria-label="Jump to page"><span data-chip>–</span><input type="number" class="rd-jump" data-jumpin min="1" inputmode="numeric"></div>
        ${topBtn('mark', I.mark, 'Bookmark this page')}
        ${topBtn('toc', I.list, 'Contents, bookmarks and search')}
        ${topBtn('set', I.aa, 'Reading settings')}
      </div>
      <div class="rd-stage" data-stage tabindex="0"></div>
      <div class="rd-bottom"><span class="rd-pg-l" data-lbl>–</span><input type="range" class="rd-slider" min="1" max="1" value="1" data-slider aria-label="Page"><span class="rd-pct" data-pct></span></div>
      <button type="button" class="rd-edge l hidden" data-act="prev" aria-label="Previous page">${I.prev}</button>
      <button type="button" class="rd-edge r hidden" data-act="next" aria-label="Next page">${I.next}</button>
      <div class="rd-pop hidden" data-pop>
        <div class="rd-pop-row"><span>Theme</span>
          <div class="rd-seg" data-seg="theme"><button type="button" data-v="paper"><i style="background:#fff"></i>Paper</button><button type="button" data-v="sepia"><i style="background:#f1e4c3"></i>Sepia</button><button type="button" data-v="night"><i style="background:#14191a"></i>Night</button></div></div>
        <div class="rd-pop-row"><span>Layout</span>
          <div class="rd-seg" data-seg="mode"><button type="button" data-v="scroll">${I.scroll} Scroll</button><button type="button" data-v="page">${I.pages} Pages</button></div></div>
        <div class="rd-pop-row"><span>Zoom</span>
          <div class="rd-zoom"><button type="button" data-act="zout" aria-label="Zoom out">${I.minus}</button><b data-zv>100%</b><button type="button" data-act="zin" aria-label="Zoom in">${I.plus}</button><button type="button" data-act="zfit" class="fit">Fit</button></div></div>
      </div>
      <div class="rd-drawer hidden" data-drawer>
        <div class="rd-drawer-top"><div class="rd-seg tabs" data-seg="dtab"><button type="button" data-v="toc">Contents</button><button type="button" data-v="bm">Bookmarks</button><button type="button" data-v="find">Search</button></div>
          <button type="button" class="rd-btn" data-act="dclose" aria-label="Close panel">${I.close}</button></div>
        <div class="rd-drawer-body" data-dbody></div>
      </div>
      <div class="rd-load" data-load><div class="rd-load-card"><div class="rd-load-book"><i></i><i></i><i></i></div><p data-loadmsg>Opening book…</p><div class="rd-load-bar"><i data-loadbar></i></div></div></div>
    </div>`;

  const $ = s => host.querySelector(s);
  const root = $('[data-rd]'), stage = $('[data-stage]'), chip = $('[data-chip]'), slider = $('[data-slider]');
  const lbl = $('[data-lbl]'), pct = $('[data-pct]'), pop = $('[data-pop]'), drawer = $('[data-drawer]'), dbody = $('[data-dbody]');
  const jin = $('[data-jumpin]'), chipBox = $('.rd-chip'), markBtn = $('[data-act=mark]');
  const offs = [];
  const on = (t, e, f, o) => { t.addEventListener(e, f, o); offs.push(() => t.removeEventListener(e, f, o)); };

  let dead = false, pdf = null, n = 0, cur = 1, mode = prefs.mode, theme = prefs.theme, zoom = prefs.zoom;
  let epoch = 0, io1 = null, io2 = null, ratio = 1.414, bmarks = new Set(getJSON(KEY_BM, []));
  let outline = null, dtab = 'toc', wake = null, saveT = 0, uiHidden = false, jumping = false;
  const vis = new Map(), texts = new Map(), cache = new Map();
  let bw = 595, bh = 842;

  const savePos = () => { clearTimeout(saveT); saveT = setTimeout(() => setJSON(KEY_POS, cur), 350); };
  const persist = () => savePrefs({ theme, mode, zoom });
  const stageW = () => stage.clientWidth || 360;
  const stageH = () => stage.clientHeight || 600;

  function setUi(show) {
    if (compact) return;
    uiHidden = !show; root.classList.toggle('hide-ui', uiHidden);
    if (uiHidden) pop.classList.add('hidden');
  }
  function applyTheme() {
    root.dataset.theme = theme;
    host.querySelectorAll('[data-seg=theme] button').forEach(x => x.classList.toggle('on', x.dataset.v === theme));
  }
  function applyModeUi() {
    host.querySelectorAll('[data-seg=mode] button').forEach(x => x.classList.toggle('on', x.dataset.v === mode));
    root.dataset.mode = mode;
    host.querySelectorAll('.rd-edge').forEach(e => e.classList.toggle('hidden', mode !== 'page'));
    $('[data-zv]').textContent = Math.round(zoom * 100) + '%';
  }
  function setCur(p, { silent } = {}) {
    p = Math.min(n || 1, Math.max(1, p));
    cur = p;
    chip.textContent = `${p} / ${n}`;
    lbl.textContent = `Page ${p}`;
    pct.textContent = n > 1 ? Math.round(((p - 1) / (n - 1)) * 100) + '%' : '100%';
    slider.value = p; slider.style.setProperty('--p', n > 1 ? ((p - 1) / (n - 1)) * 100 : 100);
    const marked = bmarks.has(p);
    markBtn.innerHTML = marked ? I.markOn : I.mark; markBtn.classList.toggle('on', marked);
    if (!silent) savePos();
  }

  /* ----- rendering ----- */
  async function renderCanvas(num, cssW) {
    const page = await pdf.getPage(num);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.min((cssW / base.width) * dpr, Math.sqrt(14e6 / (base.width * base.height)));   // cap canvas memory
    const v = page.getViewport({ scale: px });
    const c = document.createElement('canvas');
    c.width = Math.floor(v.width); c.height = Math.floor(v.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    return { canvas: c, ratio: base.height / base.width };
  }
  const scrollW = () => Math.max(150, Math.min(stageW() - (compact ? 14 : 28), compact ? 1400 : 980) * zoom);
  const fitScale = () => Math.min((stageW() - 24) / bw, (stageH() - 24) / bh);

  function layout(keep = cur) {
    epoch++;
    const my = epoch;
    if (io1) io1.disconnect(); if (io2) io2.disconnect();
    vis.clear(); cache.clear();
    stage.innerHTML = '';
    stage.scrollTo(0, 0);
    applyModeUi();
    if (mode === 'scroll') {
      const wrap = document.createElement('div');
      wrap.className = 'rd-pages'; wrap.style.width = scrollW() + 'px';
      for (let i = 1; i <= n; i++) {
        const d = document.createElement('div');
        d.className = 'rd-pg'; d.dataset.n = i; d.style.aspectRatio = `1 / ${ratio}`;
        d.innerHTML = `<span class="rd-pg-n">${i}</span>`;
        wrap.appendChild(d);
      }
      stage.appendChild(wrap);
      const draw = async d => {
        if (d.dataset.busy || d.querySelector('canvas')) return;
        d.dataset.busy = '1';
        try {
          const r = await renderCanvas(+d.dataset.n, d.clientWidth);
          if (!dead && my === epoch) { d.appendChild(r.canvas); d.style.aspectRatio = `${r.canvas.width} / ${r.canvas.height}`; d.classList.add('done'); }
        } catch (_) {} finally { delete d.dataset.busy; }
      };
      io1 = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) draw(e.target); }), { root: stage, rootMargin: '1100px 0px' });
      io2 = new IntersectionObserver(es => {
        es.forEach(e => vis.set(+e.target.dataset.n, e.isIntersecting ? e.intersectionRatio : 0));
        let best = cur, br = -1;
        vis.forEach((r, k) => { if (r > br || (r === br && k < best)) { br = r; best = k; } });
        if (br > 0 && best !== cur && !jumping) setCur(best);
      }, { root: stage, threshold: [0, .15, .3, .5, .7, .9, 1] });
      wrap.querySelectorAll('.rd-pg').forEach(d => { io1.observe(d); io2.observe(d); });
      goTo(keep, true);
    } else {
      showPage(keep, 0);
    }
  }

  function goTo(p, instant) {
    p = Math.min(n, Math.max(1, p));
    if (mode === 'page') { showPage(p, p >= cur ? 1 : -1); return; }
    const el = stage.querySelector(`.rd-pg[data-n="${p}"]`);
    if (!el) { setCur(p); return; }
    jumping = true; setCur(p);
    const pad = parseFloat(getComputedStyle(stage).paddingTop) || 0;      // clear the floating toolbar
    const top = el.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop - pad + 2;
    stage.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' });
    setTimeout(() => { jumping = false; }, instant ? 80 : 700);
  }

  let showToken = 0;
  async function showPage(p, dir) {
    p = Math.min(n, Math.max(1, p));
    const my = ++showToken, ep = epoch;
    setCur(p);
    const w = Math.max(120, bw * fitScale() * zoom);
    const ck = `${p}@${Math.round(w)}`;
    let holder = stage.querySelector('.rd-single');
    if (!holder) { stage.innerHTML = ''; holder = document.createElement('div'); holder.className = 'rd-single'; stage.appendChild(holder); }
    let item = cache.get(ck);
    if (!item) {
      holder.classList.add('busy');
      try { item = await renderCanvas(p, w); } catch (_) { return; }
      if (dead || my !== showToken || ep !== epoch) return;
      cache.set(ck, item);
      if (cache.size > 6) cache.delete(cache.keys().next().value);
    }
    holder.classList.remove('busy');
    const pg = document.createElement('div');
    pg.className = 'rd-pg done single' + (dir > 0 ? ' in-r' : dir < 0 ? ' in-l' : '');
    pg.style.width = w + 'px';
    pg.style.aspectRatio = `${item.canvas.width} / ${item.canvas.height}`;
    item.canvas.style.width = '100%';
    pg.appendChild(item.canvas);
    holder.replaceChildren(pg);
    stage.scrollTo(0, 0);
    [p + 1, p - 1].forEach(q => {      // warm the neighbours so flipping is instant
      const k = `${q}@${Math.round(w)}`;
      if (q >= 1 && q <= n && !cache.has(k)) renderCanvas(q, w).then(r => { if (ep === epoch && !dead) cache.set(k, r); }).catch(() => {});
    });
  }

  const next = () => goTo(cur + 1), prev = () => goTo(cur - 1);
  function setZoom(z) { zoom = Math.min(3, Math.max(0.6, Math.round(z * 100) / 100)); persist(); layout(cur); }

  /* ----- drawer: contents / bookmarks / search ----- */
  function openDrawer(tab) {
    if (tab) dtab = tab;
    pop.classList.add('hidden');
    drawer.classList.remove('hidden'); requestAnimationFrame(() => drawer.classList.add('show'));
    renderDrawer();
  }
  function closeDrawer() { drawer.classList.remove('show'); setTimeout(() => { if (!drawer.classList.contains('show')) drawer.classList.add('hidden'); }, 220); }
  let lastQuery = '', lastResults = '', searchTok = 0;
  function renderDrawer() {
    host.querySelectorAll('[data-seg=dtab] button').forEach(x => x.classList.toggle('on', x.dataset.v === dtab));
    if (dtab === 'toc') {
      if (outline === null) { dbody.innerHTML = '<div class="rd-empty">Loading contents…</div>'; return; }
      dbody.innerHTML = outline.length
        ? outline.map((o, i) => `<button type="button" class="rd-toc" style="--d:${o.depth}" data-toc="${i}"><span>${esc(o.title)}</span></button>`).join('')
        : '<div class="rd-empty"><b>No table of contents</b><p>This book has no chapter list. Use the page slider or search.</p></div>';
    } else if (dtab === 'bm') {
      const list = [...bmarks].sort((a, c) => a - c);
      dbody.innerHTML = list.length
        ? list.map(p => `<div class="rd-bm"><button type="button" data-goto="${p}"><i>${I.markOn}</i><span>Page ${p}</span></button><button type="button" class="rd-bm-x" data-unmark="${p}" aria-label="Remove bookmark">${I.close}</button></div>`).join('')
        : '<div class="rd-empty"><b>No bookmarks yet</b><p>Tap the bookmark icon to save a page.</p></div>';
    } else {
      dbody.innerHTML = `<form class="rd-find" data-find><span>${I.search}</span><input type="search" placeholder="Search in this book…" data-q autocomplete="off" inputmode="search"><button type="submit" class="rd-go">Go</button></form><div data-results class="rd-results"></div>`;
      const q = dbody.querySelector('[data-q]'); if (lastQuery) q.value = lastQuery;
      if (lastResults) dbody.querySelector('[data-results]').innerHTML = lastResults;
      setTimeout(() => q.focus(), 80);
    }
  }
  async function search(q) {
    q = q.trim(); lastQuery = q;
    const out = dbody.querySelector('[data-results]');
    if (!q) { out.innerHTML = ''; lastResults = ''; return; }
    const my = ++searchTok, ql = q.toLowerCase();
    let found = 0, html = '';
    out.innerHTML = '<div class="rd-empty small">Searching…</div>';
    for (let p = 1; p <= n; p++) {
      if (dead || my !== searchTok) return;
      let t = texts.get(p);
      if (t == null) { try { t = (await (await pdf.getPage(p)).getTextContent()).items.map(i => i.str).join(' ').replace(/\s+/g, ' '); } catch (_) { t = ''; } texts.set(p, t); }
      const lo = t.toLowerCase();
      let from = 0, per = 0, at;
      while (per < 3 && found < 150 && (at = lo.indexOf(ql, from)) >= 0) {
        const s = Math.max(0, at - 36), e = Math.min(t.length, at + q.length + 54);
        html += `<button type="button" class="rd-hit" data-goto="${p}"><b>p. ${p}</b><span>${s > 0 ? '…' : ''}${esc(t.slice(s, at))}<mark>${esc(t.slice(at, at + q.length))}</mark>${esc(t.slice(at + q.length, e))}${e < t.length ? '…' : ''}</span></button>`;
        found++; per++; from = at + q.length;
      }
      if (p % 5 === 0 && p < n && out.isConnected) out.innerHTML = html + `<div class="rd-empty small">Searching… page ${p} of ${n} · ${found} found</div>`;
    }
    lastResults = found ? `<p class="rd-count">${found}${found >= 150 ? '+' : ''} result${found === 1 ? '' : 's'}</p>${html}` : '<div class="rd-empty"><b>No results</b><p>Try another word.</p></div>';
    if (out.isConnected) out.innerHTML = lastResults;
  }
  async function jumpToOutline(i) {
    const o = outline && outline[i]; if (!o) return;
    try {
      let dest = o.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (Array.isArray(dest)) { const idx = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : +dest[0]; closeDrawer(); goTo(idx + 1); }
    } catch (_) {}
  }
  async function loadOutline() {
    try {
      const raw = await pdf.getOutline();
      outline = [];
      const walk = (items, depth) => (items || []).forEach(it => { outline.push({ title: it.title || '—', dest: it.dest, depth: Math.min(depth, 3) }); walk(it.items, depth + 1); });
      walk(raw, 0);
    } catch (_) { outline = []; }
    if (!drawer.classList.contains('hidden') && dtab === 'toc') renderDrawer();
  }

  /* ----- events ----- */
  const endJump = go => { const v = +jin.value; chipBox.classList.remove('editing'); if (go && v) goTo(v); };
  on(jin, 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); endJump(true); } else if (e.key === 'Escape') { e.stopPropagation(); endJump(false); } });
  on(jin, 'blur', () => endJump(false));

  on(host, 'click', e => {
    if (e.target.closest('a[href]')) { e.preventDefault(); return; }           // nothing may leave the app
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { if (onClose) onClose(); return; }
    if (act === 'next') return next();
    if (act === 'prev') return prev();
    if (act === 'zin') return setZoom(zoom + 0.25);
    if (act === 'zout') return setZoom(zoom - 0.25);
    if (act === 'zfit') return setZoom(1);
    if (act === 'set') { if (drawer.classList.contains('show')) closeDrawer(); pop.classList.toggle('hidden'); return; }
    if (act === 'toc') { pop.classList.add('hidden'); drawer.classList.contains('show') ? closeDrawer() : openDrawer(); return; }
    if (act === 'dclose') return closeDrawer();
    if (act === 'mark') { bmarks.has(cur) ? bmarks.delete(cur) : bmarks.add(cur); setJSON(KEY_BM, [...bmarks]); setCur(cur, { silent: true }); if (dtab === 'bm' && drawer.classList.contains('show')) renderDrawer(); return; }
    if (act === 'jump') {
      if (chipBox.classList.contains('editing')) return;
      chipBox.classList.add('editing'); jin.max = n; jin.value = cur; jin.focus(); jin.select(); return;
    }
    const seg = e.target.closest('[data-seg] button[data-v]');
    if (seg) {
      const kind = seg.closest('[data-seg]').dataset.seg, v = seg.dataset.v;
      if (kind === 'theme') { theme = v; applyTheme(); persist(); }
      else if (kind === 'mode') { if (v !== mode) { mode = v; persist(); layout(cur); } }
      else if (kind === 'dtab') { dtab = v; renderDrawer(); }
      return;
    }
    const toc = e.target.closest('[data-toc]'); if (toc) { jumpToOutline(+toc.dataset.toc); return; }
    const g = e.target.closest('[data-goto]'); if (g) { closeDrawer(); goTo(+g.dataset.goto); return; }
    const um = e.target.closest('[data-unmark]');
    if (um) { bmarks.delete(+um.dataset.unmark); setJSON(KEY_BM, [...bmarks]); setCur(cur, { silent: true }); renderDrawer(); return; }
    if (e.target.closest('[data-stage]')) {                                   // tap on the page
      if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
      if (drawer.classList.contains('show')) { closeDrawer(); return; }
      if (mode === 'page') {
        const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
        if (x < 0.28) return prev();
        if (x > 0.72) return next();
      }
      setUi(uiHidden);
    }
  });
  on(host, 'submit', e => { if (e.target.matches('[data-find]')) { e.preventDefault(); search(e.target.querySelector('[data-q]').value); } });
  on(host, 'input', e => { if (e.target.matches('[data-slider]')) { const p = +e.target.value; goTo(p, true); savePos(); } });

  // toolbars: hide while scrolling down, back when scrolling up
  let lastTop = 0;
  on(stage, 'scroll', () => {
    if (compact || mode !== 'scroll' || jumping) { lastTop = stage.scrollTop; return; }
    const t = stage.scrollTop, d = t - lastTop;
    if (Math.abs(d) > 14) { setUi(d < 0 || t < 40); lastTop = t; }
  }, { passive: true });

  // swipe to turn pages
  let sx = 0, sy = 0, st = 0;
  on(stage, 'touchstart', e => { if (mode !== 'page' || e.touches.length !== 1) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }, { passive: true });
  on(stage, 'touchend', e => {
    if (mode !== 'page' || !e.changedTouches.length || zoom > 1.05) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Date.now() - st < 600 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) { dx < 0 ? next() : prev(); }
  }, { passive: true });

  on(stage, 'wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.15 : -0.15)); } }, { passive: false });
  on(document, 'keydown', e => {                       // capture phase: runs before the app's own Esc handler
    if (!host.isConnected) return;
    if (e.key === 'Escape') {
      if (drawer.classList.contains('show')) { e.stopImmediatePropagation(); closeDrawer(); }
      else if (!pop.classList.contains('hidden')) { e.stopImmediatePropagation(); pop.classList.add('hidden'); }
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (compact && !host.contains(document.activeElement)) return;
    if (mode === 'page') {
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
    }
    if (e.key === '+' || e.key === '=') setZoom(zoom + 0.25);
    else if (e.key === '-') setZoom(zoom - 0.25);
    else if (e.key === 'Home') goTo(1);
    else if (e.key === 'End') goTo(n);
  }, true);

  // re-layout on rotation / resize
  let rzT = 0, lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = stage.clientWidth;
    if (!n || Math.abs(w - lastW) < 8) { lastW = w; return; }
    lastW = w; clearTimeout(rzT); rzT = setTimeout(() => !dead && layout(cur), 180);
  });
  ro.observe(stage);
  offs.push(() => ro.disconnect());

  // keep the screen awake while reading (full-screen reader only)
  const keepAwake = async () => { try { if (!compact && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (_) {} };
  keepAwake();
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && !dead) keepAwake(); });

  function toast(t) {
    const el = document.createElement('div'); el.className = 'rd-toast'; el.textContent = t; root.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2200); setTimeout(() => el.remove(), 2700);
  }
  applyTheme(); applyModeUi();

  /* ----- open the document ----- */
  (async () => {
    const loadbar = $('[data-loadbar]'), msg = $('[data-loadmsg]');
    try {
      const lib = await loadPdfjs();
      const task = lib.getDocument({ url: plan.url });
      task.onProgress = p => { if (p.total) { const v = Math.round((p.loaded / p.total) * 100); loadbar.style.width = v + '%'; msg.textContent = `Opening book… ${v}%`; } };
      const doc = await task.promise;
      if (dead) { doc.destroy(); return; }
      pdf = doc; n = doc.numPages;
      const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
      bw = vp.width; bh = vp.height; ratio = bh / bw;
      slider.max = n; lastW = stage.clientWidth;
      const saved = Math.min(n, Math.max(1, +getJSON(KEY_POS, 1) || 1));
      layout(saved);
      const ld = $('[data-load]'); ld.classList.add('gone'); setTimeout(() => ld.remove(), 350);
      if (saved > 1) toast(`Continued from page ${saved}`);
      loadOutline();
      stage.focus({ preventScroll: true });
    } catch (_) {
      if (dead) return;
      // CORS-blocked / unreadable PDF: fall back to an embedded (sandboxed) viewer, still inside the app
      root.classList.add('plain'); root.classList.remove('hide-ui');
      root.innerHTML = `<div class="rd-top">${lead}${titleHtml}</div><div class="rd-frame">${frameHtml(`https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(plan.url)}`, b.title || 'Book')}<div class="rd-frame-guard"></div></div>`;
    }
  })();

  return {
    destroy() {
      dead = true; clearTimeout(saveT); clearTimeout(rzT); searchTok++;
      if (n) setJSON(KEY_POS, cur);
      offs.forEach(f => f());
      if (io1) io1.disconnect(); if (io2) io2.disconnect();
      if (pdf) { try { pdf.destroy(); } catch (_) {} }
      if (wake) { try { wake.release(); } catch (_) {} }
    }
  };
}
