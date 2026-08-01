/*
 * Cooud webhook receiver.
 *
 * Cooud signs every webhook with HMAC-SHA256 over the raw body using your
 * webhook signing secret (created in Dashboard > Store > Integrations >
 * Webhooks). The signature is delivered in the `Cooud-Signature` header as
 *   `t=<unix>,v1=<hex>`
 * — same shape Stripe uses. We verify with a timing-safe compare and only
 * fire side effects when the signature checks out.
 *
 * Environment variable:
 *   COOUD_WEBHOOK_SECRET — the `whsec_*` string from the dashboard
 *
 * As with the WayMB integration, this endpoint always returns HTTP 200 — even
 * on bad payloads — to avoid Cooud's retry+suspend escalation. Bad payloads
 * are logged with `ignored:true` so you can spot them in Vercel logs.
 */

const crypto = require('crypto');
const { sendServerEvent } = require('./tt');

const WEBHOOK_SECRET = process.env.COOUD_WEBHOOK_SECRET || '';
const SIG_TOLERANCE_S = 5 * 60; // 5 minutes

// Dedupe Purchase between webhook and status polling.
const purchaseFired = new Map();
function alreadyFired(id) {
  const now = Date.now();
  for (const [k, t] of purchaseFired) {
    if (now - t > 60 * 60 * 1000) purchaseFired.delete(k);
  }
  return purchaseFired.has(id);
}
function markFired(id) { purchaseFired.set(id, Date.now()); }

function readRawBody(req) {
  return new Promise((resolve) => {
    let data = '';
    try {
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(data));
      setTimeout(() => resolve(data), 5000);
    } catch (e) {
      resolve('');
    }
  });
}

function parseSignatureHeader(header) {
  // "t=1700000000,v1=hex,v1=hex2"
  const out = { t: null, v1: [] };
  if (!header) return out;
  for (const part of String(header).split(',')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    if (k.trim() === 't') out.t = parseInt(v.trim(), 10);
    else if (k.trim() === 'v1') out.v1.push(v.trim());
  }
  return out;
}

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

function verifySignature(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET) return { ok: false, reason: 'no-secret-configured' };
  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed.t || parsed.v1.length === 0) return { ok: false, reason: 'bad-signature-format' };

  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - parsed.t);
  if (ageSec > SIG_TOLERANCE_S) return { ok: false, reason: 'stale' };

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${parsed.t}.${rawBody}`, 'utf8')
    .digest('hex');

  for (const sig of parsed.v1) {
    if (timingSafeEqualHex(sig, expected)) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'cooud-webhook', method: 'GET' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(200).json({ ok: true, ignored: true, reason: 'method-not-post' });
  }

  const raw = (typeof req.body === 'string' && req.body) || (await readRawBody(req));

  // Always ack 200 — even on bad payload — to stop Cooud's retry storm.
  const sigHeader = req.headers['cooud-signature'] || req.headers['Cooud-Signature'] || '';
  const sigCheck = verifySignature(raw, sigHeader);
  if (!sigCheck.ok) {
    console.warn('[cooud:webhook] signature failed:', sigCheck.reason);
    return res.status(200).json({ ok: true, ignored: true, reason: sigCheck.reason });
  }

  let event = null;
  try { event = JSON.parse(raw); } catch (e) {
    console.warn('[cooud:webhook] invalid JSON');
    return res.status(200).json({ ok: true, ignored: true, reason: 'invalid-json' });
  }
  if (!event || typeof event !== 'object') {
    return res.status(200).json({ ok: true, ignored: true, reason: 'empty-body' });
  }

  try {
    const type = String(event.type || '');
    const data = (event.data && event.data.object) || event.data || {};
    const sessionId = String(data.id || data.checkout_session_id || event.id || '');

    console.log('[cooud:webhook]', JSON.stringify({
      received_at: new Date().toISOString(),
      type,
      id: sessionId,
      amount: data.amount || data.total_amount || 0,
      currency: data.currency || 'usd',
      customer_email: data.customer_email || (data.metadata && data.metadata.payer_email) || '',
    }));

    const isPaid =
      type === 'checkout_session.completed' ||
      type === 'order.paid' ||
      type === 'payment.succeeded';

    if (sessionId && isPaid && !alreadyFired(sessionId)) {
      markFired(sessionId);
      const amount = typeof data.amount === 'number' ? data.amount / 100 :
                     typeof data.total_amount === 'number' ? data.total_amount / 100 : 0;
      const currency = String(data.currency || 'usd').toUpperCase();
      const meta = data.metadata || {};
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket?.remoteAddress || '';

      sendServerEvent({
        event: 'Purchase',
        eventId: 'purchase_' + sessionId,
        properties: {
          currency,
          value: amount,
          content_type: 'product',
          content_id: 'apple-card-us',
          content_name: meta.funnel_step ? `Apple Card — ${meta.funnel_step}` : 'Apple Card',
          transaction_id: sessionId,
        },
        user: {
          external_id: sessionId,
          email: data.customer_email || meta.payer_email || '',
          phone: meta.payer_phone || '',
        },
        page: { url: 'https://' + (req.headers.host || 'apple-card-en.vercel.app') + '/' },
        ip,
        userAgent: req.headers['user-agent'] || '',
      }).catch((e) => console.error('[webhook:tt]', e && e.message));
    }
  } catch (e) {
    console.error('[cooud:webhook] handler threw', e && e.message);
  }

  return res.status(200).json({ ok: true });
};

// Disable Vercel's body parser so we can verify HMAC over the raw bytes.
module.exports.config = {
  api: { bodyParser: false },
};
