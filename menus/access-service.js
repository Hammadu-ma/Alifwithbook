/* ALIF Med — single-source entitlement service.
   Runtime access is derived only from /access/{uid}/resources/{resourceKey}.
   Legacy userLocks are intentionally not consulted here.
*/
import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { collection, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const auth = getAuth(getApp());
let unsubscribe = null;
let readyResolve;
export const accessReady = new Promise(resolve => { readyResolve = resolve; });
export const ACCESS = new Map();

export function resourceKey(type, id) {
  return `${String(type || '').toLowerCase()}_${String(id || '').replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v.seconds != null) return Number(v.seconds) * 1000;
  const n = Number(v); return Number.isFinite(n) ? n : 0;
}

function activeGrant(data) {
  if (!data || data.mode !== 'allow' || data.status !== 'active') return false;
  const exp = toMs(data.expiresAt);
  return !exp || exp > Date.now();
}

export function getAccess(type, id) {
  const key = resourceKey(type, id);
  const data = ACCESS.get(key);
  if (!data) return { mode: 'default', active: false, expiresAt: 0 };
  return { mode: data.mode || 'default', active: activeGrant(data), expiresAt: toMs(data.expiresAt), ...data };
}

export function hasAccess(type, id) {
  return getAccess(type, id).active;
}

export function hasDeny(type, id) {
  return getAccess(type, id).mode === 'deny' && getAccess(type, id).status === 'active';
}

export function clearAccessSubscription() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  activeUid = null;
  paused = false;
  ACCESS.clear();
}

let activeUid = null, hiddenTimer = null, paused = false;

function attachListener(uid) {
  const ref = collection(db, 'access', uid, 'resources');
  unsubscribe = onSnapshot(query(ref, where('status', '==', 'active')), snap => {
    ACCESS.clear();
    snap.forEach(d => ACCESS.set(d.id, d.data()));
    readyResolve?.();
    window.dispatchEvent(new CustomEvent('alif:access-changed'));
  }, err => {
    console.error('[access] entitlement listener failed', err);
    readyResolve?.();
  });
}

export function startAccessSubscription(uid) {
  clearAccessSubscription();
  activeUid = uid || null;
  paused = false;
  if (!uid || !db) { readyResolve?.(); return; }
  attachListener(uid);
}

/* Read-cost saver: a backgrounded app doesn't need a live listener. Detach after 3 min hidden and
   re-attach on return (persistent cache + resume token => only changed grants are billed if < 30 min). */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(() => {
      if (document.hidden && unsubscribe) { unsubscribe(); unsubscribe = null; paused = true; }
    }, 180000);
  } else {
    clearTimeout(hiddenTimer);
    if (paused && activeUid && db) { paused = false; attachListener(activeUid); }
  }
});

onAuthStateChanged(auth, user => {
  if (user?.uid && !user.isAnonymous) startAccessSubscription(user.uid);
  else clearAccessSubscription();
});
