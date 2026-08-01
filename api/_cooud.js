/*
 * Shared helper for talking to the Cooud v2 API.
 *
 * Docs: https://docs.cooud.com/public-doc
 *
 * Environment variables expected:
 *   COOUD_API_KEY        — cooud_sk_live_* (or cooud_sk_sandbox_* in test)
 *   COOUD_COMPAT_DATE    — optional; defaults to the date this code was authored
 *
 * Cooud rules we follow:
 *   - Always send `Authorization: Bearer cooud_sk_*` on server calls
 *   - Always send `Cooud-Compat-Date` (pinning the schema we coded against)
 *   - Send `Idempotency-Key` on every POST (UUID per logical request)
 *   - Amounts are integers in the smallest currency unit (cents)
 *   - Currencies are lowercase ISO 4217 ("usd", "brl", "eur")
 *   - IDs are Cooud-native (cooud_cs_*, cooud_ord_*, etc.) — never expose Stripe IDs
 */

const BASE = 'https://api.cooud.com/v2';
const COMPAT_DATE = process.env.COOUD_COMPAT_DATE || '2026-09-01';
const API_KEY = process.env.COOUD_API_KEY || '';
const TIMEOUT_MS = 15000;

function uuid() {
  // RFC4122 v4 — good enough for Idempotency-Key
  const b = (n) => Math.floor(Math.random() * (1 << n)).toString(16).padStart(n / 4, '0');
  return `${b(32)}-${b(16)}-4${b(12).slice(1)}-${((Math.random() * 4) | 8).toString(16)}${b(12).slice(1)}-${b(48)}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function cooudFetch(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
  if (!API_KEY) {
    const err = new Error('cooud_api_key_missing');
    err.code = 'config';
    throw err;
  }

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Cooud-Compat-Date': COMPAT_DATE,
    Accept: 'application/json',
  };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey || uuid();

  const r = await fetchWithTimeout(`${BASE}${path}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  }, TIMEOUT_MS);

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!r.ok) {
    const err = new Error((data && data.error && data.error.message) || `cooud_http_${r.status}`);
    err.status = r.status;
    err.code = (data && data.error && data.error.code) || 'http_error';
    err.recovery = (data && data.error && data.error.recovery_action) || 'none';
    err.body = data;
    throw err;
  }

  return data;
}

/**
 * Create a hosted-redirect checkout session.
 * Returns { id, url, status, ... }.
 *
 * Cooud responds with `url` pointing at the hosted checkout page; the buyer is
 * redirected there, pays, and is sent back to `success_url`/`cancel_url`.
 */
async function createCheckoutSession({
  name,
  amount,        // integer cents
  currency,      // ISO 4217 lowercase (e.g. "usd")
  quantity = 1,
  customerEmail = '',
  successUrl,
  cancelUrl,
  metadata = {},
}) {
  if (!Number.isInteger(amount) || amount < 1) throw new Error('amount_invalid');
  if (!currency || !/^[a-z]{3}$/i.test(currency)) throw new Error('currency_invalid');
  if (!name) throw new Error('name_required');

  const body = {
    line_items: [{
      name: String(name).slice(0, 120),
      amount,
      currency: currency.toLowerCase(),
      quantity,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  if (customerEmail) body.customer_email = customerEmail;

  // Cooud expects scalar metadata values (string|number|boolean)
  const cleanMeta = {};
  for (const [k, v] of Object.entries(metadata || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') cleanMeta[k] = v.slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') cleanMeta[k] = v;
    else cleanMeta[k] = String(v).slice(0, 500);
  }
  if (Object.keys(cleanMeta).length) body.metadata = cleanMeta;

  return cooudFetch('/checkout-sessions', { method: 'POST', body });
}

/**
 * Retrieve a checkout session by id. Used for polling status.
 */
async function getCheckoutSession(id) {
  return cooudFetch(`/checkout-sessions/${encodeURIComponent(id)}`);
}

module.exports = {
  BASE,
  COMPAT_DATE,
  uuid,
  cooudFetch,
  createCheckoutSession,
  getCheckoutSession,
};
