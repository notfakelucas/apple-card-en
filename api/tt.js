/*
 * TikTok Events API (server-side).
 *
 * Receives the same events the browser tracker.js fires and forwards them via
 * the TikTok Events API. Pairs with the client-side pixel via shared event_id
 * for deduplication and improves match quality.
 *
 *   - sdkid:        D7UKM8JC77U07JNLKKV0 (pixel_code)
 *   - access token: process.env.TIKTOK_ACCESS_TOKEN (set on Vercel)
 *   - dedup:        shared event_id with the client-side track call
 *
 * Also invoked by /api/status when Cooud confirms a payment (server-side
 * Purchase, using the Cooud session id as event_id).
 */

const crypto = require('crypto');

const PIXEL_CODE = process.env.TIKTOK_PIXEL_CODE || 'D7UKM8JC77U07JNLKKV0';
const ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN || '';
const TT_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

function sha256(s) {
  return crypto.createHash('sha256')
    .update(String(s == null ? '' : s).trim().toLowerCase())
    .digest('hex');
}

function digitsOnly(s) { return String(s || '').replace(/\D+/g, ''); }

function normalizePhone(raw) {
  if (!raw) return '';
  var d = digitsOnly(raw);
  // US numbers: 10 digits, optionally with leading 1 (country code)
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? '+1' + d : '';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}

async function sendEventToTikTok(payload) {
  if (!ACCESS_TOKEN) {
    console.error('[tt] TIKTOK_ACCESS_TOKEN missing');
    return { ok: false, reason: 'no_token' };
  }
  try {
    const r = await fetchWithTimeout(TT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': ACCESS_TOKEN
      },
      body: JSON.stringify(payload)
    }, 8000);
    const json = await r.json().catch(() => ({}));
    if (!r.ok || (json && json.code !== 0)) {
      console.error('[tt] events API error', r.status, JSON.stringify(json).slice(0, 500));
      return { ok: false, status: r.status, response: json };
    }
    return { ok: true, response: json };
  } catch (e) {
    console.error('[tt] events API exception', e && e.message);
    return { ok: false, reason: 'exception' };
  }
}

/**
 * Public helper for other endpoints (e.g. api/status) to call without an HTTP round-trip.
 *
 *   await sendServerEvent({ event, eventId, properties, user, page, ttclid, ip, userAgent })
 */
async function sendServerEvent({ event, eventId, properties, user, page, ttclid, ip, userAgent }) {
  user = user || {};
  page = page || {};
  properties = properties || {};

  const phone = normalizePhone(user.phone);
  const userObj = { external_id: user.external_id ? sha256(user.external_id) : undefined };
  if (user.email) userObj.email = sha256(user.email);
  if (phone) userObj.phone = sha256(phone);
  if (ip) userObj.ip = ip;
  if (userAgent) userObj.user_agent = userAgent;
  if (ttclid) userObj.ttclid = ttclid;
  Object.keys(userObj).forEach((k) => userObj[k] === undefined && delete userObj[k]);

  const payload = {
    event_source: 'web',
    event_source_id: PIXEL_CODE,
    data: [{
      event,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || ('srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      user: userObj,
      properties,
      page
    }]
  };

  return sendEventToTikTok(payload);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(204).end();
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') { res.status(204).end(); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket?.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';

  const result = await sendServerEvent({
    event: body.event,
    eventId: body.event_id,
    properties: body.params,
    user: body.user || {},
    page: body.page || {},
    ttclid: body.ttclid || '',
    ip,
    userAgent: ua
  });

  // Minimal response — sendBeacon ignores the body, it's fire-and-forget.
  res.status(200).json({ ok: result.ok });
};

// Export the helper so other endpoints can call it directly.
module.exports.sendServerEvent = sendServerEvent;
