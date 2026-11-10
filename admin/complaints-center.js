/* ALIF Med — Complaints (admin). Students report a wrong answer from the quiz screen; here the admin approves or rejects.
   Approve  → the question gets complaintApprovedAt + a snapshot of its current explanation/answer. While those still match
              (the admin has not corrected the question yet) students see a yellow "approved, not corrected yet" notice.
              Editing the explanation or the answer makes the snapshot stale and the notice disappears on its own.
   Reject   → closes the report (optional note). */
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc, updateDoc, collection, getDocs, query, where, limit, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const auth = getAuth(getApp());
const db = getFirestore(getApp());
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = v => String(v ?? '').replace(/<[^>]*>/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
const toast = (m, t = 'info') => { try { window.toast?.(m, t); } catch (_) {} };
const letter = i => String.fromCharCode(65 + (+i || 0));
const qPath = c => doc(db, 'subjects', c.subjectId, 'quizzes', c.quizId, 'questions', c.questionId);

let filter = 'pending', rows = [], built = false;

const CSS = `
#tab-complaints .cp-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
#tab-complaints .cp-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border,rgba(128,128,128,.3));flex:1;min-width:260px}
#tab-complaints .cp-tab{padding:10px 16px;background:none;border:0;border-bottom:3px solid transparent;margin-bottom:-1px;color:inherit;opacity:.6;font:600 14px inherit;cursor:pointer}
#tab-complaints .cp-tab.on{opacity:1;border-bottom-color:var(--tc)}
#tab-complaints .cp-card{border:1px solid var(--border,rgba(128,128,128,.3));border-radius:16px;padding:16px;margin-bottom:14px;background:var(--surface,transparent)}
#tab-complaints .cp-meta{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:12.5px;opacity:.75;margin-bottom:10px}
#tab-complaints .cp-q{font-size:14.5px;line-height:1.55;font-weight:600;margin-bottom:10px}
#tab-complaints .cp-opt{display:flex;gap:10px;align-items:flex-start;padding:8px 11px;border-radius:10px;margin-bottom:6px;border:1.5px solid rgba(128,128,128,.25);font-size:13.5px}
#tab-complaints .cp-opt .l{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11.5px;font-weight:800;background:rgba(128,128,128,.18);flex:none}
#tab-complaints .cp-opt small{margin-left:auto;font-weight:800;font-size:11px;white-space:nowrap}
#tab-complaints .cp-opt.cur{border-color:#16a34a;background:rgba(22,163,74,.1)}#tab-complaints .cp-opt.cur small{color:#16a34a}
#tab-complaints .cp-opt.prop{border-color:#2563eb;background:rgba(37,99,235,.1)}#tab-complaints .cp-opt.prop small{color:#2563eb}
#tab-complaints .cp-why{margin:12px 0;padding:11px 13px;border-radius:12px;background:rgba(217,119,6,.1);border-left:4px solid #d97706;font-size:14px;line-height:1.55;white-space:pre-wrap}
#tab-complaints .cp-why b{display:block;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.7;margin-bottom:4px}
#tab-complaints .cp-act{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
#tab-complaints .cp-act input{flex:1;min-width:180px;padding:10px 12px;border-radius:10px;border:1px solid var(--border,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:13.5px}
#tab-complaints .cp-btn{padding:10px 18px;border-radius:10px;border:0;font:700 13.5px inherit;cursor:pointer;color:#fff}
#tab-complaints .cp-btn.ok{background:#16a34a}#tab-complaints .cp-btn.no{background:#dc2626}#tab-complaints .cp-btn.gr{background:#6b7280}
#tab-complaints .cp-btn:disabled{opacity:.5}
#tab-complaints .cp-st{display:inline-flex;gap:6px;align-items:center;font-weight:800;font-size:12px;padding:3px 10px;border-radius:999px}
#tab-complaints .cp-st.approved{background:rgba(22,163,74,.15);color:#16a34a}#tab-complaints .cp-st.rejected{background:rgba(220,38,38,.12);color:#dc2626}#tab-complaints .cp-st.flag{background:rgba(250,204,21,.3);color:#a16207}
#tab-complaints .cp-empty{text-align:center;opacity:.6;padding:50px 10px}
.comp-badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#dc2626;color:#fff;font:800 11px/1 inherit;margin-left:6px}
`;

function build() {
  if (built) return; built = true;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  $('tab-complaints').innerHTML = `<div class="cp-top"><div class="cp-tabs">
      <button class="cp-tab on" data-f="pending" style="--tc:#d97706">Pending <b data-n="pending"></b></button>
      <button class="cp-tab" data-f="approved" style="--tc:#16a34a">Approved</button>
      <button class="cp-tab" data-f="rejected" style="--tc:#dc2626">Rejected</button></div>
      <button class="cp-btn gr" data-refresh type="button"><i class="fa-solid fa-rotate"></i> Refresh</button></div>
    <div id="cpList"></div>`;
  $('tab-complaints').addEventListener('click', onClick);
}

async function load() {
  const list = $('cpList');
  list.innerHTML = '<div class="cp-empty">Loading…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'questionComplaints'), where('status', '==', filter), limit(100)));
    rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
    render();
  } catch (e) { list.innerHTML = `<div class="cp-empty">Could not load complaints: ${esc(e.message || e)}<br><small>Publish the latest Firestore rules (questionComplaints).</small></div>`; }
}

function render() {
  const list = $('cpList');
  document.querySelectorAll('#tab-complaints .cp-tab').forEach(b => b.classList.toggle('on', b.dataset.f === filter));
  if (!rows.length) { list.innerHTML = `<div class="cp-empty">${filter === 'pending' ? 'No pending complaints 🎉' : 'Nothing here yet.'}</div>`; return; }
  list.innerHTML = rows.map(c => {
    const opts = (c.options || []).map((o, i) => `<div class="cp-opt${i === c.currentAnswer ? ' cur' : ''}${i === c.proposedAnswer ? ' prop' : ''}"><span class="l">${letter(i)}</span><span>${esc(plain(o))}</span>${i === c.currentAnswer ? '<small>CURRENT ANSWER</small>' : ''}${i === c.proposedAnswer ? '<small>STUDENT SAYS</small>' : ''}</div>`).join('');
    const when = c.createdMs ? new Date(c.createdMs).toLocaleString() : '';
    const acts = filter === 'pending'
      ? `<input data-note placeholder="Note for the record (optional)"><button class="cp-btn ok" data-a="approve" type="button"><i class="fa-solid fa-check"></i> Approve</button><button class="cp-btn no" data-a="reject" type="button"><i class="fa-solid fa-xmark"></i> Reject</button>`
      : `<span class="cp-st ${c.status}">${c.status === 'approved' ? 'Approved' : 'Rejected'}</span>${c.flagged ? '<span class="cp-st flag"><i class="fa-solid fa-flag"></i> Yellow notice is showing to students</span><button class="cp-btn gr" data-a="unflag" type="button">Remove notice</button>' : ''}${c.adminNote ? `<span style="font-size:13px;opacity:.7">Note: ${esc(c.adminNote)}</span>` : ''}`;
    return `<div class="cp-card" data-id="${esc(c.id)}">
      <div class="cp-meta"><b>Q${esc(c.questionNumber)}</b><span>${esc(c.quizName)} · ${esc(c.subjectName)}</span><span><i class="fa-solid fa-user"></i> ${esc(c.studentName || c.studentId || 'Student')}</span><span>${esc(when)}</span></div>
      <div class="cp-q">${esc(plain(c.question))}</div>${opts}
      <div class="cp-why"><b>Student's explanation</b>${esc(c.explanation)}</div>
      <div class="cp-act">${acts}</div></div>`;
  }).join('');
}

async function onClick(e) {
  const t = e.target.closest('.cp-tab'); if (t) { filter = t.dataset.f; load(); return; }
  if (e.target.closest('[data-refresh]')) { load(); return; }
  const b = e.target.closest('[data-a]'); if (!b) return;
  const card = b.closest('.cp-card'), c = rows.find(x => x.id === card.dataset.id); if (!c) return;
  const note = (card.querySelector('[data-note]')?.value || '').trim();
  card.querySelectorAll('button').forEach(x => x.disabled = true);
  try {
    const by = auth.currentUser?.uid || '';
    if (b.dataset.a === 'approve') {
      let flagged = false;
      try {
        const qs = await getDoc(qPath(c));
        if (qs.exists()) {
          const q = qs.data();
          // only mark the question if it has not been corrected since the student reported it
          if (String(q.explanation || '').trim() === String(c.explanationAtComplaint || '').trim() && Number(q.answerIndex) === Number(c.currentAnswer)) {
            await updateDoc(qPath(c), { complaintApprovedAt: Date.now(), complaintExpl: String(q.explanation || ''), complaintAns: Number(q.answerIndex) });
            flagged = true;
          }
        }
      } catch (err) { toast('Approved, but the question could not be marked: ' + (err.message || err), 'error'); }
      await updateDoc(doc(db, 'questionComplaints', c.id), { status: 'approved', flagged, adminNote: note, reviewedAt: serverTimestamp(), reviewedBy: by });
      toast(flagged ? 'Approved — students now see the yellow notice until you correct the question' : 'Approved (question already corrected)', 'success');
    } else if (b.dataset.a === 'reject') {
      await updateDoc(doc(db, 'questionComplaints', c.id), { status: 'rejected', adminNote: note, reviewedAt: serverTimestamp(), reviewedBy: by });
      toast('Rejected', 'success');
    } else if (b.dataset.a === 'unflag') {
      await updateDoc(qPath(c), { complaintApprovedAt: 0, complaintExpl: '', complaintAns: -1 });
      await updateDoc(doc(db, 'questionComplaints', c.id), { flagged: false });
      toast('Notice removed', 'success');
    }
    load();
  } catch (err) { toast('Failed: ' + (err.message || err), 'error'); card.querySelectorAll('button').forEach(x => x.disabled = false); }
}

/* pending counter on the tab button */
let watching = false;
function watch() {
  if (watching) return; watching = true;
  onAuthStateChanged(auth, u => {
    if (!u) return;
    try {
      onSnapshot(query(collection(db, 'questionComplaints'), where('status', '==', 'pending'), limit(99)), s => {
        const btn = document.querySelector('[data-tab="complaints"]'); if (!btn) return;
        btn.querySelector('.comp-badge')?.remove();
        if (s.size) { const em = document.createElement('em'); em.className = 'comp-badge'; em.textContent = s.size >= 99 ? '99+' : s.size; btn.appendChild(em); }
        const n = document.querySelector('#tab-complaints [data-n="pending"]'); if (n) n.textContent = s.size ? `(${s.size})` : '';
      }, () => {});
    } catch (_) {}
  });
}

window.__alifInitComplaintsAdmin = () => { build(); load(); };
setTimeout(watch, 1500);
