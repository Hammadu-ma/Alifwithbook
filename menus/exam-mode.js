/* =========================================================================
   ALIF Med — IN-APP TIMED EXAM (menus/exam-mode.js)
   The old standalone alif_exam.html page, rebuilt as a first-class screen of
   the app. It reuses the app's own session, Firestore instance, lock engine
   and question cache, so opening an exam costs ZERO extra reads when the
   quiz is already cached.

   Public API:
     startExam(subjectId, quizId)        -> opens the exam flow (setup -> exam -> results)
     hasExamInProgress(subjectId, quizId)-> true if a resumable attempt exists

   Mode rules (decided by the callers, admin setting is never modified):
     quiz.isExam === true  -> always exam mode (home-screen.js -> startExam)
     otherwise             -> student chooses Quiz or Exam (exam-cards.js)

   Attempts are written to their own `examAttempts` collection so they never
   collide with practice progress in `results`.
   ========================================================================= */
import { db } from './cloud-sync.js';
import { collection, addDoc, serverTimestamp, marked, DOMPurify } from './runtime-ext.js';
import { getStoredStudent, getAuthUser } from './auth.js';
import { LSC, lockBodyScroll, unlockBodyScroll } from './cache.js';
import { loadQuestions } from './onboarding-tour.js';
import { ALL_QUIZZES } from './picker-screen.js';
import { getQuizLockMessage } from './lock.js';
import { pushModalState, popModalState } from './modal-backbutton.js';

const EXAM_CSS = "#alifExam *{-webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; box-sizing: border-box; margin: 0;}\n#alifExam button,#alifExam input,#alifExam select,#alifExam textarea{color: inherit; background: none; border: none;}\n#alifExam *:focus{outline: none;}\n#alifExam *:focus-visible{outline: 2px solid var(--artery); outline-offset: 2px; border-radius: 6px;}\n#alifExam{scroll-behavior: smooth; width: 100%;}\n#alifExam{margin: 0; width: 100%; min-height: 100vh; overflow-x: hidden;\n  font-family: 'Source Sans 3', -apple-system, BlinkMacSystemFont, sans-serif;\n  -webkit-font-smoothing: antialiased;\n  transition: background .3s ease, color .25s ease;}\n#alifExam ::selection{background: color-mix(in srgb, var(--artery) 22%, transparent);}\n#alifExam button{font-family: inherit; cursor: pointer;}\n#alifExam input{font-family: inherit;}\n#alifExam .hidden{display: none !important;}\n#alifExam{--paper: #FFFFFF; --paper-2: #F3F4F6; --ink: #111318;\n  --ink-soft: rgba(11, 21, 48,.66); --ink-faint: rgba(11, 21, 48,.44);\n  --card: #FFFFFF; --card-border: rgba(11, 21, 48,.09);\n  --shadow: 0 1px 2px rgba(11, 21, 48,.05), 0 10px 28px -16px rgba(11, 21, 48,.28);\n  --shadow-lg: 0 20px 40px -16px rgba(11, 21, 48,.4);\n  --right: #2f7a52; --right-soft: #ddebe1;\n  --wrong: #ae3b33; --wrong-soft: #f3deda;\n  --gold: #C6890C; --lock: #8a6a2e; --lock-soft: #f1e6c9;\n  --artery: #2A62FF; --vein: #E85A3B; --portal: #C6890C;\n  --c0: #2A62FF; --c1: #E85A3B; --c2: #C6890C; --c3: #3f6b52; --c4: #6b4c7a;\n  --c5: #4f5b6b; --c6: #1f7a72; --c7: #a8447a; --c8: #8a5a3f; --c9: #6b7a3f;\n  --c10: #2f6b8a; --c11: #7a3f5c;\n  --bg-grad-1: rgba(42, 98, 255,.05); --bg-grad-2: rgba(232,90,59,.06);\n  --input-bg: var(--paper); --input-border: var(--card-border);\n  --explain-bg: #F6F7F9; --explain-bg-accent: #ECEEF2; --explain-text: #142433;\n  --explain-text-body: #4a5568; --explain-text-soft: rgba(20,36,51,.6); --explain-border: rgba(20,36,51,.12);\n  --radius-sm: 10px; --radius-md: 18px; --radius-lg: 26px; --radius-pill: 999px;\n  --ease: cubic-bezier(0.16, 1, 0.3, 1);\n  --timer-warn: #ae3b33;}\nbody.dark #alifExam{--paper: #000000; --paper-2: #0D0D0F; --ink: #F2F2F5;\n  --ink-soft: rgba(242,242,245,.68); --ink-faint: rgba(242,242,245,.44);\n  --card: #0D0D0F; --card-border: rgba(242,242,245,.1);\n  --shadow: 0 1px 3px rgba(0,0,0,.4), 0 12px 32px -16px rgba(0,0,0,.7);\n  --shadow-lg: 0 24px 48px -16px rgba(0,0,0,.7);\n  --right: #4ba37a; --right-soft: #1e3a2e;\n  --wrong: #c94f47; --wrong-soft: #3d2222;\n  --gold: #F0B429; --lock: #b8943f; --lock-soft: #2f281a;\n  --artery: #2A62FF; --vein: #FF6B4A; --portal: #F0B429;\n  --c0: #2A62FF; --c1: #FF6B4A; --c2: #F0B429; --c3: #5a9b7a; --c4: #8f6b9e;\n  --c5: #788a94; --c6: #2fa89c; --c7: #d666a3; --c8: #c98a5e; --c9: #9bab5e;\n  --c10: #4a9dc7; --c11: #b06690;\n  --bg-grad-1: rgba(42, 98, 255,.1); --bg-grad-2: rgba(255,107,74,.1);\n  --input-bg: var(--paper-2); --input-border: var(--card-border);\n  --explain-bg: #16232F; --explain-bg-accent: #1D2E3C; --explain-text: #DCE7F0;\n  --explain-text-body: #9aa8b8; --explain-text-soft: rgba(220,231,240,.6); --explain-border: rgba(220,231,240,.14);}\n#alifExam{background:\n    radial-gradient(1200px 600px at 90% -10%, var(--bg-grad-1), transparent 60%),\n    radial-gradient(1000px 700px at -10% 20%, var(--bg-grad-2), transparent 55%),\n    var(--paper);\n  color: var(--ink);}\n#alifExam h1,#alifExam h2,#alifExam h3,#alifExam .display{font-family: 'Fraunces', serif; letter-spacing: -.01em;}\n#alifExam .mono{font-family: 'JetBrains Mono', monospace;}\n#alifExam .exm-screen{min-height: 100vh; width: 100%; display: flex; flex-direction: column; align-items: center;}\n#alifExam .wrap{width: 100%; max-width: 720px; margin: 0 auto; padding: 24px 20px 48px;}\n#alifExam .brandmark{display: flex; align-items: center; gap: 10px; margin-bottom: 28px;}\n#alifExam .brandmark .mark{width: 38px; height: 38px; border-radius: 11px; background:  var(--artery);\n  display: flex; align-items: center; justify-content: center; color: #fff; font-family: 'Fraunces', serif; font-weight: 700; font-size: 17px;\n  box-shadow: var(--shadow);}\n#alifExam .brandmark .name{font-weight: 700; font-size: 15.5px; letter-spacing: -.01em;}\n#alifExam .brandmark .sub{font-size: 11.5px; color: var(--ink-faint); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin-top: -1px;}\n#alifExam .card{background: var(--card); border: 1px solid var(--card-border); border-radius: var(--radius-lg);\n  box-shadow: var(--shadow); padding: 26px;}\n#alifExam .btn{display: inline-flex; align-items: center; justify-content: center; gap: 8px;\n  border-radius: var(--radius-pill); border: 1px solid transparent; font-weight: 600; font-size: 14.5px;\n  padding: 13px 22px; transition: transform .15s var(--ease), opacity .15s ease, background .15s ease; user-select: none;}\n#alifExam .btn:active{transform: scale(.97);}\n#alifExam .btn:disabled{opacity: .45; pointer-events: none;}\n#alifExam .btn-primary{background: var(--ink); color: var(--paper);}\nbody.dark #alifExam .btn-primary{background: var(--card); color: var(--ink); border-color: var(--card-border);}\n#alifExam .btn-ghost{background: transparent; color: var(--ink); border-color: var(--card-border);}\n#alifExam .btn-soft{background: var(--paper-2); color: var(--ink);}\n#alifExam .btn-danger{background: var(--wrong-soft); color: var(--wrong);}\n#alifExam .btn-block{width: 100%;}\n#alifExam .btn-sm{padding: 9px 16px; font-size: 13.5px;}\n#alifExam .exm-markdown-body p{margin: 0 0 .6em; line-height: 1.6;}\n#alifExam .exm-markdown-body p:last-child{margin-bottom: 0;}\n#alifExam .exm-markdown-body strong{font-weight: 700;}\n#alifExam .exm-markdown-body code{background: var(--paper-2); padding: 1px 5px; border-radius: 5px; font-size: .92em;}\n#alifExam .exm-markdown-body ul,#alifExam .exm-markdown-body ol{padding-left: 1.3em; margin: .4em 0;}\n#alifExam .gate-card{text-align: center;}\n#alifExam .gate-card .icon-badge{width: 56px; height: 56px; border-radius: 16px; margin: 0 auto 16px; background: var(--paper-2);\n  display: flex; align-items: center; justify-content: center; font-size: 21px; color: var(--artery);}\n#alifExam .gate-card h1{font-size: 22px; margin-bottom: 6px;}\n#alifExam .gate-card p.lede{color: var(--ink-soft); font-size: 14.5px; line-height: 1.5; margin-bottom: 22px;}\n#alifExam .field-input{width: 100%; padding: 14px 16px; border-radius: var(--radius-md); border: 1.5px solid var(--input-border);\n  background: var(--input-bg); color: var(--ink); font-size: 15px; text-align: center; letter-spacing: .02em;\n  transition: border-color .15s ease;}\n#alifExam .field-input:focus{border-color: var(--artery);}\n#alifExam .gate-error{display: none; margin-top: 12px; padding: 10px 14px; border-radius: var(--radius-sm);\n  background: var(--wrong-soft); color: var(--wrong); font-size: 13.5px; font-weight: 600;}\n#alifExam .gate-error.show{display: block;}\n#alifExam .welcome-back{display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: var(--radius-md);\n  background: var(--paper-2); margin-bottom: 18px; text-align: left;}\n#alifExam .welcome-back .avatar{width: 40px; height: 40px; border-radius: 50%; background: var(--artery); color: #fff; flex-shrink: 0;\n  display: flex; align-items: center; justify-content: center; font-weight: 700; font-family: 'Fraunces', serif;}\n#alifExam .welcome-back .who b{display: block; font-size: 14.5px;}\n#alifExam .welcome-back .who span{font-size: 12.5px; color: var(--ink-faint);}\n#alifExam .gate-actions{margin-top: 18px; display: flex; flex-direction: column; gap: 10px;}\n#alifExam .switch-link{font-size: 13px; color: var(--ink-faint); margin-top: 14px;}\n#alifExam .switch-link a{color: var(--artery); font-weight: 600; cursor: pointer; text-decoration: none;}\n#alifExam .picker-head h1{font-size: 24px; margin-bottom: 4px;}\n#alifExam .picker-head p{color: var(--ink-soft); font-size: 14px; margin-bottom: 20px;}\n#alifExam .subject-scroller{display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 18px;}\n#alifExam .subject-chip{flex-shrink: 0; padding: 9px 16px; border-radius: var(--radius-pill); background: var(--paper-2);\n  color: var(--ink-soft); font-size: 13.5px; font-weight: 600; white-space: nowrap; border: 1px solid transparent;}\n#alifExam .subject-chip.active{background: var(--ink); color: var(--paper);}\nbody.dark #alifExam .subject-chip.active{background: var(--card); color: var(--ink); border-color: var(--card-border);}\n#alifExam .exam-tile-list{display: flex; flex-direction: column; gap: 10px;}\n#alifExam .exam-tile{display: flex; align-items: center; gap: 14px; padding: 16px; border-radius: var(--radius-md);\n  background: var(--card); border: 1px solid var(--card-border); box-shadow: var(--shadow); text-align: left;\n  transition: transform .15s var(--ease);}\n#alifExam .exam-tile:active{transform: scale(.98);}\n#alifExam .exam-tile .tile-icon{width: 44px; height: 44px; border-radius: 13px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;\n  color: #fff; font-size: 16px;}\n#alifExam .exam-tile .tile-body{flex: 1; min-width: 0;}\n#alifExam .exam-tile .tile-body b{display: block; font-size: 15px; margin-bottom: 2px;}\n#alifExam .exam-tile .tile-body span{font-size: 12.5px; color: var(--ink-faint);}\n#alifExam .exam-tile .tile-arrow{color: var(--ink-faint); font-size: 14px;}\n#alifExam .exam-tile.locked{opacity: .72;}\n#alifExam .exam-tile.locked .tile-body span{color: var(--lock); font-weight: 600;}\n@keyframes exm-shakeX{ 10%,90%{transform:translateX(-1px)} 20%,80%{transform:translateX(2px)} 30%,50%,70%{transform:translateX(-4px)} 40%,60%{transform:translateX(4px)} }\n#alifExam .exam-tile.shake{animation: exm-shakeX .5s cubic-bezier(.36,.07,.19,.97);}\n#alifExam .empty-note{text-align: center; padding: 40px 20px; color: var(--ink-faint); font-size: 14px;}\n#alifExam .setup-hero{text-align: center; margin-bottom: 22px;}\n#alifExam .setup-hero .exm-eyebrow{font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--vein); margin-bottom: 8px;}\n#alifExam .setup-hero h1{font-size: 25px; margin-bottom: 6px;}\n#alifExam .setup-hero p{color: var(--ink-soft); font-size: 14px;}\n#alifExam .setup-stats{display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 20px 0;}\n#alifExam .setup-stat{text-align: center; padding: 16px 8px; border-radius: var(--radius-md); background: var(--paper-2);}\n#alifExam .setup-stat .exm-num{font-family: 'Fraunces', serif; font-size: 24px; font-weight: 600;}\n#alifExam .setup-stat .exm-lbl{font-size: 11.5px; color: var(--ink-faint); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px;}\n#alifExam .rule-list{display: flex; flex-direction: column; gap: 12px; margin: 20px 0;}\n#alifExam .rule-item{display: flex; gap: 12px; align-items: flex-start; font-size: 13.5px; color: var(--ink-soft); line-height: 1.5;}\n#alifExam .rule-item i{color: var(--artery); margin-top: 2px; width: 16px; flex-shrink: 0;}\n#alifExam .cat-preview{display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 4px;}\n#alifExam .cat-pill{font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: var(--radius-pill); color: #fff;}\n#alifExam .exam-topbar{position: sticky; top: 0; z-index: 20; width: 100%; background: color-mix(in srgb, var(--paper) 88%, transparent);\n  backdrop-filter: blur(14px); border-bottom: 1px solid var(--card-border);}\n#alifExam .exam-topbar-inner{max-width: 720px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px;}\n#alifExam .exam-progress-txt{font-size: 12.5px; font-weight: 700; color: var(--ink-soft);}\n#alifExam .timer-pill{display: flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: var(--radius-pill);\n  background: var(--paper-2); font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 14.5px;\n  transition: background .25s ease, color .25s ease;}\n#alifExam .timer-pill i{font-size: 12px;}\n#alifExam .timer-pill.warn{background: var(--wrong-soft); color: var(--wrong); animation: exm-timerPulse 1s ease-in-out infinite;}\n@keyframes exm-timerPulse{ 0%,100% { opacity: 1; } 50% { opacity: .6; } }\n#alifExam .palette-toggle-btn{width: 34px; height: 34px; border-radius: 10px; background: var(--paper-2); color: var(--ink-soft);\n  display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;}\n#alifExam .exam-progress-bar{height: 3px; background: var(--paper-2); width: 100%;}\n#alifExam .exam-progress-bar-fill{height: 100%; background: var(--artery); transition: width .25s var(--ease);}\n#alifExam .qpanel{padding: 26px 4px 14px; user-select: none; -webkit-user-select: none;}\n#alifExam .qpanel .qmeta{display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap;}\n#alifExam .qpanel .cat-tag{font-size: 11.5px; font-weight: 700; padding: 4px 11px; border-radius: var(--radius-pill); color: #fff;}\n#alifExam .qpanel .flag-btn{margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;\n  color: var(--ink-faint); padding: 6px 12px; border-radius: var(--radius-pill); background: var(--paper-2);}\n#alifExam .qpanel .flag-btn.on{background: var(--wrong-soft); color: var(--wrong); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--wrong) 35%, transparent) inset;}\n#alifExam .qpanel .qtext{font-size: 17.5px; line-height: 1.55; font-weight: 500; margin-bottom: 22px;}\n#alifExam .exm-q-stem-image{display: block; max-width: 100%; max-height: 360px; width: auto; object-fit: contain; border-radius: 14px; border: 1px solid var(--card-border); margin: 0 0 16px; box-shadow: var(--shadow);}\n#alifExam .opt-list{display: flex; flex-direction: column; gap: 10px; margin-bottom: 24px;}\n#alifExam .opt-btn{display: flex; align-items: center; gap: 13px; width: 100%; text-align: left; padding: 15px 16px;\n  border-radius: var(--radius-md); border: 1.5px solid var(--card-border); background: var(--card);\n  transition: border-color .15s ease, background .15s ease, transform .1s ease;}\n#alifExam .opt-btn:active{transform: scale(.99);}\n#alifExam .opt-btn .exm-letter{width: 28px; height: 28px; border-radius: 9px; background: var(--paper-2); color: var(--ink-soft);\n  display: flex; align-items: center; justify-content: center; font-size: 12.5px; font-weight: 700; flex-shrink: 0;\n  transition: background .15s ease, color .15s ease;}\n#alifExam .opt-btn .opt-text{font-size: 14.5px; line-height: 1.5; flex: 1;}\n#alifExam .opt-btn.selected{border-color: var(--artery); background: color-mix(in srgb, var(--artery) 6%, var(--card));}\n#alifExam .opt-btn.selected .exm-letter{background: var(--artery); color: #fff;}\n#alifExam .exam-nav-bar{position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;\n  display: flex; justify-content: center;\n  padding: 0 16px calc(14px + env(safe-area-inset-bottom));\n  pointer-events: none;}\n#alifExam .exam-nav-inner{width: auto; max-width: calc(100% - 32px); margin: 0 auto; display: flex; gap: 12px;\n  pointer-events: auto;\n  padding: 10px; border-radius: var(--radius-pill);\n  background: color-mix(in srgb, var(--card) 55%, transparent);\n  border: 1px solid color-mix(in srgb, var(--card-border) 70%, transparent);\n  backdrop-filter: blur(20px) saturate(180%);\n  -webkit-backdrop-filter: blur(20px) saturate(180%);\n  box-shadow: 0 12px 32px -8px rgba(0,0,0,.18), 0 2px 8px -2px rgba(0,0,0,.08), inset 0 1px 0 color-mix(in srgb, #fff 25%, transparent);}\nbody.dark #alifExam .exam-nav-inner{background: color-mix(in srgb, var(--card) 45%, transparent);\n  box-shadow: 0 12px 32px -8px rgba(0,0,0,.5), 0 2px 8px -2px rgba(0,0,0,.3), inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);}\n#alifExam .exam-nav-inner .btn{flex: 0 0 auto; padding: 16px 38px; font-size: 15px;}\n#alifExam .exam-nav-inner .btn-ghost{background: color-mix(in srgb, var(--paper-2) 70%, transparent); border-color: transparent;}\n#alifExam .exam-body{padding-bottom: 88px;}\n#alifExam .palette-drawer{position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; justify-content: center;\n  background: rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .2s ease;}\n#alifExam .palette-drawer.show{opacity: 1; pointer-events: auto;}\n#alifExam .palette-sheet{width: 100%; max-width: 720px; max-height: 78vh; background: var(--card); border-radius: 24px 24px 0 0;\n  padding: 10px 20px calc(20px + env(safe-area-inset-bottom)); overflow-y: auto; transform: translateY(100%);\n  transition: transform .25s var(--ease), max-height .3s var(--ease), border-radius .3s ease; box-shadow: var(--shadow-lg);}\n#alifExam .palette-drawer.show .palette-sheet{transform: translateY(0);}\n#alifExam .palette-sheet.full{max-height: 100dvh; height: 100dvh; border-radius: 16px 16px 0 0;\n  padding-top: calc(10px + env(safe-area-inset-top));}\n#alifExam .sheet-handle{width: 40px; height: 5px; border-radius: 3px; background: var(--card-border);\n  margin: 0 auto 14px; cursor: grab; touch-action: none; flex-shrink: 0;}\n#alifExam .sheet-handle:active{cursor: grabbing;}\n#alifExam .palette-sheet h3{font-size: 16.5px; margin-bottom: 4px;}\n#alifExam .palette-legend{display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--ink-faint); margin: 10px 0 16px;}\n#alifExam .palette-legend span{display: inline-flex; align-items: center; gap: 5px;}\n#alifExam .palette-legend i{width: 9px; height: 9px; border-radius: 3px; display: inline-block;}\n#alifExam .palette-grid{display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px;}\n#alifExam .palette-num{aspect-ratio: 1; border-radius: 10px; background: var(--paper-2); color: var(--ink-soft); font-weight: 700;\n  font-size: 13px; display: flex; align-items: center; justify-content: center; position: relative; border: 1.5px solid transparent;\n  transition: background .15s ease, color .15s ease, border-color .15s ease, box-shadow .15s ease, transform .1s ease;}\n#alifExam .palette-num.answered{background: var(--right); color: #fff; border-color: var(--right);\n  box-shadow: 0 3px 10px -3px color-mix(in srgb, var(--right) 55%, transparent);}\n#alifExam .palette-num.current{border-color: var(--artery); box-shadow: 0 0 0 3px color-mix(in srgb, var(--artery) 18%, transparent); transform: scale(1.05);}\n#alifExam .palette-num.flagged{box-shadow: 0 0 0 2px var(--card), 0 0 0 3.5px var(--wrong);}\n#alifExam .palette-num.flagged::after{content: ''; position: absolute; top: -4px; right: -4px; width: 12px; height: 12px; border-radius: 50%;\n  background: var(--wrong); border: 2px solid var(--card); box-shadow: 0 2px 5px -1px color-mix(in srgb, var(--wrong) 60%, transparent);}\n@media (min-width: 960px){#alifExam .exam-body{display: grid; grid-template-columns: 3fr 1fr; align-items: start; gap: 32px;\n    max-width: 1100px; margin: 0 auto; padding: 30px 24px 110px;}\n#alifExam .exam-body .wrap{padding: 0; margin: 0;}\n#alifExam .palette-toggle-btn{display: none;}\n#alifExam .palette-drawer{position: sticky; top: 88px; z-index: 5; inset: auto; background: none; opacity: 1; pointer-events: auto;\n    display: block; width: 100%; flex-shrink: 0; align-self: start;\n    max-height: calc(100vh - 104px);}\n#alifExam .palette-sheet{width: 100%; max-width: none; max-height: calc(100vh - 104px); overflow-y: auto;\n    transform: none; border-radius: 22px; box-shadow: var(--shadow-lg);\n    border: 1px solid var(--card-border); padding: 24px;}\n#alifExam .palette-sheet.full{max-height: calc(100vh - 104px); height: auto; border-radius: 22px; padding-top: 24px;}\n#alifExam .sheet-handle{display: none;}\n#alifExam .palette-grid{gap: 10px; grid-template-columns: repeat(5, 1fr);}\n#alifExam .palette-num{border-radius: 12px; font-size: 13.5px;}\n#alifExam .exam-topbar-inner{max-width: 1100px;}}\n#alifExam .modal-overlay{position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.45); display: flex; align-items: center;\n  justify-content: center; padding: 20px; opacity: 0; pointer-events: none; transition: opacity .2s ease;}\n#alifExam .modal-overlay.show{opacity: 1; pointer-events: auto;}\n#alifExam .modal-card{width: 100%; max-width: 380px; background: var(--card); border-radius: var(--radius-lg); padding: 26px;\n  box-shadow: var(--shadow-lg); transform: scale(.94); transition: transform .2s var(--ease);}\n#alifExam .modal-overlay.show .modal-card{transform: scale(1);}\n#alifExam .modal-card .modal-icon{width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center;\n  font-size: 19px; margin-bottom: 14px;}\n#alifExam .modal-card h3{font-size: 18px; margin-bottom: 8px;}\n#alifExam .modal-card p{font-size: 13.5px; color: var(--ink-soft); line-height: 1.5; margin-bottom: 20px;}\n#alifExam .modal-actions{display: flex; gap: 10px;}\n#alifExam .modal-actions .btn{flex: 1;}\n#alifExam .results-hero{text-align: center; padding: 6px 0 8px;}\n#alifExam .score-ring-wrap{position: relative; width: 168px; height: 168px; margin: 0 auto 18px;}\n#alifExam .score-ring-wrap svg{width: 100%; height: 100%; transform: rotate(-90deg);}\n#alifExam .score-ring-wrap .ring-bg{fill: none; stroke: var(--paper-2); stroke-width: 10;}\n#alifExam .score-ring-wrap .exm-ring-fill{fill: none; stroke: var(--artery); stroke-width: 10; stroke-linecap: round; transition: stroke-dashoffset 1s var(--ease);}\n#alifExam .score-ring-center{position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;}\n#alifExam .score-ring-center .exm-pct{font-family: 'Fraunces', serif; font-size: 36px; font-weight: 700; line-height: 1;}\n#alifExam .score-ring-center .exm-frac{font-size: 12.5px; color: var(--ink-faint); margin-top: 4px; font-weight: 600;}\n#alifExam .results-hero .verdict{font-size: 15.5px; font-weight: 700; margin-bottom: 2px;}\n#alifExam .results-hero .verdict-sub{font-size: 13px; color: var(--ink-soft); margin-bottom: 20px;}\n#alifExam .stat-row{display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 24px;}\n#alifExam .stat-chip{text-align: center; padding: 13px 6px; border-radius: var(--radius-md); background: var(--paper-2);}\n#alifExam .stat-chip .exm-n{font-family: 'Fraunces', serif; font-size: 19px; font-weight: 700;}\n#alifExam .stat-chip .exm-l{font-size: 10.5px; color: var(--ink-faint); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; margin-top: 2px;}\n#alifExam .stat-chip.right .exm-n{color: var(--right);}\n#alifExam .stat-chip.wrong .exm-n{color: var(--wrong);}\n#alifExam .stat-chip.skip .exm-n{color: var(--lock);}\n#alifExam .section-title{font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-faint); margin: 26px 0 12px;}\n#alifExam .cat-card{border: 1px solid var(--card-border); border-radius: var(--radius-md); padding: 16px 18px; margin-bottom: 10px; background: var(--card);}\n#alifExam .cat-card-head{display: flex; align-items: center; gap: 10px; margin-bottom: 10px;}\n#alifExam .cat-card-head .exm-dot{width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0;}\n#alifExam .cat-card-head b{font-size: 14.5px; flex: 1;}\n#alifExam .cat-card-head .badge{font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: var(--radius-pill);}\n#alifExam .badge.strong{background: var(--right-soft); color: var(--right);}\n#alifExam .badge.average{background: var(--lock-soft); color: var(--lock);}\n#alifExam .badge.weak{background: var(--wrong-soft); color: var(--wrong);}\n#alifExam .cat-bar{height: 7px; border-radius: 4px; background: var(--paper-2); overflow: hidden; display: flex; margin-bottom: 10px;}\n#alifExam .cat-bar div{height: 100%;}\n#alifExam .cat-card .cat-frac{font-size: 12px; color: var(--ink-faint); font-weight: 600; margin-bottom: 8px;}\n#alifExam .cat-card .advice{font-size: 13px; color: var(--ink-soft); line-height: 1.5;}\n#alifExam .cat-card .advice i{color: var(--artery); margin-right: 5px;}\n#alifExam .advice-block{border-radius: var(--radius-md); background: var(--explain-bg); border: 1px solid var(--explain-border); padding: 18px 20px; margin-bottom: 6px;}\n#alifExam .advice-block h4{font-size: 14.5px; color: var(--explain-text); margin-bottom: 8px; display: flex; align-items: center; gap: 8px;}\n#alifExam .advice-block p{font-size: 13.5px; color: var(--explain-text-body); line-height: 1.6;}\n#alifExam .advice-block ul{margin: 8px 0 0; padding-left: 1.2em;}\n#alifExam .advice-block li{font-size: 13.5px; color: var(--explain-text-body); line-height: 1.6; margin-bottom: 4px;}\n#alifExam .review-item{border: 1px solid var(--card-border); border-radius: var(--radius-md); margin-bottom: 10px; overflow: hidden; background: var(--card);}\n#alifExam .review-head{display: flex; align-items: center; gap: 12px; padding: 14px 16px;}\n#alifExam .review-head .rstatus{width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;\n  color: #fff; font-size: 11px; flex-shrink: 0;}\n#alifExam .rstatus.ok{background: var(--right);}\n#alifExam .rstatus.bad{background: var(--wrong);}\n#alifExam .rstatus.skip{background: var(--ink-faint);}\n#alifExam .review-head .rq{flex: 1; font-size: 13.5px; font-weight: 600; line-height: 1.4;}\n#alifExam .review-head .rn{font-size: 11.5px; color: var(--ink-faint); font-weight: 700; flex-shrink: 0;}\n#alifExam .review-head .chev{color: var(--ink-faint); font-size: 12px; transition: transform .2s ease; flex-shrink: 0;}\n#alifExam .review-item.open .chev{transform: rotate(180deg);}\n#alifExam .review-body{max-height: 0; overflow: hidden; transition: max-height .25s var(--ease);}\n#alifExam .review-item.open .review-body{max-height: 2000px;}\n#alifExam .review-body-inner{padding: 4px 16px 18px;}\n#alifExam .review-opt{display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; margin-bottom: 6px;\n  border: 1.5px solid var(--card-border); font-size: 13.5px;}\n#alifExam .review-opt .exm-letter{width: 22px; height: 22px; border-radius: 7px; background: var(--paper-2); color: var(--ink-soft);\n  display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0;}\n#alifExam .review-opt.is-correct{border-color: var(--right); background: var(--right-soft);}\n#alifExam .review-opt.is-correct .exm-letter{background: var(--right); color: #fff;}\n#alifExam .review-opt.is-chosen-wrong{border-color: var(--wrong); background: var(--wrong-soft);}\n#alifExam .review-opt.is-chosen-wrong .exm-letter{background: var(--wrong); color: #fff;}\n#alifExam .review-opt .tag{margin-left: auto; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; flex-shrink: 0;}\n#alifExam .explain-box{border-radius: 14px; background: var(--explain-bg); border: 1px solid var(--explain-border); padding: 14px 16px; margin-top: 10px;}\n#alifExam .explain-box .et{font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--explain-text-soft); margin-bottom: 6px;}\n#alifExam .explain-box .exm-markdown-body{color: var(--explain-text-body); font-size: 13.5px;}\n#alifExam .review-filter-row{display: flex; gap: 8px; margin-bottom: 14px; overflow-x: auto; padding-bottom: 2px;}\n#alifExam .review-filter-btn{flex-shrink: 0; padding: 7px 14px; border-radius: var(--radius-pill); background: var(--paper-2); color: var(--ink-soft); font-size: 12.5px; font-weight: 600;}\n#alifExam .review-filter-btn.active{background: var(--ink); color: var(--paper);}\nbody.dark #alifExam .review-filter-btn.active{background: var(--card); color: var(--ink); border: 1px solid var(--card-border);}\n#alifExam .results-actions{display: flex; flex-direction: column; gap: 10px; margin-top: 26px;}\n#alifExam .exm-boot-loader{min-height: 100vh; display: flex; align-items: center; justify-content: center;}\n#alifExam .exm-boot-loader .exm-spin{width: 30px; height: 30px; border-radius: 50%; border: 3px solid var(--card-border); border-top-color: var(--artery);\n  animation: exm-spin .7s linear infinite;}\n@keyframes exm-spin{ to { transform: rotate(360deg); } }\n#alifExam .spin-sm{width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: exm-spin .6s linear infinite; display: inline-block;}\n@media (min-width: 640px){#alifExam .wrap{padding-top: 48px;}\n#alifExam .setup-stats{gap: 14px;}}\nbody.dark #alifExam .exm-markdown-body,body.dark #alifExam .exm-markdown-body *,body.dark #alifExam .qtext,body.dark #alifExam .opt-text,body.dark #alifExam .rq{color: var(--ink) !important;\n  background-color: transparent !important;}\nbody.dark #alifExam .explain-box .exm-markdown-body,body.dark #alifExam .explain-box .exm-markdown-body *{color: var(--explain-text-body) !important;\n  background-color: transparent !important;}\n#alifExam{position:fixed;inset:0;z-index:5000;display:none;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;min-height:0;width:auto;}\n#alifExam.open{display:block;}\n#alifExam .exm-screen{min-height:100vh;min-height:100dvh;}\n#alifExam .exam-topbar{padding-top:env(safe-area-inset-top);}\n\n#alifExam .timing-box{margin:4px 0 18px;padding:16px;border-radius:var(--radius-md);background:var(--paper-2);border:1px solid var(--card-border)}\n#alifExam .timing-box.locked{opacity:.8}\n#alifExam .timing-box.locked .timing-seg,#alifExam .timing-box.locked .timing-field,#alifExam .timing-box.locked .timing-chips{pointer-events:none;opacity:.6}\n#alifExam .timing-head{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin-bottom:12px}\n#alifExam .timing-head i{color:var(--vein)}\n#alifExam .timing-head small{margin-left:auto;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint)}\n#alifExam .timing-seg{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:var(--radius-pill);background:var(--card);border:1px solid var(--card-border)}\n#alifExam .timing-thumb{position:absolute;top:4px;bottom:4px;left:4px;width:calc(50% - 4px);border-radius:var(--radius-pill);background: var(--artery);box-shadow:0 8px 18px -8px color-mix(in srgb,var(--artery) 80%,transparent);transition:transform .35s var(--ease)}\n#alifExam .timing-seg.per .timing-thumb{transform:translateX(100%)}\n#alifExam .timing-opt{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 6px;border-radius:var(--radius-pill);font-size:13.5px;font-weight:700;color:var(--ink-soft);transition:color .25s ease}\n#alifExam .timing-opt.active{color:#fff}\n#alifExam .timing-field{display:flex;align-items:center;gap:10px;margin-top:14px}\n#alifExam .tf-step{width:46px;height:46px;flex:none;border-radius:14px;background:var(--card);border:1px solid var(--card-border);color:var(--ink);font-size:14px;display:flex;align-items:center;justify-content:center;transition:transform .12s ease,background .15s ease}\n#alifExam .tf-step:active{transform:scale(.92)}\n#alifExam .tf-input{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;height:46px;border-radius:14px;background:var(--card);border:1.5px solid var(--card-border);transition:border-color .15s ease}\n#alifExam .tf-input:focus-within{border-color:var(--artery)}\n#alifExam .tf-input input{width:84px;text-align:center;font-family:'Fraunces',serif;font-size:22px;font-weight:600;color:var(--ink);-moz-appearance:textfield}\n#alifExam .tf-input input::-webkit-outer-spin-button,#alifExam .tf-input input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}\n#alifExam .tf-input span{font-size:13px;font-weight:700;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.05em}\n#alifExam .timing-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}\n#alifExam .tchip{padding:7px 14px;border-radius:var(--radius-pill);background:var(--card);border:1px solid var(--card-border);font-size:12.5px;font-weight:700;color:var(--ink-soft);transition:all .18s ease}\n#alifExam .tchip.on{background:color-mix(in srgb,var(--artery) 14%,var(--card));border-color:color-mix(in srgb,var(--artery) 45%,transparent);color:var(--artery)}\n#alifExam .timing-sum{margin-top:12px;font-size:13px;line-height:1.5;color:var(--ink-soft)}\n#alifExam .timing-sum i{color:var(--artery);margin-right:4px}\n#alifExam .timing-sum b{color:var(--ink)}\n#alifExam .timer-pill small{font-family:'Source Sans 3',sans-serif;font-size:11px;font-weight:600;opacity:.7;margin-left:2px}\n#alifExam .timer-pill small:empty{display:none}\n";
const EXAM_HTML = "<!-- ===== BOOT LOADER ===== -->\n<div class=\"exm-screen exm-boot-loader\" id=\"exm-bootScreen\"><div class=\"exm-spin\"></div></div>\n\n<!-- ===== PICKER SCREEN ===== -->\n<!-- ===== SETUP / INSTRUCTIONS SCREEN ===== -->\n<div class=\"exm-screen hidden\" id=\"exm-setupScreen\">\n  <div class=\"wrap\">\n    <div class=\"card\">\n      <div class=\"setup-hero\">\n        <div class=\"exm-eyebrow\" id=\"exm-setupSubjectName\">Subject</div>\n        <h1 id=\"exm-setupQuizName\">Exam name</h1>\n        <p id=\"exm-setupResumeNote\" class=\"hidden\" style=\"color:var(--vein);font-weight:600;\">You have an exam already in progress \u2014 continuing where you left off.</p>\n      </div>\n      <div class=\"setup-stats\">\n        <div class=\"setup-stat\"><div class=\"exm-num\" id=\"exm-setupQCount\">0</div><div class=\"exm-lbl\">Questions</div></div>\n        <div class=\"setup-stat\"><div class=\"exm-num\" id=\"exm-setupDuration\">0m</div><div class=\"exm-lbl\">Duration</div></div>\n        <div class=\"setup-stat\"><div class=\"exm-num\" id=\"exm-setupCatCount\">0</div><div class=\"exm-lbl\">Categories</div></div>\n      </div>\n      <div class=\"timing-box\" id=\"exm-timingBox\">\n        <div class=\"timing-head\"><i class=\"fa-solid fa-hourglass-half\"></i><span>Set your timer</span><small>pick one</small></div>\n        <div class=\"timing-seg\" id=\"exm-timingSeg\">\n          <span class=\"timing-thumb\"></span>\n          <button type=\"button\" class=\"timing-opt active\" id=\"exm-tmTotal\" data-tmode=\"total\"><i class=\"fa-solid fa-clock\"></i> Whole exam</button>\n          <button type=\"button\" class=\"timing-opt\" id=\"exm-tmPer\" data-tmode=\"perQuestion\"><i class=\"fa-solid fa-list-ol\"></i> Per question</button>\n        </div>\n        <div class=\"timing-field\">\n          <button type=\"button\" class=\"tf-step\" data-step=\"-1\" aria-label=\"Less time\"><i class=\"fa-solid fa-minus\"></i></button>\n          <label class=\"tf-input\"><input id=\"exm-timeInput\" type=\"number\" inputmode=\"decimal\" step=\"0.5\" min=\"0.5\" max=\"600\" autocomplete=\"off\"><span>min</span></label>\n          <button type=\"button\" class=\"tf-step\" data-step=\"1\" aria-label=\"More time\"><i class=\"fa-solid fa-plus\"></i></button>\n        </div>\n        <div class=\"timing-chips\" id=\"exm-timeChips\"></div>\n        <div class=\"timing-sum\" id=\"exm-timingSummary\"></div>\n        <div class=\"gate-error\" id=\"exm-timingErr\"></div>\n      </div>\n      <div class=\"cat-preview\" id=\"exm-setupCatPreview\"></div>\n      <div class=\"rule-list\">\n        <div class=\"rule-item\"><i class=\"fa-solid fa-hourglass-half\"></i><span>The timer starts the moment you tap Start and cannot be paused. Closing or reloading this tab won't stop the clock.</span></div>\n        <div class=\"rule-item\"><i class=\"fa-solid fa-eye-slash\"></i><span>Answers are not scored as you go \u2014 no correct/incorrect feedback is shown until you submit.</span></div>\n        <div class=\"rule-item\"><i class=\"fa-solid fa-shuffle\"></i><span>You can move freely between questions and change your answers any time before submitting.</span></div>\n        <div class=\"rule-item\"><i class=\"fa-solid fa-paper-plane\"></i><span>If time runs out, the exam auto-submits with whatever you've answered so far.</span></div>\n        <div class=\"rule-item\"><i class=\"fa-solid fa-shield-halved\"></i><span>This exam runs in fullscreen and is monitored for security: switching tabs, minimizing the window, switching apps, or exiting fullscreen shows a warning with a 10-second countdown \u2014 if you don't return in time, the exam is submitted automatically with whatever you've answered.</span></div>\n      </div>\n      <div class=\"gate-error\" id=\"exm-setupStartError\"></div>\n      <div class=\"gate-actions\">\n        <button class=\"btn btn-primary btn-block\" id=\"exm-startExamBtn\"><i class=\"fa-solid fa-play\"></i> Start exam</button>\n        <button class=\"btn btn-ghost btn-block\" id=\"exm-setupBackBtn\">Back to Alif Med</button>\n      </div>\n    </div>\n  </div>\n</div>\n\n<!-- ===== EXAM SCREEN ===== -->\n<div class=\"exm-screen hidden\" id=\"exm-examScreen\">\n  <div class=\"exam-topbar\">\n    <div class=\"exam-topbar-inner\">\n      <div class=\"exam-progress-txt\" id=\"exm-examProgressTxt\">Question 1 / 20</div>\n      <div style=\"display:flex;align-items:center;gap:8px;\">\n        <div class=\"timer-pill\" id=\"exm-timerPill\"><i class=\"fa-solid fa-clock\"></i><span id=\"exm-timerText\">30:00</span><small id=\"exm-timerKind\"></small></div>\n        <button class=\"palette-toggle-btn\" id=\"exm-paletteToggleBtn\"><i class=\"fa-solid fa-table-cells\"></i></button>\n      </div>\n    </div>\n    <div class=\"exam-progress-bar\"><div class=\"exam-progress-bar-fill\" id=\"exm-examProgressFill\" style=\"width:0%\"></div></div>\n  </div>\n\n  <div class=\"exam-body\">\n    <div class=\"wrap\" style=\"max-width:680px;\">\n      <div class=\"qpanel\" id=\"exm-qpanel\"></div>\n    </div>\n\n    <!-- palette drawer (becomes a persistent sidebar on desktop, see @media rules) -->\n    <div class=\"palette-drawer\" id=\"exm-paletteDrawer\">\n      <div class=\"palette-sheet\" id=\"exm-paletteSheet\">\n        <div class=\"sheet-handle\" id=\"exm-sheetHandle\"></div>\n        <h3>Question navigator</h3>\n        <div class=\"palette-legend\">\n          <span><i style=\"background:var(--right)\"></i> Answered</span>\n          <span><i style=\"background:var(--paper-2)\"></i> Unanswered</span>\n          <span><i style=\"background:var(--wrong)\"></i> Flagged</span>\n        </div>\n        <div class=\"palette-grid\" id=\"exm-paletteGrid\"></div>\n        <button class=\"btn btn-danger btn-block\" style=\"margin-top:18px;\" id=\"exm-paletteSubmitBtn\"><i class=\"fa-solid fa-paper-plane\"></i> Submit exam</button>\n      </div>\n    </div>\n  </div>\n\n  <div class=\"exam-nav-bar\">\n    <div class=\"exam-nav-inner\">\n      <button class=\"btn btn-ghost\" id=\"exm-prevQBtn\"><i class=\"fa-solid fa-arrow-left\"></i> Prev</button>\n      <button class=\"btn btn-primary\" id=\"exm-nextQBtn\">Next <i class=\"fa-solid fa-arrow-right\"></i></button>\n      <button class=\"btn btn-danger hidden\" id=\"exm-submitExamBtn\"><i class=\"fa-solid fa-paper-plane\"></i> Submit</button>\n    </div>\n  </div>\n</div>\n\n<!-- resource-lock toast (matches the main app's lock overlay) -->\n<div class=\"modal-overlay\" id=\"exm-lockOverlay\" style=\"align-items:flex-end;\">\n  <div class=\"modal-card\" style=\"max-width:420px;text-align:center;\">\n    <div class=\"modal-icon\" style=\"background:var(--lock-soft);color:var(--lock);margin:0 auto 14px;\"><i class=\"fa-solid fa-lock\"></i></div>\n    <p id=\"exm-lockOverlayMsg\" style=\"margin-bottom:0;\">This exam is locked.</p>\n  </div>\n</div>\n\n<!-- category celebration modal \u2014 content fully editable by the admin via\n     the settings/categoryCelebration document in Firestore -->\n<div class=\"modal-overlay\" id=\"exm-celebrationModal\">\n  <div class=\"modal-card\">\n    <div class=\"modal-icon\" style=\"background:var(--right-soft);color:var(--right);\"><i class=\"fa-solid fa-check\"></i></div>\n    <h3 id=\"exm-celebrationTitle\">Nice work! \ud83c\udf89</h3>\n    <p id=\"exm-celebrationMessage\">You've completed a category.</p>\n    <div class=\"modal-actions\">\n      <button class=\"btn btn-primary btn-block\" id=\"exm-celebrationOkBtn\">Continue</button>\n    </div>\n  </div>\n</div>\n\n<!-- confirm submit modal -->\n<div class=\"modal-overlay\" id=\"exm-confirmSubmitModal\">\n  <div class=\"modal-card\">\n    <div class=\"modal-icon\" style=\"background:var(--lock-soft);color:var(--lock);\"><i class=\"fa-solid fa-triangle-exclamation\"></i></div>\n    <h3>Submit exam?</h3>\n    <p id=\"exm-confirmSubmitText\">You still have unanswered questions. Once submitted, you cannot change your answers.</p>\n    <div class=\"modal-actions\">\n      <button class=\"btn btn-ghost\" id=\"exm-confirmSubmitCancelBtn\">Keep working</button>\n      <button class=\"btn btn-danger\" id=\"exm-confirmSubmitOkBtn\">Submit</button>\n    </div>\n  </div>\n</div>\n\n<!-- leave-exam warning modal \u2014 shown the moment focus leaves the exam tab/window;\n     counts down and auto-submits if the student doesn't return in time -->\n<div class=\"modal-overlay\" id=\"exm-leaveWarnModal\">\n  <div class=\"modal-card\">\n    <div class=\"modal-icon\" style=\"background:var(--wrong-soft);color:var(--wrong);\"><i class=\"fa-solid fa-triangle-exclamation\"></i></div>\n    <h3>Stay on this page</h3>\n    <p>Switching tabs, apps, or windows during the exam isn't allowed. Return now or the exam will be submitted automatically in <b id=\"exm-leaveWarnSeconds\">5</b>s.</p>\n    <div class=\"modal-actions\">\n      <button class=\"btn btn-primary btn-block\" id=\"exm-leaveWarnOkBtn\">I'm back \u2014 continue</button>\n    </div>\n  </div>\n</div>\n\n<!-- auto-submitted-for-leaving modal -->\n<div class=\"modal-overlay\" id=\"exm-leftExamModal\">\n  <div class=\"modal-card\">\n    <div class=\"modal-icon\" style=\"background:var(--wrong-soft);color:var(--wrong);\"><i class=\"fa-solid fa-lock\"></i></div>\n    <h3>Exam submitted</h3>\n    <p>You left the exam tab/window, so it was automatically submitted with your current answers to keep the exam secure.</p>\n    <div class=\"modal-actions\">\n      <button class=\"btn btn-primary btn-block\" id=\"exm-leftExamOkBtn\">See my results</button>\n    </div>\n  </div>\n</div>\n\n<!-- time up modal -->\n<div class=\"modal-overlay\" id=\"exm-timeUpModal\">\n  <div class=\"modal-card\">\n    <div class=\"modal-icon\" style=\"background:var(--wrong-soft);color:var(--wrong);\"><i class=\"fa-solid fa-hourglass-end\"></i></div>\n    <h3>Time's up</h3>\n    <p>The exam has been automatically submitted with your current answers.</p>\n    <div class=\"modal-actions\">\n      <button class=\"btn btn-primary btn-block\" id=\"exm-timeUpOkBtn\">See my results</button>\n    </div>\n  </div>\n</div>\n\n<!-- ===== RESULTS SCREEN ===== -->\n<div class=\"exm-screen hidden\" id=\"exm-resultsScreen\">\n  <div class=\"wrap\">\n    <div class=\"sub\" id=\"exm-resultsSub\" style=\"text-align:center;margin-bottom:12px;\"></div>\n\n    <div class=\"results-hero\">\n      <div class=\"score-ring-wrap\">\n        <svg viewBox=\"0 0 120 120\">\n          <circle class=\"ring-bg\" cx=\"60\" cy=\"60\" r=\"52\"></circle>\n          <circle class=\"exm-ring-fill\" id=\"exm-ringFill\" cx=\"60\" cy=\"60\" r=\"52\" stroke-dasharray=\"326.7\" stroke-dashoffset=\"326.7\"></circle>\n        </svg>\n        <div class=\"score-ring-center\"><div class=\"exm-pct\" id=\"exm-scorePct\">0%</div><div class=\"exm-frac\" id=\"exm-scoreFrac\">0 / 0</div></div>\n      </div>\n      <div class=\"verdict\" id=\"exm-resultVerdict\">\u2014</div>\n      <div class=\"verdict-sub\" id=\"exm-resultVerdictSub\">\u2014</div>\n    </div>\n\n    <div class=\"stat-row\">\n      <div class=\"stat-chip right\"><div class=\"exm-n\" id=\"exm-statCorrect\">0</div><div class=\"exm-l\">Correct</div></div>\n      <div class=\"stat-chip wrong\"><div class=\"exm-n\" id=\"exm-statWrong\">0</div><div class=\"exm-l\">Wrong</div></div>\n      <div class=\"stat-chip skip\"><div class=\"exm-n\" id=\"exm-statSkipped\">0</div><div class=\"exm-l\">Skipped</div></div>\n      <div class=\"stat-chip\"><div class=\"exm-n\" id=\"exm-statTime\">0m</div><div class=\"exm-l\">Time used</div></div>\n    </div>\n\n    <div class=\"advice-block\" id=\"exm-overallAdviceBlock\">\n      <h4><i class=\"fa-solid fa-compass\"></i> Overall advice</h4>\n      <p id=\"exm-overallAdviceText\"></p>\n    </div>\n\n    <div class=\"section-title\">Category insight</div>\n    <div id=\"exm-categoryInsightList\"></div>\n\n    <div class=\"section-title\">Full review</div>\n    <div class=\"review-filter-row\" id=\"exm-reviewFilterRow\">\n      <button class=\"review-filter-btn active\" data-filter=\"all\">All</button>\n      <button class=\"review-filter-btn\" data-filter=\"wrong\">Wrong</button>\n      <button class=\"review-filter-btn\" data-filter=\"skipped\">Skipped</button>\n      <button class=\"review-filter-btn\" data-filter=\"correct\">Correct</button>\n    </div>\n    <div id=\"exm-reviewList\"></div>\n\n    <div class=\"results-actions\">\n      <button class=\"btn btn-primary btn-block\" id=\"exm-retakeExamBtn\"><i class=\"fa-solid fa-rotate-right\"></i> Retake this exam</button>\n      <button class=\"btn btn-ghost btn-block\" id=\"exm-backToPickerBtn\"><i class=\"fa-solid fa-list\"></i> Choose another exam</button>\n    </div>\n  </div>\n</div>\n\n";

try { marked.setOptions({ gfm: true, breaks: true }); } catch (_) {}
const PURIFY_OPTS = {
  ADD_ATTR: ['target', 'rel'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_ATTR: ['style', 'color', 'bgcolor']
};
const renderRich = md => md ? DOMPurify.sanitize(marked.parse(String(md)), PURIFY_OPTS) : '';
const renderInline = md => md ? DOMPurify.sanitize(marked.parseInline(String(md)), PURIFY_OPTS) : '';
const escapeAttr = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- DOM bootstrap (lazy: nothing is injected until the first exam opens) ---------- */
let root = null;
let isOpen = false;
const $ = id => root.querySelector('#exm-' + id);
const SCREENS = ['bootScreen', 'setupScreen', 'examScreen', 'resultsScreen'];

function ensureRoot() {
  if (root) return root;
  const style = document.createElement('style');
  style.id = 'alifExamStyle';
  style.textContent = EXAM_CSS;
  document.head.appendChild(style);
  root = document.createElement('div');
  root.id = 'alifExam';
  root.innerHTML = EXAM_HTML;
  document.body.appendChild(root);
  wireStatic();
  return root;
}

function showScreen(id) {
  SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id));
  root.scrollTop = 0;
}

function openRoot() {
  if (isOpen) return;
  isOpen = true;
  root.classList.add('open');
  lockBodyScroll();
  pushModalState(onBack);
  document.addEventListener('keydown', onKeyNav);
  document.addEventListener('contextmenu', blockIfActive);
  document.addEventListener('copy', blockIfActive);
  document.addEventListener('cut', blockIfActive);
}

function closeExam(fromBack) {
  if (!isOpen) return;
  isOpen = false;
  clearInterval(timerInterval);
  stopFocusGuard();
  document.removeEventListener('keydown', onKeyNav);
  document.removeEventListener('contextmenu', blockIfActive);
  document.removeEventListener('copy', blockIfActive);
  document.removeEventListener('cut', blockIfActive);
  root.classList.remove('open');
  root.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
  closePaletteDrawer();
  unlockBodyScroll();
  EXAM_STATE = null;
  if (!fromBack) popModalState(onBack);
}

// Hardware / browser back: on setup + results it simply leaves; mid-exam it asks to submit
// (so a stray back-swipe can never silently abandon or lose an attempt).
function onBack() {
  if (isExamActiveOnScreen()) {
    pushModalState(onBack);
    askSubmit();
    return;
  }
  closeExam(true);
}

/* ---------- constants / helpers ---------- */
const PALETTE = ['--c0', '--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8', '--c9', '--c10', '--c11'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
function letterOf(i) {
  const letters = []; let n = Number(i);
  while (n >= 0) { letters.unshift(String.fromCharCode(65 + (n % 26))); n = Math.floor(n / 26) - 1; }
  return letters.join('');
}
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let CURRENT_SUBJECT_ID = null, CURRENT_QUIZ_ID = null, CURRENT_SUBJECT_NAME = '', CURRENT_QUIZ_NAME = '';
let QUESTIONS = [];
let CATEGORY_META = [];
let DURATION_MINUTES = 30;
let EXAM_STATE = null;
let timerInterval = null;
let CURRENT_ATTEMPT = null;
let REVIEW_FILTER = 'all';
let lockOverlayCloseTimer = null;
// Student-chosen timing for the next attempt: ONE of whole-exam time or per-question time, both in minutes.
let TIMING = { mode: 'total', total: 30, per: 1 };
let timingLocked = false;
const fmtMin = x => { const n = Math.round(Number(x) * 10) / 10; return Number.isInteger(n) ? String(n) : n.toFixed(1); };
const TIME_LIMITS = { total: { min: 1, max: 600 }, perQuestion: { min: 0.5, max: 120 } };
const isPerQ = () => !!(EXAM_STATE && EXAM_STATE.mode === 'perQuestion');

const studentIdOf = s => (s && (s.id || s.docId)) || '';
function stateKeyFor(subjectId, quizId) {
  return `alif_examstate_${studentIdOf(getStoredStudent())}_${subjectId}_${quizId}`;
}
const examStateKey = () => stateKeyFor(CURRENT_SUBJECT_ID, CURRENT_QUIZ_ID);
function saveExamState() { if (EXAM_STATE) LSC.set(examStateKey(), EXAM_STATE); }

export function hasExamInProgress(subjectId, quizId) {
  try {
    const s = LSC.get(stateKeyFor(subjectId, quizId));
    return !!(s && !s.submitted && s.endsAt > Date.now());
  } catch (_) { return false; }
}

function showLockOverlay(message) {
  const el = $('lockOverlay');
  clearTimeout(lockOverlayCloseTimer);
  $('lockOverlayMsg').textContent = message;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  lockOverlayCloseTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

/* ---------- entry point ---------- */
export async function startExam(subjectId, quizId) {
  const student = getStoredStudent();
  if (!student) return;
  const quiz = ALL_QUIZZES.find(q => q.id === quizId && q.subjectId === subjectId);
  if (!quiz) return;
  // Same lock hierarchy as practice mode (module -> subject -> quiz, plus access grants).
  if (getQuizLockMessage(quiz, student)) return;

  ensureRoot();
  openRoot();
  showScreen('bootScreen');
  try {
    CURRENT_SUBJECT_ID = subjectId;
    CURRENT_QUIZ_ID = quizId;
    CURRENT_SUBJECT_NAME = quiz.subjectName || 'Subject';
    CURRENT_QUIZ_NAME = quiz.name || 'Exam';

    // Cached + TTL-aware loader shared with practice mode — no extra Firestore reads.
    const raw = await loadQuestions(subjectId, quizId);
    if (!raw || !raw.length) throw new Error('NO_QUESTIONS');

    // Strictly grouped by category (all of one category before the next).
    const groups = new Map();
    raw.forEach(q => { if (!groups.has(q.category)) groups.set(q.category, []); groups.get(q.category).push(q); });
    QUESTIONS = [];
    groups.forEach(list => QUESTIONS.push(...list));

    const byCat = {};
    QUESTIONS.forEach(q => { (byCat[q.category] = byCat[q.category] || []).push(q); });
    CATEGORY_META = Object.keys(byCat).map((key, i) => ({
      key, label: byCat[key][0].categoryLabel, plate: 'Plate ' + (ROMAN[i] || (i + 1)),
      color: `var(${PALETTE[i % PALETTE.length]})`, count: byCat[key].length
    }));

    // Admin-set duration wins; otherwise ~1 minute per question (min 10) so ANY quiz can be sat as an exam.
    DURATION_MINUTES = Number(quiz.duration) || Math.max(10, QUESTIONS.length);

    TIMING = { mode: 'total', total: DURATION_MINUTES, per: 1 };
    renderSetupCard();
    const existing = LSC.get(examStateKey());
    const resumable = existing && !existing.submitted && existing.endsAt > Date.now();
    setupTimingUI(resumable ? existing : null);
    $('setupResumeNote').classList.toggle('hidden', !resumable);
    const startBtn = $('startExamBtn');
    startBtn.disabled = false;
    startBtn.innerHTML = resumable ? '<i class="fa-solid fa-play"></i> Resume exam' : '<i class="fa-solid fa-play"></i> Start exam';
    showScreen('setupScreen');
  } catch (e) {
    showLockOverlay("Couldn't load this exam. Check your connection and try again.");
    setTimeout(() => closeExam(), 1800);
  }
}

function renderSetupCard() {
  $('setupSubjectName').textContent = CURRENT_SUBJECT_NAME;
  $('setupQuizName').textContent = CURRENT_QUIZ_NAME;
  $('setupQCount').textContent = QUESTIONS.length;
  $('setupDuration').textContent = DURATION_MINUTES + 'm';
  $('setupCatCount').textContent = CATEGORY_META.length;
  $('setupCatPreview').innerHTML = CATEGORY_META.map(c => `<span class="cat-pill" style="background:${c.color}">${escapeHtml(c.label)}</span>`).join('');
  $('setupStartError').classList.remove('show');
}

function launchExam() {
  const student = getStoredStudent();
  const quiz = ALL_QUIZZES.find(q => q.id === CURRENT_QUIZ_ID && q.subjectId === CURRENT_SUBJECT_ID);
  const lockMessage = quiz ? getQuizLockMessage(quiz, student) : null;
  if (lockMessage) { showLockOverlay(lockMessage); setTimeout(() => closeExam(), 1800); return; }

  const existing = LSC.get(examStateKey());
  if (existing && !existing.submitted && existing.endsAt > Date.now()) {
    beginExamScreen(existing);
  } else {
    const perMode = TIMING.mode === 'perQuestion';
    const perSec = Math.round(TIMING.per * 60);
    const totalSec = perMode ? perSec * QUESTIONS.length : Math.round(TIMING.total * 60);
    const now = Date.now();
    const fresh = {
      startedAt: now, endsAt: now + totalSec * 1000,
      durationSeconds: totalSec, mode: perMode ? 'perQuestion' : 'total',
      perQuestionSeconds: perMode ? perSec : null, qEndsAt: perMode ? now + perSec * 1000 : null,
      answers: {}, flagged: {}, currentIndex: 0,
      submitted: false, celebratedCategories: {}
    };
    LSC.set(examStateKey(), fresh);
    beginExamScreen(fresh);
  }
}

/* ---------- exam engine ---------- */
function beginExamScreen(state) {
  EXAM_STATE = state;
  if (state.mode === 'perQuestion') {
    // Resuming: every question whose slot elapsed while away is gone (forward-only).
    const per = (state.perQuestionSeconds || 60) * 1000, now = Date.now();
    let idx = state.currentIndex || 0;
    while (now >= state.qEndsAt && idx < QUESTIONS.length - 1) { idx++; state.qEndsAt += per; }
    state.currentIndex = idx;
    saveExamState();
  }
  showScreen('examScreen');
  renderQuestion(EXAM_STATE.currentIndex);
  startTimer();
  startFocusGuard();
}

function startTimer() { clearInterval(timerInterval); tickTimer(); timerInterval = setInterval(tickTimer, 1000); }
function tickTimer() {
  if (!EXAM_STATE) return;
  if (isPerQ()) {
    const remSec = (EXAM_STATE.qEndsAt - Date.now()) / 1000;
    const per = EXAM_STATE.perQuestionSeconds || 60;
    $('timerText').textContent = formatClock(remSec);
    $('timerPill').classList.toggle('warn', remSec <= Math.min(30, Math.max(5, per * 0.2)));
    if (remSec <= 0) {
      if (EXAM_STATE.currentIndex < QUESTIONS.length - 1) renderQuestion(EXAM_STATE.currentIndex + 1);   // new question => fresh timer
      else { clearInterval(timerInterval); submitExam({ auto: true }); }
    }
    return;
  }
  const remainingMs = EXAM_STATE.endsAt - Date.now();
  $('timerText').textContent = formatClock(remainingMs / 1000);
  $('timerPill').classList.toggle('warn', remainingMs / 1000 <= 120);
  if (remainingMs <= 0) { clearInterval(timerInterval); submitExam({ auto: true }); }
}

function renderQuestion(idx) {
  const changed = idx !== EXAM_STATE.currentIndex;
  EXAM_STATE.currentIndex = idx;
  if (isPerQ() && changed) EXAM_STATE.qEndsAt = Date.now() + (EXAM_STATE.perQuestionSeconds || 60) * 1000;
  $('timerKind').textContent = isPerQ() ? 'this question' : '';
  if (isPerQ()) { $('timerText').textContent = formatClock((EXAM_STATE.qEndsAt - Date.now()) / 1000); }
  saveExamState();
  const q = QUESTIONS[idx];
  const meta = CATEGORY_META.find(c => c.key === q.category);
  const ans = EXAM_STATE.answers[q.id];
  const isFlagged = !!EXAM_STATE.flagged[q.id];

  $('examProgressTxt').textContent = `Question ${idx + 1} / ${QUESTIONS.length}`;
  $('examProgressFill').style.width = (Object.keys(EXAM_STATE.answers).length / QUESTIONS.length * 100) + '%';

  const optsHtml = q.options.map((opt, i) => `
    <button class="opt-btn ${ans && ans.selected === i ? 'selected' : ''}" data-idx="${i}">
      <span class="exm-letter">${letterOf(i)}</span>
      <span class="opt-text exm-markdown-body">${renderInline(opt)}</span>
    </button>`).join('');

  $('qpanel').innerHTML = `
    <div class="qmeta">
      <span class="cat-tag" style="background:${meta ? meta.color : 'var(--artery)'}">${escapeHtml(meta ? meta.label : q.categoryLabel)}</span>
      <button class="flag-btn ${isFlagged ? 'on' : ''}" id="exm-flagBtn"><i class="fa-solid fa-flag"></i> ${isFlagged ? 'Flagged' : 'Flag for review'}</button>
    </div>
    ${q.image ? `<img src="${escapeAttr(q.image)}" alt="" class="exm-q-stem-image" loading="lazy" onerror="this.remove()">` : ''}
    <div class="qtext exm-markdown-body">${renderRich(q.question)}</div>
    <div class="opt-list">${optsHtml}</div>`;

  root.querySelectorAll('#exm-qpanel .opt-btn').forEach(btn => btn.addEventListener('click', () => {
    EXAM_STATE.answers[q.id] = { selected: Number(btn.dataset.idx), number: q.number, category: q.category, categoryLabel: q.categoryLabel };
    saveExamState();
    renderQuestion(idx);
  }));
  $('flagBtn').addEventListener('click', () => {
    if (EXAM_STATE.flagged[q.id]) delete EXAM_STATE.flagged[q.id]; else EXAM_STATE.flagged[q.id] = true;
    saveExamState();
    renderQuestion(idx);
  });

  $('prevQBtn').disabled = idx === 0;
  $('prevQBtn').classList.toggle('hidden', isPerQ());   // per-question timing is forward-only
  const isLast = idx === QUESTIONS.length - 1;
  $('nextQBtn').classList.toggle('hidden', isLast);
  $('submitExamBtn').classList.toggle('hidden', !isLast);
  renderPalette();
}

function goNext() {
  if (!EXAM_STATE || EXAM_STATE.currentIndex >= QUESTIONS.length - 1) return;
  const nextIdx = EXAM_STATE.currentIndex + 1;
  const curCat = QUESTIONS[EXAM_STATE.currentIndex].category;
  const nextCat = QUESTIONS[nextIdx].category;
  if (!isPerQ() && curCat !== nextCat && !(EXAM_STATE.celebratedCategories && EXAM_STATE.celebratedCategories[nextCat])) {
    showCelebration(curCat, nextCat, () => renderQuestion(nextIdx));
  } else {
    renderQuestion(nextIdx);
  }
}
function goPrev() { if (EXAM_STATE && !isPerQ() && EXAM_STATE.currentIndex > 0) renderQuestion(EXAM_STATE.currentIndex - 1); }

function onKeyNav(e) {
  if (!isExamActiveOnScreen()) return;
  if (root.querySelector('.modal-overlay.show')) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goNext(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev(); }
}
function blockIfActive(e) { if (isExamActiveOnScreen()) e.preventDefault(); }

/* ---------- category celebration (simple built-in copy; no extra reads) ---------- */
let celebrationOnContinue = null;
function categoryLabelFor(key) { return (CATEGORY_META.find(c => c.key === key) || {}).label || key || ''; }
function showCelebration(fromKey, toKey, onContinue) {
  $('celebrationTitle').textContent = 'Nice work! 🎉';
  $('celebrationMessage').textContent = `You've completed ${categoryLabelFor(fromKey)}. Up next: ${categoryLabelFor(toKey)}.`;
  celebrationOnContinue = () => {
    if (!EXAM_STATE.celebratedCategories) EXAM_STATE.celebratedCategories = {};
    EXAM_STATE.celebratedCategories[toKey] = true;
    saveExamState();
    onContinue();
  };
  $('celebrationModal').classList.add('show');
}

/* ---------- question navigator ---------- */
function closePaletteDrawer() {
  if (!root) return;
  $('paletteDrawer').classList.remove('show');
  $('paletteSheet').classList.remove('full');
}
function renderPalette() {
  const grid = $('paletteGrid');
  grid.innerHTML = QUESTIONS.map((q, i) => {
    const answered = !!EXAM_STATE.answers[q.id];
    const flagged = !!EXAM_STATE.flagged[q.id];
    const current = i === EXAM_STATE.currentIndex;
    const frozen = isPerQ() && !current;
    return `<button class="palette-num ${answered ? 'answered' : ''} ${current ? 'current' : ''} ${flagged ? 'flagged' : ''}" ${frozen ? 'disabled style="opacity:.55;pointer-events:none"' : `data-jump="${i}"`}>${i + 1}</button>`;
  }).join('');
  grid.querySelectorAll('[data-jump]').forEach(btn => btn.addEventListener('click', () => {
    renderQuestion(Number(btn.dataset.jump));
    closePaletteDrawer();
  }));
}

/* ---------- submit flow ---------- */
function askSubmit() {
  if (!EXAM_STATE) return;
  const unanswered = QUESTIONS.length - Object.keys(EXAM_STATE.answers).length;
  $('confirmSubmitText').textContent = unanswered > 0
    ? `You still have ${unanswered} unanswered question${unanswered === 1 ? '' : 's'}. Once submitted, you cannot change your answers.`
    : `You've answered every question. Once submitted, you cannot change your answers.`;
  $('confirmSubmitModal').classList.add('show');
}

/* ---------- focus guard (tab / app switch / fullscreen exit => grace countdown => auto-submit) ---------- */
const LEAVE_GRACE_SECONDS = 10;
let leaveGraceTimer = null, leaveGraceRemaining = 0, focusGuardArmed = false, fullscreenExitExpected = false;

function isExamActiveOnScreen() {
  return !!(root && isOpen && focusGuardArmed && EXAM_STATE && !EXAM_STATE.submitted && !$('examScreen').classList.contains('hidden'));
}
function fullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen);
}
function isFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}
function requestFullscreenSafe() {
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
  if (el.msRequestFullscreen) return el.msRequestFullscreen();
  return Promise.reject(new Error('Fullscreen not supported'));
}
function exitFullscreenSafe() {
  if (!isFullscreenActive()) return Promise.resolve();
  fullscreenExitExpected = true;
  if (document.exitFullscreen) return document.exitFullscreen().catch(() => {});
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
  if (document.msExitFullscreen) return document.msExitFullscreen();
  return Promise.resolve();
}

function onVisibility() { if (document.visibilityState === 'hidden') startLeaveCountdown(); else cancelLeaveCountdown(); }
function onFullscreenChange() {
  if (fullscreenExitExpected) { fullscreenExitExpected = false; return; }
  if (!isFullscreenActive()) startLeaveCountdown();
}
function handlePageUnloading() { if (isExamActiveOnScreen()) submitExam({ auto: true, reason: 'left' }); }
const FS_EVENTS = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];

function startFocusGuard() {
  if (focusGuardArmed) return;
  focusGuardArmed = true;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', startLeaveCountdown);
  window.addEventListener('focus', cancelLeaveCountdown);
  window.addEventListener('pagehide', handlePageUnloading);
  FS_EVENTS.forEach(ev => document.addEventListener(ev, onFullscreenChange));
}
function stopFocusGuard() {
  if (focusGuardArmed) {
    focusGuardArmed = false;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', startLeaveCountdown);
    window.removeEventListener('focus', cancelLeaveCountdown);
    window.removeEventListener('pagehide', handlePageUnloading);
    FS_EVENTS.forEach(ev => document.removeEventListener(ev, onFullscreenChange));
  }
  clearInterval(leaveGraceTimer);
  leaveGraceTimer = null;
  if (root) $('leaveWarnModal').classList.remove('show');
  exitFullscreenSafe();
}
function startLeaveCountdown() {
  if (!isExamActiveOnScreen() || leaveGraceTimer) return;
  leaveGraceRemaining = LEAVE_GRACE_SECONDS;
  $('leaveWarnSeconds').textContent = leaveGraceRemaining;
  $('leaveWarnModal').classList.add('show');
  leaveGraceTimer = setInterval(() => {
    leaveGraceRemaining -= 1;
    if (leaveGraceRemaining <= 0) {
      clearInterval(leaveGraceTimer); leaveGraceTimer = null;
      $('leaveWarnModal').classList.remove('show');
      if (isExamActiveOnScreen()) submitExam({ auto: true, reason: 'left' });
      return;
    }
    $('leaveWarnSeconds').textContent = leaveGraceRemaining;
  }, 1000);
}
function cancelLeaveCountdown() {
  if (leaveGraceTimer) { clearInterval(leaveGraceTimer); leaveGraceTimer = null; }
  if (root) $('leaveWarnModal').classList.remove('show');
}

/* ---------- scoring + persistence ---------- */
function computeResults(autoSubmitted) {
  const student = getStoredStudent();
  const timeTakenSeconds = Math.min(EXAM_STATE.durationSeconds, Math.round((Date.now() - EXAM_STATE.startedAt) / 1000));
  let correctCount = 0, wrongCount = 0;
  const perQuestion = QUESTIONS.map(q => {
    const a = EXAM_STATE.answers[q.id];
    const answered = !!a;
    const correct = answered && a.selected === q.answerIndex;
    if (answered) { if (correct) correctCount++; else wrongCount++; }
    return { q, selected: answered ? a.selected : null, correct, answered };
  });
  const unansweredCount = QUESTIONS.length - correctCount - wrongCount;
  const percentage = QUESTIONS.length ? Math.round((correctCount / QUESTIONS.length) * 100) : 0;
  const categoryBreakdown = CATEGORY_META.map(meta => {
    const qs = perQuestion.filter(p => p.q.category === meta.key);
    const c = qs.filter(p => p.correct).length;
    const w = qs.filter(p => p.answered && !p.correct).length;
    const pct = qs.length ? Math.round((c / qs.length) * 100) : 0;
    const band = pct >= 80 ? 'strong' : pct >= 50 ? 'average' : 'weak';
    return { key: meta.key, label: meta.label, color: meta.color, total: qs.length, correct: c, wrong: w, unanswered: qs.length - c - w, percentage: pct, band };
  }).sort((a, b) => a.percentage - b.percentage);
  return {
    student, subjectId: CURRENT_SUBJECT_ID, subjectName: CURRENT_SUBJECT_NAME, quizId: CURRENT_QUIZ_ID, quizName: CURRENT_QUIZ_NAME,
    total: QUESTIONS.length, correctCount, wrongCount, unansweredCount, percentage,
    durationSeconds: EXAM_STATE.durationSeconds, timeTakenSeconds, autoSubmitted, categoryBreakdown, perQuestion,
    timingMode: EXAM_STATE.mode || 'total', perQuestionSeconds: EXAM_STATE.perQuestionSeconds || null
  };
}

function categoryAdvice(cat) {
  if (cat.band === 'strong') return `Strong footing in ${cat.label} — ${cat.percentage}% correct. Keep it sharp with light spaced review rather than heavy re-study.`;
  if (cat.band === 'average') return `${cat.label} is developing — ${cat.percentage}% correct. Revisit the questions you missed here and re-read the explanations before your next attempt.`;
  return `${cat.label} needs focused attention — only ${cat.percentage}% correct. Go back to the source material for this topic and redo practice questions before your next exam.`;
}
function overallAdvice(result) {
  const weakest = result.categoryBreakdown.filter(c => c.band === 'weak');
  const strongest = result.categoryBreakdown.filter(c => c.band === 'strong');
  let msg = `You scored ${result.percentage}% (${result.correctCount} of ${result.total}). `;
  if (result.unansweredCount > 0) msg += `${result.unansweredCount} question${result.unansweredCount === 1 ? ' was' : 's were'} left unanswered — pacing is worth practicing so you reach every question next time. `;
  if (weakest.length) msg += `Prioritize ${weakest.map(c => c.label).join(', ')} before your next attempt — that's where the biggest score gains are available. `;
  if (strongest.length) msg += `${strongest.map(c => c.label).join(', ')} ${strongest.length === 1 ? 'is' : 'are'} already solid — a quick review is enough to maintain it.`;
  return msg.trim();
}

async function writeExamAttempt(result) {
  try {
    const answersMap = {};
    result.perQuestion.forEach(p => {
      answersMap[p.q.id] = { number: p.q.number, selected: p.selected, correct: p.correct, category: p.q.category, categoryLabel: p.q.categoryLabel };
    });
    const categoryBreakdownMap = {};
    result.categoryBreakdown.forEach(c => {
      categoryBreakdownMap[c.key] = { label: c.label, total: c.total, correct: c.correct, wrong: c.wrong, unanswered: c.unanswered, percentage: c.percentage, band: c.band };
    });
    const user = getAuthUser();
    await addDoc(collection(db, 'examAttempts'), {
      uid: (user && user.uid) || result.student.uid || '',
      studentId: studentIdOf(result.student) || null,
      name: result.student.name || '',
      batch: result.student.batch || '',
      subjectId: result.subjectId, subjectName: result.subjectName,
      quizId: result.quizId, quizName: result.quizName,
      total: result.total, correctCount: result.correctCount, wrongCount: result.wrongCount,
      unansweredCount: result.unansweredCount, score: result.correctCount, percentage: result.percentage,
      durationSeconds: result.durationSeconds, timeTakenSeconds: result.timeTakenSeconds,
      autoSubmitted: result.autoSubmitted, timingMode: result.timingMode, perQuestionSeconds: result.perQuestionSeconds,
      categoryBreakdown: categoryBreakdownMap, answers: answersMap,
      submittedAt: serverTimestamp(), createdAt: serverTimestamp()
    });
  } catch (e) { /* offline / rules — the student still sees their results */ }
}

function submitExam({ auto, reason }) {
  if (!EXAM_STATE || EXAM_STATE.submitted) return;
  clearInterval(timerInterval);
  stopFocusGuard();
  EXAM_STATE.submitted = true;
  saveExamState();
  const result = computeResults(auto);
  CURRENT_ATTEMPT = result;
  LSC.remove(examStateKey());
  writeExamAttempt(result);
  renderResults(result);
  if (reason === 'left') $('leftExamModal').classList.add('show');
  else if (auto) $('timeUpModal').classList.add('show');
  else showScreen('resultsScreen');
}

/* ---------- results ---------- */
const RING_CIRC = 2 * Math.PI * 52;
function verdictFor(pct) {
  if (pct >= 90) return ['Outstanding', 'A near-perfect performance.'];
  if (pct >= 80) return ['Excellent', "You're in strong command of this material."];
  if (pct >= 70) return ['Good', 'Solid performance, with clear room to sharpen a few areas.'];
  if (pct >= 50) return ['Fair', 'A passable attempt — targeted review will move this up quickly.'];
  return ['Needs work', 'This topic needs another focused pass before your next attempt.'];
}

function renderResults(result) {
  $('resultsSub').textContent = `${result.subjectName} · ${result.quizName}`;
  const ringFill = $('ringFill');
  ringFill.setAttribute('stroke-dasharray', RING_CIRC);
  ringFill.setAttribute('stroke-dashoffset', RING_CIRC);
  ringFill.style.stroke = result.percentage >= 70 ? 'var(--right)' : result.percentage >= 50 ? 'var(--gold)' : 'var(--wrong)';
  requestAnimationFrame(() => requestAnimationFrame(() => ringFill.setAttribute('stroke-dashoffset', RING_CIRC - (result.percentage / 100) * RING_CIRC)));

  $('scorePct').textContent = result.percentage + '%';
  $('scoreFrac').textContent = `${result.correctCount} / ${result.total}`;
  const [verdict, verdictSub] = verdictFor(result.percentage);
  $('resultVerdict').textContent = verdict + (result.autoSubmitted ? ' (auto-submitted)' : '');
  $('resultVerdictSub').textContent = verdictSub;
  $('statCorrect').textContent = result.correctCount;
  $('statWrong').textContent = result.wrongCount;
  $('statSkipped').textContent = result.unansweredCount;
  $('statTime').textContent = formatClock(result.timeTakenSeconds).replace(':', 'm ') + 's';
  $('overallAdviceText').textContent = overallAdvice(result);

  $('categoryInsightList').innerHTML = result.categoryBreakdown.map(c => `
    <div class="cat-card">
      <div class="cat-card-head">
        <span class="exm-dot" style="background:${c.color}"></span>
        <b>${escapeHtml(c.label)}</b>
        <span class="badge ${c.band}">${c.band === 'strong' ? 'Strong' : c.band === 'average' ? 'Developing' : 'Weak'}</span>
      </div>
      <div class="cat-bar">
        <div style="width:${c.total ? c.correct / c.total * 100 : 0}%;background:var(--right)"></div>
        <div style="width:${c.total ? c.wrong / c.total * 100 : 0}%;background:var(--wrong)"></div>
      </div>
      <div class="cat-frac">${c.correct} correct · ${c.wrong} wrong · ${c.unanswered} skipped · ${c.percentage}%</div>
      <div class="advice"><i class="fa-solid fa-lightbulb"></i>${escapeHtml(categoryAdvice(c))}</div>
    </div>`).join('');

  REVIEW_FILTER = 'all';
  root.querySelectorAll('.review-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  renderReviewList(result);
}

function renderReviewList(result) {
  let items = result.perQuestion;
  if (REVIEW_FILTER === 'wrong') items = items.filter(p => p.answered && !p.correct);
  else if (REVIEW_FILTER === 'skipped') items = items.filter(p => !p.answered);
  else if (REVIEW_FILTER === 'correct') items = items.filter(p => p.correct);

  const listEl = $('reviewList');
  if (!items.length) { listEl.innerHTML = `<div class="empty-note">Nothing in this filter.</div>`; return; }

  listEl.innerHTML = items.map(p => {
    const status = !p.answered ? 'skip' : (p.correct ? 'ok' : 'bad');
    const icon = !p.answered ? 'fa-minus' : (p.correct ? 'fa-check' : 'fa-xmark');
    const optsHtml = p.q.options.map((opt, i) => {
      let cls = '', tag = '';
      if (i === p.q.answerIndex) { cls = 'is-correct'; tag = '<span class="tag" style="color:var(--right)">Correct</span>'; }
      else if (i === p.selected) { cls = 'is-chosen-wrong'; tag = '<span class="tag" style="color:var(--wrong)">Your answer</span>'; }
      return `<div class="review-opt ${cls}"><span class="exm-letter">${letterOf(i)}</span><span class="exm-markdown-body">${renderInline(opt)}</span>${tag}</div>`;
    }).join('');
    return `
    <div class="review-item" data-qid="${escapeAttr(p.q.id)}">
      <div class="review-head">
        <span class="rstatus ${status}"><i class="fa-solid ${icon}"></i></span>
        <span class="rq exm-markdown-body">${renderInline(p.q.question.slice(0, 90))}${p.q.question.length > 90 ? '…' : ''}</span>
        <span class="rn">Q${p.q.number || ''}</span>
        <i class="fa-solid fa-chevron-down chev"></i>
      </div>
      <div class="review-body">
        <div class="review-body-inner">
          ${p.q.image ? `<img src="${escapeAttr(p.q.image)}" alt="" class="exm-q-stem-image" loading="lazy" onerror="this.remove()">` : ''}
          <div class="exm-markdown-body" style="margin-bottom:12px;">${renderRich(p.q.question)}</div>
          ${optsHtml}
          ${p.q.explanation ? `<div class="explain-box"><div class="et">Explanation</div><div class="exm-markdown-body">${renderRich(p.q.explanation)}</div></div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.review-head').forEach(head => head.addEventListener('click', () => head.parentElement.classList.toggle('open')));
}

/* ---------- setup: student-chosen timing (whole exam OR per question, minutes) ---------- */
function setupTimingUI(resumeState) {
  timingLocked = !!resumeState;
  if (resumeState) {
    if (resumeState.mode === 'perQuestion') { TIMING.mode = 'perQuestion'; TIMING.per = (resumeState.perQuestionSeconds || 60) / 60; }
    else { TIMING.mode = 'total'; TIMING.total = (resumeState.durationSeconds || DURATION_MINUTES * 60) / 60; }
  }
  $('timingBox').classList.toggle('locked', timingLocked);
  $('timeInput').disabled = timingLocked;
  $('timingErr').classList.remove('show');
  renderTimingUI();
}

function renderTimingUI() {
  const per = TIMING.mode === 'perQuestion';
  const n = QUESTIONS.length;
  const val = per ? TIMING.per : TIMING.total;
  $('timingSeg').classList.toggle('per', per);
  $('tmTotal').classList.toggle('active', !per);
  $('tmPer').classList.toggle('active', per);
  const inp = $('timeInput');
  if (document.activeElement !== inp) inp.value = fmtMin(val);

  const presets = per ? [0.5, 1, 1.5, 2]
    : [...new Set([Math.max(1, Math.round(n * 0.5)), n, Math.round(n * 1.5)])].sort((a, b) => a - b);
  $('timeChips').innerHTML = presets.map(p =>
    `<button type="button" class="tchip ${Math.abs(p - val) < 1e-6 ? 'on' : ''}" data-v="${p}">${fmtMin(p)} min</button>`).join('');

  const totalMin = per ? val * n : val;
  $('setupDuration').textContent = fmtMin(totalMin) + 'm';
  if ($('setupDuration').nextElementSibling) $('setupDuration').nextElementSibling.textContent = per ? 'Max time' : 'Duration';
  $('timingSummary').innerHTML = timingLocked
    ? '<i class="fa-solid fa-lock"></i> Timing is fixed for the attempt in progress.'
    : per
      ? `<i class="fa-solid fa-list-ol"></i> <b>${fmtMin(val)} min</b> for each question · <b>${fmtMin(totalMin)} min</b> at most. When a question's time ends you move on automatically.`
      : `<i class="fa-solid fa-clock"></i> <b>${fmtMin(val)} min</b> for the whole exam — about ${fmtMin(val / Math.max(1, n))} min per question, spend it however you like.`;

  const rules = root.querySelectorAll('#exm-setupScreen .rule-item span');
  if (rules.length >= 4) {
    rules[2].textContent = per
      ? "Each question has its own timer. You can only move forward — earlier questions can't be reopened."
      : 'You can move freely between questions and change your answers any time before submitting.';
    rules[3].textContent = per
      ? "When a question's time ends you're moved to the next one automatically; if the last question times out, the exam is submitted."
      : "If time runs out, the exam auto-submits with whatever you've answered so far.";
  }
}

function setTimingMode(mode) { if (timingLocked || TIMING.mode === mode) return; TIMING.mode = mode; $('timingErr').classList.remove('show'); renderTimingUI(); }
function setTimingValue(v) { if (timingLocked) return; if (TIMING.mode === 'perQuestion') TIMING.per = v; else TIMING.total = v; renderTimingUI(); }
function currentTimingValue() { return TIMING.mode === 'perQuestion' ? TIMING.per : TIMING.total; }

// Returns true when the chosen value is usable; otherwise shows a hint and snaps the field into range.
function validateTiming() {
  if (timingLocked) return true;
  const lim = TIME_LIMITS[TIMING.mode];
  const v = currentTimingValue();
  if (isFinite(v) && v >= lim.min && v <= lim.max) { $('timingErr').classList.remove('show'); return true; }
  const fixed = Math.min(lim.max, Math.max(lim.min, isFinite(v) ? v : lim.min));
  $('timingErr').textContent = `Choose between ${fmtMin(lim.min)} and ${fmtMin(lim.max)} minutes.`;
  $('timingErr').classList.add('show');
  $('timeInput').value = fmtMin(fixed);
  setTimingValue(fixed);
  return false;
}

function wireTiming() {
  $('timingSeg').addEventListener('click', e => { const b = e.target.closest('[data-tmode]'); if (b) setTimingMode(b.dataset.tmode); });
  $('timeChips').addEventListener('click', e => { const c = e.target.closest('.tchip'); if (c) { $('timingErr').classList.remove('show'); setTimingValue(Number(c.dataset.v)); $('timeInput').value = fmtMin(c.dataset.v); } });
  root.querySelectorAll('#exm-timingBox .tf-step').forEach(btn => btn.addEventListener('click', () => {
    if (timingLocked) return;
    const per = TIMING.mode === 'perQuestion';
    const step = (per ? 0.5 : (currentTimingValue() >= 30 ? 5 : 1)) * Number(btn.dataset.step);
    const lim = TIME_LIMITS[TIMING.mode];
    const next = Math.min(lim.max, Math.max(lim.min, Math.round((currentTimingValue() + step) * 10) / 10));
    $('timingErr').classList.remove('show');
    $('timeInput').value = fmtMin(next);
    setTimingValue(next);
  }));
  $('timeInput').addEventListener('input', () => {
    const v = parseFloat($('timeInput').value);
    if (isFinite(v) && v > 0) setTimingValue(v);
  });
  $('timeInput').addEventListener('blur', () => { if (!validateTiming()) return; $('timeInput').value = fmtMin(currentTimingValue()); });
}

/* ---------- one-time wiring of the static markup ---------- */
function wireStatic() {
  $('lockOverlay').addEventListener('click', () => $('lockOverlay').classList.remove('show'));
  wireTiming();

  $('setupBackBtn').addEventListener('click', () => closeExam());
  $('backToPickerBtn').addEventListener('click', () => { CURRENT_ATTEMPT = null; closeExam(); });
  $('retakeExamBtn').addEventListener('click', () => startExam(CURRENT_SUBJECT_ID, CURRENT_QUIZ_ID));

  $('startExamBtn').addEventListener('click', async () => {
    const btn = $('startExamBtn'), errEl = $('setupStartError');
    if (btn.disabled) return;
    errEl.classList.remove('show');
    if (!validateTiming()) return;
    btn.disabled = true;
    const originalLabel = btn.innerHTML;
    btn.innerHTML = '<span class="spin-sm"></span> Loading…';
    // Fullscreen only works from a direct tap. Best-effort: if unsupported (e.g. some WebViews) the exam still starts.
    if (fullscreenSupported()) {
      try { await requestFullscreenSafe(); }
      catch (e) { errEl.textContent = "Couldn't enable fullscreen automatically — please maximize your window. Starting the exam anyway."; errEl.classList.add('show'); }
    }
    try { launchExam(); }
    finally {
      if (!$('setupScreen').classList.contains('hidden')) { btn.disabled = false; btn.innerHTML = originalLabel; }
    }
  });

  $('prevQBtn').addEventListener('click', goPrev);
  $('nextQBtn').addEventListener('click', goNext);
  $('submitExamBtn').addEventListener('click', askSubmit);
  $('paletteSubmitBtn').addEventListener('click', () => { closePaletteDrawer(); askSubmit(); });
  $('confirmSubmitCancelBtn').addEventListener('click', () => $('confirmSubmitModal').classList.remove('show'));
  $('confirmSubmitOkBtn').addEventListener('click', () => { $('confirmSubmitModal').classList.remove('show'); submitExam({ auto: false }); });
  $('timeUpOkBtn').addEventListener('click', () => { $('timeUpModal').classList.remove('show'); showScreen('resultsScreen'); });
  $('leftExamOkBtn').addEventListener('click', () => { $('leftExamModal').classList.remove('show'); showScreen('resultsScreen'); });
  $('celebrationOkBtn').addEventListener('click', () => {
    $('celebrationModal').classList.remove('show');
    const cb = celebrationOnContinue; celebrationOnContinue = null;
    if (cb) cb();
  });
  $('leaveWarnOkBtn').addEventListener('click', async () => {
    cancelLeaveCountdown();
    if (isExamActiveOnScreen() && fullscreenSupported() && !isFullscreenActive()) {
      try { await requestFullscreenSafe(); } catch (e) {}
    }
  });

  $('paletteToggleBtn').addEventListener('click', () => { renderPalette(); $('paletteDrawer').classList.add('show'); });
  $('paletteDrawer').addEventListener('click', e => { if (e.target === $('paletteDrawer')) closePaletteDrawer(); });

  $('reviewFilterRow').addEventListener('click', e => {
    const btn = e.target.closest('.review-filter-btn');
    if (!btn || !CURRENT_ATTEMPT) return;
    REVIEW_FILTER = btn.dataset.filter;
    root.querySelectorAll('.review-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderReviewList(CURRENT_ATTEMPT);
  });

  // drag-to-expand / drag-to-close bottom sheet (mobile)
  const sheet = $('paletteSheet'), handle = $('sheetHandle');
  let dragging = false, startY = 0, moved = false, wasFull = false;
  handle.addEventListener('pointerdown', e => {
    dragging = true; moved = false; startY = e.clientY; wasFull = sheet.classList.contains('full');
    sheet.style.transition = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 5) moved = true;
    sheet.style.transform = `translateY(${dy < 0 ? Math.max(dy, -24) : dy}px)`;
  });
  const endDrag = e => {
    if (!dragging) return;
    dragging = false; sheet.style.transition = ''; sheet.style.transform = '';
    const dy = e.clientY - startY;
    if (dy < -40) sheet.classList.add('full');
    else if (dy > 90 && !wasFull) closePaletteDrawer();
    else if (dy > 40 && wasFull) sheet.classList.remove('full');
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('click', () => { if (!moved) sheet.classList.toggle('full'); });
}
