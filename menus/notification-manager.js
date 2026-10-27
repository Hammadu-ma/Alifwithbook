/* ALIF Med — zero-Firestore-read Web Push notifications.
 *
 * Notifications are delivered through the browser Push API. Firebase/Firestore
 * is NOT used for notification delivery, history, listeners, or subscriptions.
 * The only Firebase call is getIdToken() so the external push API can associate
 * a subscription with the already-authenticated ALIF user.
 *
 * NOTE: The in-app bell icon / panel UI has been removed. Push subscription
 * still runs automatically when the browser has already granted permission.
 */
import { getAuthInstance, waitForAuthReady } from './auth.js';

const API_BASE = (window.ALIF_PUSH_API_BASE || '').replace(/\/$/, '');
const VAPID_PUBLIC_KEY = window.ALIF_VAPID_PUBLIC_KEY || '';
const ENABLE_KEY = 'alif_browser_notifications_v2';
let currentUser = null;
let initialized = false;
let registration = null;

const enabled = () => localStorage.getItem(ENABLE_KEY) === '1';
function setEnabled(v){ localStorage.setItem(ENABLE_KEY, v ? '1' : '0'); }

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4),
        base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/'),
        raw=atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

async function authHeaders(){
  if(!currentUser) throw new Error('You must be signed in.');
  const token = await currentUser.getIdToken();
  return {'Content-Type':'application/json','Authorization':`Bearer ${token}`};
}

async function api(path, body){
  if(!API_BASE) throw new Error('Push API is not configured.');
  const r = await fetch(`${API_BASE}${path}`, {
    method:'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || `Push API error (${r.status})`);
  return data;
}

async function ensureSubscription(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Web Push is not supported by this browser.');
  if(!API_BASE || !VAPID_PUBLIC_KEY || /YOUR[-_]/i.test(API_BASE + VAPID_PUBLIC_KEY)) throw new Error('Web Push is not configured yet.');
  if(location.protocol !== 'https:' && location.hostname !== 'localhost') throw new Error('Notifications require HTTPS.');
  registration = registration || await navigator.serviceWorker.register('/sw.js',{scope:'/'});
  await navigator.serviceWorker.ready;
  let sub = await registration.pushManager.getSubscription();
  if(!sub) sub = await registration.pushManager.subscribe({
    userVisibleOnly:true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });
  await api('/api/push/subscribe', { subscription: sub.toJSON() });
  return sub;
}

async function start(user){
  currentUser = user;
  if(initialized) return;
  initialized = true;
  // Silently (re)register push if the browser has already granted permission.
  if('Notification' in window && Notification.permission === 'granted'){
    try {
      await ensureSubscription();
      setEnabled(true);
    } catch(e){
      console.warn('[ALIF push] register:', e);
    }
  }
}

/* Called by signOutStudent() BEFORE Firebase sign-out, while the ID token is still valid.
   Removes this device's subscription from the push server so a logged-out device stops receiving pushes. */
window.__alifPushBeforeSignOut = async () => {
  try {
    if(!currentUser || !('serviceWorker' in navigator)) return;
    const reg = registration || await navigator.serviceWorker.getRegistration('/');
    const sub = reg && await reg.pushManager.getSubscription();
    if(sub){
      try { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); }
      catch(e){ console.warn('[ALIF push] unsubscribe:', e); }
      try { await sub.unsubscribe(); } catch(_){}
    }
    setEnabled(false);
  } catch(e){
    console.warn('[ALIF push] sign-out cleanup:', e);
  }
};

function stop(){
  currentUser = null;
  initialized = false;
  registration = null;
}

export async function initNotifications(){
  const auth = getAuthInstance();
  const user = await waitForAuthReady();
  if(user && !user.isAnonymous) await start(user);
  auth.onAuthStateChanged?.(u => {
    if(u && !u.isAnonymous) start(u);
    else stop();
  });
}

initNotifications().catch(e => console.warn('[ALIF push] init:', e));
