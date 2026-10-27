/* ============================================================================
   quiz-live.js — LIVE badges + pin toggle for quiz cards, and a "Live now"
   section above continue practicing with horizontally scrollable live quizzes.

   Reads (per quiz, matched by name — see LIMITATION below):
     - liveStart / liveEnd (ISO strings) — set in the admin's "Live Quizzes"
       panel. When "now" falls inside this window, the quiz is LIVE.
     - pinnedByAdmin (bool) — also set in that same admin panel; pins the
       quiz for every student. Shown as a non-toggleable "Pinned" badge on
       the card, and surfaces the quiz in the horizontal rail even when
       it isn't currently live.
     - liveLabel (string) — small tag shown on the card/rail (e.g. "Exam prep").
     - liveCardColor (hex string) — theme color for the LIVE badge, glow,
       countdown, and rail card for this quiz.
     - liveNoteEnabled (bool) — turns the pre-quiz notes banner on/off.
     - liveNoteTitle (string)    — big H1 headline.
     - liveNoteSubtitle (string) — H2 sub-headline (optional).
     - liveNoteBody (string)     — body copy; line breaks are preserved.
     - liveNoteImages (array of URLs) — optional images, shown as a gallery.
       A single string is also accepted (comma-separated URLs).
   Writes (personal, per student):
     - studentPins/{studentId}.quizIds — array of quiz IDs this student has
       personally pinned. Toggled by tapping the pin icon on any quiz card.

   LIMITATION — name-based matching
   Same constraint as buy-modal.js: the rest of the app is obfuscated, so
   quizzes are matched by their rendered name, not a Firestore doc ID. Two
   quizzes sharing an identical name are treated as the same quiz here.

   READ COST
   A single Firestore query fetches only quizzes that are pinned or
   currently live right now (liveStart <= now <= liveEnd) — ordinary
   quizzes are never read, and a quiz matching multiple conditions is
   still only billed once. Runs once per page load, no polling. If you
   have N quizzes live right now and nothing extra pinned, this is
   exactly N reads. See the comment above getAllQuizzes() below for the
   required Firestore index.

   INTEGRATION
   Add this next to buy-modal.js in index.html:
     <script type="module" src="menus/quiz-live.js"></script>
   ============================================================================ */

import { ALL_MODULES, SUBJECTS_CACHE } from './picker-screen.js';
import { db } from './firebase-config.js';
import { getStoredStudent } from './auth.js';
import { collectionGroup, getDocs, query, where, or, and, doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// ------------------------------------------------------------------------
// Student identity — same resolution order as buy-modal.js (explicit
// login, else the app's own persistent device ID for guests).
// ------------------------------------------------------------------------
function getCurrentStudentId() {
  try {
    const student = getStoredStudent();
    return student && !student.guest ? (student.id || student.docId) : null;
  } catch (e) { return null; }
}

// ------------------------------------------------------------------------
// Personal pins — cached in memory after first load, updated optimistically
// on toggle.
// ------------------------------------------------------------------------
let PERSONAL_PINS = new Set();
let PERSONAL_PINS_LOADED = false;

async function loadPersonalPins() {
  const studentId = getCurrentStudentId();
  if (!studentId || PERSONAL_PINS_LOADED) return;
  PERSONAL_PINS_LOADED = true;
  try {
    const snap = await getDoc(doc(db, 'studentPins', studentId));
    if (snap.exists()) PERSONAL_PINS = new Set(snap.data().quizIds || []);
  } catch (e) { /* best-effort */ }
}

async function togglePersonalPin(quizId) {
  const studentId = getCurrentStudentId();
  if (!studentId) return;
  const wasPinned = PERSONAL_PINS.has(quizId);
  if (wasPinned) PERSONAL_PINS.delete(quizId); else PERSONAL_PINS.add(quizId);
  try {
    await setDoc(doc(db, 'studentPins', studentId), { quizIds: [...PERSONAL_PINS] });
  } catch (e) {
    // revert on failure
    if (wasPinned) PERSONAL_PINS.add(quizId); else PERSONAL_PINS.delete(quizId);
  }
}

// ------------------------------------------------------------------------
// Quiz data lookup — EXACT READ COUNT VERSION.
//
// One single query, one single round trip, and Firestore bills exactly
// one read per document actually returned — no more, no less. If you have
// 9 quizzes live right now and nothing else pinned, this reads exactly 9
// documents. A quiz that is neither pinned nor currently live is never
// touched at all.
//
// The query is a single OR condition:
//   pinnedByAdmin == true
//   OR (liveStart <= now AND liveEnd >= now)
// i.e. it matches the SAME window your liveStatus() function checks, so
// "currently live" here means exactly what the badge means. A quiz that's
// merely scheduled for later (liveStart in the future) is NOT read until
// its window actually opens.
//
// Because this is one query (not two separate getDocs calls merged in
// JS), a quiz that happens to be both pinned AND live is only billed
// once — Firestore's OR queries de-duplicate matching documents in the
// result set automatically.
//
// This still runs once per page load (no polling, no onSnapshot) — see
// the bottom of this file. A quiz that becomes live after the page has
// already loaded won't show up until the next reload.
//
// REQUIRES a Firestore composite index for this collection-group query.
// The first time this runs against a fresh project, the browser console
// will print an error containing a link that auto-creates the exact
// index needed — click it, wait ~1 minute for it to finish building,
// then reload.
// ------------------------------------------------------------------------
let ALL_QUIZZES_PROMISE = null;
async function getAllQuizzes(force = false) {
  if (force) ALL_QUIZZES_PROMISE = null;
  if (!ALL_QUIZZES_PROMISE) {
    ALL_QUIZZES_PROMISE = (async () => {
      try {
        const nowIso = new Date().toISOString();
        const q = query(
          collectionGroup(db, 'quizzes'),
          or(
            where('pinnedByAdmin', '==', true),
            and(where('liveStart', '<=', nowIso), where('liveEnd', '>=', nowIso)),
          ),
        );
        const snap = await getDocs(q);
        const docs = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

        console.log(`[quiz-live] loaded ${docs.length} pinned/currently-live quiz doc(s) — ` +
          `exactly ${docs.length} Firestore read(s) for this page load, no full-collection scan`);
        if (docs.length === 0) {
          console.log('[quiz-live] no pinned or currently-live quiz docs matched. This is EXPECTED if nothing ' +
            'is live or admin-pinned right now. If you expected results and got none, check: (1) firestore.rules ' +
            'has a collectionGroup-level rule for "quizzes" — a rule on subjects/{id}/quizzes/{id} alone does NOT ' +
            'cover collectionGroup("quizzes") queries, you need:\n' +
            '  match /{path=**}/quizzes/{quizId} { allow read: if <condition>; }\n' +
            '(2) the required composite index exists (see console for an auto-create link if missing) ' +
            '(3) liveStart/liveEnd are stored as ISO strings in the same format everywhere, since this query ' +
            'compares them as strings.');
        } else {
          console.log('[quiz-live] quiz names as seen by this script:', docs.map((d) => d.name));
        }
        return docs;
      } catch (e) {
        console.error('[quiz-live] FAILED to load quizzes from Firestore:', e.code || '', e.message || e);
        if (e.code === 'permission-denied') {
          console.error('[quiz-live] "permission-denied" confirms this is a Firestore security-rules issue, ' +
            'not a bug in this script. Check firestore.rules for a collectionGroup-level rule on "quizzes".');
        }
        if (e.code === 'failed-precondition') {
          console.error('[quiz-live] "failed-precondition" usually means a required Firestore index is missing. ' +
            'Look a few lines up in the console for an error with a link that auto-creates it — click it, wait ' +
            'a minute for the index to build, then reload.');
        }
        return [];
      }
    })();
  }
  return ALL_QUIZZES_PROMISE;
}

async function getQuizByName(name) {
  // NOTE: `all` here is only the pinned/live-or-upcoming subset (see
  // getAllQuizzes above), not every quiz. A miss is the NORMAL case for a
  // plain quiz that isn't currently live or pinned — it should NOT be
  // logged as a warning, or the console would be flooded with one "no
  // match" line per ordinary quiz card on every page.
  const all = await getAllQuizzes();
  const exact = all.find((q) => (q.name || '').trim() === name.trim());
  if (exact) return exact;

  // No exact match against the (small) pinned/live set — check for a
  // near-miss (case/whitespace) so a genuine typo on a quiz that SHOULD be
  // live/pinned is still easy to spot in the console.
  const loose = all.find((q) => (q.name || '').trim().toLowerCase() === name.trim().toLowerCase());
  if (loose) {
    console.warn(`[quiz-live] "${name}" did not match exactly but matched case-insensitively against ` +
      `Firestore quiz "${loose.name}". Fix the casing/whitespace on one side so they match exactly.`);
    return loose;
  }
  return null;
}

function liveStatus(q) {
  if (!q || !q.liveStart || !q.liveEnd) return 'none';
  const now = Date.now();
  const start = new Date(q.liveStart).getTime();
  const end = new Date(q.liveEnd).getTime();
  if (now >= start && now <= end) return 'live';
  return 'none';
}

function formatCountdown(endIso) {
  const ms = new Date(endIso).getTime() - Date.now();
  if (ms <= 0) return 'ending now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m left`;
  return `${Math.floor(hrs / 24)}d left`;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}` : '255,0,0';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Body text supports plain line breaks. A blank line starts a new
// paragraph; a single line break becomes <br>.
function formatNoteBody(str) {
  const escaped = escapeHtml(str).trim();
  if (!escaped) return '';
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function normalizeImageList(images) {
  if (!images) return [];
  if (Array.isArray(images)) return images.map((s) => String(s).trim()).filter(Boolean);
  return String(images).split(',').map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------------
// Styles for live badges on quiz cards
// ------------------------------------------------------------------------
const style = document.createElement('style');
style.textContent = `
  @keyframes ql-pulse { 
    0% { box-shadow: 0 0 0 0 rgba(255,0,0,.8), 0 0 15px 0 rgba(255,0,0,.6); } 
    40% { box-shadow: 0 0 0 12px rgba(255,0,0,.3), 0 0 25px 0 rgba(255,0,0,.4); } 
    70% { box-shadow: 0 0 0 24px rgba(255,0,0,0), 0 0 35px 0 rgba(255,0,0,.1); } 
    100% { box-shadow: 0 0 0 0 rgba(255,0,0,0), 0 0 15px 0 rgba(255,0,0,.6); } 
  }
  @keyframes ql-dot-pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.3); }
  }
  .ql-live-badge {
    position: absolute; top: 10px; left: 10px; z-index: 5;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px 6px 8px; border-radius: 999px;
    background: var(--ql-color, #ff0000); color: #fff; font-size: 11px; font-weight: 900;
    letter-spacing: .05em; text-transform: uppercase;
    box-shadow: 0 0 20px rgba(var(--ql-color-rgb, 255,0,0),.8), 0 4px 12px -2px rgba(var(--ql-color-rgb, 255,0,0),.7);
    animation: ql-badge-glow 1.2s ease-in-out infinite;
  }
  @keyframes ql-badge-glow {
    0%, 100% { filter: brightness(1) drop-shadow(0 0 8px rgba(var(--ql-color-rgb, 255,0,0),.8)); }
    50% { filter: brightness(1.15) drop-shadow(0 0 16px rgba(var(--ql-color-rgb, 255,0,0),1)); }
  }
  .ql-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: ql-dot-pulse 0.8s ease-in-out infinite; box-shadow: 0 0 6px #fff; }
  .ql-live-countdown {
    position: absolute; bottom: 8px; left: 10px; z-index: 5;
    font-size: 10px; font-weight: 700; color: var(--ql-color, #d34848);
    background: rgba(255,255,255,.92); padding: 2px 7px; border-radius: 999px;
    border: 1px solid rgba(var(--ql-color-rgb, 211,72,72),.35);
  }
  body.dark .ql-live-countdown {
    background: rgba(20,22,26,.85); color: var(--ql-color, #ff8a8a);
  }

  .ql-pin-btn {
    position: absolute; top: 10px; right: 10px; z-index: 5;
    width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer;
    background: rgba(0,0,0,.35); backdrop-filter: blur(4px);
    color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px;
    transition: transform .15s ease, background .15s ease;
  }
  .ql-pin-btn:hover { transform: scale(1.08); }
  .ql-pin-btn.pinned { background: var(--accent, #2f7a5f); color: #fff; }

  .ql-admin-pin-badge {
    position: absolute; bottom: 8px; right: 10px; z-index: 5;
    display: flex; align-items: center; gap: 5px;
    padding: 3px 9px; border-radius: 999px;
    background: rgba(47,122,95,.12); color: #2f7a5f;
    font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
  }
  .ql-admin-pin-badge i { font-size: 9px; }

  /* Live card labels */
  .lc-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .05em;
    margin-top: 8px;
  }
`;
document.head.appendChild(style);

// Track live quizzes for the live section
const LIVE_QUIZZES = new Map(); // quizId -> {id, name, liveEnd, subject, ...}

function ensureLiveSectionMarkup() {
  // If the host page doesn't already have a #liveSection / #liveRail
  // (e.g. it hasn't been added to index.html yet), create a minimal
  // one so the feature works out of the box instead of silently no-op'ing.
  if (document.getElementById('liveSection')) return;

  const containerParent =
    document.querySelector('.quiz-list')?.parentElement ||
    document.querySelector('.quiz-card')?.closest('section')?.parentElement ||
    document.body;
  const referenceNode =
    document.querySelector('.quiz-list') ||
    document.querySelector('.quiz-card')?.closest('section') ||
    containerParent.firstElementChild;

  const section = document.createElement('section');
  section.id = 'liveSection';
  section.className = 'ql-live-section';
  section.innerHTML = `
    <h3 class="ql-live-heading"><i class="fa-solid fa-fire"></i> Live now</h3>
    <div id="liveRail" class="ql-live-rail"></div>
  `;

  if (referenceNode && referenceNode.parentElement === containerParent) {
    containerParent.insertBefore(section, referenceNode);
  } else {
    containerParent.insertBefore(section, containerParent.firstChild);
  }
}

const liveSectionStyle = document.createElement('style');
liveSectionStyle.textContent = `
  @keyframes ql-card-drift {
    0%, 100% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
  }
  @keyframes ql-card-rise {
    from { opacity: 0; transform: translateY(10px) scale(.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes ql-flame-flicker {
    0%, 100% { transform: scale(1) rotate(0deg); }
    50% { transform: scale(1.08) rotate(-3deg); }
  }
  @keyframes ql-shimmer-sweep {
    0% { transform: translateX(-120%) skewX(-12deg); }
    100% { transform: translateX(220%) skewX(-12deg); }
  }

  .ql-live-section { display: none; margin-bottom: 24px; }
  .ql-live-section.has-items { display: block; }
  .ql-live-heading {
    display: flex; align-items: center; gap: 9px;
    font-size: 15.5px; font-weight: 900; margin: 0 0 12px;
    letter-spacing: -.01em;
    background: linear-gradient(90deg, #ff3d3d, #ff8a3d 55%, #ff3d3d);
    background-size: 200% auto;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: ql-card-drift 4s ease-in-out infinite;
  }
  .ql-live-heading i { -webkit-text-fill-color: #ff3d3d; animation: ql-flame-flicker 1.4s ease-in-out infinite; }

  .ql-live-rail {
    display: flex; gap: 14px; overflow-x: auto; padding: 4px 4px 10px;
    scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch;
  }
  .ql-live-rail::-webkit-scrollbar { height: 6px; }
  .ql-live-rail::-webkit-scrollbar-thumb { background: rgba(0,0,0,.15); border-radius: 999px; }

  .live-card {
    scroll-snap-align: start; flex: 0 0 236px; cursor: pointer;
    border-radius: 20px; padding: 2px; position: relative;
    background: linear-gradient(135deg,
      rgba(var(--live-color-rgb,76,110,245),.9),
      rgba(var(--live-color-rgb,76,110,245),.25) 45%,
      rgba(var(--live-color-rgb,76,110,245),.9));
    background-size: 220% 220%;
    animation: ql-card-rise .4s cubic-bezier(.2,.9,.25,1) both, ql-card-drift 5s ease-in-out infinite;
    transition: transform .2s ease, box-shadow .2s ease;
    box-shadow: 0 10px 24px -12px rgba(var(--live-color-rgb,76,110,245),.55);
  }
  .live-card:hover { transform: translateY(-4px) scale(1.015); box-shadow: 0 16px 32px -12px rgba(var(--live-color-rgb,76,110,245),.7); }
  .live-card:active { transform: translateY(-1px) scale(.99); }

  .live-card .lc-inner {
    position: relative; overflow: hidden; border-radius: 18px;
    padding: 14px 14px 13px;
    background:
      radial-gradient(120% 140% at 100% 0%, rgba(var(--live-color-rgb,76,110,245),.16), transparent 60%),
      color-mix(in srgb, var(--ql-card-bg, #ffffff) 96%, transparent);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  }
  .live-card .lc-inner::before {
    content: ''; position: absolute; top: 0; bottom: 0; width: 55%;
    background: linear-gradient(100deg, transparent, rgba(255,255,255,.4), transparent);
    animation: ql-shimmer-sweep 3.5s ease-in-out infinite;
    pointer-events: none;
  }

  .live-card .lc-badge {
    position: absolute; top: 12px; right: 12px; z-index: 2;
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--live-color,#4C6EF5); color: #fff; font-size: 9px; font-weight: 900;
    text-transform: uppercase; letter-spacing: .06em; padding: 4px 10px 4px 8px; border-radius: 999px;
    box-shadow: 0 4px 12px -2px rgba(var(--live-color-rgb,76,110,245),.6);
  }
  .live-card .lc-badge .lc-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #fff;
    animation: ql-dot-pulse .9s ease-in-out infinite; box-shadow: 0 0 6px #fff;
  }

  .live-card .cc-top { position: relative; z-index: 1; }
  .live-card .cc-icon {
    width: 40px; height: 40px; border-radius: 13px; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, rgba(var(--live-color-rgb,76,110,245),.22), rgba(var(--live-color-rgb,76,110,245),.08));
    box-shadow: inset 0 0 0 1px rgba(var(--live-color-rgb,76,110,245),.25);
    font-size: 15px;
  }
  .live-card .cc-body { position: relative; z-index: 1; }
  .live-card .lc-module {
    display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
    font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    padding: 3px 8px; margin-top: 10px; border-radius: 999px;
    color: var(--live-color, #4C6EF5); background: rgba(var(--live-color-rgb,76,110,245),.12);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .live-card .cc-subject {
    font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em;
    color: var(--live-color,#4C6EF5); opacity: .85; margin-top: 10px;
  }
  .live-card h4 {
    margin: 3px 0 0; font-size: 15px; font-weight: 900; line-height: 1.28;
    letter-spacing: -.01em; color: var(--ql-card-ink, #17181c);
  }
  .live-card .cc-meta {
    position: relative; z-index: 1;
    display: flex; align-items: center; justify-content: space-between; margin-top: 12px;
  }
  .live-card .lc-countdown {
    font-size: 10.5px; font-weight: 800; padding: 4px 10px; border-radius: 999px;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .live-card .lc-start {
    font-size: 11.5px; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 5px;
    background: var(--live-color,#4C6EF5); padding: 6px 12px; border-radius: 999px;
    box-shadow: 0 4px 10px -3px rgba(var(--live-color-rgb,76,110,245),.6);
    transition: transform .15s ease;
  }
  .live-card:hover .lc-start { transform: scale(1.05); }

  @media (prefers-color-scheme: dark) {
    .live-card .lc-inner { --ql-card-bg: #1b1c22; --ql-card-ink: #f2f3f5; }
  }
  /* App's own manual theme toggle (body.dark, set by theme.js) takes
     priority over the OS-level media query above, so switching the
     in-app toggle to dark/light always matches — even when it disagrees
     with the OS setting. */
  body.dark .live-card .lc-inner { --ql-card-bg: #1b1c22; --ql-card-ink: #f2f3f5; }
`;
document.head.appendChild(liveSectionStyle);

// Module label for a live card - looked up from the modules/subjects the app
// already loaded (no extra Firestore reads).
function liveModuleName(q) {
  const subj = SUBJECTS_CACHE.find((s) => q.subjectId && s.id === q.subjectId)
    || SUBJECTS_CACHE.find((s) => s.name === q.subject);
  const mod = subj && ALL_MODULES.find((m) => m.id === subj.moduleId);
  const name = (mod && mod.name) || q.moduleName || '';
  return String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderLiveSection() {
  const liveQuizzes = [...LIVE_QUIZZES.values()].filter((q) => liveStatus(q) === 'live' || q.pinnedByAdmin);

  ensureLiveSectionMarkup();
  const liveSection = document.getElementById('liveSection');

  if (!liveQuizzes.length) {
    liveSection?.classList.remove('has-items');
    return;
  }

  liveSection?.classList.add('has-items');
  const liveRail = document.getElementById('liveRail');
  if (!liveRail) return;

  liveRail.innerHTML = liveQuizzes.map((q) => {
    const isLive = liveStatus(q) === 'live';
    const cardColor = q.liveCardColor || '#4C6EF5';
    const cardColorRgb = hexToRgb(cardColor);
    const metaTag = isLive
      ? `<span class="lc-countdown" style="color:${cardColor};background:rgba(${cardColorRgb},0.12);"><i class="fa-solid fa-hourglass-half"></i> ${formatCountdown(q.liveEnd)}</span>`
      : `<span class="lc-countdown" style="color:#2f7a5f;background:rgba(47,122,95,.12);"><i class="fa-solid fa-thumbtack"></i> Pinned</span>`;
    return `
      <div class="live-card" data-quiz-id="${q.id}" style="--live-color:${cardColor};--live-color-rgb:${cardColorRgb};">
        <div class="lc-inner">
          <span class="lc-badge" style="${isLive ? '' : 'background:#2f7a5f;box-shadow:0 4px 12px -2px rgba(47,122,95,.6);'}">
            <span class="lc-dot"></span>${isLive ? 'Live' : 'Pinned'}
          </span>
          <div class="cc-top">
            <div class="cc-icon"><i class="fa-solid ${isLive ? 'fa-fire' : 'fa-thumbtack'}" style="color:${isLive ? cardColor : '#2f7a5f'};"></i></div>
          </div>
          <div class="cc-body">
            ${liveModuleName(q) ? `<span class="lc-module"><i class="fa-solid fa-layer-group"></i> ${liveModuleName(q)}</span>` : ''}
            <div class="cc-subject">${q.subject || 'Quiz'}</div>
            <h4>${q.name}</h4>
            ${q.liveLabel ? `<span class="lc-label" style="color:${cardColor};background:rgba(${cardColorRgb},0.12);"><i class="fa-solid fa-tag"></i> ${q.liveLabel}</span>` : ''}
          </div>
          <div class="cc-meta">
            ${metaTag}
            <span class="lc-start"><i class="fa-solid fa-play"></i> Start</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers to open quiz from main list
  liveRail.querySelectorAll('.live-card').forEach((card) => {
    card.addEventListener('click', () => {
      const quizId = card.dataset.quizId;
      const quiz = LIVE_QUIZZES.get(quizId);
      if (quiz) {
        const target = [...document.querySelectorAll('.quiz-card')].find(
          (c) => (c.querySelector('h3') || {}).textContent?.trim() === quiz.name
        );
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Simulate a click to open the quiz
          setTimeout(() => {
            target.click();
          }, 300);
        }
      }
    });
  });
  
  // Update countdown every 30 seconds (clear any previous interval first —
  // renderLiveSection can be called repeatedly as new cards are scanned).
  if (window.__qlCountdownInterval) clearInterval(window.__qlCountdownInterval);
  window.__qlCountdownInterval = setInterval(() => {
    liveRail.querySelectorAll('.live-card').forEach((card) => {
      const quizId = card.dataset.quizId;
      const quiz = LIVE_QUIZZES.get(quizId);
      if (quiz && liveStatus(quiz) === 'live') {
        const countdown = card.querySelector('.lc-countdown');
        if (countdown) {
          countdown.textContent = formatCountdown(quiz.liveEnd);
        }
      }
    });
  }, 30000);
}

// ------------------------------------------------------------------------
// Pre-quiz "Live Notes" banner — a big rich announcement shown right
// before a student enters a live quiz. Admin-authored (title / subtitle /
// body / images), dismissed with an animated FontAwesome handshake button.
// ------------------------------------------------------------------------
const noteStyle = document.createElement('style');
noteStyle.textContent = `
  @keyframes ql-note-in { from { opacity: 0; transform: translateY(18px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes ql-note-backdrop-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ql-shake-wiggle {
    0%, 100% { transform: rotate(0deg) scale(1); }
    15% { transform: rotate(-14deg) scale(1.08); }
    30% { transform: rotate(12deg) scale(1.08); }
    45% { transform: rotate(-10deg) scale(1.05); }
    60% { transform: rotate(8deg) scale(1.05); }
    75% { transform: rotate(-4deg) scale(1.02); }
  }
  @keyframes ql-shake-glow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(var(--note-color-rgb,255,0,0),.55); }
    50% { box-shadow: 0 0 0 10px rgba(var(--note-color-rgb,255,0,0),0); }
  }
  @keyframes ql-shine {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }

  .ql-note-overlay {
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(10, 10, 14, .62);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    padding: 24px; animation: ql-note-backdrop-in .25s ease both;
  }
  .ql-note-card {
    --note-color: #ff0000; --note-color-rgb: 255,0,0;
    width: 100%; max-width: 560px; max-height: 88vh; overflow-y: auto;
    background: #fff; border-radius: 24px; position: relative;
    box-shadow: 0 30px 60px -15px rgba(0,0,0,.4), 0 0 0 1px rgba(var(--note-color-rgb),.15);
    animation: ql-note-in .35s cubic-bezier(.2,.9,.25,1) both;
  }
  body.dark .ql-note-card { background: #1b1c22; }
  .ql-note-hero {
    position: relative; padding: 30px 28px 22px;
    background: linear-gradient(135deg, rgba(var(--note-color-rgb),.95), rgba(var(--note-color-rgb),.65) 60%, rgba(var(--note-color-rgb),.4));
    border-radius: 24px 24px 0 0; color: #fff; overflow: hidden;
  }
  .ql-note-hero::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,.25) 45%, transparent 60%);
    background-size: 250% 100%;
    animation: ql-shine 3.2s ease-in-out infinite;
    pointer-events: none;
  }
  .ql-note-card h1.ql-note-title {
    margin: 0; font-size: 26px; line-height: 1.18; font-weight: 900;
    letter-spacing: -.01em; position: relative;
  }
  .ql-note-card h2.ql-note-subtitle {
    margin: 8px 0 0; font-size: 14.5px; font-weight: 600; opacity: .95; line-height: 1.4;
    position: relative;
  }
  .ql-note-body-wrap { padding: 22px 28px 8px; color: #23262b; }
  body.dark .ql-note-body-wrap { color: #e7e9ec; }
  .ql-note-body-wrap p { margin: 0 0 12px; font-size: 14.5px; line-height: 1.65; }
  .ql-note-body-wrap p:last-child { margin-bottom: 0; }
  .ql-note-gallery {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px; padding: 4px 28px 24px;
  }
  .ql-note-gallery img {
    width: 100%; height: 130px; object-fit: cover; border-radius: 14px;
    box-shadow: 0 6px 16px -8px rgba(0,0,0,.35);
    border: 1px solid rgba(var(--note-color-rgb),.15);
  }
  .ql-note-gallery.single img { height: 200px; }
  .ql-note-footer {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    padding: 10px 28px 26px;
  }
  .ql-note-skip {
    display: inline-flex; align-items: center; gap: 10px;
    border: none; cursor: pointer; padding: 12px 26px; border-radius: 999px;
    background: rgba(var(--note-color-rgb),.1); color: var(--note-color);
    font-size: 14px; font-weight: 800;
    transition: transform .15s ease, background .15s ease;
  }
  .ql-note-skip:hover { transform: translateY(-1px) scale(1.02); background: rgba(var(--note-color-rgb),.16); }
  .ql-note-skip i {
    font-size: 17px;
    animation: ql-shake-wiggle 1.8s ease-in-out infinite, ql-shake-glow 1.8s ease-in-out infinite;
    border-radius: 50%;
  }
`;
document.head.appendChild(noteStyle);

function showLiveNoteModal(quiz, proceed) {
  const hasContent = quiz.liveNoteTitle || quiz.liveNoteBody || (quiz.liveNoteImages && quiz.liveNoteImages.length);
  if (!quiz.liveNoteEnabled || !hasContent) { proceed(); return; }

  const color = quiz.liveCardColor || '#4C6EF5';
  const colorRgb = hexToRgb(color);

  const overlay = document.createElement('div');
  overlay.className = 'ql-note-overlay';

  const images = quiz.liveNoteImages || [];
  const galleryHtml = images.length
    ? `<div class="ql-note-gallery${images.length === 1 ? ' single' : ''}">${images
        .map((src) => `<img src="${escapeHtml(src)}" alt="" loading="lazy" onerror="this.remove()">`)
        .join('')}</div>`
    : '';

  overlay.innerHTML = `
    <div class="ql-note-card" style="--note-color:${color};--note-color-rgb:${colorRgb};" role="dialog" aria-modal="true" aria-label="Live quiz notes">
      <div class="ql-note-hero">
        ${quiz.liveNoteTitle ? `<h1 class="ql-note-title">${escapeHtml(quiz.liveNoteTitle)}</h1>` : ''}
        ${quiz.liveNoteSubtitle ? `<h2 class="ql-note-subtitle">${escapeHtml(quiz.liveNoteSubtitle)}</h2>` : ''}
      </div>
      ${quiz.liveNoteBody ? `<div class="ql-note-body-wrap">${formatNoteBody(quiz.liveNoteBody)}</div>` : ''}
      ${galleryHtml}
      <div class="ql-note-footer">
        <button type="button" class="ql-note-skip">
          <i class="fa-solid fa-handshake"></i>
          <span>Got it, let's go</span>
        </button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.remove();
    proceed();
  };

  // The handshake button is the only way to dismiss this — no X, no Esc,
  // no backdrop tap. Intentional: the admin's note has to be acknowledged,
  // not swiped away by accident.
  overlay.querySelector('.ql-note-skip').addEventListener('click', close);

  document.body.appendChild(overlay);
}

// Intercept clicks on live quiz cards that have a notes banner enabled;
// show the banner first, then let the original click through once
// it's dismissed (via the handshake button — the only way to close it).
document.addEventListener('click', (e) => {
  const card = e.target.closest('.quiz-card');
  if (!card) return;

  // Programmatic replay after the banner was dismissed — let it through.
  if (card.dataset.qlNoteBypass) {
    delete card.dataset.qlNoteBypass;
    return;
  }
  // Don't intercept the pin button itself.
  if (e.target.closest('.ql-pin-btn')) return;

  const quizId = card.dataset.quizId;
  const quiz = quizId ? LIVE_QUIZZES.get(quizId) : null;
  if (!quiz || liveStatus(quiz) !== 'live' || !quiz.liveNoteEnabled) return;

  const hasContent = quiz.liveNoteTitle || quiz.liveNoteBody || (quiz.liveNoteImages && quiz.liveNoteImages.length);
  if (!hasContent) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  showLiveNoteModal(quiz, () => {
    card.dataset.qlNoteBypass = '1';
    card.click();
  });
}, true);

// ------------------------------------------------------------------------
// Scan quiz cards: attach LIVE badge + countdown + pin toggle. Cards are
// reconciled (not just scanned once) so a quiz that goes live, ends, or
// changes color/label is reflected on the next poll without a page reload.
// ------------------------------------------------------------------------
console.log('[quiz-live] script loaded and running');

function buildLiveQuizEntry(q, name) {
  return {
    id: q.id,
    name: name || q.name,
    liveEnd: q.liveEnd,
    subject: q.subject,
    subjectId: q.subjectId,
    moduleName: q.moduleName,
    liveStart: q.liveStart,
    liveLabel: q.liveLabel,
    liveCardColor: q.liveCardColor || '#4C6EF5',
    pinnedByAdmin: !!q.pinnedByAdmin,
    liveNoteEnabled: !!q.liveNoteEnabled,
    liveNoteTitle: q.liveNoteTitle || '',
    liveNoteSubtitle: q.liveNoteSubtitle || '',
    liveNoteBody: q.liveNoteBody || '',
    liveNoteImages: normalizeImageList(q.liveNoteImages),
  };
}

// (Re)applies badge/countdown/pin/admin-pin visuals to a single card based
// on the quiz's current data. Safe to call repeatedly — clears anything it
// previously added before re-adding, so it can be used both for first
// paint and for reconciling after a poll.
function applyCardVisuals(card, q) {
  card.querySelectorAll('.ql-live-badge, .ql-live-countdown, .ql-pin-btn, .ql-admin-pin-badge')
    .forEach((el) => el.remove());
  if (card.__qlCountdownInterval) {
    clearInterval(card.__qlCountdownInterval);
    card.__qlCountdownInterval = null;
  }

  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  card.dataset.quizId = q.id;

  if (q.pinnedByAdmin) {
    const adminPinBadge = document.createElement('div');
    adminPinBadge.className = 'ql-admin-pin-badge';
    adminPinBadge.innerHTML = '<i class="fa-solid fa-thumbtack"></i>Pinned';
    adminPinBadge.title = 'Pinned by admin for everyone';
    card.appendChild(adminPinBadge);
  }

  if (liveStatus(q) === 'live') {
    const cardColor = q.liveCardColor || '#4C6EF5';
    card.style.setProperty('--ql-color', cardColor);
    card.style.setProperty('--ql-color-rgb', hexToRgb(cardColor));

    const badge = document.createElement('div');
    badge.className = 'ql-live-badge';
    badge.innerHTML = '<span class="ql-live-dot"></span>Live';
    card.appendChild(badge);

    const countdown = document.createElement('div');
    countdown.className = 'ql-live-countdown';
    countdown.textContent = formatCountdown(q.liveEnd);
    card.appendChild(countdown);
    card.__qlCountdownInterval = setInterval(() => {
      countdown.textContent = formatCountdown(q.liveEnd);
    }, 30000);

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'ql-pin-btn';
    const setPinVisual = () => {
      const isPinned = PERSONAL_PINS.has(q.id);
      pinBtn.classList.toggle('pinned', isPinned);
      pinBtn.innerHTML = `<i class="fa-solid fa-thumbtack"></i>`;
      pinBtn.title = isPinned ? 'Unpin this quiz' : 'Pin this quiz';
    };
    setPinVisual();
    pinBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      await togglePersonalPin(q.id);
      setPinVisual();
    });
    card.appendChild(pinBtn);
  }
}

function scanQuizCards() {
  const cards = document.querySelectorAll('.quiz-card:not([data-ql-scanned])');
  if (cards.length) console.log(`[quiz-live] found ${cards.length} unscanned .quiz-card element(s)`);
  cards.forEach((card) => {
    card.setAttribute('data-ql-scanned', '1');
    const nameEl = card.querySelector('h3');
    const name = nameEl ? nameEl.textContent.trim() : null;
    if (!name) {
      console.warn('[quiz-live] a .quiz-card was found but has no h3 (or it was empty) — cannot match it to a Firestore quiz. Card:', card);
      return;
    }

    getQuizByName(name).then((q) => {
      // No match = this quiz is just not live or pinned right now, which is
      // the normal case for most cards — nothing to warn about.
      if (!q) return;
      if (q.liveStart || q.liveEnd) {
        console.log(`[quiz-live] "${name}" liveStatus=${liveStatus(q)} liveStart=${q.liveStart} liveEnd=${q.liveEnd}`);
      }

      LIVE_QUIZZES.set(q.id, buildLiveQuizEntry(q, name));
      renderLiveSection();
      applyCardVisuals(card, q);
    });
  });
}

// Ordinary (non-live) load: scan cards once against the data fetched at
// page load. The MutationObserver still catches cards that render late
// (e.g. after an async list render) and applies visuals to them using the
// SAME cached data — it does not trigger any additional Firestore reads,
// since getAllQuizzes() only re-fetches when called with force=true, which
// nothing does anymore.
new MutationObserver(() => {
  scanQuizCards();
}).observe(document.body, { childList: true, subtree: true });
scanQuizCards();
loadPersonalPins();

// One-off diagnostic: total .quiz-card count on the page 2s after load,
// regardless of scan state — helps tell "wrong selector" apart from
// "cards render after this ran".
setTimeout(() => {
  const total = document.querySelectorAll('.quiz-card').length;
  console.log(`[quiz-live] diagnostic: total .quiz-card elements on page = ${total}`);
  if (total === 0) {
    console.warn('[quiz-live] no .quiz-card elements exist on this page at all. Either this script is ' +
      'loaded on the wrong page, quizzes render later than 2s after load, or the app uses a different ' +
      'class name for quiz cards than ".quiz-card" — inspect the DOM and update the selector in quiz-live.js if needed.');
  }
}, 2000);
