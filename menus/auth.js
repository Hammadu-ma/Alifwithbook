/* ========================================================================
   ALIF Med — Firebase Authentication
   
   Security model:
   - Firebase Auth is the only student identity.
   - Firestore users/{uid} is the profile/authorization anchor.
   - secretkeys/{studentId} is a legacy student/entitlement record, NOT a
     credential. New code never stores or reads a secret login key.
   - localStorage contains only a UI cache. It is never trusted for auth.
   ======================================================================== */
import { LSC, withTimeout } from './cache.js';
import { db } from './firebase-config.js';
import { getAuth, setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail, sendEmailVerification,
  updateProfile, deleteUser, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { PROGRESS_KEY_PREFIX, REMOTE_PROGRESS_KEY_PREFIX, invalidateRemoteProgressCache } from './progress-rings.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export const DASH_USER_KEY = 'medicalUser'; // legacy compatibility only
export const DASH_DISMISS_KEY = 'atlas_dash_dismissed_v1'; // legacy compatibility only
const STUDENT_KEY = 'atlas_student_v2';
const LEGACY_STUDENT_KEY = 'atlas_student_v1';
const auth = getAuth(getApp());
let persistenceReady;

persistenceReady = setPersistence(auth, browserLocalPersistence)
  .catch(() => setPersistence(auth, browserSessionPersistence))
  .catch(() => setPersistence(auth, inMemoryPersistence))
  .catch(() => undefined);

export function getAuthInstance() { return auth; }
export function getAuthUser() { return auth.currentUser || null; }
export async function waitForAuthReady() {
  return new Promise(resolve => {
    let done = false;
    const finish = user => { if (!done) { done = true; resolve(user || null); } };
    import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js').then(({ onAuthStateChanged }) => {
      const unsub = onAuthStateChanged(auth, user => { unsub(); finish(user); }, () => finish(null));
    }).catch(() => finish(auth.currentUser));
  });
}

function normalizeMillis(value) {
  return value?.toMillis?.() || value?.seconds ? value.seconds * 1000 : Number(value) || 0;
}

function cleanStudentForCache(student) {
  if (!student) return null;
  const copy = JSON.parse(JSON.stringify(student, (_k, value) => {
    if (value && typeof value === 'object' && value.seconds !== undefined && value.nanoseconds !== undefined) {
      return { seconds: value.seconds, nanoseconds: value.nanoseconds };
    }
    return value;
  }));
  // Never keep the old credential field in the browser cache.
  delete copy.secretkey;
  delete copy.password;
  return copy;
}

export function getStoredStudent() {
  const student = LSC.get(STUDENT_KEY);
  if (student?.id || student?.docId) return student;
  return null;
}

export function storeStudent(student) {
  const safe = cleanStudentForCache(student);
  if (safe) LSC.set(STUDENT_KEY, safe);
  return safe;
}

export function clearStudent() {
  try {
    LSC.remove(STUDENT_KEY);
    LSC.remove(LEGACY_STUDENT_KEY);
    LSC.remove('atlas_secretkeys_cache');
    LSC.remove(DASH_DISMISS_KEY);
  } catch (_) {}
}

function studentFromRecords(user, userProfile, legacy) {
  const studentId = userProfile?.studentId || legacy?.id || legacy?.docId;
  if (!studentId || !legacy) return null;
  return {
    ...legacy,
    ...userProfile,
    id: studentId,
    docId: studentId,
    uid: user.uid,
    authUid: user.uid,
    email: user.email || userProfile?.email || legacy.email || '',
    name: userProfile?.name || legacy.name || user.displayName || '',
    batch: userProfile?.batch || legacy.batch || '',
    guest: false,
    source: userProfile?.source || legacy.source || 'firebaseAuth',
    migrationState: userProfile?.migrationState || 'complete'
  };
}

async function findLegacyStudentForUid(uid) {
  if (!db || !uid) return null;
  const snap = await getDocs(query(collection(db, 'secretkeys'), where('authUid', '==', uid), limit(1)));
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, docId: d.id, ...d.data() };
}

async function backfillUserProfile(uid, user, legacy) {
  if (!legacy?.id) return null;
  const userRef = doc(db, 'users', uid);
  const payload = {
    role: 'student',
    status: legacy.status || 'active',
    name: legacy.name || user.displayName || '',
    email: user.email || legacy.email || '',
    batch: legacy.batch || '',
    studentId: legacy.id,
    source: 'legacyLinked',
    migrationState: 'complete',
    migrationVersion: 1,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(userRef, payload, { merge: false });
  return payload;
}

export async function loadStudentForUser(user) {
  if (!user || user.isAnonymous || !db) return null;
  const uid = user.uid;
  const saved = getStoredStudent();
  if (saved && saved.uid === uid && !saved.guest) {
    // Offline: the saved profile is all we can have — open instantly instead of waiting for timeouts.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return saved;
  }
  let profileSnap;
  try {
    profileSnap = await withTimeout(getDoc(doc(db, 'users', uid)), 5000);
  } catch (e) {
    const cached = getStoredStudent();
    if (cached?.uid === uid && !cached.guest) return cached;
    throw e;
  }

  let profile = profileSnap.exists() ? profileSnap.data() : null;
  if (profile && profile.status && profile.status !== 'active') {
    const err = new Error('ACCOUNT_DISABLED');
    err.code = 'account-disabled';
    throw err;
  }
  if (!profile || profile.role !== 'student' || !profile.studentId) {
    const legacy = await findLegacyStudentForUid(uid);
    if (!legacy) return null;
    profile = await backfillUserProfile(uid, user, legacy);
  }

  const studentSnap = await withTimeout(getDoc(doc(db, 'secretkeys', profile.studentId)), 5000);
  if (!studentSnap.exists()) return null;
  const legacy = { id: studentSnap.id, docId: studentSnap.id, ...studentSnap.data() };
  if (legacy.authUid !== uid) return null;

  const student = studentFromRecords(user, profile, legacy);
  if (!student) return null;
  storeStudent(student);
  return student;
}

export async function signInStudent(email, password) {
  if (!db) throw new Error('Firebase is not configured.');
  await persistenceReady;
  const cred = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  try {
    const student = await loadStudentForUser(cred.user);
    if (!student) {
      await signOut(auth);
      throw Object.assign(new Error('ACCOUNT_NOT_READY'), { code: 'account-not-ready' });
    }
    return student;
  } catch (e) {
    if (e.code === 'account-disabled' || e.code === 'account-not-ready') {
      try { await signOut(auth); } catch (_) {}
    }
    throw e;
  }
}

export async function signUpStudent({ name, email, batch, password }) {
  if (!db) throw new Error('Firebase is not configured.');
  await persistenceReady;
  const cred = await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  const user = cred.user;
  try {
    await updateProfile(user, { displayName: name.trim() });
    const studentRef = doc(collection(db, 'secretkeys'));
    const userRef = doc(db, 'users', user.uid);
    const studentId = studentRef.id;
    const now = serverTimestamp();
    const userData = {
      role: 'student',
      status: 'active',
      name: name.trim(),
      email: user.email || email.trim().toLowerCase(),
      batch: batch.trim(),
      studentId,
      source: 'firebaseAuth',
      migrationState: 'complete',
      migrationVersion: 1,
      createdAt: now,
      updatedAt: now
    };
    const studentData = {
      name: name.trim(),
      batch: batch.trim(),
      ID: `ALIF-${studentId.slice(-8).toUpperCase()}`,
      authUid: user.uid,
      userLocks: {},
      oneTimeUse: false,
      used: false,
      appearInChat: true,
      deviceLockEnabled: true,
      maxDevices: 2,
      source: 'firebaseAuth',
      status: 'active',
      createdAt: now,
      updatedAt: now
    };
    const batchWrite = writeBatch(db);
    batchWrite.set(userRef, userData);
    batchWrite.set(studentRef, studentData);
    await batchWrite.commit();
    try { await sendEmailVerification(user); } catch (_) {}
    const student = { ...studentData, ...userData, id: studentId, docId: studentId, uid: user.uid, authUid: user.uid, email: user.email, guest: false };
    storeStudent(student);
    return { student, verificationSent: true };
  } catch (e) {
    try { await deleteUser(user); } catch (_) {}
    throw e;
  }
}

export async function resetStudentPassword(email) {
  if (!db) throw new Error('Firebase is not configured.');
  await persistenceReady;
  try {
    await sendPasswordResetEmail(auth, email.trim().toLowerCase());
  } catch (e) {
    // Keep the UI generic to avoid turning password reset into an account
    // enumeration endpoint. Firebase can also be configured to reject
    // enumeration explicitly in the console.
    if (['auth/network-request-failed', 'auth/too-many-requests'].includes(e.code)) throw e;
  }
  return true;
}

/* Change the signed-in student's password. Firebase requires a fresh credential for this, so the current
   password is verified first; a wrong current password surfaces as auth/invalid-credential. */
export async function changeStudentPassword(currentPassword, newPassword) {
  const user = auth.currentUser;
  if (!user || !user.email) {
    const err = new Error('Please sign in again to change your password.');
    err.code = 'auth/requires-recent-login';
    throw err;
  }
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword));
  await updatePassword(user, newPassword);
}

export async function sendStudentVerification() {
  if (!auth.currentUser) return false;
  await sendEmailVerification(auth.currentUser);
  return true;
}

export async function signOutStudent() {
  try { await Promise.race([window.__alifPushBeforeSignOut?.(), new Promise(r => setTimeout(r, 3000))]); } catch (_) {}
  clearStudent();
  try { await signOut(auth); } catch (_) {}
}

// Compatibility exports for modules that still import the former API.
export async function validateSecretKey() {
  const err = new Error('Secret-key authentication has been disabled. Use Firebase Authentication.');
  err.code = 'legacy-auth-disabled';
  throw err;
}
export async function markKeyAsUsed() {
  const err = new Error('Secret-key authentication has been disabled.');
  err.code = 'legacy-auth-disabled';
  throw err;
}
export async function ensureAuthUidStamped(student) {
  const uid = auth.currentUser?.uid || null;
  if (student && uid && student.uid === uid) return student;
  return student || null;
}

// -------------------------------------------------------------------------
// Sync / progress helpers — these remain compatible with the existing app,
// but their server-side owner is now the Firebase Auth UID.
// -------------------------------------------------------------------------
let SYSTEM_SETTINGS_CACHE = null;
let SYSTEM_SETTINGS_CACHE_TS = 0;
async function getSystemSettingsCached() {
  if (SYSTEM_SETTINGS_CACHE && (Date.now() - SYSTEM_SETTINGS_CACHE_TS) < 60000) return SYSTEM_SETTINGS_CACHE;
  if (!db) return SYSTEM_SETTINGS_CACHE || {};
  try {
    const snap = await withTimeout(getDoc(doc(db, 'settings', 'system')), 1200);
    SYSTEM_SETTINGS_CACHE = snap.exists() ? snap.data() : {};
    SYSTEM_SETTINGS_CACHE_TS = Date.now();
    return SYSTEM_SETTINGS_CACHE;
  } catch (e) {
    return SYSTEM_SETTINGS_CACHE || {};
  }
}

export async function shouldSyncToFirebase() {
  try {
    const student = getStoredStudent();
    if (student && student.syncEnabled !== undefined && student.syncEnabled !== null) return student.syncEnabled;
    const settings = await getSystemSettingsCached();
    return settings.syncEnabled === true;
  } catch (_) { return false; }
}

async function shouldTrackProgress() {
  try {
    const student = getStoredStudent();
    if (student && student.progressTrackingEnabled !== undefined && student.progressTrackingEnabled !== null) return student.progressTrackingEnabled;
    const settings = await getSystemSettingsCached();
    return settings.progressTrackingEnabled === true;
  } catch (_) { return false; }
}

let PROGRESS_PUSH_TIMER = null;
export function pushProgressSnapshot(subjectId, quizId) {
  clearTimeout(PROGRESS_PUSH_TIMER);
  PROGRESS_PUSH_TIMER = setTimeout(async () => {
    const tracking = await shouldTrackProgress();
    if (!tracking || !db) return;
    const student = getStoredStudent();
    if (!student || !(student.id || student.docId) || !getAuthUser()) return;
    const saved = LSC.get(`${PROGRESS_KEY_PREFIX}${student.id}_${subjectId}_${quizId}`);
    if (!saved) return;
    const answeredCount = Object.keys(saved.answers || {}).length;
    const correctCount = Object.values(saved.answers || {}).filter(a => a.correct).length;
    try {
      await setDoc(doc(db, 'progress', getAuthUser().uid), {
        uid: getAuthUser().uid,
        studentId: student.id || student.docId,
        subjects: {
          [subjectId]: {
            [quizId]: {
              total: saved.total || 0,
              answeredCount,
              correctCount,
              completed: !!saved.completed,
              updatedAt: serverTimestamp()
            }
          }
        },
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (_) {}
  }, 900);
}

const _mergeAt = {};
export async function mergeRemoteProgress() {
  const student = getStoredStudent();
  const uid = getAuthUser()?.uid;
  if (!student || !uid) return false;
  const key = uid;
  if (Date.now() - (_mergeAt[key] || 0) < 300000) return false;
  _mergeAt[key] = Date.now();
  if (!(await shouldTrackProgress()) || !db) return false;
  try {
    const snap = await withTimeout(getDoc(doc(db, 'progress', uid)), 1400);
    if (!snap.exists()) return false;
    LSC.set(`${REMOTE_PROGRESS_KEY_PREFIX}${student.id}`, snap.data().subjects || {});
    invalidateRemoteProgressCache();
    return true;
  } catch (_) { return false; }
}

