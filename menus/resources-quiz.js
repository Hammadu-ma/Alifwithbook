/* Related quizzes for the video player: resolve admin-made links into quiz cards,
   and run a quiz INLINE (under the video) with instant feedback.
   Link shapes stored on a video:  related.quizzes = [
     { type: 'quiz',     subjectId, quizId }      one specific quiz (e.g. a past-year paper)
     { type: 'subject',  subjectId }               every quiz of a subject
     { type: 'module',   moduleId }                every quiz of every subject in a module
     { type: 'category', subjectId, category }     questions of one category across a subject's quizzes
   ] */
import { db } from './cloud-sync.js';
import { cacheState, getCachedWithTTL, setCachedWithTTL } from './loaders.js';
import { getEffectiveLockMessage, isResourceLocked } from './lock.js';
import { loadQuestions } from './onboarding-tour.js';
import { collection, getDocs, orderBy, query } from './runtime-ext.js';
import { esc, norm, plain, safeUrl, shuffle } from './resources-util.js';

/* same cache key + shape the Exams tab uses, so quizzes already seen there cost nothing */
export async function loadQuizzesOf(subjectId) {
  const key = 'atlas_quizzes_' + subjectId;
  const cached = getCachedWithTTL(key);
  if (cached && cacheState(cached) === 'fresh') return cached.data;
  try {
    const list = (await getDocs(query(collection(db, 'subjects', subjectId, 'quizzes'), orderBy('order')))).docs.map(d => ({ id: d.id, ...d.data() }));
    setCachedWithTTL(key, list);
    return list;
  } catch (e) {
    if (cached) return cached.data;
    throw e;
  }
}

const isInAppQuiz = q => !(q.linkUrl || q.type === 'link');

/* -> [{ subjectId, subjectName, items: [ {key, kind:'quiz'|'category', ...} ] }] */
export async function resolveQuizLinks(links, { subjects, student }) {
  const subjOf = id => subjects.find(s => s.id === id);
  const groups = new Map();
  const seen = new Set();
  const add = (subjectId, item) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    const s = subjOf(subjectId);
    if (!groups.has(subjectId)) groups.set(subjectId, { subjectId, subjectName: s ? s.name : 'Quizzes', items: [] });
    groups.get(subjectId).items.push({ ...item, subjectId, subjectName: s ? s.name : '' });
  };
  const quizItem = (subjectId, q) => ({ key: `q:${subjectId}:${q.id}`, kind: 'quiz', quiz: q, locked: isResourceLocked({ ...q, subjectId }, student, 'quiz') });

  const subjectIdsFor = l => l.type === 'module' ? subjects.filter(s => s.moduleId === l.moduleId).map(s => s.id) : [l.subjectId];
  await Promise.all((links || []).map(async l => {
    try {
      if (l.type === 'category') { if (l.subjectId && l.category) add(l.subjectId, { key: `c:${l.subjectId}:${norm(l.category)}`, kind: 'category', category: l.category }); return; }
      for (const sid of subjectIdsFor(l)) {
        if (!sid) continue;
        const list = await loadQuizzesOf(sid);
        list.filter(isInAppQuiz).forEach(q => { if (l.type !== 'quiz' || q.id === l.quizId) add(sid, quizItem(sid, q)); });
      }
    } catch (_) { /* a failed link just doesn't show */ }
  }));
  // quizzes first (in their own order), then category practice; subjects in the subjects-list order
  groups.forEach(g => g.items.sort((a, b) => (a.kind === 'category') - (b.kind === 'category') || (a.kind === 'quiz' ? (Number(a.quiz.order) || 0) - (Number(b.quiz.order) || 0) : 0)));
  return [...groups.values()].sort((a, b) => subjects.findIndex(s => s.id === a.subjectId) - subjects.findIndex(s => s.id === b.subjectId));
}

export function lockMessage(item, student) {
  return getEffectiveLockMessage({ ...item.quiz, subjectId: item.subjectId }, 'quizzes', student) || 'This quiz is locked for you';
}

export async function loadQuizQuestions(item) {
  return loadQuestions(item.subjectId, item.quiz.id);
}

/* Gather a category's questions across a subject's open quizzes (cached per quiz). */
export async function loadCategoryQuestions(item, student, onProgress) {
  const quizzes = (await loadQuizzesOf(item.subjectId)).filter(isInAppQuiz)
    .filter(q => !isResourceLocked({ ...q, subjectId: item.subjectId }, student, 'quiz'));
  const want = norm(item.category), out = [];
  let done = 0;
  const queue = quizzes.slice();
  const worker = async () => {
    while (queue.length) {
      const q = queue.shift();
      try { (await loadQuestions(item.subjectId, q.id)).forEach(x => { if (norm(x.categoryLabel || x.category) === want) out.push(x); }); } catch (_) {}
      onProgress && onProgress(++done, quizzes.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return shuffle(out).slice(0, 50);
}

/* ------------------------------------------------------------- inline runner */
const LETTERS = 'ABCDEFGHIJ';

export function mountQuiz(host, { title, sub, questions }, { onBack } = {}) {
  let list = questions.slice(), i = 0, answers = {}, finished = false;
  const total = () => list.length;

  host.innerHTML = '<div class="rq"></div>';
  const root = host.firstElementChild;

  function head(countText, pct) {
    return `<div class="rq-bar"><button type="button" class="res-sheet-x static" data-back aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
      <div class="rq-title"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div><span class="rq-count">${esc(countText)}</span></div>
      <div class="rq-prog"><i style="width:${pct}%"></i></div>`;
  }

  function renderQuestion() {
    const q = list[i];
    const picked = answers[q.id];
    const answered = picked !== undefined;
    const img = safeUrl(q.image);
    root.innerHTML = `${head(`${i + 1} / ${total()}`, (i / total()) * 100)}
      <div class="rq-body">
        ${q.categoryLabel ? `<span class="rq-cat">${esc(q.categoryLabel)}</span>` : ''}
        <div class="rq-q">${esc(plain(q.question))}</div>
        ${img ? `<img class="rq-img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <div class="rq-opts">${q.options.map((o, k) => {
          const cls = !answered ? '' : k === q.answerIndex ? ' correct' : k === picked ? ' wrong' : ' dim';
          return `<button type="button" class="rq-opt${cls}" data-opt="${k}" ${answered ? 'disabled' : ''}><b>${LETTERS[k] || k + 1}</b><span>${esc(plain(o))}</span>
            ${answered && k === q.answerIndex ? '<i class="fa-solid fa-check"></i>' : ''}${answered && k === picked && k !== q.answerIndex ? '<i class="fa-solid fa-xmark"></i>' : ''}</button>`;
        }).join('')}</div>
        ${answered && q.explanation ? `<div class="rq-exp"><b>Explanation</b><p>${esc(plain(q.explanation))}</p></div>` : ''}
      </div>
      <div class="rq-foot">
        <button type="button" class="rq-nav" data-prev ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-left"></i> Prev</button>
        <button type="button" class="rq-nav primary" data-next ${answered ? '' : 'disabled'}>${i === total() - 1 ? 'Finish' : 'Next'} <i class="fa-solid fa-chevron-right"></i></button>
      </div>`;
    root.querySelector('.rq-body').scrollTop = 0;
  }

  function renderSummary() {
    const correct = list.filter(q => answers[q.id] === q.answerIndex).length;
    const wrong = list.filter(q => answers[q.id] !== undefined && answers[q.id] !== q.answerIndex);
    const pct = Math.round((correct / total()) * 100);
    root.innerHTML = `${head('Done', 100)}
      <div class="rq-body rq-sum">
        <div class="rq-ring" style="--p:${pct}"><span>${pct}%</span></div>
        <h4>${pct >= 80 ? 'Excellent work!' : pct >= 50 ? 'Good effort — keep going' : 'Keep practising'}</h4>
        <p>You answered <b>${correct}</b> of <b>${total()}</b> correctly.</p>
        <div class="rq-sum-actions">
          ${wrong.length ? `<button type="button" class="rq-nav primary" data-retry-wrong><i class="fa-solid fa-hourglass-half"></i> Retry ${wrong.length} mistake${wrong.length === 1 ? '' : 's'}</button>` : ''}
          <button type="button" class="rq-nav" data-retry-all><i class="fa-solid fa-play"></i> Restart</button>
          <button type="button" class="rq-nav" data-back><i class="fa-solid fa-arrow-left"></i> Back to quizzes</button>
        </div>
      </div>`;
  }

  const render = () => (finished ? renderSummary() : renderQuestion());

  const onClick = e => {
    if (e.target.closest('[data-back]')) { onBack && onBack(); return; }
    const opt = e.target.closest('[data-opt]');
    if (opt && !finished) { const q = list[i]; if (answers[q.id] === undefined) { answers[q.id] = +opt.dataset.opt; renderQuestion(); } return; }
    if (e.target.closest('[data-next]')) { if (i < total() - 1) { i++; } else { finished = true; } render(); return; }
    if (e.target.closest('[data-prev]')) { if (i > 0) { i--; render(); } return; }
    if (e.target.closest('[data-retry-all]')) { list = questions.slice(); answers = {}; i = 0; finished = false; render(); return; }
    if (e.target.closest('[data-retry-wrong]')) {
      list = list.filter(q => answers[q.id] !== undefined && answers[q.id] !== q.answerIndex); answers = {}; i = 0; finished = false; render();
    }
  };
  root.addEventListener('click', onClick);
  render();
  return { destroy() { root.removeEventListener('click', onClick); } };
}
