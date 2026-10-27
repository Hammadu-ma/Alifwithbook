/* ========================================================================
   ALIF Med — authentication gate
   Firebase Auth is the identity. This file controls presentation and calls
   the auth service; it never reads credentials from Firestore.
   ======================================================================== */
import {
  getStoredStudent, storeStudent, clearStudent, loadStudentForUser,
  getAuthInstance, signInStudent, signUpStudent, resetStudentPassword,
  signOutStudent
} from './auth.js';
import { createGuestStudent } from './guest-dashboard.js';
import { assertDeviceAllowed, holdBlockedDevice, startHeartbeat } from './device-session.js';
import { showToast } from './ui-feedback.js';
import { pushModalState, popModalState } from './modal-backbutton.js';

export const gateScreen = document.getElementById('gateScreen');
export const homeScreen = document.getElementById('homeScreen');
export const pickerScreen = document.getElementById('pickerScreen');
export const appScreen = document.getElementById('appScreen');

const $ = id => document.getElementById(id);
const views = { login: $('authViewLogin'), signup: $('authViewSignup'), forgot: $('authViewForgot') };
const title = $('authTitle');
const eyebrow = $('authEyebrow');
const subtitle = $('authSubtitle');
const errorBox = $('authError');
const noticeBox = $('authNotice');
const closeBtn = $('gateCloseBtn');
let returnTarget = 'home';
let prevScreens = null;
let gateHistoryPushed = false;
let busy = false;

function setHidden(el, hidden) { el?.classList.toggle('hidden', !!hidden); }
function clearMessages() {
  if (errorBox) { errorBox.textContent = ''; errorBox.classList.remove('show'); }
  if (noticeBox) { noticeBox.textContent = ''; noticeBox.classList.remove('show'); }
}
function errorMessage(err) {
  const c = err?.code || '';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found') return 'Email or password is incorrect.';
  if (c === 'auth/too-many-requests') return 'Too many attempts. Please try again later.';
  if (c === 'auth/network-request-failed') return 'Connection failed. Check your internet connection and try again.';
  if (c === 'auth/email-already-in-use') return 'An account already exists for this email. Sign in instead.';
  if (c === 'auth/invalid-email') return 'Enter a valid email address.';
  if (c === 'auth/weak-password' || c === 'auth/password-does-not-meet-requirements') return 'Choose a stronger password (at least 8 characters).';
  if (c === 'account-not-ready') return 'This account is missing its ALIF student profile. Please contact an administrator.';
  if (c === 'account-disabled' || c === 'auth/user-disabled') return 'This account is currently disabled. Please contact an administrator.';
  if (c === 'legacy-auth-disabled') return 'The old secret-key login has been retired. Use your Firebase account.';
  return err?.message || 'Something went wrong. Please try again.';
}
function showError(message) {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.classList.add('show');
}
function showNotice(message) {
  if (!noticeBox) return;
  noticeBox.textContent = message;
  noticeBox.classList.add('show');
}
function setBusy(button, state, label = '') {
  if (!button) return;
  button.disabled = state;
  const target = button.querySelector('.auth-btn-label');
  if (state) {
    button.dataset.originalLabel = target?.textContent || button.textContent;
    if (target) target.innerHTML = '<span class="auth-spinner"></span> Please wait…';
  } else if (target) {
    target.textContent = label || button.dataset.originalLabel || 'Continue';
  }
}
function setView(view) {
  clearMessages();
  Object.entries(views).forEach(([key, el]) => setHidden(el, key !== view));
  if (view === 'login') {
    eyebrow && (eyebrow.textContent = 'WELCOME BACK');
    title && (title.textContent = 'Sign in');
    subtitle && (subtitle.textContent = 'Use your email and password to continue.');
  } else if (view === 'signup') {
    eyebrow && (eyebrow.textContent = 'GET STARTED');
    title && (title.textContent = 'Create your account');
    subtitle && (subtitle.textContent = '');
  } else {
    eyebrow && (eyebrow.textContent = 'ACCOUNT RECOVERY');
    title && (title.textContent = 'Reset your password');
    subtitle && (subtitle.textContent = 'We’ll send a secure password reset link to your email.');
    const email = $('authLoginEmail')?.value?.trim();
    if (email && $('authResetEmail')) $('authResetEmail').value = email;
  }
}

/* ---- Navigation helpers: keep screens + browser history coherent ---- */
function waitForPop(ms = 400) {
  return new Promise(resolve => {
    let done = false;
    const fin = () => { if (done) return; done = true; window.removeEventListener('popstate', fin); resolve(); };
    window.addEventListener('popstate', fin);
    setTimeout(fin, ms);
  });
}

// After a successful sign-in / sign-up / guest start: land on HOME (same as logout does),
// remove the gate's own history entry, and keep exactly one coherent history trail.
async function releaseGateHistory() {
  const hadEntry = gateHistoryPushed;
  gateHistoryPushed = false;
  if (hadEntry) {
    const needBack = !!history.state?.atlasModal;
    const waiter = needBack ? waitForPop() : null;
    try { popModalState?.(closeAuthGate); } catch (_) {}
    if (waiter) await waiter;
  }
}

async function enterHome() {
  await releaseGateHistory();
  gateScreen?.classList.add('hidden');
  document.body.classList.remove('auth-gate-open');
  appScreen?.classList.add('hidden');
  pickerScreen?.classList.add('hidden');
  const [{ replaceAppState, pushAppState }, { showHome }] = await Promise.all([
    import('./progress-rings.js'),
    import('./home-screen.js')
  ]);
  const st = history.state?.appState;
  if (!st || st === 'home' || st === 'gate') replaceAppState('home');
  else pushAppState('home');
  prevScreens = null;
  await showHome({ skipHistory: true });
}

async function finishAuthenticated(student) {
  if (!student || student.guest) throw new Error('Authenticated student profile is unavailable.');
  try {
    await assertDeviceAllowed(student);
  } catch (e) {
    if (e?.blocked) {
      // Blocked device: keep them signed in and show the blocked screen (their choice: sign out / free items).
      await releaseGateHistory();
      prevScreens = null;
      holdBlockedDevice(student, e, () => { import('./class-chat.js').then(c => c.startUnreadTracking?.()).catch(() => {}); });
      return;
    }
    await signOutStudent();
    throw e;
  }
  storeStudent(student);
  await enterHome();
  try { startHeartbeat(); } catch (_) {}
  try { const chat = await import('./class-chat.js'); chat.startUnreadTracking?.(); } catch (_) {}
  try { showToast('Signed in successfully', { icon: 'fa-solid fa-circle-check' }); } catch (_) {}
}

export async function openAuthGate(view = 'login', reason = '') {
  returnTarget = !pickerScreen?.classList.contains('hidden') ? 'picker' : 'home';
  // Remember exactly which screens were visible so closing the gate restores them
  // (re-showing appScreen on home/picker exposes its fixed sidebar toggle).
  if (!prevScreens || gateScreen?.classList.contains('hidden')) {
    prevScreens = {
      home: !homeScreen?.classList.contains('hidden'),
      picker: !pickerScreen?.classList.contains('hidden'),
      app: !appScreen?.classList.contains('hidden')
    };
  }
  clearMessages();
  gateScreen?.classList.remove('hidden');
  homeScreen?.classList.add('hidden');
  pickerScreen?.classList.add('hidden');
  appScreen?.classList.add('hidden');
  document.body.classList.add('auth-gate-open');
  setView(view);
  closeBtn?.classList.toggle('hidden', returnTarget === 'home' && !getStoredStudent());
  if (reason) showError(reason === 'account-not-ready' ? errorMessage({ code: 'account-not-ready' }) : reason);
  // Closable gate => give it its own history entry so the Back button closes it
  // and returns to the exact previous screen.
  if (!gateHistoryPushed && (returnTarget === 'picker' || getStoredStudent())) {
    gateHistoryPushed = true;
    try { pushModalState?.(closeAuthGate); } catch (_) { gateHistoryPushed = false; }
  }
}

export function closeAuthGate() {
  gateScreen?.classList.add('hidden');
  document.body.classList.remove('auth-gate-open');
  if (getStoredStudent()) {
    let prev = prevScreens || { home: returnTarget !== 'picker', picker: returnTarget === 'picker', app: false };
    if (!prev.home && !prev.picker && !prev.app) prev = { home: true, picker: false, app: false };
    homeScreen?.classList.toggle('hidden', !prev.home);
    pickerScreen?.classList.toggle('hidden', !prev.picker);
    appScreen?.classList.toggle('hidden', !prev.app);
  }
  prevScreens = null;
  gateHistoryPushed = false;
  try { popModalState?.(closeAuthGate); } catch (_) {}
}

async function attemptLogin() {
  if (busy) return;
  const email = $('authLoginEmail')?.value?.trim() || '';
  const password = $('authLoginPassword')?.value || '';
  if (!email || !password) return showError('Enter your email and password.');
  busy = true;
  const btn = $('authLoginBtn');
  setBusy(btn, true);
  clearMessages();
  try {
    const student = await signInStudent(email, password);
    await finishAuthenticated(student);
  } catch (e) {
    console.error('[auth] sign-in failed', e);
    showError(errorMessage(e));
  } finally {
    busy = false;
    setBusy(btn, false, 'Sign in');
  }
}

async function attemptSignup() {
  if (busy) return;
  const name = $('authSignupName')?.value?.trim() || '';
  const email = $('authSignupEmail')?.value?.trim() || '';
  const batch = $('authSignupBatch')?.value?.trim() || '';
  const password = $('authSignupPassword')?.value || '';
  const confirm = $('authSignupConfirm')?.value || '';
  if (!name) return showError('Enter your full name.');
  if (!email) return showError('Enter your email address.');
  if (!batch) return showError('Enter your batch.');
  if (password.length < 8) return showError('Password must be at least 8 characters.');
  if (password !== confirm) return showError('Passwords do not match.');
  busy = true;
  const btn = $('authCreateBtn');
  setBusy(btn, true);
  clearMessages();
  try {
    const result = await signUpStudent({ name, email, batch, password });
    await finishAuthenticated(result.student);
    try { showToast('Account created. Please check your email to verify your address.', { icon: 'fa-solid fa-envelope-circle-check' }); } catch (_) {}
  } catch (e) {
    console.error('[auth] sign-up failed', e);
    showError(errorMessage(e));
  } finally {
    busy = false;
    setBusy(btn, false, 'Create account');
  }
}

async function attemptReset() {
  if (busy) return;
  const email = $('authResetEmail')?.value?.trim() || '';
  if (!email) return showError('Enter your email address.');
  busy = true;
  const btn = $('authResetBtn');
  setBusy(btn, true);
  clearMessages();
  try {
    await resetStudentPassword(email);
    showNotice('If that email is registered, a password reset message has been sent.');
  } catch (e) {
    console.error('[auth] password reset failed', e);
    showError(errorMessage(e));
  } finally {
    busy = false;
    setBusy(btn, false, 'Send reset email');
  }
}

async function continueAsGuest() {
  if (busy) return;
  clearMessages();
  clearStudent();
  const guest = createGuestStudent();
  storeStudent(guest);
  await enterHome();
}

$('authLoginForm')?.addEventListener('submit', e => { e.preventDefault(); attemptLogin(); });
$('authSignupForm')?.addEventListener('submit', e => { e.preventDefault(); attemptSignup(); });
$('authResetForm')?.addEventListener('submit', e => { e.preventDefault(); attemptReset(); });
$('openSignupBtn')?.addEventListener('click', () => setView('signup'));
$('openLoginBtn')?.addEventListener('click', () => setView('login'));
$('forgotPasswordBtn')?.addEventListener('click', () => setView('forgot'));
$('backToLoginBtn')?.addEventListener('click', () => setView('login'));
$('guestContinueLink')?.addEventListener('click', continueAsGuest);
$('gateCloseBtn')?.addEventListener('click', closeAuthGate);

document.querySelectorAll('[data-password-toggle]').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.passwordToggle);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});

export async function refreshAuthenticatedStudent() {
  const auth = getAuthInstance();
  const user = auth.currentUser;
  if (!user) return null;
  const student = await loadStudentForUser(user);
  if (student) storeStudent(student);
  return student;
}
