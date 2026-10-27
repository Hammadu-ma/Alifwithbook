/* Firebase Auth identity bridge.
   This file keeps the old import name for compatibility, but NEVER creates an
   anonymous account. A null UID means the app is in guest mode. */
import './firebase-config.js';   // must run first: it calls initializeApp(), which getApp() below depends on
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const auth = getAuth(getApp());
let authUid = auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.uid : null;
let readyResolve;
const readyPromise = new Promise(resolve => { readyResolve = resolve; });

onAuthStateChanged(auth, user => {
  authUid = user && !user.isAnonymous ? user.uid : null;
  readyResolve(authUid);
});

export function getAuthUid() {
  return auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.uid : authUid || null;
}

export async function getAuthUidAsync() {
  await readyPromise;
  return auth.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.uid : authUid || null;
}

export function isFirebaseAuthenticated() {
  return !!getAuthUid();
}
