import { clearStudent, getStoredStudent, loadStudentForUser, signOutStudent, storeStudent, waitForAuthReady } from './auth.js';
import { startUnreadTracking } from './class-chat.js';
import { assertDeviceAllowed, holdBlockedDevice, startHeartbeat } from './device-session.js';
import { CONFIG_READY } from './firebase-config.js';
import { gateScreen, openAuthGate } from './gate-screen.js';
import { createGuestStudent } from './guest-dashboard.js';
import { showHome } from './home-screen.js';
import { replaceAppState } from './progress-rings.js';
import { startAccessSubscription } from './access-service.js';
import { LSC } from './cache.js';

/* The 38 KB legacy-migration module is only needed by the few students who still have an old-style
   login on this device — load it on demand instead of on every launch. */
let legacyModule = null;
const loadLegacy = () => legacyModule || (legacyModule = import('./legacy-migration.js'));
function hasLegacyCandidate() {   // same rule as legacy-migration.getLegacyCandidate, without loading it
  try {
    const direct = LSC.get('atlas_student_v1');
    if (direct?.id && direct?.secretkey) return true;
    const roster = LSC.get('atlas_secretkeys_cache');
    if (roster && typeof roster === 'object') for (const v of Object.values(roster)) if (v?.id && v?.secretkey) return true;
  } catch (_) {}
  return false;
}
const openLegacyMigrationModal = async candidate => (await loadLegacy()).openLegacyMigrationModal(candidate);

async function startStudent(student, { deferHeartbeat = false } = {}) {
  storeStudent(student);
  replaceAppState('home');
  showHome({ skipHistory: true });
  if (!student.guest) {
    startAccessSubscription(student.uid);
    if (!deferHeartbeat) startHeartbeat();
    startUnreadTracking();
  }
}

/* Fast refresh: a returning student with a saved profile sees the home screen immediately.
   The slow, network-bound checks (profile reload, account status, device lock) run right after
   in the background; if any of them fails we apply exactly the same outcome as the normal path. */
async function verifyInBackground(authUser, legacyCandidate) {
  try {
    let student = await loadStudentForUser(authUser);
    if ((!student || student.migrationState === 'in_progress') && legacyCandidate) {
      student = await openLegacyMigrationModal(legacyCandidate);
    }
    if (!student) {
      clearStudent();
      await openAuthGate('login', 'account-not-ready');
      return;
    }
    try {
      await assertDeviceAllowed(student);
    } catch (e) {
      if (e?.blocked) { holdBlockedDevice(student, e, () => { startAccessSubscription(student.uid); startUnreadTracking(); }); return; }
      if (e?.name === 'DeviceLockError') await signOutStudent().catch(() => {}); else clearStudent();
      await openAuthGate('login', e?.message || 'This device is not allowed for this account.');
      return;
    }
    storeStudent(student);
    startHeartbeat();
  } catch (e) {
    console.error('[boot] background verification failed', e);
    clearStudent();
    await openAuthGate('login', 'Could not restore your account session. Please sign in again.');
  }
}

(async () => {
  try {
    if (!CONFIG_READY) {
      gateScreen.classList.remove('hidden');
      openAuthGate('login');
      return;
    }

    let authUser = await waitForAuthReady();
    if (authUser?.isAnonymous) { clearStudent(); authUser = null; }
    let legacyCandidate = null;
    if (hasLegacyCandidate()) legacyCandidate = (await loadLegacy()).getLegacyMigrationCandidate();

    if (authUser) {
      const saved = getStoredStudent();
      const canFastStart = saved && !saved.guest && saved.uid === authUser.uid
        && saved.migrationState !== 'in_progress' && !legacyCandidate
        && !(typeof navigator !== 'undefined' && navigator.onLine === false);
      if (canFastStart) {
        await startStudent(saved, { deferHeartbeat: true });
        document.getElementById('bootLoader')?.remove();
        verifyInBackground(authUser, legacyCandidate);   // intentionally not awaited
        return;
      }
      let student = await loadStudentForUser(authUser);
      if ((!student || student.migrationState === 'in_progress') && legacyCandidate) {
        student = await openLegacyMigrationModal(legacyCandidate);
      }
      if (!student) {
        clearStudent();
        await openAuthGate('login', 'account-not-ready');
        return;
      }
      try {
        await assertDeviceAllowed(student);
      } catch (e) {
        // Blocked device: do NOT sign out. Hold the user on the blocked screen (sign out / free items are their choice).
        if (e?.blocked) { holdBlockedDevice(student, e, () => { startAccessSubscription(student.uid); startUnreadTracking(); }); return; }
        // Device limit reached: end the session on this device and say why.
        if (e?.name === 'DeviceLockError') await signOutStudent().catch(() => {}); else clearStudent();
        await openAuthGate('login', e?.message || 'This device is not allowed for this account.');
        return;
      }
      await startStudent(student);
    } else if (legacyCandidate) {
      // Existing students get one beautiful just-in-time migration prompt
      // instead of being sent through an admin/manual linking workflow.
      const migrated = await openLegacyMigrationModal(legacyCandidate);
      if (migrated) {
        try { await assertDeviceAllowed(migrated); } catch (e) { if (e?.blocked) { holdBlockedDevice(migrated, e, () => { startAccessSubscription(migrated.uid); startUnreadTracking(); }); return; } if (e?.name === 'DeviceLockError') await signOutStudent().catch(() => {}); else clearStudent(); await openAuthGate('login', e?.message || 'This device is not allowed for this account.'); return; }
        await startStudent(migrated);
      } else {
        await startStudent(createGuestStudent());
      }
    } else {
      const stale = getStoredStudent();
      if (stale && !stale.guest) clearStudent();
      await startStudent(createGuestStudent());
    }
  } catch (e) {
    console.error('[boot] authentication bootstrap failed', e);
    clearStudent();
    await openAuthGate('login', 'Could not restore your account session. Please sign in again.');
  } finally {
    document.getElementById('bootLoader')?.remove();
  }
})();

// Notifications use Firestore realtime delivery in this zero-cost build.
// Do not register/unregister a service worker here: a future Web Push worker
// can be added independently without destroying an existing registration.
