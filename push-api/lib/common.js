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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALIF_APP_ORIGIN || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

async function verify(req) {
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
    cors(res);
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

module.exports = { init, verify, isAdminToken, handler };
