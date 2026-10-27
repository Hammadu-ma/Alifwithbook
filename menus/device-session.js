/* ======================================================================
   device-session.js
   ----------------------------------------------------------------------
   Device fingerprinting, per-student device-count enforcement, and a
   live "is this device still allowed in?" watcher.

   DATA MODEL (chosen for rule-simplicity, see firestore.rules):
     secretkeys/{studentId}                  — the student record
     secretkeys/{studentId}/devices/{deviceId} — one doc per device

   Putting each device in its own subdocument (deviceId as the doc ID)
   means Firestore rules can scope permissions using the document path
   itself — "you may create your own device doc, and once created you
   may only touch lastSeen/lastLogin on it, never `blocked`" — instead
   of needing brittle rules that inspect individual keys inside a big
   map field. A student can now never flip their own `blocked: true`
   back to false, and can never touch another device's doc, purely
   from the rules, with no extra app logic required.

   READ-COST FIX (carried over from the previous pass): still ONE
   onSnapshot() listener per session instead of a 10s getDoc() poll,
   and presence writes are decoupled and infrequent (90s) instead of
   on every tick. verifyNotBlocked() stays free (in-memory only).
   ====================================================================== */

import { getStoredStudent, storeStudent } from './auth.js';
import { updateBottomNavVisibility } from './bottom-nav.js';
import { forceUnlockBodyScroll } from './cache.js';
import { closeChatScreen } from './class-chat.js';
import { db } from './cloud-sync.js';
import { appScreen, gateScreen, homeScreen, openAuthGate, pickerScreen } from './gate-screen.js';
import { doLogout, showHome } from './home-screen.js';
import { modulesScreenEl, subjectsScreenEl } from './picker-screen.js';
import { progressScreen } from './progress-page.js';
import { replaceAppState } from './progress-rings.js';
import {
  collection, doc, getDoc, getDocs, onSnapshot,
  serverTimestamp, setDoc, updateDoc,
} from './runtime-ext.js';

/* ----------------------------------------------------------------------
   Device identity + fingerprint (unchanged behavior)
   ---------------------------------------------------------------------- */

/* DEVICE IDENTITY
   'browser' (default): a random id (crypto.randomUUID) generated once per browser and stored in it. Two identical
                        phones always get different ids, and privacy browsers (Brave…) work because nothing is read
                        from the GPU. Trade-off: every browser counts as a device, and clearing site data = new device.
   'hardware'          : the id is derived from OS, screen, CPU cores and GPU, so all browsers on one phone are ONE device,
                         but identical phones look like one device and GPU-hiding browsers get their own id.
   Switching to 'browser' keeps students registered under the hardware id working: see getMigratedHardwareId(). */
const DEVICE_IDENTITY_MODE = 'browser';

// The old per-browser random id. Never created any more in 'hardware' mode, but still READ so devices that were
// registered before the switch keep working (and stay blockable) until they are migrated.
const DEVICE_ID_KEY = 'atlas_device_id_v1';

function getLegacyDeviceId() {
  try { return localStorage.getItem(DEVICE_ID_KEY) || null; } catch (e) { return null; }
}

function getPersistentDeviceId() {
  let id = getLegacyDeviceId();
  if (!id) {
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    id = 'dev_' + rnd;
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {}
  }
  return id;
}

/* Browser mode only. A browser that already registered under the old hardware id remembers it in its own storage
   (LS_REG_KEY = 'studentId:hw_…'). Reusing that hw doc as this browser's "legacy" doc lets the student stay in without
   a free device slot, and keeps an admin block on it effective. A classmate's identical phone has no such marker,
   so it is NOT matched and counts as a new device. */
function getMigratedHardwareId() {
  try {
    const m = /:(hw_[a-z0-9]+)$/.exec(localStorage.getItem('atlas_dev_reg_v1') || '');
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Only signals that every browser on one machine reports identically. Deliberately NOT used: user agent, language,
// deviceMemory (Chrome only), canvas/audio rendering and device model (browser-specific or frozen by UA reduction).
function osFamily() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)) return 'ios';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'win';
  return 'nix';                                       // Android + Linux + ChromeOS (also covers "desktop site" mode)
}

function normalizeGpu(raw) {
  return String(raw || '').toLowerCase()
    .replace(/angle|direct3d\d*|d3d\d*|vs_\d_\d|ps_\d_\d|opengl( es)?[\d. ]*|metal|vulkan|pcie|sse2|\(tm\)|\(r\)|0x[0-9a-f]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((w, i, all) => w && all.indexOf(w) === i)        // Chrome/ANGLE repeats the vendor ("Intel, Intel UHD…"), Firefox does not
    .join(' ') || 'na';
}

function gpuRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'na';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) {}
    return normalizeGpu(raw);
  } catch (e) { return 'na'; }
}

export function hardwareSignature() {
  const dpr = window.devicePixelRatio || 1;
  // short side in PHYSICAL pixels (zoom-proof: screen.width shrinks as dpr grows), rounded to absorb browser differences
  const shortSide = Math.round((Math.min(screen.width || 0, screen.height || 0) * dpr) / 20) * 20;
  return [osFamily(), shortSide, navigator.hardwareConcurrency || 0, gpuRenderer()].join('|');
}

function hardwareDeviceId() {
  const sig = hardwareSignature();
  return 'hw_' + cyrb53(sig).toString(36) + cyrb53(sig, 7).toString(36);
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

function getCanvasFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('Alif Med-fp-🩺', 2, 2);
    return simpleHash(canvas.toDataURL());
  } catch (e) {
    return 'na';
  }
}

function computeFingerprint() {
  const parts = [
    navigator.userAgent,
    navigator.language,
    navigator.hardwareConcurrency,
    (screen.width || 0) + 'x' + (screen.height || 0) + 'x' + (screen.colorDepth || 0),
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    navigator.deviceMemory || '',
    navigator.platform || '',
    getCanvasFingerprint(),
  ].join('|');
  return simpleHash(parts);
}

// Cosmetic only — used for the "This device: …" label in the account
// sheet. Falls back to the raw model code if it isn't in the table.
const MODEL_MAP = {
  'SM-A146B': 'Samsung Galaxy A14', 'SM-A156B': 'Samsung Galaxy A15',
  'SM-A155F': 'Samsung Galaxy A15', 'SM-A155M': 'Samsung Galaxy A15',
  'SM-A057F': 'Samsung Galaxy A05s', 'SM-A047F': 'Samsung Galaxy A04s',
  'SM-A346B': 'Samsung Galaxy A34', 'SM-A546B': 'Samsung Galaxy A54',
  'SM-S911B': 'Samsung Galaxy S23', 'SM-S916B': 'Samsung Galaxy S23+',
  'SM-S918B': 'Samsung Galaxy S23 Ultra', 'SM-S921B': 'Samsung Galaxy S24',
  'SM-G990B': 'Samsung Galaxy S21 FE', 'SM-M336B': 'Samsung Galaxy M34',
  'Pixel 6': 'Google Pixel 6', 'Pixel 7': 'Google Pixel 7',
  'Pixel 8': 'Google Pixel 8', 'Pixel 8a': 'Google Pixel 8a',
};

function prettyModel(raw) {
  if (!raw) return null;
  return MODEL_MAP[raw] || raw;
}

async function detectDeviceModel() {
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const info = await navigator.userAgentData.getHighEntropyValues(['model', 'platform']);
      if (info && info.model) return prettyModel(info.model);
    }
  } catch (e) {}
  const ua = navigator.userAgent || '';
  const androidMatch = ua.match(/Android[^;]*;\s*([^)]+)\)/i);
  if (androidMatch && androidMatch[1]) {
    return prettyModel(androidMatch[1].split('Build')[0].trim());
  }
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Unknown device';
}

let DEVICE_INFO_CACHE = null;
export async function getDeviceInfo() {
  if (DEVICE_INFO_CACHE) return DEVICE_INFO_CACHE;
  const hardwareMode = DEVICE_IDENTITY_MODE === 'hardware';
  DEVICE_INFO_CACHE = {
    deviceId: hardwareMode ? hardwareDeviceId() : getPersistentDeviceId(),
    legacyId: hardwareMode ? getLegacyDeviceId() : getMigratedHardwareId(),   // other registration of THIS browser, if any
    fingerprint: computeFingerprint(),
    model: await detectDeviceModel(),
    ua: navigator.userAgent,
  };
  return DEVICE_INFO_CACHE;
}

function deviceDocRef(studentId, deviceId) {
  return doc(db, 'secretkeys', studentId, 'devices', deviceId);
}

/* All device docs that belong to THIS physical device: the hardware doc, plus (only for browsers registered
   before the switch) the old per-browser doc, which must keep honouring an admin block. */
function ownDeviceRefs(studentId, deviceInfo) {
  const refs = [deviceDocRef(studentId, deviceInfo.deviceId)];
  if (deviceInfo.legacyId && deviceInfo.legacyId !== deviceInfo.deviceId) refs.push(deviceDocRef(studentId, deviceInfo.legacyId));
  return refs;
}

/* A legacy (per-browser) doc and the hardware doc that the same browser created when it migrated carry the same
   fingerprint: they are ONE physical device and must not be counted (or listed) twice. Blocked rows always stay. */
export function dedupeDeviceDocs(docs) {
  if (DEVICE_IDENTITY_MODE === 'browser') {
    // Reverse case: an old hardware doc and the browser doc this browser created after migrating are ONE device.
    const browserFps = new Set(docs.filter(d => !String(d.id).startsWith('hw_') && d.fingerprint).map(d => d.fingerprint));
    return docs.filter(d => !String(d.id).startsWith('hw_') || d.blocked || !(d.fingerprint && browserFps.has(d.fingerprint)));
  }
  const hwFingerprints = new Set(docs.filter(d => String(d.id).startsWith('hw_') && d.fingerprint).map(d => d.fingerprint));
  return docs.filter(d => String(d.id).startsWith('hw_') || d.blocked || !(d.fingerprint && hwFingerprints.has(d.fingerprint)));
}
export function countActiveDevices(docs) {
  return dedupeDeviceDocs(docs).filter(d => !d.blocked).length;
}

/* ----------------------------------------------------------------------
   Per-device doc writes. Rules (see firestore.rules) let a student
   CREATE their own device doc with blocked:false, and after that only
   ever touch lastSeen/lastLogin on it — never the `blocked` field, and
   never another device's doc. Only an admin can block/unblock.
   ---------------------------------------------------------------------- */

/* COST HELPERS: tiny localStorage timestamps/flags so reloads and
   re-logins don't repeat reads/writes we already did recently. */
const LS_PING_KEY = 'atlas_dev_ping_v1';
const LS_TOUCH_KEY = 'atlas_stu_touch_v1';
const LS_REG_KEY = 'atlas_dev_reg_v1';
const LS_LOCKCFG_KEY = 'atlas_dev_lockcfg_v1';
const LS_PROFSEEN_KEY = 'atlas_prof_seen_v1';
function lsGetNum(k) { try { return Number(localStorage.getItem(k)) || 0; } catch (e) { return 0; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }

async function createOrTouchOwnDevice(studentId, deviceInfo) {
  if (!db || !studentId) return;
  const ref = deviceDocRef(studentId, deviceInfo.deviceId);
  const regVal = studentId + ':' + deviceInfo.deviceId;
  let known = false;
  try { known = localStorage.getItem(LS_REG_KEY) === regVal; } catch (e) {}

  // Fast path: device already registered before -> ONE write, zero reads.
  // (A blocked device is still caught for free by the onSnapshot watcher.)
  if (known) {
    try {
      await updateDoc(ref, { lastSeen: serverTimestamp(), lastLogin: serverTimestamp() });
      lsSet(LS_PING_KEY, Date.now());
      return { blocked: false, justCreated: false };
    } catch (e) { /* doc missing/failed -> fall through to full path */ }
  }

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        model: deviceInfo.model,
        fingerprint: deviceInfo.fingerprint,
        ua: deviceInfo.ua,
        firstSeen: serverTimestamp(),
        lastSeen: serverTimestamp(),
        lastLogin: serverTimestamp(),
        blocked: false,
      });
      lsSet(LS_REG_KEY, regVal); lsSet(LS_PING_KEY, Date.now());
      return { blocked: false, justCreated: true };
    }
    const data = snap.data();
    if (data.blocked) return { blocked: true, justCreated: false };
    await updateDoc(ref, { lastSeen: serverTimestamp(), lastLogin: serverTimestamp() });
    lsSet(LS_REG_KEY, regVal); lsSet(LS_PING_KEY, Date.now());
    return { blocked: false, justCreated: false };
  } catch (e) {
    console.error('[Alif Med] device write failed:', e.message || e.code || e);
    return { blocked: false, justCreated: false };
  }
}

async function pingOwnDevice(studentId, deviceId) {
  if (!db || !studentId) return;
  try {
    await updateDoc(deviceDocRef(studentId, deviceId), { lastSeen: serverTimestamp() });
  } catch (e) { /* best-effort presence ping */ }
}

/* Chat presence: the people list reads lastSeen from the student's public chatProfiles card ("online" = under 20 min). */
async function touchChatProfile(studentId) {
  if (!db || !studentId) return false;
  const ref = doc(db, 'chatProfiles', studentId);
  try {
    await updateDoc(ref, { lastSeen: serverTimestamp() });
    return true;
  } catch (e) {
    if (e && e.code === 'not-found') {
      // The chat card does not exist yet: create a minimal one (hidden from the people list until the student opts in).
      try { await setDoc(ref, { studentId, lastSeen: serverTimestamp() }, { merge: true }); return true; }
      catch (e2) { console.warn('[presence] could not create chat profile:', e2 && e2.code, e2 && e2.message); }
    } else {
      console.warn('[presence] lastSeen write failed:', e && e.code, e && e.message);
    }
    return false;
  }
}

async function touchStudentRecord(student) {
  if (!db || !student || !(student.id || student.docId)) return;
  try {
    await updateDoc(doc(db, 'secretkeys', student.id || student.docId), {
      lastSeen: serverTimestamp(),
      online: true,
      updatedAt: serverTimestamp(),
    });
  } catch (e) { /* best-effort presence ping */ }
}

/* ----------------------------------------------------------------------
   Login-time device-count enforcement. One settings read + one device
   read always; a subcollection list read only the first time a new
   device signs in and the account turns out to need counting. All of
   this happens once at login, not on a recurring basis.
   ---------------------------------------------------------------------- */

/* DEVICE PROTECTION for questions: firestore.rules only serve protected questions while deviceSessions/{uid}
   points at a device that is registered under this student and NOT blocked. Rules cannot see the calling
   device, so every device declares itself here right after it registers (and again when the app returns to the
   foreground, because two devices on one account share this one doc - the last one to bind is the active one).
   The rule rejects the write for a blocked/unregistered device, so a blocked device can never bind itself. */
let lastBindAt = 0;
export async function bindDeviceSession(student, deviceInfo) {
  const uid = student && student.uid;
  if (!db || !uid || !deviceInfo || !deviceInfo.deviceId) return false;
  try {
    await setDoc(doc(db, 'deviceSessions', uid), { deviceId: deviceInfo.deviceId, updatedAt: serverTimestamp() });
    lastBindAt = Date.now();
    return true;
  } catch (e) {
    console.warn('[Alif Med] device bind refused:', e && (e.code || e.message));
    return false;
  }
}

async function registerAndBind(student, studentId, deviceInfo) {
  await registerDeviceSafely(studentId, deviceInfo);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  await Promise.race([bindDeviceSession(student, deviceInfo), new Promise(r => setTimeout(r, 6000))]);
}

/* Registration ends in a Firestore WRITE, and a write promise never settles while the phone is offline.
   The allow/deny DECISION below never depends on it, so don't let it hold the app hostage. */
async function registerDeviceSafely(studentId, deviceInfo) {
  const p = createOrTouchOwnDevice(studentId, deviceInfo);
  p.catch(() => {});
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  await Promise.race([p, new Promise(resolve => setTimeout(resolve, 6000))]);
}

export class DeviceLockError extends Error {
  /* `blocked` is true only when an admin blocked THIS device (as opposed to the device-count limit).
     In that case the session is NOT ended: callers hold the user on the blocked screen instead.
     `blockMessage` is the optional reason the admin typed when blocking. */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'DeviceLockError';
    this.blocked = extra.blocked === true;
    this.blockMessage = extra.blockMessage || '';
  }
}

/* enforceDeviceLock() RETURNS { ok:false, reason } for a blocked device / exceeded device limit — it never throws.
   Callers must act on that result, so use this wrapper: it throws DeviceLockError when the device is refused. */
export async function assertDeviceAllowed(student) {
  const result = await enforceDeviceLock(student);
  if (!result || result.ok === false) {
    throw new DeviceLockError((result && result.reason) || 'This device is not allowed for this account.', {
      blocked: !!(result && result.blocked),
      blockMessage: result && result.blockMessage,
    });
  }
  return result;
}

export async function enforceDeviceLock(student) {
  const deviceInfo = await getDeviceInfo();
  const studentId = student.id || student.docId;
  // Offline: nothing can be verified. The live block-watch (cached + realtime) enforces as soon as data is available.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: true, offline: true, device: deviceInfo };

  let globalLockOn = false;
  // Only need the global setting if the student has no explicit override,
  // and even then cache it for 30 min (it almost never changes).
  if (typeof student.deviceLockEnabled !== 'boolean') {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(LS_LOCKCFG_KEY) || 'null'); } catch (e) {}
    if (cached && Date.now() - cached.t < 30 * 60 * 1000) {
      globalLockOn = cached.v === true;
    } else {
      try {
        const settingsSnap = await getDoc(doc(db, 'settings', 'forceDeviceLock'));
        if (settingsSnap.exists()) globalLockOn = settingsSnap.data().enabled === true;
        lsSet(LS_LOCKCFG_KEY, JSON.stringify({ t: Date.now(), v: globalLockOn }));
      } catch (e) {}
    }
  }

  const lockActive = student.deviceLockEnabled === true
    || (student.deviceLockEnabled !== false && globalLockOn);

  if (!lockActive) {
    await registerAndBind(student, studentId, deviceInfo);
    return { ok: true, device: deviceInfo };
  }

  // Is this physical device already known? (any of its docs, written by ANY browser on it)
  const ownSnaps = [];
  for (const ref of ownDeviceRefs(studentId, deviceInfo)) {
    try { const snap = await getDoc(ref); if (snap && snap.exists()) ownSnaps.push(snap); } catch (e) {}
  }
  const blockedSnap = ownSnaps.find(snap => snap.data().blocked);
  if (blockedSnap) {
    return {
      ok: false, blocked: true,
      reason: BLOCKED_DEFAULT_MSG,
      blockMessage: blockedSnap.data().blockMessage || '',
    };
  }
  if (ownSnaps.length) {
    // Known device. Browsers that were registered before the switch get their hardware doc created here
    // (createOrTouchOwnDevice), so every OTHER browser on this device will recognise it from now on.
    await registerAndBind(student, studentId, deviceInfo);
    return { ok: true, device: deviceInfo };
  }

  // New device for this account — count existing, non-blocked devices
  // against the account's limit before registering it.
  const maxDevices = student.maxDevices || 1;
  let activeCount = 0;
  try {
    const listSnap = await getDocs(collection(db, 'secretkeys', studentId, 'devices'));
    activeCount = countActiveDevices(listSnap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) {}

  if (activeCount >= maxDevices) {
    return {
      ok: false,
      reason: `Your account is limited to ${maxDevices} device${maxDevices === 1 ? '' : 's'} `
        + `and is already in use on another device. Ask your instructor to free up a device slot.`,
    };
  }

  await registerAndBind(student, studentId, deviceInfo);
  return { ok: true, device: deviceInfo };
}

/* ----------------------------------------------------------------------
   THE FIX: live block-watch (listener) + decoupled presence (rare write)
   ---------------------------------------------------------------------- */

const PRESENCE_INTERVAL_MS = 300_000;      // device presence: every 5 min (was 90s)
const MIN_PING_GAP_MS = 240_000;          // never ping the device doc more than once / 4 min
const STUDENT_TOUCH_INTERVAL_MS = 900_000; // student-record touch: every 15 min
const PROFILE_SEEN_GAP_MS = 540_000;       // chat presence (lastSeen on chatProfiles): at most once / 9 min (online window is 20 min)
let heartbeatVisHandler = null;

let unsubscribeBlockWatch = null;
let presenceTimer = null;
let profTouchBusy = false;

export let IS_DEVICE_BLOCKED = false;
export function setIS_DEVICE_BLOCKED(v) {
  return (IS_DEVICE_BLOCKED = v);
}

export function startHeartbeat() {
  stopHeartbeat();
  const student = getStoredStudent();
  if (!db || !student || !(student.id || student.docId) || student.guest) return;
  const studentId = student.id || student.docId;

  getDeviceInfo().then(deviceInfo => {
    // Realtime listener(s) on this device's own doc(s) - free while idle. An admin block on ANY doc of this
    // physical device (hardware doc, or the old per-browser doc) blocks every browser on it.
    const refs = ownDeviceRefs(studentId, deviceInfo);
    const watched = refs.map(() => ({ blocked: false, reason: '' }));
    const evaluateBlock = () => {
      const hit = watched.find(w => w.blocked);
      if (hit && !IS_DEVICE_BLOCKED) {
        IS_DEVICE_BLOCKED = true;
        showBlockedGate(BLOCKED_DEFAULT_MSG, hit.reason);
      } else if (hit) {
        setBlockedReason(hit.reason);     // already on the blocked screen: keep the admin's reason current
      } else if (IS_DEVICE_BLOCKED) {
        IS_DEVICE_BLOCKED = false;
        resumeFromBlockedGate();
      }
    };
    const unsubs = refs.map((ref, i) => onSnapshot(ref, snap => {
      const data = snap.exists() ? snap.data() : null;
      watched[i] = { blocked: !!data && data.blocked === true, reason: (data && data.blockMessage) || '' };
      evaluateBlock();
    }, () => {}));
    unsubscribeBlockWatch = () => unsubs.forEach(u => { try { u(); } catch (e) {} });

    // Throttled presence: only while the tab is visible, at most one device
    // write per 4 min and one student-record write per 15 min - timestamps
    // are persisted so page reloads / tab switches can't cause write bursts.
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      const current = getStoredStudent();
      if (!current || current.guest) return;
      const now = Date.now();
      if (!IS_DEVICE_BLOCKED && now - lastBindAt >= 60000) bindDeviceSession(current, deviceInfo);
      if (now - lsGetNum(LS_PING_KEY) >= MIN_PING_GAP_MS) {
        lsSet(LS_PING_KEY, now);
        pingOwnDevice(studentId, deviceInfo.deviceId);
      }
      if (!profTouchBusy && now - lsGetNum(LS_PROFSEEN_KEY) >= PROFILE_SEEN_GAP_MS) {
        profTouchBusy = true;
        touchChatProfile(studentId)
          .then(ok => lsSet(LS_PROFSEEN_KEY, ok ? Date.now() : now - PROFILE_SEEN_GAP_MS + 120000)) // failed: retry in ~2 min
          .finally(() => { profTouchBusy = false; });
      }
      if (now - lsGetNum(LS_TOUCH_KEY) >= STUDENT_TOUCH_INTERVAL_MS) {
        lsSet(LS_TOUCH_KEY, now);
        touchStudentRecord(current);
      }
    };
    ping();
    presenceTimer = setInterval(ping, PRESENCE_INTERVAL_MS);
    heartbeatVisHandler = ping;
    document.addEventListener('visibilitychange', heartbeatVisHandler);
  });
}

export function stopHeartbeat() {
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  if (unsubscribeBlockWatch) unsubscribeBlockWatch();
  unsubscribeBlockWatch = null;
  if (heartbeatVisHandler) document.removeEventListener('visibilitychange', heartbeatVisHandler);
  heartbeatVisHandler = null;
}

// Called on every showHome()/showPicker() navigation. Free: the
// onSnapshot listener above already keeps IS_DEVICE_BLOCKED current in
// real time, so this just reports that cached state — no Firestore
// call at all.
export async function verifyNotBlocked() {
  return !IS_DEVICE_BLOCKED;
}

/* ----------------------------------------------------------------------
   Blocked full-screen gate UI (unchanged behavior)
   ---------------------------------------------------------------------- */

export const blockedFullscreen = document.getElementById('blockedFullscreen');

const BLOCKED_DEFAULT_MSG = 'This device has been blocked from using Alif Med with this account.';
let blockedResumeHook = null;

function setBlockedReason(reason) {
  const text = (reason == null ? '' : String(reason)).trim();
  const box = document.getElementById('blockedReasonBox');
  const out = document.getElementById('blockedReasonText');
  if (out) out.textContent = text;
  if (box) box.classList.toggle('hidden', !text);
}

export function showBlockedGate(message, reason) {
  closeChatScreen();
  appScreen.classList.add('hidden');
  homeScreen.classList.add('hidden');
  gateScreen.classList.add('hidden');
  pickerScreen.classList.add('hidden');
  modulesScreenEl.classList.add('hidden');
  subjectsScreenEl.classList.add('hidden');
  progressScreen.classList.add('hidden');
  document.body.classList.remove('auth-gate-open');
  const msgEl = document.getElementById('blockedFullscreenMsg');
  if (msgEl) msgEl.textContent = message || BLOCKED_DEFAULT_MSG;
  setBlockedReason(reason);
  /* The overlay ships with the `hidden` class (display:none !important); it must be removed or the screen never appears. */
  blockedFullscreen.classList.remove('hidden');
  blockedFullscreen.classList.add('show');
  forceUnlockBodyScroll();
  replaceAppState('gate');
  updateBottomNavVisibility();
}

function hideBlockedGate() {
  blockedFullscreen.classList.remove('show');
  blockedFullscreen.classList.add('hidden');
}

/* Keep a signed-in user on the blocked screen WITHOUT signing them out. Used at app start and right after
   login when this device is blocked. The live watcher (startHeartbeat) lifts the screen if an admin unblocks. */
export function holdBlockedDevice(student, err, onResume) {
  storeStudent(student);
  IS_DEVICE_BLOCKED = true;
  blockedResumeHook = typeof onResume === 'function' ? onResume : null;
  showBlockedGate(BLOCKED_DEFAULT_MSG, err && err.blockMessage);
  startHeartbeat();
}

function resumeFromBlockedGate() {
  hideBlockedGate();
  const hook = blockedResumeHook;
  blockedResumeHook = null;
  try { if (hook) hook(); } catch (e) {}
  showHome({ skipHistory: true });
}

/* The user's choice from the blocked screen. Signing out only ever happens here, never automatically. */
async function leaveBlockedGate() {
  stopHeartbeat();
  IS_DEVICE_BLOCKED = false;
  blockedResumeHook = null;
  hideBlockedGate();
  await doLogout();
}

let leavingBlocked = false;
function bindBlockedButton(id, after) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (leavingBlocked) return;
    leavingBlocked = true;
    try { await leaveBlockedGate(); if (after) await after(); }
    finally { leavingBlocked = false; }
  });
}
// "Use free items": sign out of the blocked account and browse the free content as a guest.
bindBlockedButton('blockedFreeBtn');
// "Sign out": sign out and go straight to creating a new account (the blocked account stays blocked on this device).
bindBlockedButton('blockedSignOutBtn', () => openAuthGate('signup'));
