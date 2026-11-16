/* In-app heads-up banner (Telegram style).
   While the app is open the OS does not pop a notification, so the service worker hands the push to the page
   and we slide a banner in from the top. Tap = open the target, swipe up / wait = dismiss. */
(function () {
  if (!('serviceWorker' in navigator) || window.__alifBanner) return;
  window.__alifBanner = true;
  const css = document.createElement('style');
  css.textContent = `
  #alifBannerBox{position:fixed;left:0;right:0;top:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;padding:max(10px,env(safe-area-inset-top)) 10px 0;pointer-events:none}
  .alif-banner{pointer-events:auto;width:min(440px,100%);display:flex;gap:11px;align-items:center;background:var(--card,#fff);color:var(--ink,#111);border:1px solid var(--card-border,rgba(0,0,0,.08));border-radius:16px;padding:11px 13px;box-shadow:0 10px 32px rgba(0,0,0,.22);transform:translateY(-130%);opacity:0;transition:transform .35s cubic-bezier(.22,1,.36,1),opacity .25s;cursor:pointer;touch-action:pan-y}
  .alif-banner.in{transform:none;opacity:1}
  .alif-banner img{width:38px;height:38px;border-radius:10px;flex:none;object-fit:cover}
  .alif-banner div{min-width:0;flex:1}
  .alif-banner b{display:block;font-size:13.5px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .alif-banner span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;line-height:1.35;color:var(--ink-soft,#555);margin-top:1px}`;
  document.head.appendChild(css);
  let box;
  function show(m) {
    if (!box) { box = document.createElement('div'); box.id = 'alifBannerBox'; document.body.appendChild(box); }
    while (box.children.length >= 2) box.firstChild.remove();
    const el = document.createElement('div'); el.className = 'alif-banner'; el.setAttribute('role', 'status');
    const img = document.createElement('img'); img.src = m.icon || '/logo.png'; img.alt = '';
    const d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span');
    b.textContent = m.title || 'ALIF'; s.textContent = m.body || ''; d.append(b, s); el.append(img, d); box.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
    let gone = false;
    const close = () => { if (gone) return; gone = true; el.classList.remove('in'); setTimeout(() => el.remove(), 380); };
    const t = setTimeout(close, 6000);
    el.addEventListener('click', () => { clearTimeout(t); close(); try { location.href = m.url || '/'; } catch (_) {} });
    let y0 = null;
    el.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; clearTimeout(t); }, { passive: true });
    el.addEventListener('touchmove', e => { if (y0 !== null && y0 - e.touches[0].clientY > 24) { y0 = null; close(); } }, { passive: true });
    try { navigator.vibrate && navigator.vibrate(60); } catch (_) {}
  }
  navigator.serviceWorker.addEventListener('message', e => {
    const m = e.data; if (m && m.type === 'alif-push') show(m);
  });
})();
