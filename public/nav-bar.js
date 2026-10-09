// Proprietary – Financial Revolution – All Rights Reserved
/**
 * TFR Global Navigation Bar
 * Self-injects a fixed back arrow + shortcut strip on every page.
 * Pages excluded: / (landing), /app (has its own full nav)
 *
 * Also enforces NDA gate: any authenticated user who hasn't accepted the
 * Beta NDA is redirected to /nda.html before accessing any app page.
 */
(function () {
  var pathname = window.location.pathname.replace(/\.html$/, '');

  // ── NDA Gate + Promo Grace Banner: check on all non-auth, non-nda pages ─
  var ndaExemptPages = ['/', '/index', '/login', '/signup', '/forgot-password',
    '/reset-password', '/nda', '/pricing'];
  if (ndaExemptPages.indexOf(pathname) === -1) {
    // Async check — don't block page render
    fetch('/api/auth/me').then(function(res) {
      return res.json();
    }).then(function(data) {
      // NDA redirect
      if (data.authenticated && data.user && data.user.is_admin) {
        // Allowlisted admins stay on /admin. Do not pull them to the NDA page.
      } else if (data.authenticated && data.user && data.user.nda_required && !data.user.nda_accepted) {
        window.location.href = '/nda.html?next=' + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }

      // ── Promo Grace Period Banner ─────────────────────────────────────
      // Show a sticky banner below the nav bar whenever a promo user's
      // 14-day countdown is active.  Only hides when they subscribe.
      if (data.authenticated && data.user && data.user.promo_grace_active && !data.user.is_creator) {
        var daysLeft = data.user.promo_grace_days_remaining;

        // Build banner text
        var msg;
        if (daysLeft <= 0) {
          msg = '⚠️ <strong>Last day!</strong> Your free Individual access expires today. Subscribe now.';
        } else if (daysLeft === 1) {
          msg = '⏰ <strong>1 day left!</strong> Your free Individual access expires tomorrow. Subscribe now.';
        } else {
          msg = '⏳ Your free Individual access ends in <strong>' + daysLeft + ' days</strong>. Subscribe to keep Individual features.';
        }

        // Banner styles
        var bannerCss = [
          '#tfr-grace-banner {',
          '  position: sticky; top: 44px; z-index: 9998; width: 100%;',
          '  background: ' + (daysLeft <= 3 ? 'linear-gradient(90deg,#7f1d1d,#991b1b)' : 'linear-gradient(90deg,#78350f,#92400e)') + ';',
          '  border-bottom: 1px solid rgba(251,191,36,0.3);',
          '  color: #fef3c7; padding: 9px 16px;',
          '  font-family: Inter,"DM Sans",system-ui,sans-serif;',
          '  box-sizing: border-box;',
          '}',
          '#tfr-grace-banner .tgb-inner {',
          '  display: flex; align-items: center; justify-content: center;',
          '  gap: 12px; flex-wrap: wrap; max-width: 1100px; margin: 0 auto;',
          '}',
          '#tfr-grace-banner .tgb-text { font-size: 0.86rem; font-weight: 500; }',
          '#tfr-grace-banner .tgb-text strong { font-weight: 700; color: #fde68a; }',
          '#tfr-grace-banner .tgb-cta {',
          '  background: #f59e0b; color: #000; font-weight: 700;',
          '  border: none; padding: 6px 16px; border-radius: 6px;',
          '  cursor: pointer; font-size: 0.82rem; text-decoration: none;',
          '  display: inline-block; white-space: nowrap;',
          '  font-family: inherit;',
          '}'
        ].join('\n');

        var bannerStyle = document.createElement('style');
        bannerStyle.textContent = bannerCss;
        document.head.appendChild(bannerStyle);

        var banner = document.createElement('div');
        banner.id = 'tfr-grace-banner';
        banner.setAttribute('role', 'alert');
        banner.innerHTML =
          '<div class="tgb-inner">' +
            '<span class="tgb-text">' + msg + '</span>' +
            '<a href="/pricing.html" class="tgb-cta">Subscribe Now →</a>' +
          '</div>';

        // Insert banner right after the nav bar (first child of body)
        var navBar = document.getElementById('tfr-nav');
        if (navBar && navBar.parentNode) {
          navBar.parentNode.insertBefore(banner, navBar.nextSibling);
          // Bump body padding to account for banner height (~38px)
          var cur = parseInt(document.body.style.paddingTop) || 0;
          document.body.style.paddingTop = (cur + 38) + 'px';
        }
      }
      // ─────────────────────────────────────────────────────────────────

    }).catch(function() { /* Non-fatal */ });
  }

  // Pages that don't get the bar at all (landing, app, marketing pages, full-HUD experiences)
  var excluded = ['/', '/index', '/app', '/pricing', '/future-generations', '/ssc', '/shopping-calculator'];
  if (excluded.indexOf(pathname) !== -1) return;

  // Auth pages: back arrow only (no shortcuts — keep them clean)
  var authPages = ['/login', '/signup', '/forgot-password', '/reset-password'];
  var isAuth = authPages.indexOf(pathname) !== -1;

  // ------------------------------------------------------------------
  // Styles
  // ------------------------------------------------------------------
  var css = [
    '#tfr-nav {',
    '  position: fixed; top: 0; left: 0; right: 0; height: 44px;',
    '  background: rgba(10,15,26,0.97);',
    '  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);',
    '  border-bottom: 1px solid rgba(201,162,39,0.14);',
    '  display: flex; align-items: center; z-index: 9999;',
    '  padding: 0 12px; gap: 0; box-sizing: border-box;',
    '  font-family: Inter, "DM Sans", system-ui, sans-serif;',
    '}',

    '#tfr-back, #tfr-fwd, #tfr-refresh {',
    '  display: flex; align-items: center; justify-content: center; gap: 5px;',
    '  color: #94a3b8; background: none; border: none; cursor: pointer;',
    '  font-size: 0.82rem; font-weight: 500; font-family: inherit;',
    '  padding: 0 10px; height: 44px; min-width: 44px;',
    '  border-radius: 8px; transition: color 0.15s, background 0.15s;',
    '  white-space: nowrap; flex-shrink: 0;',
    '}',
    '#tfr-back:hover, #tfr-fwd:hover, #tfr-refresh:hover { color: #e8c96a; background: rgba(201,162,39,0.08); }',
    '#tfr-back svg, #tfr-fwd svg, #tfr-refresh svg { flex-shrink: 0; }',

    '.tfr-div {',
    '  width: 1px; height: 20px;',
    '  background: rgba(255,255,255,0.09); flex-shrink: 0; margin: 0 4px;',
    '}',

    '#tfr-shortcuts {',
    '  display: flex; align-items: center; gap: 2px;',
    '  overflow-x: auto; flex: 1;',
    '  scrollbar-width: none; -ms-overflow-style: none;',
    '  padding: 0 2px;',
    '}',
    '#tfr-shortcuts::-webkit-scrollbar { display: none; }',

    '.tfr-link {',
    '  display: flex; align-items: center; gap: 5px;',
    '  color: #64748b; text-decoration: none;',
    '  font-size: 0.78rem; font-weight: 500; font-family: inherit;',
    '  padding: 0 10px; height: 44px; min-width: 44px;',
    '  border-radius: 7px; transition: color 0.15s, background 0.15s;',
    '  white-space: nowrap; flex-shrink: 0; cursor: pointer;',
    '}',
    '.tfr-link:hover { color: #e8c96a; background: rgba(201,162,39,0.08); }',
    '.tfr-link.tfr-active { color: #c9a227; background: rgba(201,162,39,0.10); }',

    // Mobile: hide text labels on very small screens, keep icons + touch targets
    '@media (max-width: 380px) {',
    '  #tfr-back .tfr-lbl { display: none; }',
    '  .tfr-link .tfr-icon { font-size: 1rem; }',
    '  .tfr-link { padding: 0 8px; font-size: 0; }',
    '  .tfr-link .tfr-icon { font-size: 1rem; display: block; }',
    '}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ------------------------------------------------------------------
  // Build bar
  // ------------------------------------------------------------------
  var bar = document.createElement('div');
  bar.id = 'tfr-nav';

  // Back arrow
  var back = document.createElement('button');
  back.id = 'tfr-back';
  back.setAttribute('aria-label', 'Go back');
  back.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="15 18 9 12 15 6"/></svg>' +
    '<span class="tfr-lbl">Back</span>';
  back.onclick = function () {
    if (document.referrer) {
      try {
        var ref = new URL(document.referrer);
        if (ref.origin === window.location.origin) {
          history.back();
          return;
        }
      } catch (e) {}
    }
    window.location.href = '/app';
  };
  bar.appendChild(back);

  // Forward button
  var fwd = document.createElement('button');
  fwd.id = 'tfr-fwd';
  fwd.setAttribute('aria-label', 'Go forward');
  fwd.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="9 18 15 12 9 6"/></svg>' +
    '<span class="tfr-lbl">Next</span>';
  fwd.onclick = function () { history.forward(); };
  bar.appendChild(fwd);

  // Refresh button
  var refresh = document.createElement('button');
  refresh.id = 'tfr-refresh';
  refresh.setAttribute('aria-label', 'Refresh page');
  refresh.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="23 4 23 10 17 10"/>' +
    '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
    '<span class="tfr-lbl">Refresh</span>';
  refresh.onclick = function () { location.reload(); };
  bar.appendChild(refresh);

  // PWA install button (hidden by default, shown by pwa.js when installable)
  var installBtn = document.createElement('button');
  installBtn.id = 'pwa-header-install-btn';
  installBtn.setAttribute('aria-label', 'Install FACTS app');
  installBtn.style.cssText = 'display:none;align-items:center;gap:5px;color:#10b981;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);cursor:pointer;font-size:0.78rem;font-weight:600;font-family:inherit;padding:0 10px;height:32px;border-radius:6px;white-space:nowrap;flex-shrink:0;margin-left:auto;transition:all 0.15s ease;';
  installBtn.innerHTML = '📲 Install';
  installBtn.onclick = function () {
    if (window.FACTS_PWA && window.FACTS_PWA.triggerInstall) {
      window.FACTS_PWA.triggerInstall();
    }
  };
  bar.appendChild(installBtn);

  // Shortcut links (skip on auth pages)
  if (!isAuth) {
    var div = document.createElement('div');
    div.className = 'tfr-div';
    bar.appendChild(div);

    var shortcuts = document.createElement('div');
    shortcuts.id = 'tfr-shortcuts';

    var links = [
      { label: 'Dashboard',     icon: '📊', href: '/app' },
      { label: 'Transactions',  icon: '💳', href: '/app?tab=transactions' },
      { label: 'Allocations',   icon: '⚙️', href: '/app?tab=allocations' },
      { label: 'Net Worth',     icon: '📈', href: '/net-worth' },
      { label: 'Feed',          icon: '✨', href: '/feed' },
      { label: 'Community',     icon: '🏆', href: '/community' },
      { label: 'Sovereign',     icon: '⚔️', href: '/sovereign' },
      { label: 'Knowledge',     icon: '📚', href: '/knowledge-vault' },
      { label: 'Training',      icon: '🎓', href: '/training' },
      { label: 'Resources',     icon: '🗂️', href: '/resource-center' },
      { label: 'Vault',         icon: '🗄️', href: '/document-vault' },
      { label: 'Masterclass',   icon: '🎓', href: '/benefits-masterclass' },
      { label: 'Scorecard',     icon: '🏅', href: '/scorecard' },
      { label: 'Wallet',        icon: '💰', href: '/wallet' },
      { label: 'Rewards',       icon: '🎁', href: '/rewards' },
      { label: 'Project Net Zero', icon: '🎯', href: '/brokerage-tracker' },
      { label: 'SSC',           icon: '⚡', href: '/ssc' },
      { label: 'Calculator',    icon: '🛒', href: '/shopping-calculator' }
    ];

    links.forEach(function (item) {
      var a = document.createElement('a');
      a.href = item.href;
      a.className = 'tfr-link';
      a.innerHTML = '<span class="tfr-icon">' + item.icon + '</span>' + item.label;

      // Highlight the current page
      var linkPath = item.href.split('?')[0].replace(/\.html$/, '');
      if (pathname === linkPath) {
        a.classList.add('tfr-active');
      }

      shortcuts.appendChild(a);
    });

    bar.appendChild(shortcuts);
  }

  // ------------------------------------------------------------------
  // Inject bar into DOM; push body content down
  // ------------------------------------------------------------------
  function inject() {
    document.body.insertBefore(bar, document.body.firstChild);
    // Offset existing body padding (some pages may already have padding-top)
    var existing = parseInt(window.getComputedStyle(document.body).paddingTop) || 0;
    document.body.style.paddingTop = (existing + 44) + 'px';
  }

  if (document.body) {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject);
  }

  // ── Load XP Header bar (after nav is in DOM) ──────────────────────────
  if (!isAuth) {
    var xpScript = document.createElement('script');
    xpScript.src = '/xp-header.js';
    xpScript.async = true;
    document.head.appendChild(xpScript);
  }

  // ── Load PWA install script (all pages) ──────────────────────────────
  if (!document.querySelector('script[src="/pwa.js"]')) {
    var pwaScript = document.createElement('script');
    pwaScript.src = '/pwa.js';
    pwaScript.defer = true;
    document.head.appendChild(pwaScript);
  }
})();
