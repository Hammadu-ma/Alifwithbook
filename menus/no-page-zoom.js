/* ALIF Med — the app itself never zooms (pinch, double-tap, Ctrl + wheel, Ctrl + / -).
   Only the document reader zooms its own pages (see resources-reader.js). No import-time dependencies. */
(function () {
  if (window.__alifNoZoom) return; window.__alifNoZoom = true;
  const st = document.createElement('style');
  st.textContent = 'html,body{touch-action:pan-x pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%}';
  document.head.appendChild(st);
  const stop = e => e.preventDefault();
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, stop, { passive: false }));   // iOS Safari pinch
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 && !e.target.closest?.('.rd-stage')) e.preventDefault(); }, { passive: false });
  document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });                      // trackpad pinch / Ctrl + wheel
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '_', '0'].includes(e.key)) e.preventDefault(); }, true);
})();
