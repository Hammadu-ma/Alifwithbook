/* ALIF Med — Progress page: "Progress by module" as a settings-style list of the student's unlocked / enrolled
   modules. Tapping one slides in a full screen with that module's complete progress detail. */
import { escapeHtml as esc } from './loaders.js';
import { isResourceLocked } from './lock.js';
import { ALL_MODULES, ALL_QUIZZES, SUBJECTS_CACHE, subjectColorFor } from './picker-screen.js';
import { getQuizProgressPct, getSubjectProgressPct, ringColorVar, scanLocalProgress } from './progress-rings.js';
import { pushModalState, popModalState } from './modal-backbutton.js';
import { loadQuestions } from './onboarding-tour.js';
import { renderInline, renderRich } from './text-render.js';

const pct = n => Math.max(0, Math.min(100, Math.round(n || 0)));
const col = n => ringColorVar(n, false);

/* modules the student can open (not locked, or enrolled) */
function visibleModules(data, student) {
  return data.moduleBreakdown.filter(g => {
    if (g.id === '__unassigned') return true;
    const m = ALL_MODULES.find(x => x.id === g.id);
    // honours enrolments / access grants, like Home
    try { return !m || !isResourceLocked(m, student, 'module'); } catch (_) { return true; }
  });
}

export function pgModuleList(data, student) {
  const mods = visibleModules(data, student);
  if (!mods.length) return '<div class="pg-empty"><i class="fa-solid fa-book"></i><div>No modules unlocked yet.</div></div>';
  return `<div class="pgm-list">${mods.map(g => {
    const quizzes = ALL_QUIZZES.filter(q => g.subjects.some(s => s.id === q.subjectId)).length;
    return `<button type="button" class="pgm-row" data-mod="${esc(g.id)}" style="--rowc:${g.color}">
      <span class="pgm-ico"><i class="${g.icon}"></i></span>
      <span class="pgm-txt"><span class="pgm-name">${esc(g.name)}</span>
        <span class="pgm-meta">${g.subjects.length} subject${g.subjects.length === 1 ? '' : 's'} · ${quizzes} quiz${quizzes === 1 ? '' : 'zes'}</span>
        <span class="pgm-bar"><span style="width:${pct(g.pct)}%;background:${col(g.pct)}"></span></span></span>
      <span class="pgm-pct" style="color:${col(g.pct)}">${pct(g.pct)}%</span>
      <i class="fa-solid fa-chevron-right pgm-chev"></i></button>`;
  }).join('')}</div>`;
}

function detailHtml(g, student) {
  const subjIds = new Set(g.subjects.map(s => s.id));
  const quizzes = ALL_QUIZZES.filter(q => subjIds.has(q.subjectId));
  const entries = scanLocalProgress(student.id).filter(e => subjIds.has(e.subjectId));
  let answered = 0, correct = 0, completed = 0, started = 0;
  const cats = {}, recent = [];
  entries.forEach(e => {
    const ans = e.answers || {};
    const n = Object.keys(ans).length;
    if (!n) return;
    started++;
    if (e.completed) completed++;
    const q = quizzes.find(x => x.id === e.quizId && x.subjectId === e.subjectId);
    Object.values(ans).forEach(a => {
      answered++;
      if (a.correct) correct++;
      if (a.category) { const c = cats[a.category] || { correct: 0, total: 0 }; c.total++; if (a.correct) c.correct++; cats[a.category] = c; }
      if (a.answeredAt) recent.push({ t: a.answeredAt, ok: a.correct, name: q ? q.name : 'Quiz' });
    });
  });
  const acc = answered ? Math.round(correct / answered * 100) : 0;
  const catList = Object.entries(cats).map(([name, c]) => ({ name, pct: c.correct / c.total * 100, total: c.total })).filter(c => c.total >= 2);
  const strong = catList.slice().sort((a, b) => b.pct - a.pct).slice(0, 4);
  const weak = catList.slice().sort((a, b) => a.pct - b.pct).slice(0, 4);
  recent.sort((a, b) => b.t - a.t);
  const ago = t => { const m = Math.floor((Date.now() - t) / 6e4); if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'; };
  const catRows = (list, empty) => list.length ? list.map(c => `<div class="pg-cat-item"><span class="cname">${esc(c.name)}</span>
    <div class="bar-track" style="flex:1;height:6px;"><div class="bar-fill-right" style="width:${pct(c.pct)}%;background:${col(c.pct)}"></div></div>
    <span class="cpct" style="color:${col(c.pct)}">${pct(c.pct)}%</span></div>`).join('') : `<div class="pgm-none">${empty}</div>`;

  const subjectsHtml = g.subjects.map(s => {
    const qs = quizzes.filter(q => q.subjectId === s.id);
    const tone = (() => { try { return subjectColorFor(s.id) || g.color; } catch (_) { return g.color; } })();
    const se = entries.filter(e => e.subjectId === s.id);
    let sAns = 0, sOk = 0, sDone = 0, sStart = 0;
    const sc = {};
    se.forEach(e => {
      const ans = e.answers || {}, n = Object.keys(ans).length;
      if (!n) return;
      sStart++; if (e.completed) sDone++;
      Object.values(ans).forEach(a => {
        sAns++; if (a.correct) sOk++;
        if (a.category) { const c = sc[a.category] || { ok: 0, t: 0 }; c.t++; if (a.correct) c.ok++; sc[a.category] = c; }
      });
    });
    const sAcc = sAns ? Math.round(sOk / sAns * 100) : 0;
    const cl = Object.entries(sc).map(([name, c]) => ({ name, pct: c.ok / c.t * 100, t: c.t })).filter(c => c.t >= 2);
    const best = cl.slice().sort((x, y) => y.pct - x.pct)[0];
    const worst = cl.slice().sort((x, y) => x.pct - y.pct)[0];
    const insight = !sAns ? 'Not started yet — answer a few questions to see your analysis.'
      : sAcc >= 75 ? 'Strong command of this subject. Keep revising to stay sharp.'
      : sAcc >= 50 ? 'Solid base — a bit more practice will lift the weaker areas.'
      : 'Needs attention — review the explanations and retry the quizzes.';
    const catPill = (c, kind) => c && cl.length > 1 ? `<span class="pgm-pill ${kind}"><i class="fa-solid ${kind === 'best' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}"></i> ${esc(c.name)} · ${pct(c.pct)}%</span>` : '';
    return `<div class="pgm-subj" style="--tone:${tone}">
      <div class="pgm-subj-head"><span class="pgm-subj-dot"></span><span class="pgm-subj-name">${esc(s.name)}</span>
        <span class="pgm-subj-pct">${pct(s.pct)}%</span></div>
      <div class="pgm-subj-bar"><span style="width:${pct(s.pct)}%"></span></div>
      <div class="pgm-subj-stats">
        <div><b>${sDone}/${qs.length}</b><span>Completed</span></div>
        <div><b>${sAns}</b><span>Answered</span></div>
        <div><b>${sOk}</b><span>Correct</span></div>
        <div><b>${sAcc}%</b><span>Accuracy</span></div></div>
      <div class="pgm-subj-note">${esc(insight)}</div>
      ${catPill(best, 'best')}${catPill(worst, 'weak')}
      <div class="pgm-quizzes">${qs.map(q => {
        const p = getQuizProgressPct(student.id, q.subjectId, q.id);
        const state = p.pct >= 100 || (p.inProgress === false && p.pct > 0) ? 'done' : (p.inProgress || p.answeredCount) ? 'going' : 'new';
        const label = state === 'done' ? 'Completed' : state === 'going' ? 'In progress' : 'Not started';
        return `<button type="button" class="pgm-quiz" data-qs="${esc(q.subjectId)}" data-qid="${esc(q.id)}"><span class="pgm-qname">${esc(q.name)}</span><span class="pgm-chip ${state}">${label}</span>
          <span class="pgm-qpct">${pct(p.pct)}%</span><i class="fa-solid fa-chevron-right pgm-qchev"></i></button>`;
      }).join('') || '<div class="pgm-none">No quizzes yet</div>'}</div></div>`;
  }).join('');

  return `<div class="pgm-hero" style="--rowc:${g.color}">
      <div class="pgm-ring" style="background:conic-gradient(${col(g.pct)} ${3.6 * pct(g.pct)}deg, var(--card-border) 0deg)"><div class="pgm-ring-in"><b>${pct(g.pct)}%</b><small>mastery</small></div></div>
      <div class="pgm-hero-tx"><div class="pgm-hero-name">${esc(g.name)}</div>
        <div class="pgm-meta">${g.subjects.length} subject${g.subjects.length === 1 ? '' : 's'} · ${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'}</div></div></div>
    <div class="pgm-stats">
      <div class="pgm-stat"><b>${completed}/${quizzes.length}</b><span>Completed</span></div>
      <div class="pgm-stat"><b>${started}</b><span>Started</span></div>
      <div class="pgm-stat"><b>${answered}</b><span>Answered</span></div>
      <div class="pgm-stat"><b>${acc}%</b><span>Accuracy</span></div></div>
    <div class="pgm-sec"><h3>Subject analysis</h3>${subjectsHtml}</div>
    <div class="pgm-sec"><h3>Strongest categories</h3><div class="pg-cat-list">${catRows(strong, 'Answer a few more questions to unlock this.')}</div></div>
    <div class="pgm-sec"><h3>Needs work</h3><div class="pg-cat-list">${catRows(weak, 'Answer a few more questions to unlock this.')}</div></div>
    <div class="pgm-sec"><h3>Recent activity</h3>${recent.length ? recent.slice(0, 8).map(r => `<div class="pg-activity-row"><span class="act-dot ${r.ok ? 'ok' : 'no'}"></span><span class="act-txt">${esc(r.name)}</span><span class="act-time">${ago(r.t)}</span></div>`).join('') : '<div class="pgm-none">No activity in this module yet.</div>'}</div>`;
}

function openDetail(g, student) {
  const sub = document.createElement('div');
  sub.className = 'pgm-sub';
  sub.innerHTML = `<div class="pgm-topbar"><button type="button" class="pgm-back" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><div class="pgm-topbar-title">${esc(g.name)}</div><span style="width:40px"></span></div><main class="pgm-main">${detailHtml(g, student)}</main>`;
  document.body.appendChild(sub);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sub.classList.remove('open');
    popModalState(close);
    setTimeout(() => sub.remove(), 320);
  };
  sub.querySelector('.pgm-back').addEventListener('click', close);
  sub.querySelectorAll('.pgm-quiz[data-qid]').forEach(b => b.addEventListener('click', () => openQuizDetail(b.dataset.qs, b.dataset.qid, student)));
  pushModalState(close);
  requestAnimationFrame(() => requestAnimationFrame(() => sub.classList.add('open')));
}

export function pgWireModules(root, data, student) {
  root.querySelectorAll('.pgm-row').forEach(btn => btn.addEventListener('click', () => {
    const g = data.moduleBreakdown.find(x => x.id === btn.dataset.mod);
    if (g) openDetail(g, student);
  }));
}


/* ---------- question-level analysis for one quiz ---------- */
function quizDetailHtml(quiz, questions, entry) {
  const ans = (entry && entry.answers) || {};
  const rows = questions.map((q, i) => {
    const a = ans[q.id];
    return { q, i, a, state: !a ? 'skip' : a.correct ? 'ok' : 'bad' };
  });
  const answered = rows.filter(r => r.a).length;
  const ok = rows.filter(r => r.state === 'ok').length;
  const bad = rows.filter(r => r.state === 'bad').length;
  const skip = rows.length - answered;
  const acc = answered ? Math.round(ok / answered * 100) : 0;
  const cats = {};
  rows.forEach(r => {
    const k = r.q.categoryLabel || r.q.category || 'General';
    const c = cats[k] || (cats[k] = { ok: 0, bad: 0, skip: 0, t: 0 });
    c.t++; c[r.state === 'ok' ? 'ok' : r.state === 'bad' ? 'bad' : 'skip']++;
  });
  const catHtml = Object.entries(cats).map(([name, c]) => `<div class="pgq-cat"><div class="pgq-cat-head"><span>${esc(name)}</span><b>${c.ok}/${c.t}</b></div>
    <div class="pgq-stack"><span class="ok" style="width:${c.ok / c.t * 100}%"></span><span class="bad" style="width:${c.bad / c.t * 100}%"></span></div></div>`).join('');
  const L = i => String.fromCharCode(65 + i);
  const qHtml = rows.map(r => {
    const q = r.q, a = r.a;
    const opts = q.options.map((o, oi) => {
      const isRight = oi === q.answerIndex, isPick = a && a.selected === oi;
      const cls = isRight ? 'right' : (isPick ? 'wrong' : '');
      return `<div class="pgq-opt ${cls}"><b>${L(oi)}</b><span class="markdown-body">${renderInline(String(o))}</span>${isRight ? '<i class="fa-solid fa-check"></i>' : isPick ? '<i class="fa-solid fa-xmark"></i>' : ''}</div>`;
    }).join('');
    // same panels as the normal question page: Explanation + Why not the others
    let why = '';
    q.options.forEach((o, oi) => {
      if (oi === q.answerIndex) return;
      const w = q.whyNot && q.whyNot[String(oi)] || '';
      why += `<div class="why-item"><b>${L(oi)} — ${renderInline(String(o))}</b><div class="markdown-body">${renderRich(w)}</div></div>`;
    });
    const expl = (q.explanation ? `<div class="panel" data-panel="exp"><h4>Explanation</h4><div class="markdown-body">${renderRich(q.explanation)}</div></div>` : '')
      + (why && q.options.length > 1 && Object.keys(q.whyNot || {}).length ? `<div class="panel" data-panel="why"><h4>Why not the others</h4>${why}</div>` : '');
    return `<div class="pgq-q ${r.state}" data-state="${r.state}">
      <button type="button" class="pgq-q-head"><span class="pgq-num">${r.i + 1}</span><span class="pgq-qt">${esc(q.question)}</span>
        <span class="pgq-st ${r.state}"><i class="fa-solid ${r.state === 'ok' ? 'fa-check' : r.state === 'bad' ? 'fa-xmark' : 'fa-minus'}"></i></span></button>
      <div class="pgq-q-body">${q.category ? `<div class="pgq-qcat">${esc(q.categoryLabel || q.category)}</div>` : ''}<div class="pgq-qfull markdown-body">${renderRich(q.question)}</div>${opts}${expl}</div></div>`;
  }).join('');
  return `<div class="pgm-hero"><div class="pgm-ring" style="background:conic-gradient(${col(acc)} ${3.6 * acc}deg, var(--card-border) 0deg)"><div class="pgm-ring-in"><b>${acc}%</b><small>accuracy</small></div></div>
      <div class="pgm-hero-tx"><div class="pgm-hero-name">${esc(quiz.name)}</div><div class="pgm-meta">${answered}/${rows.length} answered${entry && entry.completed ? ' · Completed' : ''}</div></div></div>
    <div class="pgm-stats">
      <div class="pgm-stat"><b style="color:var(--right)">${ok}</b><span>Correct</span></div>
      <div class="pgm-stat"><b style="color:var(--wrong)">${bad}</b><span>Wrong</span></div>
      <div class="pgm-stat"><b>${skip}</b><span>Unanswered</span></div>
      <div class="pgm-stat"><b>${rows.length}</b><span>Total</span></div></div>
    <div class="pgm-sec"><h3>By category</h3>${catHtml}</div>
    <div class="pgm-sec"><h3>Questions</h3>
      <div class="pgq-filters"><button type="button" class="on" data-f="all">All</button><button type="button" data-f="bad">Wrong</button><button type="button" data-f="ok">Correct</button><button type="button" data-f="skip">Unanswered</button></div>
      <div class="pgq-list">${qHtml}</div></div>`;
}

async function openQuizDetail(subjectId, quizId, student) {
  const quiz = ALL_QUIZZES.find(q => q.id === quizId && q.subjectId === subjectId);
  if (!quiz) return;
  const sub = document.createElement('div');
  sub.className = 'pgm-sub pgm-sub2';
  sub.innerHTML = `<div class="pgm-topbar"><button type="button" class="pgm-back" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><div class="pgm-topbar-title">${esc(quiz.name)}</div><span style="width:40px"></span></div><main class="pgm-main"><div class="pgm-none" style="text-align:center;padding:40px 0"><i class="fa-solid fa-circle-notch fa-spin"></i></div></main>`;
  document.body.appendChild(sub);
  let closed = false;
  const close = () => { if (closed) return; closed = true; sub.classList.remove('open'); popModalState(close); setTimeout(() => sub.remove(), 320); };
  sub.querySelector('.pgm-back').addEventListener('click', close);
  pushModalState(close);
  requestAnimationFrame(() => requestAnimationFrame(() => sub.classList.add('open')));
  const main = sub.querySelector('.pgm-main');
  try {
    const questions = await loadQuestions(subjectId, quizId);
    const entry = scanLocalProgress(student.id).find(e => e.subjectId === subjectId && e.quizId === quizId);
    main.innerHTML = quizDetailHtml(quiz, questions, entry);
    main.querySelectorAll('.pgq-q-head').forEach(h => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
    const filters = main.querySelectorAll('.pgq-filters button');
    filters.forEach(b => b.addEventListener('click', () => {
      filters.forEach(x => x.classList.toggle('on', x === b));
      main.querySelectorAll('.pgq-q').forEach(q => { q.style.display = b.dataset.f === 'all' || q.dataset.state === b.dataset.f ? '' : 'none'; });
    }));
  } catch (_) {
    main.innerHTML = '<div class="pgm-none" style="text-align:center;padding:40px 12px">Couldn’t load this quiz’s questions. Check your connection and try again.</div>';
  }
}
