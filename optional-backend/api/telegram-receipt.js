
function applyCors(req, res) {
  const allowed = process.env.ALIF_ALLOWED_ORIGIN || '*';
  const origin = req.headers.origin || '';
  if (allowed !== '*' && origin && origin !== allowed) {
    res.statusCode = 403;
    res.json({ error: 'Origin not allowed' });
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', allowed === '*' ? (origin || '*') : allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return false; }
  return true;
}
export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authz = req.headers.authorization || '';
  const idToken = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ error: 'Authentication required' });

  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!apiKey || !botToken || !chatId) {
    return res.status(503).json({ error: 'Receipt service is not configured' });
  }

  // Ask Firebase Identity Toolkit to validate the Firebase ID token. This avoids
  // shipping a service-account key to the public app and works without the
  // firebase-admin package.
  let account;
  try {
    const verify = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    const data = await verify.json();
    account = data?.users?.[0];
    if (!verify.ok || !account?.localId) throw new Error('Invalid Firebase ID token');
  } catch (_) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  const body = req.body || {};
  if (!body.base64 || !body.fileName) return res.status(400).json({ error: 'Receipt file is required' });
  if (typeof body.base64 !== 'string' || body.base64.length > 7_000_000) {
    return res.status(413).json({ error: 'Receipt is too large' });
  }

  try {
    const buffer = Buffer.from(body.base64, 'base64');
    const safeName = String(body.fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'receipt.jpg';
    const mime = /^image\/(jpeg|png|webp|gif)$/.test(body.mimeType || '') ? body.mimeType : 'image/jpeg';
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', [
      '🧾 New payment submission',
      `Item: ${body.offer?.name || '—'} (${body.offer?.type || 'package'})`,
      `Amount: ${body.offer?.price || '—'}`,
      `Sender: ${body.senderName || '—'}`,
      body.bankAccount ? `Sent to: ${body.bankAccount.bankName || ''} · ${body.bankAccount.accountNumber || ''}` : null,
      `Student: ${body.studentName || 'Unknown'}${body.studentId ? ` (${body.studentId})` : ''}`,
      `Firebase UID: ${account.localId}`
    ].filter(Boolean).join('\n'));
    form.append('photo', new Blob([buffer], { type: mime }), safeName);

    const tg = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form });
    const result = await tg.json();
    if (!tg.ok || !result?.ok) throw new Error(result?.description || 'Telegram rejected the receipt');
    const photos = result.result?.photo || [];
    const largest = photos.length ? photos[photos.length - 1] : null;
    return res.status(200).json({
      telegramFileId: largest?.file_id || null,
      telegramMessageId: result.result?.message_id || null
    });
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Receipt delivery failed' });
  }
}
