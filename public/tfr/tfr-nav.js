/**
 * TFR marketing nav + footer. Include as <script src="tfr-nav.js"></script>
 * after <body>. Self-contained — no Tailwind required.
 */
(function () {
  'use strict';

  var FACTS_WEB = 'https://factsmoney.com';
  var FACTS_APP = 'https://app.factsmoney.com';
  var host = (location.hostname || '').toLowerCase();
  var local = host === 'localhost' || host === '127.0.0.1';
  var onTfrDomain = host === 'thefinancialrevolution.net' || host === 'www.thefinancialrevolution.net';

  function tfrHref(file) {
    file = String(file || 'index.html').replace(/^\//, '');
    if (location.pathname.indexOf('/tfr') === 0) return file;
    if (onTfrDomain) return '/' + file;
    return file;
  }
  function factsHref(path) {
    if (local) return path || '/';
    return FACTS_WEB + (path || '/');
  }
  function appHref(path) {
    if (local) return path || '/app.html';
    return FACTS_APP + (path || '/');
  }

  var pages = [
    { href: tfrHref('library.html'), label: 'Library' },
    { href: tfrHref('programs.html'), label: 'Programs' },
    { href: tfrHref('modules.html'), label: 'Modules' },
    { href: tfrHref('tools.html'), label: 'Tools' },
    { href: tfrHref('about.html'), label: 'About' }
  ];

  var css = [
    '#tfr-header{position:sticky;top:0;z-index:50;background:rgba(7,8,13,.94);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.06);}',
    '#tfr-header *{box-sizing:border-box;}',
    '#tfr-bar{max-width:70rem;margin:0 auto;padding:0 1.25rem;height:5.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;}',
    '#tfr-brand{display:flex;align-items:center;text-decoration:none;flex-shrink:0;color:inherit;}',
    '.tfr-logo{height:4.6rem;width:auto;display:block;border-radius:10px;}',
    '.tfr-logo-footer{height:7.5rem;width:auto;display:block;border-radius:12px;margin-bottom:.8rem;}',
    '#tfr-desktop{display:none;align-items:center;gap:1.35rem;}',
    '#tfr-cta{display:none;align-items:center;gap:.75rem;}',
    '.tfr-link{color:#9ca3af;font-size:.875rem;font-weight:500;text-decoration:none;}',
    '.tfr-link:hover,.tfr-link.tfr-active{color:#e8c96a;}',
    '.tfr-btn{display:inline-flex;align-items:center;background:linear-gradient(135deg,#c9a227,#e8c96a);color:#0d1117;font-weight:700;font-size:.82rem;padding:.55rem 1.15rem;border-radius:10px;text-decoration:none;}',
    '#tfr-ham{display:flex;flex-direction:column;gap:.35rem;padding:.5rem;background:none;border:none;cursor:pointer;}',
    '.tfr-ham-line{display:block;width:1.2rem;height:2px;background:#9ca3af;}',
    '#tfr-mobile{display:none;flex-direction:column;background:rgba(7,8,13,.98);border-top:1px solid rgba(255,255,255,.06);}',
    '#tfr-mobile.tfr-open{display:flex;}',
    '#tfr-mobile a{color:#9ca3af;text-decoration:none;padding:.8rem 1.25rem;border-bottom:1px solid rgba(255,255,255,.05);}',
    '#tfr-footer{border-top:1px solid rgba(255,255,255,.06);background:#07080d;padding:3rem 1.25rem 2rem;}',
    '#tfr-footer-inner{max-width:70rem;margin:0 auto;}',
    '#tfr-footer-grid{display:grid;grid-template-columns:1fr;gap:2rem;margin-bottom:2rem;}',
    '#tfr-footer h4{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:#6b7280;margin:0 0 .8rem;font-family:system-ui,sans-serif;}',
    '#tfr-footer ul{list-style:none;margin:0;padding:0;}',
    '#tfr-footer li{margin:0 0 .45rem;}',
    '#tfr-footer a{color:#6b7280;text-decoration:none;font-size:.875rem;}',
    '#tfr-footer a:hover{color:#d1d5db;}',
    '#tfr-copy{font-size:.75rem;color:#6b7280;border-top:1px solid rgba(201,162,39,.25);padding-top:1.25rem;}',
    '@media(min-width:768px){#tfr-desktop{display:flex;}#tfr-cta{display:flex;}#tfr-ham{display:none;}#tfr-mobile{display:none!important;}#tfr-footer-grid{grid-template-columns:1.4fr 1fr 1fr 1fr;}}'
  ].join('');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  window._tfrToggle = function () {
    var m = document.getElementById('tfr-mobile');
    if (m) m.classList.toggle('tfr-open');
  };

  function links(cls) {
    return pages.map(function (p) {
      return '<a href="' + p.href + '" class="' + cls + '">' + p.label + '</a>';
    }).join('');
  }

  var home = tfrHref('index.html');
  var navHTML = [
    '<header id="tfr-header"><div id="tfr-bar">',
    '<a href="' + home + '" id="tfr-brand"><img class="tfr-logo" src="' + tfrHref('tfr-logo.jpg') + '" alt="The Financial Revolution"></a>',
    '<nav id="tfr-desktop">' + links('tfr-link') + '</nav>',
    '<div id="tfr-cta"><a class="tfr-btn" href="' + appHref('/signup.html') + '">Open FACTS Engine →</a></div>',
    '<button id="tfr-ham" onclick="window._tfrToggle()" aria-label="Menu"><span class="tfr-ham-line"></span><span class="tfr-ham-line"></span><span class="tfr-ham-line"></span></button>',
    '</div><div id="tfr-mobile">' + links('') +
    '<a href="' + appHref('/signup.html') + '">Open FACTS Engine →</a></div></header>'
  ].join('');

  var footerHTML = [
    '<footer id="tfr-footer"><div id="tfr-footer-inner"><div id="tfr-footer-grid">',
    '<div><img class="tfr-logo-footer" src="' + tfrHref('tfr-logo.jpg') + '" alt="The Financial Revolution">',
    '<p style="color:#6b7280;font-size:.85rem;line-height:1.6;margin:0;">Education, programs, modules, and public tools. The allocation engine lives on factsmoney.com.</p></div>',
    '<div><h4>Learn</h4><ul>',
    '<li><a href="' + tfrHref('library.html') + '">Education Library</a></li>',
    '<li><a href="' + tfrHref('programs.html') + '">Programs</a></li>',
    '<li><a href="' + tfrHref('modules.html') + '">Modules</a></li>',
    '<li><a href="' + tfrHref('tools.html') + '">Tools</a></li>',
    '</ul></div>',
    '<div><h4>Engine</h4><ul>',
    '<li><a href="' + factsHref('/') + '">FACTS Home</a></li>',
    '<li><a href="' + factsHref('/pricing') + '">Pricing</a></li>',
    '<li><a href="' + appHref('/signup.html') + '">Create account</a></li>',
    '<li><a href="' + appHref('/login.html') + '">Log in</a></li>',
    '</ul></div>',
    '<div><h4>Company</h4><ul>',
    '<li><a href="' + tfrHref('about.html') + '">The movement</a></li>',
    '<li><a href="' + factsHref('/about') + '">About FACTS</a></li>',
    '<li><a href="' + (local ? '/terms-of-service.html' : FACTS_APP + '/terms-of-service.html') + '">Terms</a></li>',
    '</ul></div></div>',
    '<div id="tfr-copy"><p>© 2026 The Financial Revolution. Educational only — not financial, legal, tax, lending, or credit-repair advice. We do not hold user funds.</p>',
    '<p style="margin:.6rem 0 0;">FACTS™ is the allocation engine at <a href="' + factsHref('/') + '" style="color:#c9a227;">factsmoney.com</a>.</p></div></div></footer>'
  ].join('');

  document.body.insertAdjacentHTML('afterbegin', navHTML);
  function injectFooter() { document.body.insertAdjacentHTML('beforeend', footerHTML); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFooter);
  } else {
    injectFooter();
  }

  window.TFR_NAV = { tfrHref: tfrHref, factsHref: factsHref, appHref: appHref, local: local };
})();
