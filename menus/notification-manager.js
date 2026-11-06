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

/* ---------- message notifications ---------- */
const BANNER_DISMISS_KEY = 'alif_push_banner_dismissed';
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!API_BASE && !!VAPID_PUBLIC_KEY && !/YOUR[-_]/i.test(API_BASE + VAPID_PUBLIC_KEY);

export async function enableNotifications(){
  if(!supported()) throw new Error('Notifications are not supported on this device. On iPhone, add ALIF to your Home Screen first.');
  if(!currentUser) throw new Error('Sign in first.');
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if(perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.');
  await ensureSubscription();
  setEnabled(true);
  return true;
}
export const notificationStatus = () => !('Notification' in window) ? 'unsupported' : Notification.permission === 'granted' && enabled() ? 'on' : Notification.permission;

let lastSent = 0;
function notifyMessage(info){
  try{
    if(!currentUser || !API_BASE || notificationStatus() === 'unsupported') return;
    api('/api/push/message', info).catch(e => console.warn('[ALIF push] message:', e.message));
  }catch(_){}
}
window.__alifPush = { enable: enableNotifications, status: notificationStatus, notifyMessage };

/* Soft prompt under the chat header (a browser permission request needs a tap). */
function mountChatPrompt(){
  const chat = document.getElementById('chatScreen');
  if(!chat || !supported()) return;
  if(!document.getElementById('alifPushCss')){
    const st = document.createElement('style'); st.id = 'alifPushCss';
    st.textContent = `.alif-pushbar{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 70px);z-index:2000;width:min(380px,calc(100vw - 24px));display:flex;align-items:center;gap:12px;padding:10px 10px 10px 12px;border-radius:18px;background:color-mix(in srgb,var(--card,#fff) 94%,transparent);color:var(--ink,#111);border:1px solid var(--card-border,rgba(0,0,0,.08));box-shadow:0 14px 34px -14px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);font:600 13.5px/1.25 Inter,system-ui,sans-serif;transform:translate(-50%,-14px);opacity:0;transition:transform .4s cubic-bezier(.2,.9,.3,1.1),opacity .3s}
.alif-pushbar.in{transform:translate(-50%,0);opacity:1}.alif-pushbar .ic{flex:none;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--primary,#0070f3);background:color-mix(in srgb,var(--primary,#0070f3) 12%,transparent)}
.alif-pushbar .tx{flex:1;min-width:0}.alif-pushbar small{display:block;font-weight:500;opacity:.6;font-size:11.5px;margin-top:1px}
.alif-pushbar .go{border:0;border-radius:999px;padding:8px 14px;font:inherit;font-weight:700;background:var(--primary,#0070f3);color:#fff;cursor:pointer}
.alif-pushbar .x{border:0;background:transparent;color:inherit;opacity:.5;width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:16px}`;
    document.head.appendChild(st);
  }
  const show = () => {
    if(chat.classList.contains('hidden') || document.querySelector('.alif-pushbar')) return;
    if(Notification.permission !== 'default') return;
    try{ if(localStorage.getItem(BANNER_DISMISS_KEY) && Date.now() - Number(localStorage.getItem(BANNER_DISMISS_KEY)) < 3*864e5) return; }catch(_){}
    const bar = document.createElement('div'); bar.className = 'alif-pushbar'; bar.setAttribute('role','status');
    bar.innerHTML = '<span class="ic"><i class="fa-solid fa-bell"></i></span><span class="tx">Get message notifications<small>Know when a classmate writes to you</small></span><button type="button" class="go">Turn on</button><button type="button" class="x" aria-label="Not now">&times;</button>';
    const off = () => { bar.classList.remove('in'); setTimeout(() => bar.remove(), 350); };
    bar.querySelector('.x').onclick = () => { try{ localStorage.setItem(BANNER_DISMISS_KEY, String(Date.now())); }catch(_){} off(); };
    bar.querySelector('.go').onclick = async () => { try{ await enableNotifications(); }catch(e){ console.warn('[ALIF push]', e.message); } off(); };
    document.body.appendChild(bar);
    requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('in')));
  };
  new MutationObserver(() => { if(chat.classList.contains('hidden')) document.querySelector('.alif-pushbar')?.remove(); else setTimeout(show, 600); }).observe(chat, { attributes:true, attributeFilter:['class'] });
}
mountChatPrompt();

/* Tapping a message notification opens the app with ?chat=…  -> jump to the chat list. */
async function openFromNotification(){
  try{
    const p = new URLSearchParams(location.search);
    if(!p.get('chat')) return;
    history.replaceState(null, '', location.pathname);
    const m = await import('./class-chat.js');
    m.openChatScreen('people');
  }catch(e){ console.warn('[ALIF push] open chat:', e); }
}

async function start(user){
  currentUser = user;
  if(initialized) return;
  initialized = true;
  setTimeout(openFromNotification, 1200);
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
