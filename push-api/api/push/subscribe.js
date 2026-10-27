const { init, verify, handler } = require('../../lib/common');

module.exports = handler(async (req, res) => {
  const decoded = await verify(req);
  if (decoded.firebase?.sign_in_provider === 'anonymous') throw new Error('Anonymous accounts cannot subscribe');
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid PushSubscription');
  const supabase = init();
  // endpoint is unique: if another account logs in on the same device, the row moves to that uid.
  const { error } = await supabase.from('push_subscriptions').upsert(
    { uid: decoded.uid, endpoint: sub.endpoint, subscription: sub, updated_at: new Date().toISOString() },
    { onConflict: 'endpoint' }
  );
  if (error) throw error;
  res.status(200).json({ ok: true });
});
