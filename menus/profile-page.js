/* ========================================================================
   ALIF Med — Profile page (full screen)
   Replaces the old bottom-sheet account modal. Opened from the profile
   avatar on Home / Exams via openProfilePage({ doLogout }).
   ======================================================================== */
import { getStoredStudent, getAuthUser, changeStudentPassword } from './auth.js';
import { dedupeDeviceDocs, getDeviceInfo } from './device-session.js';
import { db } from './cloud-sync.js';
import { collection, getDocs, query } from './runtime-ext.js';
import { escapeHtml as esc, forceContentRefresh } from './loaders.js';
import { isItemLockedForUser } from './lock.js';
import { ttlRead } from './read-cache.js';
import { pushModalState, popModalState } from './modal-backbutton.js';
import { lockBodyScroll, unlockBodyScroll } from './cache.js';
import { ACTIVE_UNIVERSITY_ID, initials } from './picker-screen.js';
import { THEME_KEY, applyTheme, getEffectiveTheme, switchTheme } from './theme.js';
import { getChatNotifyEnabled, setChatNotifyEnabled, setAppearInChat } from './class-chat.js';
import { showToast } from './ui-feedback.js';

const DEVICE_CACHE = {};
let screen = null;
let isOpen = false;
let hideTimer = null;
let logoutFn = null;

function ensureScreen() {
  if (screen) return screen;
  screen = document.createElement('div');
  screen.id = 'profileScreen';
  screen.className = 'profile-screen hidden';
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-modal', 'true');
  screen.setAttribute('aria-label', 'Profile');
  document.body.appendChild(screen);
  return screen;
}

function closeProfilePage() {
  if (!isOpen || !screen) return;
  isOpen = false;
  screen.classList.remove('open');
  unlockBodyScroll();
  popModalState(closeProfilePage);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!isOpen) screen.classList.add('hidden'); }, 300);
}

const row = (icon, tone, title, sub, control, forId) => `
  <label class="pf-row" ${forId ? `for="${forId}"` : ''}>
    <span class="pf-ico" style="--tone:${tone}"><i class="${icon}"></i></span>
    <span class="pf-row-text">
      <span class="pf-row-title">${title}</span>
      <span class="pf-row-sub">${sub}</span>
    </span>
    ${control}
  </label>`;

const toggle = (id, checked) => `
  <span class="toggle-switch">
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
    <span class="ts-track"></span>
  </span>`;

export async function openProfilePage({ doLogout } = {}) {
  const student = getStoredStudent();
  if (!student || isOpen) return;
  logoutFn = doLogout || logoutFn;

  const el = ensureScreen();
  const device = await getDeviceInfo();
  const appearInChat = student.appearInChat !== false;
  const email = student.email || (getAuthUser() && getAuthUser().email) || '';

  el.innerHTML = `
    <header class="pf-topbar">
      <button class="pf-back" id="pfBackBtn" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
      <div class="pf-topbar-title">Profile</div>
      <span class="pf-topbar-spacer"></span>
    </header>

    <main class="pf-main">
      <section class="pf-hero">
        <div class="pf-avatar">${esc(initials(student.name))}</div>
        <h1 class="pf-name">${esc(student.name || 'Student')}</h1>
        <div class="pf-chips">
          ${student.ID ? `<span class="pf-chip"><i class="fa-solid fa-id-card"></i>${esc(student.ID)}</span>` : ''}
          ${student.batch ? `<span class="pf-chip"><i class="fa-solid fa-graduation-cap"></i>${esc(student.batch)}</span>` : ''}
        </div>
        ${email ? `<div class="pf-email"><i class="fa-regular fa-envelope"></i>${esc(email)}</div>` : ''}
      </section>

      <h2 class="pf-section-title">Preferences</h2>
      <section class="pf-card">
        ${row('fa-solid fa-users', '#0679BC', 'Appear in Class Chat', 'Let classmates find and message you.', toggle('appearInChatToggle', appearInChat), 'appearInChatToggle')}
        ${row('fa-solid fa-bell', '#E8923B', 'Message notifications', 'Pop-up on this device for new messages.', toggle('chatNotifyToggle', getChatNotifyEnabled()), 'chatNotifyToggle')}
      </section>

      <h2 class="pf-section-title">Appearance</h2>
      <section class="pf-card pf-card-pad">
        <div class="pf-seg" id="accountThemeOptions" role="group" aria-label="Theme">
          <button class="theme-opt pf-seg-btn" data-val="system"><i class="fa-solid fa-desktop"></i><span>System</span></button>
          <button class="theme-opt pf-seg-btn" data-val="light"><i class="fa-solid fa-sun"></i><span>Light</span></button>
          <button class="theme-opt pf-seg-btn" data-val="dark"><i class="fa-solid fa-moon"></i><span>Dark</span></button>
        </div>
      </section>

      <h2 class="pf-section-title">My access</h2>
      <section class="pf-card">
        <div class="pf-access-group">
          <button type="button" class="pf-action" id="pfBundlesBtn" aria-expanded="false">
            <span class="pf-ico" style="--tone:#0679BC"><i class="fa-solid fa-box"></i></span>
            <span class="pf-row-text">
              <span class="pf-row-title">Bundles</span>
              <span class="pf-row-sub" id="pfBundlesSub">Loading…</span>
            </span>
            <i class="fa-solid fa-chevron-right pf-chev"></i>
          </button>
          <div class="pf-expand" id="bundlesExpand">
            <div class="pf-expand-inner">
              <div class="pf-list" id="bundlesContainer"><div class="pf-empty">Loading…</div></div>
            </div>
          </div>
        </div>

        <div class="pf-access-group">
          <button type="button" class="pf-action" id="pfModulesBtn" aria-expanded="false">
            <span class="pf-ico" style="--tone:var(--artery)"><i class="fa-solid fa-cube"></i></span>
            <span class="pf-row-text">
              <span class="pf-row-title">Modules</span>
              <span class="pf-row-sub" id="pfModulesSub">Loading…</span>
            </span>
            <i class="fa-solid fa-chevron-right pf-chev"></i>
          </button>
          <div class="pf-expand" id="modulesExpand">
            <div class="pf-expand-inner">
              <div class="pf-list" id="modulesContainer"><div class="pf-empty">Loading…</div></div>
            </div>
          </div>
        </div>
      </section>

      <h2 class="pf-section-title">Devices</h2>
      <section class="pf-card pf-card-pad">
        <div class="pf-sub-head"><i class="fa-solid fa-mobile-screen-button"></i>Signed-in devices<span class="pf-count" id="devSessCount">…</span></div>
        <div class="pf-list" id="devSessList"><div class="pf-empty">Loading devices…</div></div>
      </section>

      <h2 class="pf-section-title">Security</h2>
      <section class="pf-card">
        <div class="pf-access-group">
          <button type="button" class="pf-action" id="pfPasswordBtn" aria-expanded="false">
            <span class="pf-ico" style="--tone:#7b5ce0"><i class="fa-solid fa-key"></i></span>
            <span class="pf-row-text">
              <span class="pf-row-title">Change password</span>
              <span class="pf-row-sub">Update the password you sign in with.</span>
            </span>
            <i class="fa-solid fa-chevron-right pf-chev"></i>
          </button>
          <div class="pf-expand" id="passwordExpand">
            <div class="pf-expand-inner">
              <div class="pf-form" id="pfPasswordForm" role="form" aria-label="Change password">
                <label class="pf-field"><span class="pf-field-label">Current password</span>
                  <span class="pf-input-wrap"><input type="password" id="pfCurPw" autocomplete="current-password" placeholder="Current password">
                  <button type="button" class="pf-eye" data-for="pfCurPw" aria-label="Show password"><i class="fa-solid fa-eye"></i></button></span></label>
                <label class="pf-field"><span class="pf-field-label">New password</span>
                  <span class="pf-input-wrap"><input type="password" id="pfNewPw" autocomplete="new-password" placeholder="At least 8 characters">
                  <button type="button" class="pf-eye" data-for="pfNewPw" aria-label="Show password"><i class="fa-solid fa-eye"></i></button></span></label>
                <label class="pf-field"><span class="pf-field-label">Confirm new password</span>
                  <span class="pf-input-wrap"><input type="password" id="pfConfPw" autocomplete="new-password" placeholder="Repeat new password">
                  <button type="button" class="pf-eye" data-for="pfConfPw" aria-label="Show password"><i class="fa-solid fa-eye"></i></button></span></label>
                <div class="pf-form-msg" id="pfPwMsg" role="alert" aria-live="polite"></div>
                <button type="button" class="pf-submit" id="pfPwSubmit"><span class="pf-submit-label">Update password</span></button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="pf-card pf-actions">
        <button type="button" class="pf-action" id="refreshContentBtn">
          <span class="pf-ico" style="--tone:#2f7a52"><i class="fa-solid fa-rotate"></i></span>
          <span class="pf-row-text"><span class="pf-row-title" id="pfRefreshLabel">Check for new content</span>
          <span class="pf-row-sub">Pull the latest quizzes and updates.</span></span>
          <i class="fa-solid fa-chevron-right pf-chev"></i>
        </button>
        <button type="button" class="pf-action pf-danger" id="pfLogoutBtn">
          <span class="pf-ico" style="--tone:#d64545"><i class="fa-solid fa-right-from-bracket"></i></span>
          <span class="pf-row-text"><span class="pf-row-title">Log out</span>
          <span class="pf-row-sub">Sign out of this device.</span></span>
        </button>
      </section>
    </main>`;

  // --- show -------------------------------------------------------------
  clearTimeout(hideTimer);
  el.classList.remove('hidden');
  el.scrollTop = 0;
  isOpen = true;
  lockBodyScroll();
  pushModalState(closeProfilePage);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));

  // --- wiring -----------------------------------------------------------
  el.querySelector('#pfBackBtn').addEventListener('click', closeProfilePage);

  {
    const { dark, isSystem } = getEffectiveTheme();
    applyTheme(dark, isSystem);
    el.querySelectorAll('#accountThemeOptions .theme-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.val;
        if (v === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v);
        const t = getEffectiveTheme();
        switchTheme(t.dark, t.isSystem);
      });
    });
  }

  const appear = el.querySelector('#appearInChatToggle');
  appear.addEventListener('change', async () => {
    const on = appear.checked;
    appear.disabled = true;
    try {
      await setAppearInChat(on);
      showToast(on ? "You're visible in Class Chat" : 'Hidden from Class Chat',
        { icon: on ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash' });
    } catch (_) {
      appear.checked = !on;
      showToast("Couldn't update — check your connection", { icon: 'fa-solid fa-triangle-exclamation' });
    } finally { appear.disabled = false; }
  });

  const notify = el.querySelector('#chatNotifyToggle');
  notify.addEventListener('change', () => {
    setChatNotifyEnabled(notify.checked);
    showToast(notify.checked ? 'Message notifications on' : 'Message notifications off',
      { icon: notify.checked ? 'fa-solid fa-bell' : 'fa-solid fa-bell-slash' });
  });

  // --- expandable access rows ------------------------------------------
  const wireExpand = (btnSel, boxSel) => {
    const btn = el.querySelector(btnSel);
    const box = el.querySelector(boxSel);
    btn.addEventListener('click', () => {
      const open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  };
  wireExpand('#pfBundlesBtn', '#bundlesExpand');
  wireExpand('#pfModulesBtn', '#modulesExpand');
  wireExpand('#pfPasswordBtn', '#passwordExpand');
  wirePasswordForm(el);

  el.querySelector('#pfLogoutBtn').addEventListener('click', () => {
    closeProfilePage();
    if (logoutFn) logoutFn();
  });

  const refresh = el.querySelector('#refreshContentBtn');
  const refreshLabel = el.querySelector('#pfRefreshLabel');
  refresh.addEventListener('click', async () => {
    if (refresh.disabled) return;
    refresh.disabled = true;
    const original = refreshLabel.textContent;
    refreshLabel.textContent = 'Checking for new content…';
    const started = forceContentRefresh();
    started
      ? await Promise.all([window.__atlasWhenContentRefreshed(8000), new Promise(r => setTimeout(r, 1200))])
      : await new Promise(r => setTimeout(r, 900));
    refreshLabel.textContent = started ? 'Content is up to date' : 'Already up to date';
    showToast(started ? 'Content updated' : 'You already have the latest content', { icon: 'fa-solid fa-circle-check' });
    setTimeout(() => { refreshLabel.textContent = original; refresh.disabled = false; }, 2200);
  });

  loadAccess(student, el);
  loadDevices(student, device, el);
}

/* ---------- Change password --------------------------------------------- */
function passwordErrorMessage(err) {
  const c = err?.code || '';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password') return 'Your current password is incorrect.';
  if (c === 'auth/weak-password' || c === 'auth/password-does-not-meet-requirements') return 'Choose a stronger password (at least 8 characters).';
  if (c === 'auth/too-many-requests') return 'Too many attempts. Please try again later.';
  if (c === 'auth/network-request-failed') return 'Connection failed. Check your internet and try again.';
  if (c === 'auth/requires-recent-login') return 'Please log out and sign in again, then change your password.';
  return err?.message || 'Could not change your password. Please try again.';
}

function wirePasswordForm(el) {
  const cur = el.querySelector('#pfCurPw');
  const next = el.querySelector('#pfNewPw');
  const conf = el.querySelector('#pfConfPw');
  const msg = el.querySelector('#pfPwMsg');
  const btn = el.querySelector('#pfPasswordBtn');
  const box = el.querySelector('#passwordExpand');
  const submit = el.querySelector('#pfPwSubmit');
  const label = submit.querySelector('.pf-submit-label');
  const say = (text, kind = 'bad') => { msg.textContent = text; msg.className = 'pf-form-msg' + (text ? ' show ' + kind : ''); };

  el.querySelectorAll('.pf-eye').forEach(eye => eye.addEventListener('click', () => {
    const input = el.querySelector('#' + eye.dataset.for);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.querySelector('i').className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
  }));
  [cur, next, conf].forEach(i => i.addEventListener('input', () => say('')));

  let busy = false;
  const run = async () => {
    if (busy) return;
    const a = cur.value, b = next.value, c = conf.value;
    if (!a || !b || !c) return say('Fill in all three fields.');
    if (b.length < 8) return say('Your new password must be at least 8 characters.');
    if (b !== c) return say('The new passwords do not match.');
    if (a === b) return say('Choose a new password that is different from the current one.');
    busy = true; submit.disabled = true; label.textContent = 'Updating…'; say('');
    try {
      await changeStudentPassword(a, b);
      cur.value = next.value = conf.value = '';
      showToast('Password updated', { icon: 'fa-solid fa-circle-check' });
      box.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    } catch (err) {
      console.error('[profile] password change failed', err);
      say(passwordErrorMessage(err));
    } finally { busy = false; submit.disabled = false; label.textContent = 'Update password'; }
  };
  submit.addEventListener('click', run);
  [cur, next, conf].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }));
}

/* ---------- Bundles & modules ------------------------------------------- */
async function loadAccess(student, el) {
  const bundlesEl = el.querySelector('#bundlesContainer');
  const modulesEl = el.querySelector('#modulesContainer');
  const bundlesSub = el.querySelector('#pfBundlesSub');
  const modulesSub = el.querySelector('#pfModulesSub');
  const empty = msg => `<div class="pf-empty">${msg}</div>`;
  const countLabel = (n, word) => n === 0 ? `No ${word}s` : (n === 1 ? `1 ${word}` : `${n} ${word}s`);
  try {
    const packages = await ttlRead('packages', 6 * 36e5, async () => (await getDocs(query(collection(db, 'packages')))).docs.map(d => ({ id: d.id, ...d.data() })));
    const locks = student.userLocks || {};
    const bundles = packages.filter(p => locks[p.id] === false && p.type !== 'module');
    const modules = (await ttlRead('modules_all', 6 * 36e5, async () => (await getDocs(query(collection(db, 'modules')))).docs.map(d => ({ id: d.id, ...d.data() }))))
      .filter(m => (m.universityId || 'jimma') === ACTIVE_UNIVERSITY_ID)
      .filter(m => !isItemLockedForUser(m, student));

    bundlesSub.textContent = countLabel(bundles.length, 'bundle');
    modulesSub.textContent = countLabel(modules.length, 'module');

    bundlesEl.innerHTML = bundles.length ? bundles.map(b => `
      <div class="pf-item">
        <span class="pf-item-ico" style="--tone:${esc(b.color || 'var(--artery)')}"><i class="fa-solid ${esc(b.icon || 'fa-box')}"></i></span>
        <span class="pf-item-name">${esc(b.name || 'Untitled bundle')}</span>
        <i class="fa-solid fa-circle-check pf-ok"></i>
      </div>`).join('') : empty('No bundles yet');

    modulesEl.innerHTML = modules.length ? modules.map(m => `
      <div class="pf-item">
        <span class="pf-item-ico" style="--tone:var(--artery)"><i class="fa-solid fa-cube"></i></span>
        <span class="pf-item-name">${esc(m.name || 'Untitled module')}</span>
        <i class="fa-solid fa-lock-open pf-ok"></i>
      </div>`).join('') : empty('No modules assigned');
  } catch (err) {
    console.error('Error loading bundles:', err);
    bundlesSub.textContent = modulesSub.textContent = 'Couldn’t load';
    bundlesEl.innerHTML = modulesEl.innerHTML = empty('Couldn’t load');
  }
}

/* ---------- Devices ------------------------------------------------------ */
function ago(ms) {
  if (!ms) return 'Unknown';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 420) return 'Active now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function loadDevices(student, device, el) {
  const box = el.querySelector('#devSessList');
  const count = el.querySelector('#devSessCount');
  try {
    const key = student.id || student.docId;
    const cached = DEVICE_CACHE[key];
    let devices;
    if (cached && Date.now() - cached.t < 3e5) {
      devices = cached.ds;
    } else {
      const snap = await getDocs(collection(db, 'secretkeys', key, 'devices'));
      devices = dedupeDeviceDocs(snap.docs.map(d => {
        const v = d.data();
        return { id: d.id, model: v.model, ua: v.ua, blocked: v.blocked, fingerprint: v.fingerprint,
          ls: v.lastSeen && v.lastSeen.toMillis ? v.lastSeen.toMillis() : 0 };
      }));
      DEVICE_CACHE[key] = { t: Date.now(), ds: devices };
    }
    devices = devices.slice().sort((a, b) => (b.id === device.deviceId) - (a.id === device.deviceId) || b.ls - a.ls);
    count.textContent = devices.filter(d => !d.blocked).length;
    box.innerHTML = devices.length ? devices.map(d => {
      const mine = d.id === device.deviceId;
      const blocked = !!d.blocked;
      const live = !blocked && (mine || Date.now() - d.ls < 42e4);
      const mobile = /Mobi|Android|iPhone|iPad/i.test(d.ua || '');
      const status = blocked ? '<span class="pf-st bad">Blocked</span>'
        : live ? '<span class="pf-st good">Active now</span>'
        : `<span class="pf-st">Last seen ${ago(d.ls)}</span>`;
      return `
        <div class="pf-device${mine ? ' mine' : ''}">
          <span class="pf-item-ico" style="--tone:var(--ink-soft)"><i class="fa-solid ${mobile ? 'fa-mobile-screen' : 'fa-laptop'}"></i></span>
          <div class="pf-device-body">
            <div class="pf-device-name">${esc(d.model || 'Unknown device')}${mine ? '<span class="pf-this">This device</span>' : ''}</div>
            <div class="pf-device-st">${status}</div>
          </div>
        </div>`;
    }).join('') : '<div class="pf-empty">No devices found</div>';
  } catch (_) {
    count.textContent = '–';
    box.innerHTML = '<div class="pf-empty">Couldn’t load devices</div>';
  }
}