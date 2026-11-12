const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

let supabaseClient = null;

function init() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are missing');
  }
  if (!supabaseClient) {
    supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
  }
  return supabaseClient;
}

function cors(req, res) {
  // ALIF_APP_ORIGIN may hold several origins separated by commas; the header must echo exactly one.
  const allowed = (process.env.ALIF_APP_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  const out = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Origin', out);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

async function verify(req) {
  init(); // make sure the Firebase Admin app exists before verifying
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Missing Firebase ID token');
  return admin.auth().verifyIdToken(token);
}

// Admin = custom claim (isAdmin / admin) OR uid listed in ADMIN_UIDS (comma separated).
// Neither path reads Firestore, so sending costs zero Firestore reads.
function isAdminToken(decoded) {
  if (decoded.isAdmin === true || decoded.admin === true) return true;
  const list = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(decoded.uid);
}

function handler(fn) {
  return async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    try {
      await fn(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(400).json({ error: e.message || 'Request failed' });
    }
  };
}

// uid -> { studentId, name } from users/{uid}. One Firestore read, then cached for the life of the function instance.
const profileCache = new Map();
async function profileOf(uid) {
  const hit = profileCache.get(uid);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  const snap = await admin.firestore().doc(`users/${uid}`).get();
  const d = snap.exists ? snap.data() : {};
  const v = { studentId: d.studentId || null, name: d.name || 'Classmate', active: d.role === 'student' && d.status === 'active' };
  profileCache.set(uid, { t: Date.now(), v });
  return v;
}

/* ---- notification settings (Firestore settings/notifications, edited from Admin → Notifications) ----
   { autoAll: bool, events: { paymentSubmitted, paymentApproved, paymentRejected, accessGranted, accessRevoked } }
   An automatic notification is sent when its own switch is on OR the collective switch (autoAll) is on. */
let settingsCache = { t: 0, v: null };
async function notifSettings(force) {
  if (!force && settingsCache.v && Date.now() - settingsCache.t < 30 * 1000) return settingsCache.v;
  let v = { autoAll: false, events: {} };
  try {
    const snap = await admin.firestore().doc('settings/notifications').get();
    if (snap.exists) { const d = snap.data() || {}; v = { autoAll: d.autoAll === true, events: d.events || {} }; }
  } catch (e) { console.warn('[push] settings read', e.message); }
  settingsCache = { t: Date.now(), v };
  return v;
}
const autoEnabled = (st, key) => st.autoAll === true || (st.events && st.events[key] === true);

/* Send one payload to every matching subscription row. `apply(q)` narrows the Supabase query. */
const webpush = require('web-push');
async function deliver(supabase, apply, payloadObj, { budgetMs = 50000, ttl = 60 * 60 * 24 * 3, urgency = 'high' } = {}) {
  const started = Date.now();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({ icon: '/logo.png', badge: '/logo.png', ...payloadObj });
  const PAGE = 1000, CONC = 50;
  let sent = 0, failed = 0, total = 0, partial = false;
  const gone = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('push_subscriptions').select('id,uid,subscription').order('id', { ascending: true });
    q = apply(q);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    total += data.length;
    for (let i = 0; i < data.length; i += CONC) {
      if (Date.now() - started > budgetMs) { partial = true; break; }
      const chunk = data.slice(i, i + CONC);
      const results = await Promise.allSettled(chunk.map(r => webpush.sendNotification(r.subscription, payload, { TTL: ttl, ...(urgency ? { urgency } : {}) })));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') sent++;
        else if (r.reason && (r.reason.statusCode === 404 || r.reason.statusCode === 410)) gone.push(chunk[idx].id);
        else { failed++; console.warn('[push]', chunk[idx].uid, r.reason && r.reason.statusCode, r.reason && r.reason.message); }
      });
    }
    if (partial || data.length < PAGE) break;
  }
  let removed = 0;
  for (let i = 0; i < gone.length; i += 200) {
    const ids = gone.slice(i, i + 200);
    const { error } = await supabase.from('push_subscriptions').delete().in('id', ids);
    if (!error) removed += ids.length;
  }
  return { sent, failed, removed, total, partial };
}

/* In-app copy (Notifications page): one small doc per 400 recipients, readable only by the uids it lists. */
async function recordInApp({ uids, title, body, url, kind }) {
  const list = [...new Set((uids || []).filter(Boolean))];
  if (!list.length) return 0;
  const db = admin.firestore();
  const ym = new Date().toISOString().slice(0, 7);
  let n = 0;
  for (let i = 0; i < list.length; i += 400) {
    await db.collection('userNotifications').add({
      uids: list.slice(i, i + 400), title: String(title).slice(0, 100), body: String(body).slice(0, 500),
      url: url || '/', kind: kind || 'segment', ym, createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    n++;
  }
  return n;
}

module.exports = { init, verify, isAdminToken, handler, profileOf, admin, notifSettings, autoEnabled, deliver, recordInApp };
