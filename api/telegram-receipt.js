/* Vercel serverless function: forwards a student's payment receipt to the admin Telegram chat.
   The bot token never reaches the browser (Firestore rules block students from reading settings/telegram).

   Required environment variables (Vercel → Project → Settings → Environment Variables):
     TELEGRAM_BOT_TOKEN     bot token from @BotFather
     TELEGRAM_CHAT_ID       chat / channel id that receives receipts
     FIREBASE_WEB_API_KEY   the web apiKey from your Firebase config (used to verify the student's ID token)
*/
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authz = req.headers.authorization || '';
  const idToken = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ error: 'Authentication required' });

  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!apiKey || !botToken || !chatId) return res.status(503).json({ error: 'Receipt service is not configured' });

  let account;
  try {
    const verify = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
    });
    const data = await verify.json();
    account = data && data.users && data.users[0];
    if (!verify.ok || !account || !account.localId) throw new Error('bad token');
  } catch (_) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  const b = req.body || {};
  if (!b.base64 || typeof b.base64 !== 'string' || !b.fileName) return res.status(400).json({ error: 'Receipt file is required' });
  if (b.base64.length > 6_000_000) return res.status(413).json({ error: 'Receipt is too large' });

  try {
    const buffer = Buffer.from(b.base64, 'base64');
    const safeName = String(b.fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'receipt.jpg';
    const mime = /^image\/(jpeg|png|webp)$/.test(b.mimeType || '') ? b.mimeType : 'image/jpeg';
    const offer = b.offer || {}, bank = b.bankAccount || {};
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
    const caption = [
      '🪙 New payment submission',
      '━━━━━━━━━━━━━━━━━━━━',
      `Program: ${offer.name || '—'}`,
      `Type: ${offer.type || 'package'}`,
      `Amount: ${offer.price || '—'}`,
      `Bank: ${bank.bankName || '—'}`,
      `Account holder: ${bank.accountName || '—'}`,
      `Account: ${bank.accountNumber || '—'}`,
      `Sender name: ${b.senderName || '—'}`,
      `Student name: ${b.studentName || 'Unknown'}`,
      `Student ID: ${b.studentId || 'Not available'}`,
      b.batch ? `Batch: ${b.batch}` : null,
      b.email ? `Email: ${b.email}` : null,
      'Status: Pending review',
      `Submitted: ${when}`,
      `Firebase UID: ${account.localId}`
    ].filter(Boolean).join('\n').slice(0, 1000);

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('photo', new Blob([buffer], { type: mime }), safeName);
    const tg = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form });
    const result = await tg.json();
    if (!tg.ok || !result || !result.ok) throw new Error((result && result.description) || 'Telegram rejected the receipt');
    const photos = (result.result && result.result.photo) || [];
    const largest = photos.length ? photos[photos.length - 1] : null;
    return res.status(200).json({
      telegramFileId: largest ? largest.file_id : null,
      telegramMessageId: result.result ? result.result.message_id : null
    });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || 'Receipt delivery failed' });
  }
};
