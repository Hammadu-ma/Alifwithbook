/* ALIF Med — "Download for offline" screen (opened from Profile → Settings).
   Modules the student can open → subjects (dropdown) → save that subject's quizzes on this device.
   One subject at a time, never "download everything": each save reads only that subject's quizzes. */
import { getStoredStudent } from './auth.js';
import { ALL_MODULES, ALL_QUIZZES, SUBJECTS_CACHE } from './picker-screen.js';
import { isItemLockedForUser, isResourceLocked } from './lock.js';
import { escapeHtml as esc } from './loaders.js';
import { showToast, showConfirm } from './ui-feedback.js';
import { pushModalState, popModalState } from './modal-backbutton.js';
import { cacheQuizzesOffline, quizSavedCount, removeQuizzesOffline } from './offline-files.js';

const CSS = `
#offQz{position:fixed;inset:0;z-index:910;background:var(--paper);color:var(--ink);overflow-y:auto;overscroll-behavior:contain;opacity:0;transform:translateY(18px);transition:opacity .28s,transform .32s}
#offQz.open{opacity:1;transform:none}
#offQz .oq-top{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:12px;padding:calc(env(safe-area-inset-top,0px) + 12px) 16px 12px;background:var(--paper);border-bottom:1px solid var(--rule,rgba(128,128,128,.2))}
#offQz .oq-back{width:40px;height:40px;border-radius:12px;border:1px solid var(--rule,rgba(128,128,128,.25));background:transparent;color:inherit;font-size:16px;cursor:pointer}
#offQz .oq-title{font-weight:800;font-size:18px}
#offQz .oq-main{max-width:720px;margin:0 auto;padding:16px 16px 60px}
#offQz .oq-note{font-size:13px;opacity:.7;line-height:1.5;margin:0 0 16px}
#offQz .oq-mod{border:1px solid var(--rule,rgba(128,128,128,.25));border-radius:16px;margin-bottom:12px;overflow:hidden}
#offQz .oq-mh{width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;background:transparent;border:0;color:inherit;text-align:left;cursor:pointer;font:inherit}
#offQz .oq-mh b{flex:1;font-size:15px}
#offQz .oq-mh small{opacity:.6}
#offQz .oq-mh i{transition:transform .2s;opacity:.5}
#offQz .oq-mod.open>.oq-mh i{transform:rotate(180deg)}
#offQz .oq-subs{display:none;border-top:1px solid var(--rule,rgba(128,128,128,.2))}
#offQz .oq-mod.open>.oq-subs{display:block}
#offQz .oq-sub{display:flex;align-items:center;gap:10px;padding:12px 16px;flex-wrap:wrap}
#offQz .oq-sub+.oq-sub{border-top:1px solid var(--rule,rgba(128,128,128,.15))}
#offQz .oq-st{flex:1;min-width:140px}
#offQz .oq-st b{display:block;font-size:14px}
#offQz .oq-st span{font-size:12px;opacity:.65}
#offQz .oq-bar{height:4px;border-radius:4px;background:rgba(128,128,128,.2);margin-top:6px;overflow:hidden;display:none}
#offQz .oq-bar i{display:block;height:100%;width:0;background:#16a34a;transition:width .2s}
#offQz .oq-btns{display:flex;gap:8px}
#offQz .oq-btn{padding:8px 14px;border-radius:10px;border:1px solid var(--rule,rgba(128,128,128,.3));background:transparent;color:inherit;font:600 13px inherit;cursor:pointer}
#offQz .oq-btn.pri{background:#16a34a;border-color:#16a34a;color:#fff}
#offQz .oq-btn:disabled{opacity:.5;cursor:default}
#offQz .oq-empty{text-align:center;opacity:.65;padding:40px 10px;font-size:14px}
`;
let el = null, busy = false;

function groups() {
  const st = getStoredStudent();
  const quizzes = (ALL_QUIZZES || []).filter(q => q && q.subjectId && !isItemLockedForUser(q) && !isResourceLocked(q, st, 'quiz'));
  const bySub = new Map();
  quizzes.forEach(q => { (bySub.get(q.subjectId) || bySub.set(q.subjectId, []).get(q.subjectId)).push(q); });
  const mods = new Map();
  bySub.forEach((qs, sid) => {
    const sub = (SUBJECTS_CACHE || []).find(s => s.id === sid);
    if (!sub) return;
    const mid = sub.moduleId || '_';
    (mods.get(mid) || mods.set(mid, []).get(mid)).push({ sub, qs });
  });
  return [...mods.entries()].map(([mid, subs]) => {
    const m = (ALL_MODULES || []).find(x => x.id === mid);
    subs.sort((a, b) => String(a.sub.name).localeCompare(String(b.sub.name)));
    return { id: mid, name: m ? m.name : 'Other', subs };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function render() {
  const gs = groups();
  const body = el.querySelector('.oq-main');
  const open = new Set([...body.querySelectorAll('.oq-mod.open')].map(x => x.dataset.m));
  if (!gs.length) { body.innerHTML = '<div class="oq-empty">No quizzes available yet.<br>Open the Exams tab once while online, then come back here.</div>'; return; }
  body.innerHTML = '<p class="oq-note">Pick a module, open a subject and save its quizzes on this device. Saved quizzes work without internet and belong to your account. Tap <b>Update</b> any time to get the latest version.</p>' +
    gs.map(g => {
      const total = g.subs.reduce((n, x) => n + x.qs.length, 0), saved = g.subs.reduce((n, x) => n + quizSavedCount(x.qs), 0);
      return `<div class="oq-mod${open.has(g.id) ? ' open' : ''}" data-m="${esc(g.id)}">
        <button class="oq-mh" type="button"><b>${esc(g.name)}</b><small>${saved}/${total} saved</small><i class="fa-solid fa-chevron-down"></i></button>
        <div class="oq-subs">${g.subs.map(({ sub, qs }) => {
          const n = quizSavedCount(qs), all = n >= qs.length;
          return `<div class="oq-sub" data-s="${esc(sub.id)}">
            <div class="oq-st"><b>${esc(sub.name)}</b><span>${qs.length} ${qs.length === 1 ? 'quiz' : 'quizzes'} · ${n ? n + ' saved' : 'not saved'}</span><div class="oq-bar"><i></i></div></div>
            <div class="oq-btns">${n ? '<button class="oq-btn" data-a="rm" type="button">Remove</button>' : ''}<button class="oq-btn pri" data-a="dl" type="button">${all ? 'Update' : n ? 'Finish' : 'Download'}</button></div></div>`;
        }).join('')}</div></div>`;
    }).join('');
}

function close() {
  if (!el) return;
  popModalState(close);
  el.classList.remove('open');
  const e = el; setTimeout(() => { e.remove(); }, 300);
  el = null;
}

export function openOfflineQuizzesPage() {
  if (el) return;
  if (!document.getElementById('offQzCss')) { const s = document.createElement('style'); s.id = 'offQzCss'; s.textContent = CSS; document.head.appendChild(s); }
  el = document.createElement('div');
  el.id = 'offQz';
  el.innerHTML = '<header class="oq-top"><button class="oq-back" type="button" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><div class="oq-title">Download for offline</div></header><main class="oq-main"></main>';
  document.body.appendChild(el);
  pushModalState(close);
  requestAnimationFrame(() => el && el.classList.add('open'));
  el.querySelector('.oq-back').addEventListener('click', close);
  el.addEventListener('click', async ev => {
    const mh = ev.target.closest('.oq-mh');
    if (mh) { mh.parentElement.classList.toggle('open'); return; }
    const b = ev.target.closest('.oq-btn'); if (!b) return;
    const row = b.closest('.oq-sub'), sid = row.dataset.s;
    const g = groups().flatMap(x => x.subs).find(x => x.sub.id === sid); if (!g) return;
    if (b.dataset.a === 'rm') {
      const ok = await showConfirm({ title: 'Remove saved quizzes?', message: `“${g.sub.name}” quizzes will be removed from this device. You can save them again while online.`, confirmText: 'Remove', cancelText: 'Keep', danger: true, icon: 'fa-solid fa-trash' });
      if (ok) { removeQuizzesOffline(g.qs); render(); }
      return;
    }
    if (busy) { showToast('Wait for the current download to finish', { icon: 'fa-solid fa-circle-info' }); return; }
    if (navigator.onLine === false) { showToast('Connect to the internet to download', { icon: 'fa-solid fa-wifi' }); return; }
    busy = true;
    el.querySelectorAll('.oq-btn').forEach(x => x.disabled = true);
    const bar = row.querySelector('.oq-bar'), fill = bar.firstElementChild; bar.style.display = 'block';
    try {
      const r = await cacheQuizzesOffline(g.qs, (i, t) => { fill.style.width = Math.round(i / t * 100) + '%'; }, { fresh: b.textContent.trim() === 'Update' });
      showToast(r.fail ? `Saved ${r.ok}, ${r.fail} failed` : `${g.sub.name} saved for offline`, { icon: r.fail ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-check' });
    } catch (e) { showToast(e.message || 'Could not save', { icon: 'fa-solid fa-circle-exclamation' }); }
    busy = false;
    if (el) render();
  });
  render();
}
