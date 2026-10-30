/* =========================================================================
   ALIF Med — Quiz ⇄ Exam chooser on quiz cards (menus/exam-cards.js)

   • Admin-marked exam (quiz.isExam)  -> always opens in exam mode (handled in
     home-screen.js). The card just gets an "Exam" tag. Nothing to choose.
   • Every other quiz                 -> student's choice:
       PC      hover the card  -> frosted split overlay: [ Quiz | Exam ]
       Mobile  tap             -> Quiz (unchanged)
               swipe RIGHT     -> Exam  (Samsung "swipe to call" style:
                                  a lane slides out, arms with a haptic tick
                                  past the threshold, release to start)
   Cards are re-rendered by the app (innerHTML), so a MutationObserver
   decorates new cards. No Firestore reads are made here.
   ========================================================================= */
import { startQuizFromCard } from './home-screen.js';
import { LSC } from './cache.js';
import { getStoredStudent } from './auth.js';
import { ALL_QUIZZES } from './picker-screen.js';
import { showToast } from './ui-feedback.js';

const HINT_KEY = 'alif_exam_swipe_hint_v1';

// The exam engine (≈85 KB) loads only when an exam is actually opened — and is warmed the moment a student
// hovers or touches a quiz card, so it still opens instantly.
let examModule = null;
const loadExam = () => examModule || (examModule = import('./exam-mode.js'));
const startExam = (subjectId, quizId) => loadExam().then(m => m.startExam(subjectId, quizId));
function hasExamInProgress(subjectId, quizId) {   // same key as exam-mode.js
  try {
    const st = getStoredStudent();
    const sid = (st && (st.id || st.docId)) || '';
    const s = LSC.get(`alif_examstate_${sid}_${subjectId}_${quizId}`);
    return !!(s && !s.submitted && s.endsAt > Date.now());
  } catch (_) { return false; }
}

const CSS = `
.quiz-card.exm-dual{touch-action:pan-y;-webkit-user-select:none;user-select:none}

/* ---------- Exam-only tag ---------- */
.exm-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  color:#fff;background: var(--vein,#E85A3B);box-shadow:0 4px 12px -4px color-mix(in srgb,var(--vein,#E85A3B) 70%,transparent)}
.exm-tag i{font-size:9.5px}

/* ---------- PC hover chooser ---------- */
.quiz-card .exm-hover{display:none}
@media (hover:hover) and (pointer:fine){
  .quiz-card.exm-dual .exm-hover{
    position:absolute;inset:0;z-index:4;display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px;border-radius:inherit;
    background:color-mix(in srgb,var(--card) 58%,transparent);
    -webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);
    opacity:0;pointer-events:none;transition:opacity .22s var(--ease,ease)}
  .quiz-card.exm-dual:hover .exm-hover,
  .quiz-card.exm-dual:focus-visible .exm-hover{opacity:1;pointer-events:auto}
  .exm-opt{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;border-radius:14px;cursor:pointer;
    text-align:center;overflow:hidden;transform:translateY(10px) scale(.96);opacity:0;
    transition:transform .34s var(--ease,ease),opacity .26s ease,box-shadow .25s ease,filter .2s ease}
  .quiz-card.exm-dual:hover .exm-opt,
  .quiz-card.exm-dual:focus-visible .exm-opt{transform:none;opacity:1}
  .quiz-card.exm-dual:hover .exm-opt-exam{transition-delay:.05s}
  .exm-opt:hover{transform:translateY(-3px) scale(1.025)!important}
  .exm-opt:active{transform:scale(.97)!important}
  .exm-opt .exm-ic{width:40px;height:40px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:17px;transition:transform .35s var(--ease,ease)}
  .exm-opt:hover .exm-ic{transform:scale(1.12) rotate(-6deg)}
  .exm-opt b{font-family:'Fraunces',serif;font-size:16px;letter-spacing:-.01em}
  .exm-opt small{font-size:11.5px;font-weight:600;opacity:.78;max-width:92%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  .exm-opt-quiz{color:var(--ink);background:color-mix(in srgb,var(--accent,var(--artery)) 13%,var(--card));
    border:1px solid color-mix(in srgb,var(--accent,var(--artery)) 34%,transparent)}
  .exm-opt-quiz .exm-ic{background:color-mix(in srgb,var(--accent,var(--artery)) 22%,transparent);color:var(--accent,var(--artery))}
  .exm-opt-quiz:hover{box-shadow:0 14px 26px -14px color-mix(in srgb,var(--accent,var(--artery)) 70%,transparent)}

  /* Exam side: same glass-tint recipe as Quiz, but in the brand coral so the two halves read as a pair */
  .exm-opt-exam{--exm-c:var(--vein,#E85A3B);color:var(--ink);background:color-mix(in srgb,var(--exm-c) 13%,var(--card));
    border:1px solid color-mix(in srgb,var(--exm-c) 38%,transparent)}
  .exm-opt-exam::after{content:'';position:absolute;inset:0;background:none;
    transform:translateX(-120%);transition:transform .7s var(--ease,ease);pointer-events:none}
  .exm-opt-exam:hover::after{transform:translateX(120%)}
  .exm-opt-exam .exm-ic{background:color-mix(in srgb,var(--exm-c) 22%,transparent);color:var(--exm-c)}
  .exm-opt-exam:hover{box-shadow:0 14px 26px -14px color-mix(in srgb,var(--exm-c) 75%,transparent)}
  .exm-resume-dot{position:absolute;top:9px;right:9px;width:9px;height:9px;border-radius:50%;background:#fbbf24;box-shadow:0 0 0 0 rgba(251,191,36,.7);animation:exmPulse 1.6s infinite}
  @keyframes exmPulse{70%{box-shadow:0 0 0 9px rgba(251,191,36,0)}100%{box-shadow:0 0 0 0 rgba(251,191,36,0)}}
}

/* ---------- Mobile swipe-right-for-exam lane ---------- */
.quiz-card .exm-lane{position:absolute;left:0;top:0;bottom:0;width:0;z-index:3;overflow:hidden;pointer-events:none;border-radius:inherit;
  background: var(--vein,#E85A3B)}
.quiz-card .exm-lane-in{position:absolute;left:22px;top:50%;width:150px;display:flex;align-items:center;gap:12px;color:#fff;transform:translateY(-50%);white-space:nowrap}
.quiz-card .exm-lane-ic{width:44px;height:44px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:19px;
  background:rgba(255,255,255,.2);transform:scale(var(--exm-p,.6));transition:background .2s ease,box-shadow .2s ease}
.quiz-card .exm-lane-tx{display:flex;flex-direction:column;line-height:1.15;opacity:var(--exm-p,0)}
.quiz-card .exm-lane-tx b{font-family:'Fraunces',serif;font-size:16px}
.quiz-card .exm-lane-tx small{font-size:11px;font-weight:600;opacity:.85}
.quiz-card .exm-lane.armed .exm-lane-ic{background:#fff;color:var(--vein,#E85A3B);box-shadow:0 0 0 7px rgba(255,255,255,.22);animation:exmArm .5s ease}
@keyframes exmArm{0%{transform:scale(.9)}60%{transform:scale(1.22)}100%{transform:scale(1.1)}}
.quiz-card.exm-swiping{transition:none!important;transform:none!important}
.quiz-card.exm-swiping>*:not(.exm-lane):not(.exm-hover){transform:translateX(var(--exm-dx,0px));transition:none!important}
.quiz-card.exm-back>*:not(.exm-lane):not(.exm-hover){transform:translateX(0);transition:transform .42s cubic-bezier(.2,1.25,.3,1)}
.quiz-card.exm-back .exm-lane{width:0!important;transition:width .42s cubic-bezier(.2,1.25,.3,1)}
.quiz-card.exm-go>*:not(.exm-lane):not(.exm-hover){transform:translateX(110%);transition:transform .26s ease-in}
.quiz-card.exm-go .exm-lane{width:100%!important;transition:width .26s ease-in}
.quiz-card.exm-nudge>*:not(.exm-lane):not(.exm-hover){animation:exmNudgeC 1.25s var(--ease,ease) .1s}
.quiz-card.exm-nudge .exm-lane{animation:exmNudgeL 1.25s var(--ease,ease) .1s}
@keyframes exmNudgeC{0%,100%{transform:translateX(0)}35%,55%{transform:translateX(58px)}}
@keyframes exmNudgeL{0%,100%{width:0}35%,55%{width:58px}}
@media (prefers-reduced-motion:reduce){.quiz-card.exm-nudge>*,.quiz-card.exm-nudge .exm-lane{animation:none!important}}
`;
const style = document.createElement('style');
style.id = 'alifExamCardsStyle';
style.textContent = CSS;
document.head.appendChild(style);

const grid = document.getElementById('quizGrid');

function quizOf(card) {
  return ALL_QUIZZES.find(q => q.id === card.dataset.quiz && q.subjectId === card.dataset.subject);
}

function decorate(card) {
  if (card.dataset.exm) return;
  card.dataset.exm = '1';
  const quiz = quizOf(card);
  if (!quiz) return;
  if (card.classList.contains('locked') || quiz.linkUrl || quiz.type === 'link') return;

  const resumable = hasExamInProgress(card.dataset.subject, card.dataset.quiz);

  // Admin-marked exam: exam only — tag it, relabel the CTA, no chooser.
  if (quiz.isExam) {
    card.classList.add('exm-examonly');
    const row = card.querySelector('.qc-subject-row') || card.querySelector('.qc-body');
    if (row) row.insertAdjacentHTML('beforeend', '<span class="exm-tag"><i class="fa-solid fa-stopwatch"></i> Exam</span>');
    const cta = card.querySelector('.qc-cta span');
    if (cta) cta.textContent = resumable ? 'Resume exam' : (/start quiz/i.test(cta.textContent) ? 'Start exam' : cta.textContent);
    return;
  }

  // Everything else: student's choice.
  card.classList.add('exm-dual');
  card.title = 'Hover to pick Quiz or Exam · Shift+Enter starts an exam';
  const quizSub = (card.querySelector('.qc-cta span')?.textContent || 'Practice').trim();
  card.insertAdjacentHTML('beforeend', `
    <span class="exm-lane" aria-hidden="true"><span class="exm-lane-in">
      <span class="exm-lane-ic"><i class="fa-solid fa-stopwatch"></i></span>
      <span class="exm-lane-tx"><b>Exam</b><small>Release to start</small></span></span></span>
    <span class="exm-hover" aria-hidden="true">
      <span class="exm-opt exm-opt-quiz" data-exm="quiz"><span class="exm-ic"><i class="fa-solid fa-book-open"></i></span><b>Quiz</b><small>${quizSub.replace(/</g, '&lt;')}</small></span>
      <span class="exm-opt exm-opt-exam" data-exm="exam">${resumable ? '<i class="exm-resume-dot"></i>' : ''}<span class="exm-ic"><i class="fa-solid fa-stopwatch"></i></span><b>Exam</b><small>${resumable ? 'Resume attempt' : 'Timed · scored at end'}</small></span>
    </span>`);
}

function decorateAll() {
  grid.querySelectorAll('.quiz-card').forEach(decorate);
  maybeShowHint();
}

/* ---------- one-time swipe hint (touch devices) ---------- */
let hintDone = false;
function maybeShowHint() {
  if (hintDone || !matchMedia('(pointer:coarse)').matches) return;
  try { if (localStorage.getItem(HINT_KEY)) { hintDone = true; return; } } catch (_) {}
  const card = grid.querySelector('.quiz-card.exm-dual');
  if (!card || !grid.offsetParent) return;
  hintDone = true;
  try { localStorage.setItem(HINT_KEY, '1'); } catch (_) {}
  setTimeout(() => {
    if (!card.isConnected) return;
    card.classList.add('exm-nudge');
    setTimeout(() => card.classList.remove('exm-nudge'), 1600);
    try { showToast('Tip: swipe a quiz right to start it as a timed exam', { icon: 'fa-solid fa-hand-point-right', duration: 4500 }); } catch (_) {}
  }, 900);
}

/* ---------- swipe engine ---------- */
let sw = null;
let swallowUntil = 0;

function setProgress(card, dx) {
  const lane = card.querySelector('.exm-lane');
  const p = Math.max(0, Math.min(1, dx / sw.arm));
  card.style.setProperty('--exm-dx', dx + 'px');
  card.style.setProperty('--exm-p', (0.6 + 0.4 * p).toFixed(3));
  lane.style.width = dx + 'px';
  lane.querySelector('.exm-lane-tx').style.opacity = String(p);
  const armed = dx >= sw.arm;
  if (armed !== sw.armed) {
    sw.armed = armed;
    lane.classList.toggle('armed', armed);
    if (armed && navigator.vibrate) { try { navigator.vibrate(14); } catch (_) {} }
  }
}

function endSwipe(trigger) {
  if (!sw) return;
  const { card } = sw;
  sw = null;
  swallowUntil = Date.now() + 500;
  card.classList.remove('exm-swiping');
  if (trigger) {
    card.classList.add('exm-go');
    setTimeout(() => {
      launchExam(card);
      setTimeout(() => resetCard(card), 450);
    }, 230);
  } else {
    card.classList.add('exm-back');
    resetVars(card);
    setTimeout(() => card.classList.remove('exm-back'), 460);
  }
}
function resetVars(card) {
  card.style.removeProperty('--exm-dx'); card.style.removeProperty('--exm-p');
  const lane = card.querySelector('.exm-lane');
  if (lane) { lane.style.width = ''; lane.classList.remove('armed'); const t = lane.querySelector('.exm-lane-tx'); if (t) t.style.opacity = ''; }
}
function resetCard(card) {
  card.classList.remove('exm-go', 'exm-back', 'exm-swiping');
  resetVars(card);
}

function launchExam(card) {
  startExam(card.dataset.subject, card.dataset.quiz);
}

function init() {
  new MutationObserver(decorateAll).observe(grid, { childList: true });
  decorateAll();

  ['pointerover', 'pointerdown'].forEach(ev => grid.addEventListener(ev, e => {
    if (e.target.closest && e.target.closest('.quiz-card.exm-dual')) loadExam().catch(() => {});
  }, { passive: true, once: false }));

  grid.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const card = e.target.closest('.quiz-card.exm-dual');
    if (!card) return;
    sw = { card, id: e.pointerId, x: e.clientX, y: e.clientY, active: false, armed: false, w: card.offsetWidth, arm: Math.min(140, card.offsetWidth * 0.38) };
  }, { passive: true });

  grid.addEventListener('pointermove', e => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.active) {
      if (dx < -10 || (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx))) { sw = null; return; }   // left swipe / vertical scroll: not ours
      if (dx > 10 && dx > Math.abs(dy) * 1.4) {
        sw.active = true;
        sw.card.classList.remove('exm-back', 'exm-go', 'exm-nudge');
        sw.card.classList.add('exm-swiping');
        try { sw.card.setPointerCapture(e.pointerId); } catch (_) {}
      } else return;
    }
    // light rubber-band resistance past the arm point
    const eff = dx <= sw.arm ? dx : sw.arm + (dx - sw.arm) * 0.35;
    setProgress(sw.card, Math.max(0, Math.min(eff, sw.w)));
  }, { passive: true });

  grid.addEventListener('pointerup', e => { if (sw && e.pointerId === sw.id) { sw.active ? endSwipe(sw.armed) : (sw = null); } });
  grid.addEventListener('pointercancel', e => { if (sw && e.pointerId === sw.id) { sw.active ? endSwipe(false) : (sw = null); } });

  // After a swipe the browser may still synthesize a click — swallow it before the card's own handler sees it.
  grid.addEventListener('click', e => {
    if (Date.now() < swallowUntil) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  // PC hover chooser buttons (capture phase so the card's own "start quiz" click handler never fires).
  grid.addEventListener('click', e => {
    const opt = e.target.closest('.exm-opt');
    if (!opt) return;
    e.stopPropagation(); e.preventDefault();
    const card = opt.closest('.quiz-card');
    if (!card) return;
    if (opt.dataset.exm === 'exam') launchExam(card);
    else startQuizFromCard(card.dataset.subject, card.dataset.quiz);
  }, true);

  // Keyboard: Enter = quiz (default), Shift+Enter = exam.
  grid.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.shiftKey) return;
    const card = e.target.closest && e.target.closest('.quiz-card.exm-dual');
    if (!card) return;
    e.preventDefault(); e.stopPropagation();
    launchExam(card);
  }, true);
}

if (grid) init();
