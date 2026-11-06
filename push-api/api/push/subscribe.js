const { init, verify, handler, profileOf } = require('../../lib/common');

module.exports = handler(async (req, res) => {
  const decoded = await verify(req);
  if (decoded.firebase?.sign_in_provider === 'anonymous') throw new Error('Anonymous accounts cannot subscribe');
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid PushSubscription');
  const supabase = init();

  // The student this device belongs to (used to route message notifications). Resolved server-side, never trusted from the client.
  let studentId = null;
  try { studentId = (await profileOf(decoded.uid)).studentId; } catch (e) { console.warn('[push] profile lookup', e.message); }

  const row = { uid: decoded.uid, endpoint: sub.endpoint, subscription: sub, updated_at: new Date().toISOString() };
  // endpoint is unique: if another account logs in on the same device, the row moves to that uid.
  let { error } = await supabase.from('push_subscriptions').upsert({ ...row, student_id: studentId }, { onConflict: 'endpoint' });
  if (error && /student_id/i.test(error.message || '')) {
    // schema.sql has not been re-run yet: keep admin broadcasts working without message routing.
    ({ error } = await supabase.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' }));
  }
  if (error) throw error;
  res.status(200).json({ ok: true, messages: !!studentId });
});
