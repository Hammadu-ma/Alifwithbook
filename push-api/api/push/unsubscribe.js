const { init, verify, handler } = require('../../lib/common');

module.exports = handler(async (req, res) => {
  const decoded = await verify(req);
  const endpoint = req.body?.endpoint;
  if (!endpoint || typeof endpoint !== 'string') throw new Error('endpoint is required');
  const supabase = init();
  // Only the owner of the subscription can remove it.
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('uid', decoded.uid);
  if (error) throw error;
  res.status(200).json({ ok: true });
});
