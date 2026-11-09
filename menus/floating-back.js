/* ALIF Med — small floating "back" arrow for the question-practice page on PC.
   On desktop the top bar is hidden, so the only way back to the quiz list was the pill inside the sidebar.
   This arrow sits at the top-left of the question area (just right of the sidebar, or the screen edge when the
   sidebar is hidden) and presses the same Back button. No imports: safe inside the auth.js import cycle. */
(function () {
  let btn = null, raf = 0;

  function make() {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'floatBackBtn';
    btn.className = 'float-back-btn';
    btn.setAttribute('aria-label', 'Back to quizzes');
    btn.title = 'Back to quizzes';
    btn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
    btn.addEventListener('click', () => {
      const b = document.getElementById('switchQuizBtn');
      if (b) b.click();
    });
    document.body.appendChild(btn);
  }

  function update() {
    raf = 0;
    try {
      const app = document.getElementById('appScreen');
      const show = app && !app.classList.contains('hidden') && window.innerWidth > 880 &&
        !app.classList.contains('focus-mode');
      if (!show) { if (btn) btn.classList.remove('show'); return; }
      if (!btn) make();
      const sb = document.getElementById('sidebar');
      const r = sb ? sb.getBoundingClientRect() : null;
      const visibleSb = r && r.width > 40 && r.right > 40 && r.left >= -4;
      btn.style.left = ((visibleSb ? r.right : 0) + 14) + 'px';
      btn.classList.add('show');
    } catch (_) { /* decoration only */ }
  }
  const sched = () => { if (!raf) raf = requestAnimationFrame(update); };

  function start() {
    try {
      const app = document.getElementById('appScreen');
      if (!app) return setTimeout(start, 600);
      new MutationObserver(sched).observe(app, { attributes: true, attributeFilter: ['class'] });
      const sb = document.getElementById('sidebar');
      if (sb) {
        new MutationObserver(sched).observe(sb, { attributes: true, attributeFilter: ['class', 'style'] });
        sb.addEventListener('transitionend', sched);
      }
      document.body && new MutationObserver(sched).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      window.addEventListener('resize', sched);
      sched();
    } catch (_) {}
  }
  setTimeout(start, 900);
})();
