const webpush = require('web-push');
const { init, verify, handler, profileOf, admin } = require('../../lib/common');

/* Chat message notification. Called by the sender's app right after a private / group message is saved.
   Everything is verified server-side: the caller must be an active student who is a member of the chat.
   Recipients are found through Supabase (student_id column), so it costs about 1-2 Firestore reads per message
   (chat membership; the sender's profile is cached in memory). */
const memberCache = new Map(); // "private:<id>" | "group:<id>" -> { t, ids }

async function membersOf(kind, chatId) {
  const key = `${kind}:${chatId}`;
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.ids;
  const col = kind === 'private' ? 'privateChats' : 'chatGroups';
  const snap = await admin.firestore().doc(`${col}/${chatId}`).get();
  let ids = null;
  if (snap.exists) ids = (kind === 'private' ? snap.data().participantIds : snap.data().memberIds) || [];
  else if (kind === 'private') ids = String(chatId).split('_');   // chat document is created together with the first message
  if (!ids) throw new Error('Chat not found');
  memberCache.set(key, { t: Date.now(), ids });
  if (memberCache.size > 500) memberCache.delete(memberCache.keys().next().value);
  return ids;
}

const clean = (t, n) => String(t || '').replace(/[*_`#>~\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = handler(async (req, res) => {
  const decoded = await verify(req);
  if (decoded.firebase?.sign_in_provider === 'anonymous') throw new Error('Not allowed');
  const { kind, chatId, text, groupName } = req.body || {};
  if (!['private', 'group'].includes(kind) || !chatId || typeof chatId !== 'string' || chatId.length > 200) throw new Error('Invalid request');

  const me = await profileOf(decoded.uid);
  if (!me.active || !me.studentId) throw new Error('Not an active student');
  const members = await membersOf(kind, chatId);
  if (!members.includes(me.studentId)) throw new Error('Not a member of this chat');
  const recipients = members.filter(id => id !== me.studentId).slice(0, 200);
  if (!recipients.length) return res.status(200).json({ ok: true, sent: 0 });

  const supabase = init();
  const { data, error } = await supabase.from('push_subscriptions').select('id,subscription').in('student_id', recipients).limit(1000);
  if (error) throw error;
  if (!data || !data.length) return res.status(200).json({ ok: true, sent: 0 });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const body = clean(text, 140) || 'Sent you a message';
  const payload = JSON.stringify({
    kind: 'chat',
    title: kind === 'group' ? `${clean(groupName, 40) || 'Group'} · ${clean(me.name, 30)}` : clean(me.name, 40),
    body,
    url: `/?chat=${kind}:${encodeURIComponent(chatId)}`,
    icon: '/logo.png',
    badge: '/logo.png',
    tag: `alif-chat-${kind}-${chatId}`
  });

  let sent = 0;
  const gone = [];
  const results = await Promise.allSettled(data.map(r => webpush.sendNotification(r.subscription, payload, { TTL: 60 * 60 * 24, urgency: 'high' })));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sent++;
    else if (r.reason?.statusCode === 404 || r.reason?.statusCode === 410) gone.push(data[i].id);
  });
  if (gone.length) await supabase.from('push_subscriptions').delete().in('id', gone);
  res.status(200).json({ ok: true, sent, removed: gone.length });
});
