const { init, verify, isAdminToken, handler, deliver, recordInApp } = require('../../lib/common');

/* Admin broadcast.
     targetUid: 'ALL' | <auth uid>           (the original behaviour)
     uids: [auth uid, ...]                    a segment resolved by the admin page (batch / module owners / bundle owners / ...)
   Segment sends also leave an in-app copy for each recipient (Notifications page). */
const MAX_UIDS = 20000;

module.exports = handler(async (req, res) => {
  const decoded = await verify(req);
  if (!isAdminToken(decoded)) {
    throw new Error('Admin permission required. Add this account UID to ADMIN_UIDS (or set the isAdmin custom claim).');
  }
  const { title, body, url, targetUid, uids, segmentLabel } = req.body || {};
  if (!title || !body) throw new Error('Title and body are required');
  const supabase = init();
  const message = { title: String(title).slice(0, 100), body: String(body).slice(0, 500), url: url || '/', tag: `alif-${Date.now()}` };

  if (Array.isArray(uids)) {
    const list = [...new Set(uids.map(String).filter(Boolean))];
    if (!list.length) return res.status(200).json({ ok: true, sent: 0, failed: 0, removed: 0, total: 0, recipients: 0 });
    if (list.length > MAX_UIDS) throw new Error(`Segment too large (${list.length}). Maximum is ${MAX_UIDS}.`);
    let sent = 0, failed = 0, removed = 0, total = 0, partial = false;
    for (let i = 0; i < list.length; i += 300) {                       // .in() filters stay small
      const part = list.slice(i, i + 300);
      const r = await deliver(supabase, q => q.in('uid', part), message, { budgetMs: 50000 - 0 });
      sent += r.sent; failed += r.failed; removed += r.removed; total += r.total; partial = partial || r.partial;
      if (partial) break;
    }
    let saved = 0;
    try { saved = await recordInApp({ uids: list, title, body, url, kind: 'segment' }); } catch (e) { console.warn('[push] in-app copy', e.message); }
    return res.status(200).json({ ok: true, sent, failed, removed, total, partial, recipients: list.length, inApp: saved > 0, label: segmentLabel || '' });
  }

  const r = await deliver(supabase, q => (targetUid && targetUid !== 'ALL' ? q.eq('uid', targetUid) : q), message);
  res.status(200).json({ ok: true, ...r });
});
