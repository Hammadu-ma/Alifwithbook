const webpush = require('web-push');
const { init, verify, isAdminToken, handler } = require('../../lib/common');

const PAGE = 1000;          // Supabase/PostgREST returns at most 1000 rows per request
const CONCURRENCY = 50;     // parallel pushes per batch
const BUDGET_MS = 50_000;   // stop before the Vercel function limit (maxDuration 60s)

module.exports = handler(async (req, res) => {
  const started = Date.now();
  const decoded = await verify(req);
  if (!isAdminToken(decoded)) {
    throw new Error('Admin permission required. Add this account UID to ADMIN_UIDS (or set the isAdmin custom claim).');
  }
  const { title, body, url, targetUid } = req.body || {};
  if (!title || !body) throw new Error('Title and body are required');

  const supabase = init();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({
    title: String(title).slice(0, 100),
    body: String(body).slice(0, 500),
    url: url || '/',
    icon: '/logo.png',
    badge: '/logo.png',
    tag: `alif-${Date.now()}`
  });

  let sent = 0, failed = 0, total = 0, partial = false;
  const gone = [];

  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('push_subscriptions').select('id,uid,subscription').order('id', { ascending: true });
    if (targetUid && targetUid !== 'ALL') q = q.eq('uid', targetUid);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    total += data.length;

    for (let i = 0; i < data.length; i += CONCURRENCY) {
      if (Date.now() - started > BUDGET_MS) { partial = true; break; }
      const chunk = data.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(row => webpush.sendNotification(row.subscription, payload, { TTL: 60 * 60 * 24 * 3 }))
      );
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') sent++;
        else if (r.reason?.statusCode === 404 || r.reason?.statusCode === 410) gone.push(chunk[idx].id);
        else { failed++; console.warn('[push]', chunk[idx].uid, r.reason?.statusCode, r.reason?.message); }
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

  res.status(200).json({ ok: true, sent, failed, removed, total, partial });
});
