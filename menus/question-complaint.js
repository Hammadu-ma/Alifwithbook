/* ALIF Med — "Complain" about a question's answer.
   Student: opens a sheet, picks the choice they believe is correct, explains why, sends it to the admin.
   Admin: reviews it in adunmin.html → Complaints (approve / reject).
   If the admin approves but has not yet corrected the question, everyone sees a yellow notice on it
   (the question carries complaintApprovedAt + a snapshot of the explanation/answer at approval; once the admin edits either,
   the snapshot no longer matches and the notice disappears by itself).
   No import-time work except registering one delegated click listener. */
import { db } from './cloud-sync.js';
import { doc, setDoc, getDoc, serverTimestamp } from './runtime-ext.js';
import { getStoredStudent, getAuthUser } from './auth.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = v => String(v ?? '').replace(/<[^>]*>/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
const letter = i => String.fromCharCode(65 + i);

/* ---------- the yellow "approved, not corrected yet" state ----------
   Admin approval writes ONE small doc per quiz: questionFlags/{quizId} = { flags: { [questionId]: { ans, h, at } } }.
   h = hash of the explanation at approval time. While the question still has that explanation and answer it is flagged;
   editing either makes the hash differ and the notice goes away by itself. Students read the doc at most once per 30 min per quiz. */
const hashOf = t => { t = String(t ?? '').trim(); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(36) + t.length; };
export function isFlagged(q) {
  // Simple rule: an approved complaint is shown (yellow) until the admin removes the question from review.
  return !!(q && q.complaintApprovedAt);
}
const FLAG_TTL = 10 * 60 * 1000;   // the admin's stamp (settings/appVersion.cf, delivered by the already-open listener) invalidates sooner at zero cost
export async function applyFlags(subjectId, quizId, questions) {
  if (!Array.isArray(questions) || !questions.length) return;
  const key = `alif_qflags_${quizId}`;
  let c = null; try { c = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
  const cf = window.__alifCF || '';
  const stale = !c || Date.now() - (c.t || 0) > FLAG_TTL || (cf && c.cf !== cf);
  if (stale && navigator.onLine !== false) {
    try {
      const snap = await Promise.race([getDoc(doc(db, 'questionFlags', String(quizId))), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))]);
      c = { t: Date.now(), cf, flags: snap.exists() ? (snap.data().flags || {}) : {} };
      try { localStorage.setItem(key, JSON.stringify(c)); } catch (_) {}
    } catch (err) { try { console.warn('[complaints] could not read questionFlags:', err && (err.code || err.message)); } catch (_) {} }
  }
  const f = (c && c.flags) || {};
  questions.forEach(q => {
    const x = f[q.id];
    if (x) { q.complaintApprovedAt = x.at || 1; q.complaintExpl = x.h; q.complaintAns = x.ans; q.complaintProp = x.p == null ? -1 : Number(x.p); q.complaintDesc = x.d || ''; }
  });
  try { const n = questions.filter(q => q.complaintApprovedAt).length; console.info('[complaints] quiz ' + quizId + ': ' + n + ' of ' + questions.length + ' question(s) under review'); } catch (_) {}
}
export function complaintNoticeHtml(q) {
  return isFlagged(q)
    ? '<div class="qc-flag"><i class="fa-solid fa-triangle-exclamation"></i><div><b>Reported by students — approved, not corrected yet</b><span>An admin agreed this question may be wrong, but its answer and explanation have not been updated. Treat it with care.</span></div></div>'
    : '';
}
export function complaintExplHtml(q) {
  if (!isFlagged(q) || !q.complaintDesc) return '';
  const p = Number(q.complaintProp), has = p >= 0 && (q.options || [])[p] != null;
  return `<div class="qc-flag qc-desc"><i class="fa-solid fa-comment-dots"></i><div><b>Student complaint — approved, not corrected yet</b>${has ? `<span>Students suggest the answer may be <b style="display:inline">${String.fromCharCode(65 + p)}</b> (shown in yellow).</span>` : ''}<span class="qc-d">“${esc(q.complaintDesc)}”</span></div></div>`;
}
export const complaintPillHtml = q => (isFlagged(q) ? '<span class="qc-pill"><i class="fa-solid fa-flag"></i> Under review</span>' : '');

/* ---------- student sheet ---------- */
function ensureCss() {
  if (document.getElementById('qcCss')) return;
  const s = document.createElement('style'); s.id = 'qcCss';
  s.textContent = `
.qc-ov{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;padding:12px;animation:qcf .18s ease both}
@keyframes qcf{from{opacity:0}}@keyframes qcu{from{transform:translateY(34px);opacity:0}}
.qc-ov.out{opacity:0;transition:opacity .18s}
.qc-card{width:100%;max-width:520px;max-height:92vh;overflow:auto;background:var(--card,#fff);color:var(--ink,#111);border-radius:22px;padding:20px 18px calc(16px + env(safe-area-inset-bottom,0px));box-shadow:0 20px 60px rgba(0,0,0,.35);animation:qcu .26s cubic-bezier(.2,.9,.3,1) both}
@media(min-width:640px){.qc-ov{align-items:center}}
.qc-h{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.qc-ic{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:rgba(217,119,6,.15);color:#d97706;font-size:18px;flex:none}
.qc-h b{display:block;font-size:17px}.qc-h span{font-size:12.5px;opacity:.65}
.qc-q{font-size:13.5px;line-height:1.5;padding:10px 12px;border-radius:12px;background:rgba(128,128,128,.12);margin-bottom:14px;max-height:92px;overflow:auto}
.qc-lbl{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;opacity:.6;margin:0 0 8px}
.qc-opt{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;padding:10px 12px;margin-bottom:8px;border-radius:12px;border:1.5px solid rgba(128,128,128,.3);background:transparent;color:inherit;font:inherit;font-size:14px;cursor:pointer}
.qc-opt .l{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;background:rgba(128,128,128,.18);flex:none}
.qc-opt small{margin-left:auto;font-size:11px;font-weight:700;opacity:.7;white-space:nowrap;padding-top:3px}
.qc-opt.cur{opacity:.55;cursor:default;border-style:dashed}
.qc-opt.on{border-color:#2563eb;background:rgba(37,99,235,.1)}.qc-opt.on .l{background:#2563eb;color:#fff}
.qc-ta{width:100%;box-sizing:border-box;margin-top:6px;padding:11px 13px;border-radius:12px;border:1.5px solid rgba(128,128,128,.3);background:transparent;color:inherit;font:14.5px/1.5 inherit;resize:none;outline:none}
.qc-ta:focus{border-color:#2563eb}
.qc-act{display:flex;gap:10px;margin-top:14px}.qc-act button{flex:1;padding:13px;border-radius:14px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font:700 14px inherit;cursor:pointer}
.qc-act .go{background:#d97706;border-color:#d97706;color:#fff}.qc-act .go:disabled{opacity:.5}
.qc-err{color:#dc2626;font-size:13px;margin-top:8px;min-height:18px}
.qc-flag{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;margin:0 0 10px;border-radius:12px;background:rgba(250,204,21,.22);border:1px solid rgba(202,138,4,.5);color:inherit;font-size:13px;line-height:1.45}
.qc-flag i{color:#ca8a04;margin-top:2px}.qc-flag b{display:block}.qc-flag span{opacity:.8}
.qc-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;background:rgba(250,204,21,.3);color:#a16207}
body.dark .qc-pill{color:#fde047}
.qcard.qc-flagged .card-inner{background-image:linear-gradient(rgba(250,204,21,.16),rgba(250,204,21,.16));border-left-color:#eab308!important;box-shadow:0 0 0 1.5px rgba(234,179,8,.55)}
.qc-flag{margin:10px 0 12px}
.qc-flag .qc-d{margin-top:6px;white-space:pre-wrap;font-style:italic;opacity:1}
.opt.reveal-claim{background:rgba(250,204,21,.22)!important;border-color:#eab308!important}
.opt.reveal-claim .letter{background:#eab308!important;color:#1f1700!important;border-color:#eab308!important}
body.dark .opt.reveal-claim{background:rgba(250,204,21,.18)!important}
`;
  document.head.appendChild(s);
}

export function openComplaint({ q, subjectId, quizId, subjectName, quizName }) {
  if (!q || !subjectId || !quizId) { alert('Could not identify this question.'); return; }
  const st = getStoredStudent();
  if (!st || st.guest) { alert('Sign in with your student account to report a question.'); return; }
  ensureCss();
  const opts = (q.options || []).map(plain);
  let pick = -1;
  const w = document.createElement('div');
  w.className = 'qc-ov';
  w.innerHTML = `<div class="qc-card" role="dialog" aria-modal="true" aria-label="Report this question">
    <div class="qc-h"><div class="qc-ic"><i class="fa-solid fa-flag"></i></div><div><b>Report a wrong answer</b><span>Q${esc(q.number || '')} · ${esc(quizName || '')}</span></div></div>
    <div class="qc-q">${esc(plain(q.question)).slice(0, 400)}</div>
    <p class="qc-lbl">Which answer do you think is correct?</p>
    ${opts.map((o, i) => `<button type="button" class="qc-opt${i === q.answerIndex ? ' cur' : ''}" data-i="${i}" ${i === q.answerIndex ? 'disabled' : ''}><span class="l">${letter(i)}</span><span>${esc(o).slice(0, 220)}</span>${i === q.answerIndex ? '<small>Current answer</small>' : ''}</button>`).join('')}
    <p class="qc-lbl" style="margin-top:14px">Why? Explain for the admin</p>
    <textarea class="qc-ta" rows="4" maxlength="1200" placeholder="Explain why your choice is correct — mention the book, page or guideline if you can."></textarea>
    <div class="qc-err" data-err></div>
    <div class="qc-act"><button type="button" data-x>Cancel</button><button type="button" class="go" data-go>Send</button></div></div>`;
  document.body.appendChild(w);
  const ta = w.querySelector('textarea'), err = w.querySelector('[data-err]'), go = w.querySelector('[data-go]');
  const close = () => { w.classList.add('out'); setTimeout(() => w.remove(), 180); };
  w.addEventListener('click', async e => {
    if (e.target === w || e.target.closest('[data-x]')) { close(); return; }
    const o = e.target.closest('.qc-opt:not(.cur)');
    if (o) { pick = +o.dataset.i; w.querySelectorAll('.qc-opt').forEach(x => x.classList.toggle('on', x === o)); err.textContent = ''; return; }
    if (!e.target.closest('[data-go]')) return;
    const text = ta.value.trim();
    if (pick < 0) { err.textContent = 'Choose the answer you think is correct.'; return; }
    if (text.length < 10) { err.textContent = 'Please write a short explanation (at least 10 characters).'; return; }
    const user = getAuthUser && getAuthUser();
    if (!user) { err.textContent = 'Please sign in again.'; return; }
    go.disabled = true; go.textContent = 'Sending…';
    try {
      await setDoc(doc(db, 'questionComplaints', `${user.uid}_${quizId}_${q.id}`.replace(/[^a-zA-Z0-9_-]/g, '_')), {
        uid: user.uid, studentId: st.id || st.studentId || '', studentName: st.name || st.fullName || '',
        subjectId, subjectName: subjectName || '', quizId, quizName: quizName || '',
        questionId: q.id, questionNumber: q.number || 0, question: String(q.question || '').slice(0, 2000),
        options: (q.options || []).map(x => String(x).slice(0, 600)),
        currentAnswer: q.answerIndex, proposedAnswer: pick, explanation: text,
        explanationAtComplaint: String(q.explanation || ''), status: 'pending',
        createdAt: serverTimestamp(), createdMs: Date.now()
      });
      close();
      try { window.toast ? window.toast('Sent to the admin — thank you') : null; } catch (_) {}
      const t = document.createElement('div');
      t.textContent = 'Sent to the admin — thank you';
      t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2100;background:#16a34a;color:#fff;padding:11px 18px;border-radius:999px;font:700 14px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.3)';
      document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
    } catch (e2) {
      go.disabled = false; go.textContent = 'Send';
      err.textContent = /permission/i.test(String(e2 && (e2.code || e2.message))) ? 'You have already reported this question — the admin will review it.' : 'Could not send. Check your connection and try again.';
    }
  });
  setTimeout(() => { try { ta.focus({ preventScroll: true }); } catch (_) {} }, 150);
}

try { ensureCss(); } catch (_) {}   // the highlight styles must exist as soon as this module loads, not only when the complaint sheet opens
window.__alifQC = { expl: complaintExplHtml, apply: applyFlags, notice: complaintNoticeHtml, pill: complaintPillHtml, flagged: isFlagged, open: openComplaint };

/* practice cards: the Complain button inside .qcard */
document.addEventListener('click', async e => {
  const b = e.target.closest && e.target.closest('[data-complain]');
  if (!b) return;
  e.preventDefault();
  try {
    const qe = await import('./quiz-engine.js');
    const q = qe.byId && qe.byId[b.dataset.complain];
    const c = window.__alifQuizCtx || {};
    openComplaint({ q, subjectId: c.subjectId, quizId: c.quizId, subjectName: c.subjectName, quizName: c.quizName });
  } catch (_) { alert('Could not open the report form.'); }
});
