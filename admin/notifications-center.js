/* ALIF Med — Notifications centre (admin).
   1. Send: everyone, one student, or a SEGMENT (batch, module owners, subject owners, bundle owners, any mix with a batch filter).
   2. Automatic notifications: payment submitted / approved / rejected (with the reason) / content unlocked / access withdrawn.
      Each one is sent when its own switch is on OR the collective switch is on. Settings live in Firestore settings/notifications
      and are enforced by the push server, so a switched-off event can never leak out.
   3. Watchers (this page only): when YOU approve/reject a payment or grant/revoke access, the matching student is notified.

   Data comes from the admin dashboard through window.__alifAdminBridge (students, modules, subjects, bundles). */
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, collectionGroup, getDocs, query, where, onSnapshot, Timestamp, addDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const auth = getAuth(getApp());
const db = getFirestore(getApp());
const API_BASE = () => (window.ALIF_PUSH_API_BASE || '').replace(/\/$/, '');
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bridge = () => window.__alifAdminBridge || null;
const toast = (m, t = 'info') => { try { window.toast?.(m, t); } catch (_) {} };

/* ------------------------------------------------------------------ API */
async function api(path, body) {
  if (!API_BASE()) throw new Error('Push API is not configured.');
  if (!auth.currentUser) throw new Error('Sign in as an admin first.');
  const token = await auth.currentUser.getIdToken();
  const r = await fetch(`${API_BASE()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Push server error (${r.status})`);
  return d;
}

/* ------------------------------------------------------------ audiences */
const EVENT_DEFS = [
  { key: 'paymentSubmitted', icon: 'fa-receipt', title: 'Payment submitted', sub: 'Student gets “payment received” right after sending a receipt.' },
  { key: 'paymentApproved', icon: 'fa-circle-check', title: 'Payment approved', sub: 'Tells the student what was unlocked.' },
  { key: 'paymentRejected', icon: 'fa-circle-xmark', title: 'Payment rejected', sub: 'Includes the reason you typed when rejecting.' },
  { key: 'accessGranted', icon: 'fa-lock-open', title: 'Resources unlocked', sub: 'Whenever you enroll a student or grant access to a module / subject.' },
  { key: 'accessRevoked', icon: 'fa-lock', title: 'Access withdrawn', sub: 'Whenever you remove or block a student’s access.' }
];
let settings = { autoAll: false, events: {} };
let grantsCache = { t: 0, rows: null };

async function loadSettings() {
  try {
    const s = await getDoc(doc(db, 'settings', 'notifications'));
    if (s.exists()) { const d = s.data(); settings = { autoAll: d.autoAll === true, events: d.events || {} }; }
  } catch (e) { console.warn('[notifications] settings', e.message); }
  return settings;
}
async function saveSettings() {
  await setDoc(doc(db, 'settings', 'notifications'), { autoAll: settings.autoAll, events: settings.events, updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.email || '' }, { merge: true });
}

/* every active grant (who owns what). One collection-group read, cached for 5 minutes. */
async function grants(force) {
  if (!force && grantsCache.rows && Date.now() - grantsCache.t < 5 * 60 * 1000) return grantsCache.rows;
  const snap = await getDocs(query(collectionGroup(db, 'resources'), where('status', '==', 'active')));
  const now = Date.now();
  grantsCache = {
    t: now,
    rows: snap.docs.map(d => ({ ...d.data(), uid: d.ref.parent.parent ? d.ref.parent.parent.id : '' }))
      .filter(g => g.uid && g.mode === 'allow' && !(g.expiresAt && g.expiresAt.toMillis && g.expiresAt.toMillis() < now))
  };
  return grantsCache.rows;
}

const students = () => (bridge()?.students() || []);
const uidOfStudent = sid => (students().find(s => s.id === sid) || {}).authUid || '';

/* Resolve the chosen audience to { uids, label, noAccount }  */
async function resolveAudience(a) {
  const all = students();
  const byUid = new Map(all.filter(s => s.authUid).map(s => [s.authUid, s]));
  let uids = null, label = '';
  if (a.type === 'all' && !a.batch) return { all: true, label: 'Everyone', uids: null, count: null };
  if (a.type === 'student') {
    const sid = String(a.studentId || '').trim();
    const st = all.find(s => s.id === sid || s.ID === sid);
    if (!st) throw new Error('No student found with that Student ID.');
    if (!st.authUid) throw new Error('That student has not linked a login account yet.');
    return { uids: [st.authUid], label: st.name || sid, count: 1 };
  }
  if (a.type === 'all') { uids = new Set(all.filter(s => s.authUid).map(s => s.authUid)); label = 'Everyone'; }
  else {
    const rows = await grants();
    uids = new Set();
    if (a.type === 'module' || a.type === 'subject') {
      rows.filter(g => g.resourceType === a.type && g.resourceId === a.id).forEach(g => uids.add(g.uid));
      if (a.type === 'module') {   // legacy per-module enrolment map
        const m = (bridge()?.modules() || []).find(x => x.id === a.id);
        if (m && m.userLocks) Object.keys(m.userLocks).forEach(sid => { if (m.userLocks[sid] === 'enrolled') { const u = uidOfStudent(sid); if (u) uids.add(u); } });
      }
      label = `Owners of ${a.name || a.id}`;
    } else if (a.type === 'bundle') {
      rows.filter(g => g.sourceType === 'bundle' && (a.id === '*' || g.sourceId === a.id)).forEach(g => uids.add(g.uid));
      label = a.id === '*' ? 'Owners of any bundle' : `Owners of bundle ${a.name || a.id}`;
    }
  }
  if (a.batch) {
    uids = new Set([...uids].filter(u => (byUid.get(u) || {}).batch === a.batch));
    label += ` · ${a.batch}`;
  }
  return { uids: [...uids], label, count: uids.size };
}

/* ------------------------------------------------------------------- UI */
function css() {
  if ($('alifNcStyles')) return;
  const s = document.createElement('style'); s.id = 'alifNcStyles';
  s.textContent = `
#tab-notifications .nc{max-width:920px;margin:0 auto;display:grid;gap:18px}
#tab-notifications .nc-card{background:var(--card);border:1px solid var(--card-border);border-radius:18px;padding:20px;box-shadow:var(--shadow)}
#tab-notifications .nc-card h3{margin:0 0 4px;font-size:16px;display:flex;align-items:center;gap:9px}
#tab-notifications .nc-card h3 i{color:var(--accent,var(--artery))}
#tab-notifications .nc-sub{margin:0 0 16px;font-size:12.5px;color:var(--ink-faint);line-height:1.5}
#tab-notifications .nc-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
#tab-notifications .nc-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
#tab-notifications .nc-field label{font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint)}
#tab-notifications .nc-field input,#tab-notifications .nc-field select,#tab-notifications .nc-field textarea{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:12px;border:1px solid var(--card-border);background:var(--paper);color:var(--ink);font:inherit}
#tab-notifications .nc-field textarea{min-height:92px;resize:vertical}
#tab-notifications .nc-seg{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
#tab-notifications .nc-chip{border:1px solid var(--card-border);background:var(--paper);color:var(--ink);border-radius:999px;padding:8px 14px;font:600 13px/1 inherit;cursor:pointer}
#tab-notifications .nc-chip.on{background:var(--accent,var(--artery));border-color:transparent;color:#fff}
#tab-notifications .nc-count{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--paper-2);font-size:13px;margin-bottom:14px}
#tab-notifications .nc-count b{font-size:18px}
#tab-notifications .nc-row{display:flex;align-items:center;gap:12px;padding:13px 0;border-top:1px solid var(--card-border)}
#tab-notifications .nc-row:first-of-type{border-top:0}
#tab-notifications .nc-ic{flex:none;width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:var(--paper-2);color:var(--accent,var(--artery))}
#tab-notifications .nc-tx{flex:1;min-width:0}#tab-notifications .nc-tx b{display:block;font-size:14px}#tab-notifications .nc-tx span{font-size:12px;color:var(--ink-faint);line-height:1.4}
#tab-notifications .nc-sw{position:relative;flex:none;width:46px;height:27px}
#tab-notifications .nc-sw input{position:absolute;inset:0;opacity:0;cursor:pointer;margin:0;z-index:1}
#tab-notifications .nc-sw i{position:absolute;inset:0;border-radius:99px;background:var(--card-border);transition:.2s}
#tab-notifications .nc-sw i::after{content:'';position:absolute;top:3px;left:3px;width:21px;height:21px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:.2s}
#tab-notifications .nc-sw input:checked+i{background:var(--right,#22a06b)}
#tab-notifications .nc-sw input:checked+i::after{transform:translateX(19px)}
#tab-notifications .nc-master{background:color-mix(in srgb,var(--right,#22a06b) 9%,var(--card));border:1px solid color-mix(in srgb,var(--right,#22a06b) 35%,var(--card-border));border-radius:14px;padding:4px 14px;margin-bottom:6px}
#tab-notifications .nc-note{font-size:12px;color:var(--ink-faint);margin-top:10px;line-height:1.5}
#tab-notifications .nc-result{margin-top:12px;font-size:13px;line-height:1.5}
#tab-notifications .nc-result.ok{color:var(--right,#22a06b)}#tab-notifications .nc-result.err{color:var(--wrong,#d33)}
#tab-notifications .nc-hide{display:none!important}
@media(max-width:640px){#tab-notifications .nc-grid{grid-template-columns:1fr}}`;
  document.head.appendChild(s);
}

const TYPES = [
  ['all', 'fa-users', 'Everyone'], ['student', 'fa-user', 'One student'], ['module', 'fa-cubes', 'Module owners'],
  ['subject', 'fa-book', 'Subject owners'], ['bundle', 'fa-box-open', 'Bundle owners']
];
let audType = 'all';

function injectUI() {
  const panel = $('tab-notifications');
  if (!panel || panel.dataset.ncReady) return;
  panel.dataset.ncReady = '1';
  panel.innerHTML = `<div class="nc">
    <div><h2 class="page-title" style="margin:0 0 4px">Notifications</h2>
      <p class="nc-sub" style="margin:0">Send to everyone or to a segment, and choose which events notify students automatically.</p></div>

    <section class="nc-card"><h3><i class="fa-solid fa-paper-plane"></i> Send a notification</h3>
      <p class="nc-sub">Pick who should get it. Students who turned notifications off still see it on their Notifications page.</p>
      <div class="nc-seg" id="ncTypes">${TYPES.map(([k, ic, t]) => `<button type="button" class="nc-chip${k === 'all' ? ' on' : ''}" data-t="${k}"><i class="fa-solid ${ic}"></i> ${t}</button>`).join('')}</div>
      <div class="nc-grid">
        <div class="nc-field nc-hide" id="ncStudentWrap"><label for="ncStudent">Student ID</label><input id="ncStudent" placeholder="e.g. ALIF-1A2B3C4D"></div>
        <div class="nc-field nc-hide" id="ncItemWrap"><label for="ncItem" id="ncItemLabel">Module</label><select id="ncItem"></select></div>
        <div class="nc-field" id="ncBatchWrap"><label for="ncBatch">Limit to batch</label><select id="ncBatch"><option value="">All batches</option></select></div>
      </div>
      <div class="nc-count" id="ncCount"><i class="fa-solid fa-users"></i><span>Everyone with the app installed</span></div>
      <div class="nc-field"><label for="ncTitle">Title</label><input id="ncTitle" maxlength="100" placeholder="New lecture uploaded"></div>
      <div class="nc-field"><label for="ncBody">Message</label><textarea id="ncBody" maxlength="500" placeholder="Write the message…"></textarea></div>
      <div class="nc-field"><label for="ncUrl">Open when tapped (optional)</label><input id="ncUrl" placeholder="/ or https://…"></div>
      <button class="btn btn-primary" id="ncSend" type="button"><i class="fa-solid fa-paper-plane"></i> Send now</button>
      <div class="nc-result" id="ncResult" role="status"></div>
    </section>

    <section class="nc-card"><h3><i class="fa-solid fa-bolt"></i> Automatic notifications</h3>
      <p class="nc-sub">An automatic message is sent when its own switch is on <b>or</b> the collective switch is on. These fire when you approve or reject payments and grant or withdraw access from this dashboard.</p>
      <div class="nc-master"><div class="nc-row"><span class="nc-ic"><i class="fa-solid fa-bolt"></i></span>
        <span class="nc-tx"><b>All automatic notifications</b><span>Collective switch — turns every event below on at once.</span></span>
        <label class="nc-sw"><input type="checkbox" id="ncAll"><i></i></label></div></div>
      <div id="ncEvents">${EVENT_DEFS.map(e => `<div class="nc-row"><span class="nc-ic"><i class="fa-solid ${e.icon}"></i></span>
        <span class="nc-tx"><b>${e.title}</b><span>${e.sub}</span></span><label class="nc-sw"><input type="checkbox" data-ev="${e.key}"><i></i></label></div>`).join('')}</div>
      <div class="nc-note" id="ncSettingsNote"></div>
    </section></div>`;
}

function fillSelectors() {
  const b = bridge(); if (!b) return;
  const batches = [...new Set(students().map(s => s.batch).filter(Boolean))].sort();
  const cur = $('ncBatch').value;
  $('ncBatch').innerHTML = '<option value="">All batches</option>' + batches.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  $('ncBatch').value = batches.includes(cur) ? cur : '';
}
async function fillItems() {
  const b = bridge(); if (!b) return;
  const sel = $('ncItem');
  let list = [];
  if (audType === 'module') list = (b.modules() || []).map(x => [x.id, x.name]);
  if (audType === 'subject') list = (b.subjects() || []).map(x => [x.id, x.name]);
  if (audType === 'bundle') list = [['*', 'Any bundle'], ...((await b.packages()) || []).map(x => [x.id, x.name])];
  sel.innerHTML = '<option value="">Choose…</option>' + list.map(([id, n]) => `<option value="${esc(id)}">${esc(n || id)}</option>`).join('');
  $('ncItemLabel').textContent = audType === 'module' ? 'Module' : audType === 'subject' ? 'Subject' : 'Bundle';
}

function audience() {
  const sel = $('ncItem');
  return {
    type: audType, batch: $('ncBatch').value, studentId: $('ncStudent').value,
    id: sel.value, name: sel.selectedOptions[0]?.textContent || ''
  };
}

let countSeq = 0;
async function refreshCount() {
  const seq = ++countSeq, box = $('ncCount');
  const a = audience();
  const set = html => { if (seq === countSeq) box.innerHTML = html; };
  if (a.type === 'all' && !a.batch) return set('<i class="fa-solid fa-users"></i><span>Everyone with the app installed</span>');
  if (a.type === 'student') return set('<i class="fa-solid fa-user"></i><span>One student</span>');
  if ((a.type === 'module' || a.type === 'subject' || a.type === 'bundle') && !a.id) return set('<i class="fa-solid fa-circle-info"></i><span>Choose which one to target.</span>');
  set('<i class="fa-solid fa-spinner fa-spin"></i><span>Counting…</span>');
  try {
    await bridge()?.ensureStudents();
    const r = await resolveAudience(a);
    set(`<i class="fa-solid fa-users"></i><span><b>${r.count}</b> student${r.count === 1 ? '' : 's'} with an account match <i>${esc(r.label)}</i></span>`);
  } catch (e) { set(`<i class="fa-solid fa-triangle-exclamation"></i><span>${esc(e.message)}</span>`); }
}

function bindSend() {
  $('ncTypes').addEventListener('click', async e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    audType = b.dataset.t;
    $('ncTypes').querySelectorAll('.nc-chip').forEach(x => x.classList.toggle('on', x === b));
    $('ncStudentWrap').classList.toggle('nc-hide', audType !== 'student');
    $('ncItemWrap').classList.toggle('nc-hide', !['module', 'subject', 'bundle'].includes(audType));
    $('ncBatchWrap').classList.toggle('nc-hide', audType === 'student');
    await fillItems(); refreshCount();
  });
  ['ncItem', 'ncBatch'].forEach(id => $(id).addEventListener('change', refreshCount));
  $('ncStudent').addEventListener('input', () => { /* no count for a single student */ });
  $('ncSend').addEventListener('click', async () => {
    const btn = $('ncSend'), out = $('ncResult');
    const title = $('ncTitle').value.trim(), body = $('ncBody').value.trim(), url = $('ncUrl').value.trim() || '/';
    const show = (m, ok) => { out.textContent = m; out.className = 'nc-result ' + (ok ? 'ok' : 'err'); };
    try {
      if (!title || !body) throw new Error('Enter a title and a message.');
      const a = audience();
      if (['module', 'subject', 'bundle'].includes(a.type) && !a.id) throw new Error('Choose which one to target.');
      btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
      await bridge()?.ensureStudents();
      const r = await resolveAudience(a);
      let res;
      if (r.all) {
        res = await api('/api/push/send', { title, body, url, targetUid: 'ALL' });
        try { await addDoc(collection(db, 'notifications'), { title, body, url, createdAt: serverTimestamp(), by: auth.currentUser.uid }); } catch (err) { console.warn('[notifications] history', err); }
      } else {
        if (!r.uids.length) throw new Error('Nobody matches that audience.');
        res = await api('/api/push/send', { title, body, url, uids: r.uids, segmentLabel: r.label });
      }
      show(`✓ ${r.label}: sent to ${res.sent} device(s)${r.count != null ? ` of ${r.count} student(s)` : ''}.${res.failed ? ` ${res.failed} failed.` : ''}${res.partial ? ' Stopped early — send again for the rest.' : ''}`, true);
      $('ncTitle').value = ''; $('ncBody').value = '';
    } catch (e) { console.error('[ALIF push admin]', e); show(e.message || 'Could not send.', false); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send now'; }
  });
}

function paintSettings() {
  $('ncAll').checked = settings.autoAll;
  document.querySelectorAll('#ncEvents [data-ev]').forEach(i => { i.checked = settings.autoAll || settings.events[i.dataset.ev] === true; i.disabled = false; });
}
function bindSettings() {
  const note = $('ncSettingsNote');
  const save = async () => {
    try { await saveSettings(); note.textContent = 'Saved.'; }
    catch (e) { note.textContent = 'Could not save: ' + (e.code === 'permission-denied' ? 'only admins with the Settings permission can change this.' : e.message); await loadSettings(); paintSettings(); }
  };
  $('ncAll').addEventListener('change', () => {
    settings.autoAll = $('ncAll').checked;
    if (settings.autoAll) EVENT_DEFS.forEach(e => { settings.events[e.key] = true; });
    paintSettings(); save();
  });
  $('ncEvents').addEventListener('change', e => {
    const i = e.target.closest('[data-ev]'); if (!i) return;
    settings.events[i.dataset.ev] = i.checked;
    if (!i.checked) settings.autoAll = false;           // turning one off ends "all on"
    paintSettings(); save();
  });
}

/* ------------------------------------------------- automatic watchers */
const WATCH_MS = 2500;
const pend = new Map();       // studentId -> { grants:Set, revokes:Set, pay:{id,status} }
let flushTimer = 0;
const seenEvents = new Set();

function labelFromKey(k) {
  const m = /^(module|subject|quiz|package)_(.+)$/.exec(String(k || ''));
  if (!m) return String(k || '');
  const b = bridge(); const clean = x => String(x).replace(/[^A-Za-z0-9_-]/g, '');
  const arr = m[1] === 'module' ? b?.modules() : m[1] === 'subject' ? b?.subjects() : [];
  const hit = (arr || []).find(x => clean(x.id) === m[2]);
  return hit?.name || m[2];
}
function queue(sid, fn) {
  if (!sid) return;
  const e = pend.get(sid) || { grants: new Set(), revokes: new Set(), pay: null };
  fn(e); pend.set(sid, e);
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, WATCH_MS);
}
async function flush() {
  const items = [...pend.entries()]; pend.clear();
  const groups = new Map();   // "type|labels" -> { type, items, uids }
  const add = (type, labels, uid) => { const k = type + '|' + [...labels].sort().join('¦'); const g = groups.get(k) || { type, items: [...labels], uids: [] }; g.uids.push(uid); groups.set(k, g); };
  const payCalls = [];
  for (const [sid, e] of items) {
    const uid = uidOfStudent(sid);
    if (e.pay) { payCalls.push({ type: e.pay.status === 'approved' ? 'payment-approved' : 'payment-rejected', paymentId: e.pay.id, unlocked: e.pay.status === 'approved' ? [...e.grants] : undefined }); }
    else if (e.grants.size && uid) add('access-granted', e.grants, uid);
    if (e.revokes.size && uid) add('access-revoked', e.revokes, uid);
  }
  const calls = [...payCalls];
  groups.forEach(g => { for (let i = 0; i < g.uids.length; i += 200) calls.push({ type: g.type, items: g.items, uids: g.uids.slice(i, i + 200) }); });
  for (const c of calls) { try { await api('/api/push/event', c); } catch (err) { console.warn('[notifications] auto', c.type, err.message); } }
}

let watching = false;
function startWatchers(user) {
  if (watching || !user) return; watching = true;
  const start = Timestamp.fromMillis(Date.now() - 2000);
  // access granted / withdrawn (written by any screen of this dashboard)
  try {
    onSnapshot(query(collection(db, 'accessHistory'), where('createdAt', '>', start)), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type !== 'added') return;
        const d = ch.doc.data();
        if (d.createdBy !== user.uid || d.sourceType === 'migration') return;
        if (seenEvents.has('h' + ch.doc.id)) return; seenEvents.add('h' + ch.doc.id);
        const label = d.resourceLabel || labelFromKey(d.resourceKey);
        if (d.action === 'grant') queue(d.studentId, e => e.grants.add(label));
        else if (d.action === 'revoke' || d.action === 'deny') queue(d.studentId, e => e.revokes.add(label));
      });
    }, () => {});
  } catch (_) {}
  // payment decisions
  try {
    onSnapshot(query(collection(db, 'paymentSubmissions'), where('reviewedAt', '>', start)), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'removed') return;
        const d = ch.doc.data();
        if (!['approved', 'rejected'].includes(d.status) || d.reviewedBy !== user.email) return;
        const k = 'p' + ch.doc.id + d.status + (d.reviewedAt?.toMillis?.() || 0);
        if (seenEvents.has(k) || !d.reviewedAt) return; seenEvents.add(k);
        const sid = d.studentRecordId || d.studentId || ch.doc.id;
        queue(sid, e => { e.pay = { id: ch.doc.id, status: d.status }; });
      });
    }, () => {});
  } catch (_) {}
}

/* ------------------------------------------------------------------ boot */
let uiBooted = false;
async function boot() {
  css(); injectUI();
  if (!$('ncSend') || uiBooted) { if (uiBooted) { fillSelectors(); } return; }
  uiBooted = true;
  bindSend(); bindSettings();
  await loadSettings(); paintSettings();
  try { await bridge()?.ensureStudents(); } catch (_) {}
  fillSelectors(); refreshCount();
}
window.__alifInitNotificationsAdmin = boot;
onAuthStateChanged(auth, u => { if (u && !u.isAnonymous) setTimeout(() => startWatchers(u), 1500); });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { css(); injectUI(); }, { once: true }); else { css(); injectUI(); }
