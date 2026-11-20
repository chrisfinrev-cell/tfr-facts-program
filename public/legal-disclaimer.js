// Proprietary – Financial Revolution – All Rights Reserved
/**
 * TFR Legal Disclaimer Banner
 * Auto-injects a persistent, non-dismissible legal disclaimer footer
 * on EVERY page across all 12 levels of the platform.
 *
 * Also injects:
 *  - Pre-tool confirmation modal for financial tool pages
 *  - Meta tags: author, copyright, robots (noai, noimageai)
 *  - Right-click content protection with toast notification
 *  - Sitewide copyright notice with ToS link
 *
 * © 2024–2026 Financial Revolution. All rights reserved. FACTS™ is a proprietary system.
 */
(function () {
  'use strict';

  // ─── Disclaimer Text ────────────────────────────────────────────────
  var DISCLAIMER_TEXT =
    'FACTS is a strictly educational and informational platform for financial literacy only. ' +
    'We do not provide financial, investment, tax, legal, lending, insurance, or credit-repair advice. ' +
    'We do not manage, control, or hold user funds, nor do we act as a bank, lender, credit repair organization, ' +
    'broker-dealer, registered investment advisor (RIA), or fiduciary. All tools, calculators, scores, ' +
    'projections, comparisons, and system outputs are illustrative estimates — not guarantees. All decisions ' +
    'are made solely by you. Consult a licensed professional before acting.';

  // Collapsed version — shown by default on mobile
  var SHORT_DISCLAIMER =
    'Educational only — not financial, legal, tax, lending, or credit-repair advice. We do not hold user funds.';

  var IDENTITY_TEXT =
    'FACTS is a People-to-People (P2P) Educational SaaS and Financial Logic Layer. ' +
    'Strictly non-custodial \u2014 we do not hold, move, or manage user funds. ' +
    'All banking/brokerage connections are \u201CRead-Only.\u201D ' +
    'Not a registered investment advisor. Not a broker-dealer. Not a financial institution. ' +
    'Not a lender. Not a credit repair organization. Not fiduciary advice.';

  var COPYRIGHT_TEXT = '\u00A9 2024\u20132026 Financial Revolution. All rights reserved. FACTS\u2122 is a proprietary system.';

  // ─── Inject Meta Tags ────────────────────────────────────────────────
  // Called immediately — meta tags should be in <head> as early as possible
  function injectMetaTags() {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;

    var metaDefs = [
      { name: 'author', content: 'Financial Revolution' },
      { name: 'copyright', content: '\u00A9 2024-2026 Financial Revolution. All rights reserved.' },
      { name: 'robots', content: 'noai, noimageai' }
    ];

    metaDefs.forEach(function (def) {
      // Don't duplicate if already present
      if (document.querySelector('meta[name="' + def.name + '"]')) return;
      var m = document.createElement('meta');
      m.setAttribute('name', def.name);
      m.setAttribute('content', def.content);
      head.appendChild(m);
    });
  }

  // Run immediately for fastest injection
  injectMetaTags();

  // ─── Styles ──────────────────────────────────────────────────────────
  var css = [
    '/* ── Legal Disclaimer Footer ── */',
    '#tfr-legal-disclaimer {',
    '  position: fixed; bottom: 0; left: 0; right: 0;',
    '  z-index: 99999;',
    '  background: linear-gradient(180deg, #0d1117 0%, #0a0e17 100%);',
    '  border-top: 1px solid rgba(201,162,39,0.18);',
    '  padding: 8px 16px 6px;',
    '  font-family: Inter, "DM Sans", system-ui, sans-serif;',
    '  box-sizing: border-box;',
    '}',
    '#tfr-legal-disclaimer .tld-inner {',
    '  max-width: 1100px; margin: 0 auto;',
    '  display: flex; align-items: center; justify-content: center;',
    '  gap: 6px; flex-wrap: wrap;',
    '}',
    '#tfr-legal-disclaimer .tld-icon {',
    '  flex-shrink: 0; width: 14px; height: 14px; opacity: 0.6;',
    '}',
    '#tfr-legal-disclaimer .tld-text {',
    '  font-size: 0.72rem; color: #64748b; line-height: 1.45;',
    '  text-align: center; font-weight: 400;',
    '  display: -webkit-box; -webkit-line-clamp: 2;',
    '  -webkit-box-orient: vertical; overflow: hidden;',
    '}',
    '#tfr-legal-disclaimer.tld-expanded .tld-text {',
    '  display: block; overflow: visible;',
    '  -webkit-line-clamp: unset;',
    '}',
    '#tfr-legal-disclaimer .tld-expand {',
    '  background: none; border: none; cursor: pointer;',
    '  color: #c9a227; font-size: 0.7rem; font-weight: 600;',
    '  font-family: inherit; padding: 2px 6px;',
    '  border-radius: 4px; transition: background 0.15s;',
    '  white-space: nowrap; flex-shrink: 0;',
    '}',
    '#tfr-legal-disclaimer .tld-expand:hover {',
    '  background: rgba(201,162,39,0.1);',
    '}',
    '#tfr-legal-disclaimer .tld-identity {',
    '  display: none; width: 100%;',
    '  font-size: 0.68rem; color: #475569; line-height: 1.5;',
    '  text-align: center; margin-top: 4px; padding-top: 6px;',
    '  border-top: 1px solid rgba(255,255,255,0.04);',
    '}',
    '#tfr-legal-disclaimer.tld-expanded .tld-identity { display: block; }',
    '#tfr-legal-disclaimer.tld-expanded .tld-expand-text::after { content: "Less"; }',
    '#tfr-legal-disclaimer:not(.tld-expanded) .tld-expand-text::after { content: "More"; }',

    '/* ── Copyright strip ── */',
    '#tfr-legal-disclaimer .tld-copyright {',
    '  width: 100%; text-align: center;',
    '  font-size: 0.65rem; color: #334155; line-height: 1.3;',
    '  padding-top: 4px; margin-top: 2px;',
    '  border-top: 1px solid rgba(255,255,255,0.03);',
    '}',
    '#tfr-legal-disclaimer .tld-copyright a {',
    '  color: #475569; text-decoration: none;',
    '  transition: color 0.15s;',
    '}',
    '#tfr-legal-disclaimer .tld-copyright a:hover { color: #c9a227; }',

    '/* ── Body + content bottom padding to avoid overlap ── */',
    'body.has-legal-disclaimer { padding-bottom: 64px !important; }',
    'body.has-legal-disclaimer .tab-content.active { padding-bottom: 76px !important; }',
    'body.has-legal-disclaimer main, body.has-legal-disclaimer .wrap, body.has-legal-disclaimer .page-wrap { padding-bottom: 76px !important; }',
    'body.has-legal-disclaimer #app-page { padding-bottom: 76px !important; }',
    '@media (max-width: 640px) {',
    '  body.has-legal-disclaimer { padding-bottom: 52px !important; }',
    '  body.has-legal-disclaimer .tab-content.active { padding-bottom: 56px !important; }',
    '  body.has-legal-disclaimer main, body.has-legal-disclaimer .wrap, body.has-legal-disclaimer .page-wrap { padding-bottom: 56px !important; }',
    '  body.has-legal-disclaimer #app-page { padding-bottom: 56px !important; }',
    '  #tfr-legal-disclaimer { padding: 6px 12px 5px; }',
    '  #tfr-legal-disclaimer .tld-text { font-size: 0.68rem; }',
    '}',

    '/* ── Pre-Tool Disclaimer Modal ── */',
    '#tfr-tool-disclaimer-overlay {',
    '  position: fixed; inset: 0; z-index: 100000;',
    '  background: rgba(0,0,0,0.78); backdrop-filter: blur(6px);',
    '  -webkit-backdrop-filter: blur(6px);',
    '  display: flex; align-items: center; justify-content: center;',
    '  padding: 24px;',
    '  font-family: Inter, "DM Sans", system-ui, sans-serif;',
    '  opacity: 0; transition: opacity 0.3s ease;',
    '}',
    '#tfr-tool-disclaimer-overlay.tdm-visible { opacity: 1; }',
    '#tfr-tool-disclaimer-modal {',
    '  background: #111827; border: 1px solid rgba(201,162,39,0.25);',
    '  border-radius: 16px; padding: 32px 28px;',
    '  max-width: 480px; width: 100%;',
    '  box-shadow: 0 20px 60px rgba(0,0,0,0.5);',
    '  animation: tdm-card-in 0.4s cubic-bezier(0.34,1.56,0.64,1) both;',
    '}',
    '@keyframes tdm-card-in {',
    '  from { opacity:0; transform: scale(0.9) translateY(16px); }',
    '  to   { opacity:1; transform: scale(1) translateY(0); }',
    '}',
    '#tfr-tool-disclaimer-modal h3 {',
    '  font-family: "Space Grotesk", sans-serif;',
    '  font-size: 1.15rem; font-weight: 700;',
    '  color: #f1f5f9; margin-bottom: 16px;',
    '  display: flex; align-items: center; gap: 8px;',
    '}',
    '#tfr-tool-disclaimer-modal .tdm-body {',
    '  font-size: 0.88rem; color: #94a3b8; line-height: 1.6;',
    '  margin-bottom: 20px;',
    '}',
    '#tfr-tool-disclaimer-modal .tdm-body strong { color: #f1f5f9; }',
    '#tfr-tool-disclaimer-modal .tdm-identity {',
    '  font-size: 0.8rem; color: #64748b; line-height: 1.5;',
    '  background: rgba(201,162,39,0.06);',
    '  border: 1px solid rgba(201,162,39,0.12);',
    '  border-radius: 8px; padding: 12px 14px; margin-bottom: 20px;',
    '}',
    '/* ── Timed countdown row ── */',
    '#tfr-tool-disclaimer-modal .tdm-countdown {',
    '  text-align: center; font-size: 0.8rem; color: #64748b;',
    '  margin-bottom: 14px; min-height: 20px; transition: color 0.3s;',
    '}',
    '#tfr-tool-disclaimer-modal .tdm-countdown.tdm-ready {',
    '  color: #10b981; font-weight: 600;',
    '}',
    '#tfr-tool-disclaimer-modal .tdm-btn {',
    '  width: 100%; padding: 12px 20px;',
    '  background: linear-gradient(135deg, #c9a227 0%, #d4a929 100%);',
    '  color: #0a0f1a; font-weight: 700; font-size: 0.9rem;',
    '  border: none; border-radius: 10px; cursor: pointer;',
    '  font-family: inherit; transition: all 0.2s ease;',
    '  position: relative; overflow: hidden;',
    '}',
    '#tfr-tool-disclaimer-modal .tdm-btn:disabled {',
    '  background: #1a2332; color: #4b5563; cursor: not-allowed;',
    '}',
    '#tfr-tool-disclaimer-modal .tdm-btn:not(:disabled):hover {',
    '  transform: translateY(-1px);',
    '  box-shadow: 0 6px 24px rgba(201,162,39,0.4);',
    '}',
    '#tfr-tool-disclaimer-modal .tdm-btn .tdm-btn-progress {',
    '  position: absolute; left: 0; top: 0; height: 100%;',
    '  background: rgba(255,255,255,0.15); transition: width 1s linear;',
    '}',

    '/* ── Mobile scroll fix ── */',
    '@media (max-height: 600px) {',
    '  #tfr-tool-disclaimer-modal {',
    '    max-height: calc(100vh - 88px);',
    '    overflow-y: auto;',
    '  }',
    '  #tfr-tool-disclaimer-modal .tdm-body {',
    '    max-height: 120px; overflow-y: auto;',
    '    scrollbar-width: thin; scrollbar-color: #1e293b transparent;',
    '  }',
    '  #tfr-tool-disclaimer-modal .tdm-body::-webkit-scrollbar { width: 3px; }',
    '  #tfr-tool-disclaimer-modal .tdm-body::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }',
    '  #tfr-tool-disclaimer-modal .tdm-identity {',
    '    max-height: 80px; overflow-y: auto;',
    '    scrollbar-width: thin; scrollbar-color: #1e293b transparent;',
    '  }',
    '  #tfr-tool-disclaimer-modal .tdm-identity::-webkit-scrollbar { width: 3px; }',
    '  #tfr-tool-disclaimer-modal .tdm-identity::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }',
    '}',

    '/* ── Right-click protection toast ── */',
    '#tfr-copy-toast {',
    '  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);',
    '  z-index: 200000;',
    '  background: #1e293b; border: 1px solid rgba(201,162,39,0.3);',
    '  color: #f1f5f9; font-size: 0.82rem; font-weight: 600;',
    '  font-family: Inter, "DM Sans", system-ui, sans-serif;',
    '  padding: 10px 20px; border-radius: 8px;',
    '  box-shadow: 0 8px 24px rgba(0,0,0,0.5);',
    '  display: flex; align-items: center; gap: 8px;',
    '  pointer-events: none;',
    '  opacity: 0; transition: opacity 0.2s;',
    '}',
    '#tfr-copy-toast.show { opacity: 1; }',
    '#tfr-copy-toast svg { color: #c9a227; flex-shrink: 0; }'
  ].join('\n');

  // Inject styles
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ─── Build Footer Banner ──────────────────────────────────────────
  var banner = document.createElement('div');
  banner.id = 'tfr-legal-disclaimer';
  banner.setAttribute('role', 'contentinfo');
  banner.setAttribute('aria-label', 'Legal disclaimer');
  banner.innerHTML =
    '<div class="tld-inner">' +
      '<svg class="tld-icon" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2">' +
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
      '</svg>' +
      '<span class="tld-text">' + SHORT_DISCLAIMER + '</span>' +
      '<button class="tld-expand" aria-expanded="false" aria-label="Expand legal disclaimer">' +
        '<span class="tld-expand-text"></span>' +
      '</button>' +
      '<div class="tld-identity">' + IDENTITY_TEXT + '</div>' +
    '</div>' +
    '<div class="tld-copyright">' +
      COPYRIGHT_TEXT +
      ' &nbsp;\u00B7&nbsp; ' +
      '<a href="/terms-of-service">Terms of Service</a>' +
    '</div>';

  // Toggle expanded state — swaps short/full disclaimer text
  var expandBtn = banner.querySelector('.tld-expand');
  var tldText = banner.querySelector('.tld-text');
  expandBtn.addEventListener('click', function () {
    var isExpanded = banner.classList.toggle('tld-expanded');
    expandBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    // Swap text content on toggle
    if (isExpanded) {
      tldText.textContent = DISCLAIMER_TEXT;
    } else {
      tldText.textContent = SHORT_DISCLAIMER;
    }
  });

  // Insert when DOM is ready
  function insertBanner() {
    document.body.appendChild(banner);
    document.body.classList.add('has-legal-disclaimer');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertBanner);
  } else {
    insertBanner();
  }

  // ─── Right-Click Content Protection ─────────────────────────────
  // Show a toast instead of silently swallowing the event
  var _toastEl = null;
  var _toastTimer = null;

  function getToast() {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.id = 'tfr-copy-toast';
      _toastEl.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
          '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
        '</svg>' +
        'Content protected — \u00A9 Financial Revolution';
    }
    return _toastEl;
  }

  function showProtectedToast() {
    var t = getToast();
    if (!document.body.contains(t)) {
      document.body.appendChild(t);
    }
    // Re-trigger animation
    t.classList.remove('show');
    void t.offsetWidth; // force reflow
    t.classList.add('show');

    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      t.classList.remove('show');
    }, 2400);
  }

  // Disable right-click context menu on public-facing pages
  // (excludes admin panel and authenticated tool pages where devs may legitimately use devtools)
  var adminExcluded = ['/admin', '/command-console'];
  var currentPath = window.location.pathname;
  var isAdminPage = adminExcluded.some(function (p) { return currentPath.indexOf(p) === 0; });

  if (!isAdminPage) {
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showProtectedToast();
    });
  }

  // ─── Pre-Tool Disclaimer Modal ────────────────────────────────────
  // Financial tool pages that require acknowledgment before use
  // Note: /app is excluded here — it has its own dedicated timed compliance modal
  // via compliance-disclaimer.js which handles the TOS acknowledgment flow.
  var toolPages = [
    '/net-worth',
    '/discovery-scan',
    '/crypto-tracker',
    '/scorecard',
    '/scorecard-view',
    '/heloc-velocity-engine',
    '/lending-desk',
    '/brokerage-tracker',
    '/credit-analysis',
    '/forensic-scan',
    '/rate-radar',
    '/shopping-calculator',
    '/receipt-scanner',
    '/ssc',
    '/phase-zero',
    '/wallet',
    '/rewards',
    '/legacy-lens',
    '/paycheck-entry',
    '/coaching-readiness',
    '/elite-bundles',
    '/vantage-point',
    '/sovereign-dashboard',
    '/document-vault',
    '/knowledge-vault',
    '/facts-funnel',
    '/benefits-masterclass',
    '/training',
    '/level1-intake',
  ];

  var pathname = window.location.pathname.replace(/\.html$/, '');

  // ─── Per-page tool disclaimer — TIMED (10s) ──────────────────────
  // Stored in localStorage so it persists across sessions (not just the tab).
  // Key: 'tfr_tool_ack_<pathname>'  Value: ISO timestamp of acceptance
  var TOOL_COUNTDOWN = 10;

  if (toolPages.indexOf(pathname) !== -1) {
    var lsKey = 'tfr_tool_ack_' + pathname;

    // Only show if not yet acknowledged in this browser
    if (!localStorage.getItem(lsKey)) {
      showToolDisclaimer(lsKey);
    }
  }

  function showToolDisclaimer(lsKey) {
    var overlay = document.createElement('div');
    overlay.id = 'tfr-tool-disclaimer-overlay';
    overlay.innerHTML =
      '<div id="tfr-tool-disclaimer-modal" role="dialog" aria-modal="true" aria-labelledby="tdm-title">' +
        '<h3 id="tdm-title">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c9a227" stroke-width="2">' +
            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
          '</svg>' +
          'Educational Tool Disclaimer' +
        '</h3>' +
        '<div class="tdm-body">' +
          '<strong>' + DISCLAIMER_TEXT + '</strong>' +
        '</div>' +
        '<div class="tdm-identity">' + IDENTITY_TEXT + '</div>' +
        '<div class="tdm-countdown" id="tdm-countdown-el" aria-live="polite">' +
          'Please read the above \u2014 you can continue in <strong id="tdm-count-num">' + TOOL_COUNTDOWN + '</strong> seconds' +
        '</div>' +
        '<button class="tdm-btn" id="tdm-continue-btn" disabled aria-disabled="true">' +
          '<span class="tdm-btn-progress" id="tdm-btn-progress" style="width:0%"></span>' +
          '<span id="tdm-btn-label" style="position:relative;z-index:1;">I Understand — Continue to Tool</span>' +
        '</button>' +
      '</div>';

    function insertOverlay() {
      document.body.appendChild(overlay);

      // Fade in
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          overlay.classList.add('tdm-visible');
        });
      });

      var btn = document.getElementById('tdm-continue-btn');
      var countdownEl = document.getElementById('tdm-countdown-el');
      var countNum = document.getElementById('tdm-count-num');
      var progressBar = document.getElementById('tdm-btn-progress');
      var btnLabel = document.getElementById('tdm-btn-label');

      // Countdown timer
      var startTime = Date.now();

      function tick() {
        var elapsed = (Date.now() - startTime) / 1000;
        var remaining = Math.max(0, TOOL_COUNTDOWN - elapsed);
        var pct = ((TOOL_COUNTDOWN - remaining) / TOOL_COUNTDOWN) * 100;
        progressBar.style.width = pct + '%';

        if (remaining > 0) {
          countNum.textContent = Math.ceil(remaining);
          setTimeout(tick, 50);
        } else {
          btn.disabled = false;
          btn.setAttribute('aria-disabled', 'false');
          countdownEl.className = 'tdm-countdown tdm-ready';
          countdownEl.innerHTML = '\u2713 You may now continue';
          progressBar.style.width = '0%';
          btn.focus();
        }
      }

      setTimeout(tick, 50);

      // Trap focus in modal
      overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') e.preventDefault();
      });

      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        btn.disabled = true;
        btnLabel.textContent = 'Continuing\u2026';

        // Persist acknowledgment in localStorage
        try { localStorage.setItem(lsKey, new Date().toISOString()); } catch (e) { /* quota */ }

        // Log acceptance to server (fire-and-forget)
        try {
          fetch('/api/disclaimer/tool-acknowledge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              page: pathname,
              acknowledged_at: new Date().toISOString()
            }),
            credentials: 'same-origin'
          }).catch(function() { /* non-fatal */ });
        } catch (e) { /* non-fatal */ }

        // Fade out and remove
        overlay.style.transition = 'opacity 0.3s ease';
        overlay.style.opacity = '0';
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 320);
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', insertOverlay);
    } else {
      insertOverlay();
    }
  }
})();
