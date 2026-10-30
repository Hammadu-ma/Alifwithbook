/* ========================================================================
   Runs the app's REAL quiz screen (quiz-engine.js) inside the video panel.
   The quiz screen element is moved into the panel, its sidebars/topbar are
   hidden (CSS: #appScreen.embedded), and a slim bar of our own exposes the
   things that live in that sidebar: search, categories, bookmarks, submit.
   "Full screen" hands the same running quiz back to the normal quiz screen.
   Progress and results are saved exactly like a quiz started from Exams.
   ======================================================================== */
import { appScreen, homeScreen, pickerScreen } from './gate-screen.js';
import { launchQuiz } from './quiz-engine.js';
import { esc } from './resources-util.js';

const ico = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  back: ico('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  search: ico('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  cats: ico('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  mark: ico('<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z"/>'),
  submit: ico('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  full: ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')
};

/* payload: { subjectId, quizId, subjectName, quizName, questions }
   hooks:   { onBack(), onFull() }  ->  { destroy(), release() } */
export function mountEmbeddedQuiz(host, payload, { onBack, onFull } = {}) {
  const origParent = appScreen.parentNode, origNext = appScreen.nextSibling;
  let released = false, destroyed = false;

  host.innerHTML = `
    <div class="rqe">
      <div class="rqe-bar">
        <button type="button" class="rqe-btn" data-e="back" aria-label="Back to quizzes">${I.back}</button>
        <div class="rqe-title"><b>${esc(payload.quizName || 'Quiz')}</b><span>${esc(payload.subjectName || '')}</span></div>
        <button type="button" class="rqe-btn" data-e="search" aria-label="Search questions">${I.search}</button>
        <button type="button" class="rqe-btn" data-e="cats" aria-label="Categories">${I.cats}</button>
        <button type="button" class="rqe-btn" data-e="marks" aria-label="Bookmarks">${I.mark}</button>
        <button type="button" class="rqe-btn go" data-e="submit" aria-label="Submit quiz">${I.submit}</button>
        <button type="button" class="rqe-btn" data-e="full" aria-label="Open in full-screen quiz">${I.full}</button>
      </div>
      <div class="rqe-find hidden" data-find><input type="search" placeholder="Search questions…" data-fi autocomplete="off" inputmode="search"></div>
      <div class="rqe-slot" data-slot></div>
    </div>`;
  const slot = host.querySelector('[data-slot]'), find = host.querySelector('[data-find]'), fi = host.querySelector('[data-fi]');

  window.__alifEmbedQuiz = true;
  document.body.classList.add('rq-embedded');
  slot.appendChild(appScreen);
  appScreen.classList.add('embedded');
  launchQuiz({ ...payload, embed: true });

  const q = id => appScreen.querySelector(id) || document.getElementById(id.slice(1));
  const onClick = e => {
    const b = e.target.closest('[data-e]'); if (!b) return;
    const k = b.dataset.e;
    if (k === 'back') onBack && onBack();
    else if (k === 'full') onFull && onFull();
    else if (k === 'cats') q('#openCategoryOverlay')?.click();
    else if (k === 'marks') q('#openBookmarks')?.click();
    else if (k === 'submit') q('#submitQuizBtn')?.click();
    else if (k === 'search') { find.classList.toggle('hidden'); if (!find.classList.contains('hidden')) fi.focus(); else { fi.value = ''; push(''); } }
  };
  const push = v => { const si = document.getElementById('searchInput'); if (si) { si.value = v; si.dispatchEvent(new Event('input', { bubbles: true })); } };
  host.addEventListener('click', onClick);
  fi.addEventListener('input', () => push(fi.value));

  /* if the engine leaves the quiz screen by itself (e.g. a "back to quizzes" button in a result dialog),
     undo whatever it revealed and return to the quiz list */
  const mo = new MutationObserver(() => {
    if (released || destroyed || !appScreen.classList.contains('hidden')) return;
    pickerScreen.classList.add('hidden'); homeScreen.classList.add('hidden');
    document.getElementById('resourcesScreen')?.classList.remove('hidden');
    onBack && onBack();
  });
  mo.observe(appScreen, { attributes: true, attributeFilter: ['class'] });

  function restoreDom() {
    window.__alifEmbedQuiz = false;
    document.body.classList.remove('rq-embedded');
    appScreen.classList.remove('embedded');
    origParent.insertBefore(appScreen, origNext);
  }
  return {
    /* leave the quiz running and hand the screen back to the app (full-screen quiz) */
    release() {
      if (released || destroyed) return;
      released = true; mo.disconnect(); host.removeEventListener('click', onClick); restoreDom();
      document.getElementById('resourcesScreen')?.classList.add('hidden');     // the quiz is now the app's main screen
      document.getElementById('bottomNav')?.classList.add('hidden');
    },
    destroy() {
      if (released || destroyed) return;
      destroyed = true; mo.disconnect(); host.removeEventListener('click', onClick);
      appScreen.classList.add('hidden');
      restoreDom();
      push('');
    }
  };
}
