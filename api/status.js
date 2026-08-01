/*
 * Polls Cooud for the status of a checkout session and returns the normalized
 * shape the frontend expects: { status: "PENDING" | "APPROVED" | "REFUSED" }.
 *
 * Also fires a server-side Purchase event to the TikTok Events API (deduped by
 * transactionId so it pairs with the pixel event from the browser).
 */

const { getCheckoutSession } = require('./_cooud');
const { sendServerEvent } = require('./tt');

// In-process dedupe cache. For higher volume a Vercel KV would be more robust,
// but this prevents >99% of duplicates with zero ops cost.
const purchaseFiredCache = new Map();
function alreadyFired(txId) {
  const now = Date.now();
  for (const [k, t] of purchaseFiredCache) {
    if (now - t > 60 * 60 * 1000) purchaseFiredCache.delete(k);
  }
  return purchaseFiredCache.has(txId);
}
function markFired(txId) { purchaseFiredCache.set(txId, Date.now()); }

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ status: 'ERROR', error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');

  let transactionId = '';
  if (req.method === 'GET') {
    transactionId = String((req.query && (req.query.id || req.query.transactionId)) || '').trim();
  } else {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (body && typeof body === 'object') {
      transactionId = String(body.id || body.transactionId || '').trim();
    }
  }

  // Cooud checkout session ids look like cooud_cs_<26 chars of Crockford base32>
  if (!transactionId || !/^cooud_cs_[0-9A-HJKMNP-TV-Z]{26}$/i.test(transactionId)) {
    return res.status(400).json({ status: 'ERROR', error: 'Invalid transactionId' });
  }

  let session = null;
  try {
    session = await getCheckoutSession(transactionId);
  } catch (e) {
    console.error('[cooud:status]', e.status || '-', e.code || '-', e.message);
    return res.status(200).json({ status: 'PENDING' });
  }

  if (!session || typeof session !== 'object') {
    return res.status(200).json({ status: 'PENDING' });
  }

  // Cooud session status: "open" → not yet paid, "complete" → paid.
  // Payment-level status lives under session.payment.status when present.
  const sessionStatus = String(session.status || 'open').toLowerCase();
  const paymentStatus = String((session.payment && session.payment.status) || '').toLowerCase();

  let normalized = 'PENDING';
  if (sessionStatus === 'complete' || paymentStatus === 'succeeded' || paymentStatus === 'paid') {
    normalized = 'APPROVED';
  } else if (['failed', 'canceled', 'cancelled', 'expired', 'requires_payment_method'].includes(paymentStatus)) {
    normalized = 'REFUSED';
  }

  // Fire Purchase server-side (once per session) for TikTok Events API.
  if (normalized === 'APPROVED' && !alreadyFired(transactionId)) {
    markFired(transactionId);
    const meta = session.metadata || {};
    const amount = typeof session.amount === 'number' ? session.amount / 100 : 0;
    const currency = String(session.currency || 'usd').toUpperCase();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.socket?.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';

    sendServerEvent({
      event: 'Purchase',
      eventId: 'purchase_' + transactionId,
      properties: {
        currency,
        value: amount,
        content_type: 'product',
        content_id: 'apple-card-us',
        content_name: meta.funnel_step ? `Apple Card — ${meta.funnel_step}` : 'Apple Card',
        transaction_id: transactionId,
      },
      user: {
        external_id: transactionId,
        email: session.customer_email || meta.payer_email || '',
        phone: meta.payer_phone || '',
      },
      page: {
        url: (req.headers.origin || '') + '/checkout.html',
      },
      ip,
      userAgent: ua,
    }).catch((e) => console.error('[tt:purchase server]', e && e.message));
  }

  const out = { status: normalized };
  if (normalized === 'APPROVED' && session.payment && session.payment.paid_at) {
    out.paidAt = session.payment.paid_at;
  }
  return res.status(200).json(out);
};
