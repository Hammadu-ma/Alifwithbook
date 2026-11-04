/* ALIF Med — full-screen status shown when a quiz/exam can't open:
   • offline : no connection / couldn't load  -> Reload button, and it reloads by itself when the network returns
   • empty   : connected, but the quiz has no questions (not added yet, or withdrawn for refinement)
   showQuizState(kind, { title, onRetry, onBack }) -> { close() } */
let cur = null;

const CSS = `
.qs-screen{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;
  background:var(--paper,#fff);color:var(--ink,#111);opacity:0;transition:opacity .3s ease;overflow:hidden}
.qs-screen.in{opacity:1}
.qs-screen::before,.qs-screen::after{content:'';position:absolute;border-radius:50%;pointer-events:none;filter:blur(60px);opacity:.5}
.qs-screen::before{width:320px;height:320px;left:-110px;top:-90px;background:var(--qs-tone-soft)}
.qs-screen::after{width:280px;height:280px;right:-90px;bottom:-80px;background:var(--qs-tone-soft)}
.qs-card{position:relative;z-index:1;width:min(380px,100%);text-align:center;transform:translateY(14px);transition:transform .45s cubic-bezier(.2,.9,.3,1.1)}
.qs-screen.in .qs-card{transform:none}
.qs-orb{width:104px;height:104px;margin:0 auto 22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:38px;
  color:var(--qs-tone);background:var(--qs-tone-soft);position:relative;animation:qsFloat 4s ease-in-out infinite}
.qs-orb::after{content:'';position:absolute;inset:-9px;border-radius:50%;border:1.5px solid var(--qs-tone);opacity:.22}
.qs-orb.spin::before{content:'';position:absolute;inset:-9px;border-radius:50%;border:2px solid transparent;border-top-color:var(--qs-tone);animation:qsSpin 1.1s linear infinite}
.qs-title{font-family:'Fraunces',Georgia,serif;font-size:23px;font-weight:700;letter-spacing:-.01em;margin:0 0 8px}
.qs-name{font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--qs-tone);margin:0 0 10px}
.qs-text{font-size:14.5px;line-height:1.55;color:var(--ink-soft,#666);margin:0 0 24px}
.qs-actions{display:flex;flex-direction:column;gap:10px}
.qs-btn{border:0;border-radius:999px;padding:13px 20px;font:inherit;font-weight:700;font-size:15px;cursor:pointer;transition:transform .15s,opacity .2s}
.qs-btn:active{transform:scale(.97)}
.qs-btn.primary{background:var(--primary,#0070f3);color:#fff}
.qs-btn.ghost{background:transparent;color:var(--ink,#111);border:1px solid var(--card-border,rgba(0,0,0,.12))}
.qs-btn[disabled]{opacity:.6;cursor:default}
.qs-hint{margin-top:16px;font-size:12px;color:var(--ink-soft,#777);display:flex;align-items:center;justify-content:center;gap:7px}
.qs-dot{width:7px;height:7px;border-radius:50%;background:var(--qs-tone);animation:qsPulse 1.6s ease-in-out infinite}
@keyframes qsFloat{50%{transform:translateY(-6px)}}
@keyframes qsSpin{to{transform:rotate(360deg)}}
@keyframes qsPulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.qs-orb,.qs-dot,.qs-orb.spin::before{animation:none}}
`;

function ensureCss() {
  if (document.getElementById('alifQsCss')) return;
  const st = document.createElement('style');
  st.id = 'alifQsCss';
  st.textContent = CSS;
  document.head.appendChild(st);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function closeQuizState() {
  if (!cur) return;
  const { el, onOnline } = cur;
  cur = null;
  window.removeEventListener('online', onOnline);
  el.classList.remove('in');
  setTimeout(() => el.remove(), 320);
}

export function showQuizState(kind, { title = '', onRetry, onBack } = {}) {
  ensureCss();
  closeQuizState();
  const offline = kind !== 'empty';
  const el = document.createElement('div');
  el.className = 'qs-screen';
  el.setAttribute('role', 'alert');
  el.style.setProperty('--qs-tone', offline ? 'var(--primary,#0070f3)' : '#f59e0b');
  el.style.setProperty('--qs-tone-soft', offline ? 'color-mix(in srgb,var(--primary,#0070f3) 14%,transparent)' : 'color-mix(in srgb,#f59e0b 16%,transparent)');
  el.innerHTML = `<div class="qs-card">
    <div class="qs-orb"><i class="fa-solid ${offline ? 'fa-wifi' : 'fa-feather-pointed'}"></i></div>
    ${title ? `<div class="qs-name">${esc(title)}</div>` : ''}
    <h2 class="qs-title">${offline ? 'No connection' : 'No questions here yet'}</h2>
    <p class="qs-text">${offline
      ? 'We couldn’t load this quiz. Check your internet connection and try again — it will reload by itself once you’re back online.'
      : 'Questions haven’t been added to this quiz yet, or they were withdrawn for refinement. Please check back soon.'}</p>
    <div class="qs-actions">
      ${offline ? '<button type="button" class="qs-btn primary" data-retry><i class="fa-solid fa-rotate-right"></i>&nbsp; Reload</button>' : ''}
      <button type="button" class="qs-btn ${offline ? 'ghost' : 'primary'}" data-back>Back</button>
    </div>
    ${offline ? '<div class="qs-hint"><span class="qs-dot"></span><span data-hint>Waiting for connection…</span></div>' : ''}
  </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));

  let busy = false;
  const retry = () => {
    if (busy || !onRetry || cur?.el !== el) return;
    busy = true;
    const orb = el.querySelector('.qs-orb'), btn = el.querySelector('[data-retry]'), hint = el.querySelector('[data-hint]');
    orb.classList.add('spin');
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = 'Reloading…';
    Promise.resolve().then(onRetry).then(() => { closeQuizState(); }).catch(() => {
      busy = false;
      orb.classList.remove('spin');
      if (btn) btn.disabled = false;
      if (hint) hint.textContent = 'Still offline — waiting for connection…';
    });
  };
  const onOnline = () => retry();
  window.addEventListener('online', onOnline);
  cur = { el, onOnline };
  const rb = el.querySelector('[data-retry]');
  if (rb) rb.addEventListener('click', retry);
  el.querySelector('[data-back]').addEventListener('click', () => { closeQuizState(); if (onBack) onBack(); });
  return { close: closeQuizState };
}
