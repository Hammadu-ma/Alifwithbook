/* ALIF Med — modern live search for every classmate list in chat: the People tab, the share / forward pickers
   and the group member pickers. The box lives inside each list (re-attached after the app re-renders it) and
   filters rows by name or batch as you type. */
const LISTS = [
  ['peopleList', 'Search people or batch…'],
  ['forwardPeopleList', 'Search classmates…'],
  ['shareDestPeopleList', 'Search classmates…'],
  ['createGroupMemberList', 'Search classmates…'],
  ['addMembersPicker', 'Search classmates…']
];
const ROW = '.people-row, .group-member-row';
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();

function build(placeholder) {
  const box = document.createElement('div');
  box.className = 'cs-box';
  box.innerHTML = `<svg class="cs-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input class="cs-in" type="search" inputmode="search" autocomplete="off" enterkeyhint="search" spellcheck="false" placeholder="${placeholder}" aria-label="${placeholder}">
    <button type="button" class="cs-x" aria-label="Clear search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  return box;
}

function attach(listEl, placeholder) {
  const box = build(placeholder);
  const input = box.querySelector('.cs-in');
  const clear = box.querySelector('.cs-x');
  let empty = null;

  const apply = () => {
    const q = norm(input.value);
    box.classList.toggle('has-text', !!q);
    let shown = 0, total = 0;
    listEl.querySelectorAll(ROW).forEach(r => {
      total++;
      const hit = !q || norm(r.textContent).includes(q);
      r.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    // hide section labels that have no visible row after them
    listEl.querySelectorAll('.people-section-label').forEach(l => {
      let n = l.nextElementSibling, any = false;
      while (n && !n.classList.contains('people-section-label')) { if (n.matches(ROW) && n.style.display !== 'none') any = true; n = n.nextElementSibling; }
      l.style.display = !q || any ? '' : 'none';
    });
    if (q && total && !shown) {
      if (!empty) { empty = document.createElement('div'); empty.className = 'cs-empty'; }
      empty.innerHTML = `<i class="fa-solid fa-user-slash"></i><div>No one matches “${q.replace(/[<>&]/g, '')}”</div>`;
      if (!empty.isConnected) listEl.appendChild(empty);
    } else if (empty && empty.isConnected) empty.remove();
  };

  const ensure = () => {
    if (listEl.firstElementChild !== box) listEl.prepend(box);
    apply();
  };

  input.addEventListener('input', apply);
  clear.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });
  let busy = false;
  new MutationObserver(() => {
    if (busy) return;
    busy = true;
    ensure();
    Promise.resolve().then(() => { busy = false; });
  }).observe(listEl, { childList: true });
  ensure();
}

LISTS.forEach(([id, ph]) => { const el = document.getElementById(id); if (el) attach(el, ph); });
