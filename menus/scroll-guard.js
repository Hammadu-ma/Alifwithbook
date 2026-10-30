/* Screen + scroll guard.
   1) Screen exclusivity: whenever a screen becomes visible, every screen that must not be
      visible alongside it is hidden, and quiz-only chrome (jump button, sidebar backdrop,
      explain bubble, quiz overlays) is torn down once the quiz screen is gone.
   2) Scroll health: the page never stays scroll-locked once no gate/overlay is open. */
import { forceUnlockBodyScroll } from './cache.js';

const $ = id => document.getElementById(id);
const ids = {
  gate: 'gateScreen', home: 'homeScreen', picker: 'pickerScreen', app: 'appScreen',
  progress: 'progressScreen', chat: 'chatScreen', resources: 'resourcesScreen',
  modules: 'modulesScreen', subjects: 'subjectsScreen', universities: 'universitiesScreen'
};
const ALL = Object.keys(ids);
const SUB = ['modules', 'subjects', 'universities'];            // sub-pages that sit on top of the picker
const PRIMARY = ['home', 'picker', 'app', 'progress', 'chat', 'resources'];  // one at a time
// what may stay visible together with the screen that just opened
const KEEP = {
  gate: [],
  home: [],
  picker: SUB,
  app: [],
  progress: [],
  chat: [],
  resources: [],
  modules: ['picker'], subjects: ['picker'], universities: ['picker']
};
const hidden = k => !$(ids[k]) || $(ids[k]).classList.contains('hidden');
const hide = k => { const el = $(ids[k]); if (el && !el.classList.contains('hidden')) el.classList.add('hidden'); };

function enforce(winner) {
  if (!winner || hidden(winner)) return;
  const keep = new Set([winner, ...(KEEP[winner] || [])]);
  if (winner === 'app' && window.__alifEmbedQuiz) keep.add('resources');   // quiz embedded in the video panel
  ALL.forEach(k => { if (!keep.has(k)) hide(k); });
}

function tearDownQuizChrome() {
  $('jumpFab')?.classList.add('hide');
  $('sidebar')?.classList.remove('open');
  $('sidebarBackdrop')?.classList.remove('show');
  document.querySelectorAll('.ai-explain-btn').forEach(e => e.remove());
  ['resultOverlay', 'bmOverlay', 'categoryOverlay'].forEach(i => $(i)?.classList.remove('show'));
}

function gateVisible() { return !hidden('gate'); }
const OPEN = '.overlay.show,.package-overlay.show,.lock-overlay.show,.search-overlay:not(.hidden),.sidebar.open';

export function healScroll() {
  if (gateVisible()) return;
  document.body.classList.remove('auth-gate-open');
  if (!document.querySelector(OPEN) && document.body.style.overflow) forceUnlockBodyScroll();
}

function refreshChrome() {
  if (hidden('app')) tearDownQuizChrome();
  healScroll();
  import('./bottom-nav.js').then(m => m.updateBottomNavVisibility?.()).catch(() => {});
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; refreshChrome(); });
}

const screenObs = new MutationObserver(records => {
  let winner = null;
  for (const r of records) {
    const was = (r.oldValue || '').split(/\s+/).includes('hidden');
    if (was && !r.target.classList.contains('hidden')) {
      const k = ALL.find(key => ids[key] === r.target.id);
      if (k) winner = k;                      // last screen opened wins
    }
  }
  if (winner) enforce(winner);
  schedule();
});
ALL.forEach(k => { const el = $(ids[k]); if (el) screenObs.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true }); });

const ovObs = new MutationObserver(schedule);
document.querySelectorAll('.overlay,.package-overlay,.lock-overlay,.search-overlay').forEach(el => ovObs.observe(el, { attributes: true, attributeFilter: ['class'] }));

window.addEventListener('popstate', () => setTimeout(refreshChrome, 60));
window.addEventListener('pageshow', schedule);
document.addEventListener('visibilitychange', schedule);
window.addEventListener('wheel', healScroll, { passive: true, capture: true });
window.addEventListener('touchstart', healScroll, { passive: true, capture: true });
schedule();
