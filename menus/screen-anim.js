/* Screen-switch animation (same feel as the Resources page): when Home / Exams / Modules / Subjects
   become visible, their sections glide up and fade in one after another. */
const IDS = ['homeScreen', 'pickerScreen', 'modulesScreen', 'subjectsScreen', 'universitiesScreen'];
const reduce = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
IDS.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  let wasHidden = el.classList.contains('hidden'), timer = 0;
  new MutationObserver(() => {
    const hidden = el.classList.contains('hidden');
    if (wasHidden && !hidden && !reduce()) {
      el.classList.remove('scr-enter'); void el.offsetWidth; el.classList.add('scr-enter');
      clearTimeout(timer); timer = setTimeout(() => el.classList.remove('scr-enter'), 1300);
    }
    wasHidden = hidden;
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
});
