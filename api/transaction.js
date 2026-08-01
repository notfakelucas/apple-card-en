/*
 * Creates a Cooud v2 checkout session and returns the hosted-redirect URL.
 *
 * The frontend POSTs:
 *   {
 *     amount: <integer cents>,          // required
 *     currency: "usd" | "brl" | "eur",  // optional (defaults to "usd")
 *     productName: "Apple Card — ..." , // shows up on the Cooud checkout page
 *     payerName, email, phone,          // best-effort attribution
 *     successPath: "obrigado.html",     // relative path on this site
 *     cancelPath:  "checkout.html",     // relative path on this site
 *     utm: "utm_source=...&utm_medium=...",  // for UTMify
 *     abGroup: "A" | "B" | "C"
 *   }
 *
 * Returns:
 *   { success: true, transactionId, url, status, amount, currency }
 *
 * The browser then redirects to `url` to complete payment. After payment Cooud
 * redirects back to `successPath`/`cancelPath`, with `?session_id=<cooud_cs_*>`
 * appended so the front-end can verify status if it wants.
 */

const { createCheckoutSession } = require('./_cooud');

const DEFAULT_CURRENCY = 'usd';

function bad(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function siteOrigin(req) {
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
  return host ? `${proto}://${host}` : '';
}

function appendQs(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.toString();
}

function safePath(value, fallback) {
  const v = String(value || '').trim();
  // only allow simple relative paths (no scheme, no leading slash, no `..`)
  if (!v || /^[a-z]+:\/\//i.test(v) || v.startsWith('/') || v.includes('..')) return fallback;
  return v;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 405, 'Method not allowed');
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return bad(res, 400, 'Invalid JSON');

  const amountCents = parseInt(body.amount, 10);
  if (!Number.isFinite(amountCents) || amountCents < 100) {
    return bad(res, 400, 'Invalid amount (minimum $1.00)');
  }

  const currency = (body.currency || DEFAULT_CURRENCY).toString().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return bad(res, 400, 'Invalid currency');

  const productName = String(body.productName || 'Apple Card order').trim().slice(0, 120);
  const email = String(body.email || '').trim();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';

  const origin = siteOrigin(req);
  if (!origin) return bad(res, 500, 'Unable to resolve site origin');

  const successPath = safePath(body.successPath, 'obrigado.html');
  const cancelPath = safePath(body.cancelPath, 'checkout.html');

  // Cooud will append nothing to success_url itself, so we tag it ourselves
  // with `cooud_session_id={ID}` — Cooud substitutes that template at redirect
  // time (documented behaviour for hosted checkout). Some integrations prefer
  // appending a static marker the frontend can detect.
  const successUrl = appendQs(`${origin}/${successPath}`, {
    pay: 'ok',
    cooud_session_id: '{CHECKOUT_SESSION_ID}',
  });
  const cancelUrl = appendQs(`${origin}/${cancelPath}`, { pay: 'cancel' });

  // Build metadata: UTMs + light attribution fields for the merchant dashboard.
  const metadata = {
    payer_name: String(body.payerName || body.name || '').slice(0, 120),
    payer_email: validEmail,
    payer_phone: String(body.phone || '').slice(0, 32),
    ab_group: String(body.abGroup || '').slice(0, 8),
    funnel_step: String(body.funnelStep || 'checkout').slice(0, 40),
  };
  // Spread UTM params from the `utm` querystring blob
  if (typeof body.utm === 'string' && body.utm) {
    try {
      const params = new URLSearchParams(body.utm);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((k) => {
        const v = params.get(k);
        if (v) metadata[k] = v.slice(0, 500);
      });
    } catch { /* ignore */ }
  }

  let session;
  try {
    session = await createCheckoutSession({
      name: productName,
      amount: amountCents,
      currency,
      customerEmail: validEmail,
      successUrl,
      cancelUrl,
      metadata,
    });
  } catch (e) {
    console.error('[cooud:create]', e.status || '-', e.code || '-', e.message);
    return bad(res, e.status && e.status >= 400 && e.status < 500 ? e.status : 502, e.message || 'Cooud error');
  }

  if (!session || !session.id || !session.url) {
    console.error('[cooud:create] unexpected response', session);
    return bad(res, 502, 'Invalid Cooud response');
  }

  return res.status(200).json({
    success: true,
    transactionId: session.id,         // cooud_cs_*
    url: session.url,                  // hosted checkout URL — browser redirects here
    status: session.status || 'open',  // "open" | "complete"
    amount: amountCents / 100,
    currency,
  });
};
