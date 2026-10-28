/* In-app book reader. mountReader() renders into any host element, so the same
   reader works full-screen (from the library) and inside the video player's panel. */
import { driveId, esc, fileExt, safeUrl } from './resources-util.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
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

/* opts: { back: bool (arrow instead of ×), onClose } -> { destroy() } */
export function mountReader(host, b, { back = false, onClose } = {}) {
  const plan = readerPlan(b);
  let dead = false, pdf = null, io1 = null, io2 = null;
  const body = plan.kind === 'pdf'
    ? '<div class="res-reader-body" data-body><div class="res-reader-msg"><i class="fa-solid fa-hourglass-half"></i><p>Opening book…</p></div></div>'
    : plan.kind === 'iframe'
      ? `<div class="res-reader-body frame"><iframe src="${esc(plan.src)}" title="${esc(b.title || 'Book')}" referrerpolicy="no-referrer"></iframe></div>${plan.loose ? '<div class="res-reader-foot">If the page stays blank, its host doesn’t allow reading inside the app.</div>' : ''}`
      : `<div class="res-reader-body"><div class="res-reader-msg"><i class="fa-solid fa-book"></i><p>${plan.kind === 'unsupported' ? 'EPUB books can’t be read in the app yet.' : 'This book’s link isn’t available yet.'}</p></div></div>`;
  host.innerHTML = `
    <div class="res-reader-card${back ? ' in-panel' : ''}" role="dialog" aria-label="${esc(b.title || 'Book')}">
      <div class="res-reader-bar">
        ${back ? '<button type="button" class="res-sheet-x static" data-close aria-label="Back to list"><i class="fa-solid fa-arrow-left"></i></button>' : ''}
        <div class="res-reader-name">${esc(b.title || 'Book')}</div>
        ${plan.kind === 'pdf' ? '<span class="res-reader-pg" data-pg></span><button type="button" class="res-sheet-x static" data-zoom="-1" aria-label="Zoom out"><i class="fa-solid fa-minus"></i></button><button type="button" class="res-sheet-x static" data-zoom="1" aria-label="Zoom in"><i class="fa-solid fa-plus"></i></button>' : ''}
        ${back ? '' : '<button type="button" class="res-sheet-x static" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>'}
      </div>
      ${body}
    </div>`;

  let zoom = 1, wrap = null;
  const onClick = e => {
    if (e.target.closest('[data-close]')) { if (onClose) onClose(); return; }
    const z = e.target.closest('[data-zoom]');
    if (z && wrap && io1) {
      zoom = Math.min(3, Math.max(1, zoom + (+z.dataset.zoom) * 0.5));
      wrap.style.width = zoom * 100 + '%';
      wrap.querySelectorAll('.res-pg').forEach(d => { d.querySelector('canvas')?.remove(); io1.unobserve(d); io1.observe(d); });
    }
  };
  host.addEventListener('click', onClick);

  async function renderPdf() {
    const bodyEl = host.querySelector('[data-body]');
    try {
      const lib = await loadPdfjs();
      const doc = await lib.getDocument({ url: plan.url }).promise;
      if (dead) { doc.destroy(); return; }
      pdf = doc;
      const first = await doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      bodyEl.innerHTML = '<div class="res-pages"></div>';
      wrap = bodyEl.firstElementChild;
      for (let i = 1; i <= doc.numPages; i++) {
        const d = document.createElement('div');
        d.className = 'res-pg'; d.dataset.n = i; d.style.aspectRatio = `1 / ${vp.height / vp.width}`;
        wrap.appendChild(d);
      }
      const pg = host.querySelector('[data-pg]'); if (pg) pg.textContent = `1 / ${doc.numPages}`;
      const draw = async d => {
        if (d.dataset.busy || d.querySelector('canvas')) return;
        d.dataset.busy = '1';
        try {
          const page = await doc.getPage(+d.dataset.n);
          if (dead) return;
          const base = page.getViewport({ scale: 1 });
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const v = page.getViewport({ scale: (d.clientWidth / base.width) * dpr });
          const c = document.createElement('canvas');
          c.width = v.width; c.height = v.height;
          await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
          if (!dead) { d.appendChild(c); d.style.aspectRatio = `${c.width} / ${c.height}`; }
        } catch (_) {} finally { delete d.dataset.busy; }
      };
      io1 = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) draw(e.target); }), { root: bodyEl, rootMargin: '900px 0px' });
      io2 = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && pg) pg.textContent = `${e.target.dataset.n} / ${doc.numPages}`; }), { root: bodyEl, threshold: 0.5 });
      wrap.querySelectorAll('.res-pg').forEach(d => { io1.observe(d); io2.observe(d); });
    } catch (_) {
      if (dead) return;
      // CORS-blocked / unreadable PDF: fall back to an embedded viewer, still inside the app
      bodyEl.classList.add('frame');
      bodyEl.innerHTML = `<iframe src="https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(plan.url)}" title="${esc(b.title || 'Book')}" referrerpolicy="no-referrer"></iframe>`;
    }
  }
  if (plan.kind === 'pdf') renderPdf();

  return {
    destroy() {
      dead = true;
      host.removeEventListener('click', onClick);
      if (io1) io1.disconnect();
      if (io2) io2.disconnect();
      if (pdf) { try { pdf.destroy(); } catch (_) {} }
    }
  };
}
