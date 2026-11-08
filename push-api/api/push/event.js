const { init, verify, isAdminToken, handler, deliver, recordInApp, notifSettings, autoEnabled, admin } = require('../../lib/common');

/* Automatic notifications.
   Student  → payment-submitted        { type, paymentId }          (caller must own the payment)
   Admin    → payment-approved | payment-rejected   { type, paymentId, unlocked? }   (reads the payment, so the text cannot be forged)
   Admin    → access-granted | access-revoked       { type, uids: [...], items: ['Anatomy', ...] }
   Each type is sent only if its own switch OR the collective switch is on (Admin → Notifications → Automatic).  */
const EVENTS = {
  'payment-submitted': 'paymentSubmitted',
  'payment-approved': 'paymentApproved',
  'payment-rejected': 'paymentRejected',
  'access-granted': 'accessGranted',
  'access-revoked': 'accessRevoked'
};
const clean = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);
const list = a => { const x = (a || []).map(v => clean(v, 40)).filter(Boolean); return x.length > 3 ? x.slice(0, 3).join(', ') + ` +${x.length - 3} more` : x.join(', '); };

module.exports = handler(async (req, res) => {
  const decoded = await verify(req);
  const { type, paymentId, uids, items, unlocked } = req.body || {};
  const key = EVENTS[type];
  if (!key) throw new Error('Unknown event');
  const st = await notifSettings();
  if (!autoEnabled(st, key)) return res.status(200).json({ ok: true, skipped: 'disabled' });

  const admin_ = isAdminToken(decoded);
  const db = admin.firestore();
  let target = [], title = '', body = '', kind = type;

  if (type === 'payment-submitted') {
    if (decoded.firebase && decoded.firebase.sign_in_provider === 'anonymous') throw new Error('Not allowed');
    const snap = await db.doc(`paymentSubmissions/${String(paymentId || '')}`).get();
    if (!snap.exists) throw new Error('Payment not found');
    const p = snap.data();
    if (p.uid !== decoded.uid) throw new Error('Not your payment');
    if (p.status !== 'pending' || p.pushSubmittedAt) return res.status(200).json({ ok: true, skipped: 'duplicate' });
    await snap.ref.update({ pushSubmittedAt: admin.firestore.FieldValue.serverTimestamp() });
    target = [p.uid];
    title = 'Payment received';
    body = `We received your payment${p.offerName ? ' for ' + clean(p.offerName, 60) : ''}. You will be notified once it is reviewed.`;
  } else {
    if (!admin_) throw new Error('Admin permission required');
    if (type === 'payment-approved' || type === 'payment-rejected') {
      const snap = await db.doc(`paymentSubmissions/${String(paymentId || '')}`).get();
      if (!snap.exists) throw new Error('Payment not found');
      const p = snap.data();
      const want = type === 'payment-approved' ? 'approved' : 'rejected';
      if (p.status !== want) throw new Error(`Payment is ${p.status}, not ${want}`);
      if (!p.uid) return res.status(200).json({ ok: true, skipped: 'no-account' });
      target = [p.uid];
      const what = p.offerName ? clean(p.offerName, 60) : 'your payment';
      if (want === 'approved') {
        title = 'Payment approved';
        body = `Your payment for ${what} was approved.` + (unlocked ? ` Unlocked: ${list(unlocked)}.` : (p.grantedTo ? ` ${clean(String(p.grantedTo).replace(/\s*\(.*$/, ''), 80)} is now unlocked.` : ''));
      } else {
        title = 'Payment rejected';
        const why = clean(p.rejectReason, 200);
        body = `Your payment for ${what} was not accepted.` + (why ? ` Reason: ${why}` : ' Please contact support or submit it again.');
      }
    } else {
      const ids = [...new Set((Array.isArray(uids) ? uids : []).map(String).filter(Boolean))].slice(0, 200);
      if (!ids.length) return res.status(200).json({ ok: true, skipped: 'no-recipients' });
      target = ids;
      const what = list(items);
      if (type === 'access-granted') { title = 'New content unlocked'; body = what ? `You now have access to: ${what}.` : 'New content was unlocked for you.'; }
      else { title = 'Access removed'; body = what ? `Your access to ${what} was withdrawn.` : 'Some of your access was withdrawn.'; }
    }
  }

  const supabase = init();
  const message = { kind: 'auto', title, body, url: '/?notifications=1', tag: `alif-${type}-${Date.now()}` };
  const r = await deliver(supabase, q => q.in('uid', target), message, { ttl: 60 * 60 * 24 * 7, urgency: 'high' });
  try { await recordInApp({ uids: target, title, body, url: '/?notifications=1', kind }); } catch (e) { console.warn('[push] in-app copy', e.message); }
  res.status(200).json({ ok: true, ...r });
});
