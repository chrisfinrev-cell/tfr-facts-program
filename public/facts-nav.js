/**
 * FACTS Marketing Site — Shared Nav + Footer Injector
 * Include after body open: <script src="/facts-nav.js"></script>
 * Self-contained — no Tailwind or external CSS framework required.
 */
(function() {
  'use strict';

  if (!document.querySelector('script[src="/tfr-host-gate.js"]')) {
    var gate = document.createElement('script');
    gate.src = '/tfr-host-gate.js';
    document.head.appendChild(gate);
  }

  var pages = [
    { href: '/products', label: 'Products' },
    { href: '/pricing',  label: 'Pricing'  },
    { href: '/tfr/',     label: 'Education' },
    { href: '/partners', label: 'Partners' },
    { href: '/about',    label: 'About'    }
  ];

  var APP_URL = 'https://app.factsmoney.com';

  // ── Inject scoped styles for responsive behavior ──────────────────
  var css = [
    '/* FACTS Nav Injector — scoped styles */',
    '#fn-header { position: sticky; top: 0; z-index: 50; background: rgba(13,17,23,0.94); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid rgba(255,255,255,0.06); }',
    '#fn-header * { box-sizing: border-box; }',
    '#fn-bar { max-width: 80rem; margin: 0 auto; padding: 0 1rem; height: 5.25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }',

    /* Brand — lockup already includes the FACTS wordmark and tagline */
    '#fn-brand { display: flex; align-items: center; text-decoration: none; flex-shrink: 0; min-width: 0; }',
    '#fn-brand-logo { display: block; height: 4.75rem; width: auto; border-radius: 10px; }',

    /* Desktop nav */
    '#fn-desktop-nav { display: none; align-items: center; gap: 1.5rem; }',
    '#fn-desktop-cta { display: none; align-items: center; gap: 0.75rem; }',

    /* Nav links */
    '.fn-nav-link { color: #9ca3af; transition: color 0.2s; font-size: 0.875rem; font-weight: 500; text-decoration: none; }',
    '.fn-nav-link:hover { color: #fff; }',
    '.fn-nav-link.fn-active { color: #c9a227; }',

    /* CTA buttons */
    '.fn-btn-login { display: inline-flex; align-items: center; color: #9ca3af; font-size: 0.875rem; font-weight: 500; text-decoration: none; padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid rgba(255,255,255,0.1); transition: color 0.2s; }',
    '.fn-btn-login:hover { color: #fff; }',
    '.fn-btn-primary { display: inline-flex; align-items: center; gap: 0.5rem; background: linear-gradient(135deg, #c9a227, #e8c96a); color: #0d1117; font-weight: 700; font-size: 0.85rem; letter-spacing: 0.01em; padding: 0.6rem 1.4rem; border-radius: 10px; text-decoration: none; transition: opacity 0.2s, transform 0.2s; }',
    '.fn-btn-primary:hover { opacity: 0.92; transform: translateY(-1px); }',

    /* Hamburger */
    '#fn-hamburger { display: flex; flex-direction: column; gap: 0.375rem; padding: 0.5rem; background: none; border: none; cursor: pointer; }',
    '.fn-ham-line { display: block; width: 1.25rem; height: 2px; background: #9ca3af; transition: all 0.3s; }',

    /* Mobile menu */
    '#fn-mobile-menu { display: none; flex-direction: column; background: rgba(13,17,23,0.98); border-top: 1px solid rgba(255,255,255,0.06); }',
    '#fn-mobile-menu.fn-open { display: flex; }',
    '#fn-mobile-inner { max-width: 80rem; margin: 0 auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.25rem; width: 100%; }',
    '.fn-mobile-link { color: #9ca3af; font-size: 0.875rem; font-weight: 500; text-decoration: none; padding: 0.75rem 0; border-bottom: 1px solid rgba(255,255,255,0.06); transition: color 0.2s; }',
    '.fn-mobile-link:hover { color: #fff; }',
    '#fn-mobile-ctas { display: flex; gap: 0.75rem; padding-top: 0.75rem; }',
    '#fn-mobile-ctas a { flex: 1; text-align: center; padding: 0.625rem 1rem; border-radius: 0.5rem; font-size: 0.875rem; font-weight: 500; text-decoration: none; }',
    '.fn-mobile-login { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #d1d5db; }',
    '.fn-mobile-signup { background: linear-gradient(135deg, #c9a227, #e8c96a); color: #0d1117; font-weight: 700; }',

    /* Footer */
    '#fn-footer { background: #0d1117; border-top: 1px solid rgba(255,255,255,0.05); }',
    '#fn-footer * { box-sizing: border-box; }',
    '#fn-footer-inner { max-width: 80rem; margin: 0 auto; padding: 3rem 1rem; }',
    '#fn-footer-grid { display: grid; grid-template-columns: 1fr; gap: 2.5rem; margin-bottom: 2.5rem; }',
    '.fn-footer-col h4 { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #6b7280; margin-bottom: 1rem; font-family: system-ui, sans-serif; }',
    '.fn-footer-col ul { list-style: none; margin: 0; padding: 0; }',
    '.fn-footer-col li { margin-bottom: 0.5rem; }',
    '.fn-footer-col li a { color: #6b7280; text-decoration: none; font-size: 0.875rem; transition: color 0.2s; }',
    '.fn-footer-col li a:hover { color: #d1d5db; }',
    '#fn-footer-brand { display: block; margin-bottom: 1rem; }',
    '#fn-footer-logo { display: block; width: 15rem; max-width: 100%; height: auto; border-radius: 12px; }',
    '#fn-footer-tagline { font-size: 0.75rem; color: #6b7280; line-height: 1.6; margin: 0; }',
    '#fn-footer-divider { background: linear-gradient(90deg, transparent, rgba(201,162,39,0.35), transparent); height: 1px; margin-bottom: 1.5rem; }',
    '#fn-footer-bottom { display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 1rem; font-size: 0.75rem; color: #6b7280; }',
    '#fn-footer-bottom p { margin: 0; color: #6b7280; font-size: 0.75rem; }',

    /* PWA install button in nav */
    '#fn-pwa-install { display: none; align-items: center; gap: 6px; padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.82rem; font-weight: 600; background: rgba(201,162,39,0.1); color: #c9a227; border: 1px solid rgba(201,162,39,0.3); cursor: pointer; transition: all 0.2s; white-space: nowrap; }',

    '/* Responsive: sm (640px+) */',
    '@media (min-width: 640px) {',
    '  #fn-bar { padding: 0 1.5rem; }',
    '  #fn-footer-inner { padding: 3rem 1.5rem; }',
    '  #fn-footer-grid { grid-template-columns: 1fr 1fr; }',
    '  #fn-footer-bottom { flex-direction: row; }',
    '}',
    '/* Responsive: md (768px+) */',
    '@media (min-width: 768px) {',
    '  #fn-desktop-nav { display: flex; }',
    '  #fn-desktop-cta { display: flex; }',
    '  #fn-hamburger { display: none; }',
    '  #fn-mobile-menu { display: none !important; }',
    '}',
    '/* Responsive: lg (1024px+) */',
    '@media (min-width: 1024px) {',
    '  #fn-footer-grid { grid-template-columns: 1.2fr 1fr 1fr 1fr; }',
    '}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── Mobile menu toggle — declared BEFORE navHTML uses it via onclick.
  // Inline onclick="window._fnToggleMenu()" fires when the HTML is parsed,
  // so the function must exist at document.body.insertAdjacentHTML time.
  window._fnToggleMenu = function() {
    var menu = document.getElementById('fn-mobile-menu');
    var h1 = document.getElementById('fn-ham-1');
    var h2 = document.getElementById('fn-ham-2');
    var h3 = document.getElementById('fn-ham-3');
    var isOpen = menu && menu.classList.contains('fn-open');
    if (isOpen) {
      menu.classList.remove('fn-open');
      if (h1) h1.style.transform = '';
      if (h2) h2.style.opacity = '1';
      if (h3) h3.style.transform = '';
    } else {
      if (menu) {
        menu.classList.add('fn-open');
        if (h1) h1.style.transform = 'rotate(45deg) translate(4px, 4px)';
        if (h2) h2.style.opacity = '0';
        if (h3) h3.style.transform = 'rotate(-45deg) translate(4px, -4px)';
      }
    }
  };
  window.toggleMobileMenu = window._fnToggleMenu;

  // ── Build nav link HTML ───────────────────────────────────────────
  function makeDesktopLinks() {
    return pages.map(function(p) {
      return '<a href="' + p.href + '" class="fn-nav-link">' + p.label + '</a>';
    }).join('');
  }

  function makeMobileLinks() {
    return pages.map(function(p) {
      return '<a href="' + p.href + '" class="fn-mobile-link">' + p.label + '</a>';
    }).join('');
  }

  // ── Header HTML ───────────────────────────────────────────────────
  var navHTML = [
    '<header id="fn-header">',
    '<div id="fn-bar">',

    // Brand
    '<a href="/" id="fn-brand">',
    '<img id="fn-brand-logo" src="/facts-logo.jpg" alt="FACTS — Financial Allocation Control &amp; Tracking System">',
    '</a>',

    // Desktop nav links
    '<nav id="fn-desktop-nav">' + makeDesktopLinks() + '</nav>',

    // Desktop CTAs
    '<div id="fn-desktop-cta">',
    '<button id="fn-pwa-install" onclick="window.FACTS_PWA && window.FACTS_PWA.triggerInstall()">⬇ Install App</button>',
    '<a href="' + APP_URL + '/login.html" class="fn-btn-login">Log In</a>',
    '<a href="' + APP_URL + '/signup.html" class="fn-btn-primary">Start Free →</a>',
    '</div>',

    // Hamburger (mobile only)
    '<button id="fn-hamburger" onclick="window._fnToggleMenu()" aria-label="Menu">',
    '<span class="fn-ham-line" id="fn-ham-1"></span>',
    '<span class="fn-ham-line" id="fn-ham-2"></span>',
    '<span class="fn-ham-line" id="fn-ham-3"></span>',
    '</button>',

    '</div>',

    // Mobile menu (hidden by default)
    '<div id="fn-mobile-menu">',
    '<div id="fn-mobile-inner">',
    makeMobileLinks(),
    '<div id="fn-mobile-ctas">',
    '<a href="' + APP_URL + '/login.html" class="fn-mobile-login">Log In</a>',
    '<a href="' + APP_URL + '/signup.html" class="fn-mobile-signup">Start Free →</a>',
    '</div></div></div>',

    '</header>'
  ].join('');

  // ── Footer HTML ───────────────────────────────────────────────────
  var footerHTML = [
    '<footer id="fn-footer">',
    '<div id="fn-footer-inner">',
    '<div id="fn-footer-grid">',

    // Column 1: Brand
    '<div class="fn-footer-col">',
    '<div id="fn-footer-brand">',
    '<img id="fn-footer-logo" src="/facts-logo.jpg" alt="FACTS — Financial Allocation Control &amp; Tracking System">',
    '</div>',
    '<p id="fn-footer-tagline">The system that replaces budgeting with freedom.</p>',
    '</div>',

    // Column 2: Product
    '<div class="fn-footer-col">',
    '<h4>Product</h4>',
    '<ul>',
    '<li><a href="/products">Products</a></li>',
    '<li><a href="/pricing">Pricing</a></li>',
    '<li><a href="/tfr/">Education Library</a></li>',
    '<li><a href="https://app.factsmoney.com/app">Open App ↗</a></li>',
    '</ul></div>',

    // Column 3: Company
    '<div class="fn-footer-col">',
    '<h4>Company</h4>',
    '<ul>',
    '<li><a href="/about">Our Mission</a></li>',
    '<li><a href="https://thefinancialrevolution.net">The Financial Revolution</a></li>',
    '<li><a href="https://app.factsmoney.com/future-generations.html">Affiliate Program</a></li>',
    '<li><a href="https://app.factsmoney.com/terms-of-service.html">Terms of Service</a></li>',
    '</ul></div>',

    // Column 4: Get Started
    '<div class="fn-footer-col">',
    '<h4>Get Started</h4>',
    '<ul>',
    '<li><a href="https://app.factsmoney.com/signup.html">Get Started</a></li>',
    '<li><a href="https://app.factsmoney.com/login.html">Log In</a></li>',
    '</ul></div>',

    '</div>',

    // Divider
    '<div id="fn-footer-divider"></div>',

    // Bottom row
    '<div id="fn-footer-bottom">',
    '<p>© 2026 FACTS. All rights reserved.</p>',
    '<p>Built on the principle that financial freedom isn\'t a destination — it\'s a practice.</p>',
    '</div></div></footer>'
  ].join('');

  // ── Inject ────────────────────────────────────────────────────────
  // Header goes at the very start of <body> — safe to inject immediately.
  document.body.insertAdjacentHTML('afterbegin', navHTML);

  // Footer must wait for the full DOM to be parsed. During synchronous
  // script execution 'beforeend' means "after the last node parsed so far",
  // which on interior pages is the <script> tag itself — placing the footer
  // ABOVE all page content that follows. Deferring to DOMContentLoaded
  // ensures the footer truly lands at the bottom.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      document.body.insertAdjacentHTML('beforeend', footerHTML);
    });
  } else {
    // DOM already parsed (e.g. script loaded with defer/async)
    document.body.insertAdjacentHTML('beforeend', footerHTML);
  }

  // ── Referral capture across all pages ─────────────────────────────
  (function() {
    var params = new URLSearchParams(window.location.search);
    var ref = params.get('ref');
    if (ref) {
      try { sessionStorage.setItem('facts_ref', ref); } catch(e) {}
    }
    var stored = '';
    try { stored = sessionStorage.getItem('facts_ref') || ''; } catch(e) {}
    if (stored) {
      document.addEventListener('DOMContentLoaded', function() {
        var links = document.querySelectorAll('a[href*="signup"]');
        links.forEach(function(link) {
          try {
            var url = new URL(link.href);
            url.searchParams.set('ref', stored);
            link.href = url.toString();
          } catch(e) {}
        });
      });
    }
  })();

  // ── Inject PWA script ─────────────────────────────────────────────
  (function() {
    if (document.querySelector('script[src="/pwa.js"]')) return;
    var s = document.createElement('script');
    s.src = '/pwa.js';
    s.defer = true;
    document.head.appendChild(s);
  })();

  // ── Map legacy PWA install button ID for pwa.js compatibility ─────
  // pwa.js looks for #pwa-header-install-btn; alias our new button
  (function() {
    var btn = document.getElementById('fn-pwa-install');
    if (btn) { btn.id = 'pwa-header-install-btn'; }
  })();

})();
