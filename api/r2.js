/* Vercel serverless function: Cloudflare R2 storage for books, notes, PDF exams, videos and thumbnails.
   No dependencies: S3 SigV4 presigning is done with node:crypto. Secrets never reach the browser.

   Environment variables (Vercel → Project → Settings → Environment Variables):
     R2_ACCOUNT_ID         Cloudflare account id
     R2_ACCESS_KEY_ID      R2 S3 Access Key ID
     R2_SECRET_ACCESS_KEY  R2 S3 Secret Access Key
     R2_BUCKET             bucket name (e.g. abooks)
     FIREBASE_WEB_API_KEY  already used by /api/telegram-receipt (verifies the admin's ID token)

   Endpoints
     GET  /api/r2?key=books/<file>          302 → short-lived signed download URL (used as the stored file URL)
     POST /api/r2 {action:'upload', folder, fileName, contentType, size}   admin only → { uploadUrl, key, url }
     POST /api/r2 {action:'delete', key}                                    admin only
     POST /api/r2 {action:'avatar-upload', size}   signed-in (non-anonymous) → { uploadUrl, key, url }
     POST /api/r2 {action:'avatar-delete', key}    only your own avatars/<uid>_… objects
*/
const crypto = require('node:crypto');

const FIREBASE_PROJECT = 'exam-d9415';
const FOLDERS = ['books', 'notes', 'pdfexams', 'videos', 'thumbs'];
const KEY_RE = /^(books|notes|pdfexams|videos|thumbs|avatars)\/[A-Za-z0-9._-]{1,220}$/;
const MAX_BYTES = 600 * 1024 * 1024;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = data => crypto.createHash('sha256').update(data).digest('hex');
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

const clean = v => String(v == null ? '' : v).replace(/\s+/g, '');   // pasted env values often carry a trailing newline
function cfg() {
  const c = {
    account: clean(process.env.R2_ACCOUNT_ID), ak: clean(process.env.R2_ACCESS_KEY_ID),
    sk: clean(process.env.R2_SECRET_ACCESS_KEY), bucket: clean(process.env.R2_BUCKET)
  };
  return c.account && c.ak && c.sk && c.bucket ? c : null;
}

/* SigV4 query-string presign (path-style, region "auto", payload unsigned) */
function presign(c, method, key, expires) {
  const host = `${c.account}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');           // 20260101T000000Z
  const day = amz.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const uri = '/' + enc(c.bucket) + '/' + key.split('/').map(enc).join('/');
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.ak}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host'
  };
  const query = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = [method, uri, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac('AWS4' + c.sk, day), kReg = hmac(kDate, 'auto'), kSvc = hmac(kReg, 's3');
  const sig = crypto.createHmac('sha256', hmac(kSvc, 'aws4_request')).update(toSign).digest('hex');
  return `https://${host}${uri}?${query}&X-Amz-Signature=${sig}`;
}

async function verifyToken(req) {
  const authz = req.headers.authorization || '';
  const idToken = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!idToken) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Server is not configured (FIREBASE_WEB_API_KEY)'), { status: 503 });

  const v = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  const data = await v.json().catch(() => ({}));
  const user = data && data.users && data.users[0];
  if (!v.ok || !user || !user.localId) throw Object.assign(new Error('Invalid authentication token'), { status: 401 });
  return { uid: user.localId, email: user.email || '', idToken };
}

async function adminOnly(req, who) {
  const { uid, idToken } = who || await verifyToken(req);
  // The caller's own admin document, read with THEIR token, so Firestore rules decide (non-admins get 403).
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/admin/${encodeURIComponent(uid)}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!r.ok) throw Object.assign(new Error('Admin permission required'), { status: 403 });
  const f = (await r.json()).fields || {};
  const role = f.role && f.role.stringValue;
  const perms = (f.permissions && f.permissions.mapValue && f.permissions.mapValue.fields) || {};
  const ok = role === 'owner' || (perms.resources && perms.resources.booleanValue === true) || (perms.programaccess && perms.programaccess.booleanValue === true);
  if (!ok) throw Object.assign(new Error('You need the AResources permission to upload files'), { status: 403 });
  return uid;
}

const safeName = n => String(n || 'file').normalize('NFKD').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'file';

module.exports = async function handler(req, res) {
  const c = cfg();
  try {
    if (req.method === 'GET') {
      const key = String((req.query && req.query.key) || '');
      if (!KEY_RE.test(key) || key.includes('..')) return res.status(400).json({ error: 'Invalid key' });
      if (!c) return res.status(503).json({ error: 'File storage is not configured' });
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Location', presign(c, 'GET', key, 3600));
      return res.status(302).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Cache-Control', 'no-store');
    if (!c) return res.status(503).json({ error: 'File storage is not configured' });
    const who = await verifyToken(req);
    const b = req.body || {};

    // ---- profile photos: any signed-in account with an email (anonymous guests are refused) ----
    if (b.action === 'avatar-upload') {
      if (!who.email) return res.status(403).json({ error: 'Sign in to set a profile photo' });
      if (!(Number(b.size) > 0) || Number(b.size) > 1024 * 1024) return res.status(413).json({ error: 'Photo is too large' });
      const key = `avatars/${who.uid}_${crypto.randomBytes(5).toString('hex')}.jpg`;
      return res.status(200).json({ ok: true, key, uploadUrl: presign(c, 'PUT', key, 300), url: `/api/r2?key=${encodeURIComponent(key)}` });
    }
    if (b.action === 'avatar-delete') {
      const key = String(b.key || '');
      if (!KEY_RE.test(key) || !key.startsWith(`avatars/${who.uid}_`)) return res.status(403).json({ error: 'Not your photo' });
      const r = await fetch(presign(c, 'DELETE', key, 300), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) return res.status(502).json({ error: `Storage delete failed (${r.status})` });
      return res.status(200).json({ ok: true });
    }

    await adminOnly(req, who);
    if (b.action === 'upload') {
      const folder = FOLDERS.includes(b.folder) ? b.folder : null;
      if (!folder) return res.status(400).json({ error: 'Invalid folder' });
      if (!(Number(b.size) > 0) || Number(b.size) > MAX_BYTES) return res.status(413).json({ error: 'File is too large (max 600 MB)' });
      const key = `${folder}/${crypto.randomBytes(6).toString('hex')}_${safeName(b.fileName)}`;
      return res.status(200).json({ ok: true, key, uploadUrl: presign(c, 'PUT', key, 900), url: `/api/r2?key=${encodeURIComponent(key)}` });
    }
    if (b.action === 'delete') {
      const key = String(b.key || '');
      if (!KEY_RE.test(key) || key.includes('..')) return res.status(400).json({ error: 'Invalid key' });
      const r = await fetch(presign(c, 'DELETE', key, 300), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) return res.status(502).json({ error: `Storage delete failed (${r.status})` });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Request failed' });
  }
};
