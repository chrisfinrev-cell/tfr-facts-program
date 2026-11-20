// Proprietary – Financial Revolution – All Rights Reserved
/**
 * TFR Persistent XP Header Bar + Level-Up Modal
 * Injects a slim XP progress bar below the nav bar on every app page.
 * Detects level changes from localStorage and fires a celebratory modal.
 *
 * Loaded dynamically by nav-bar.js after the nav is injected.
 */
(function () {
  var pathname = window.location.pathname.replace(/\.html$/, '');

  // Don't show on landing/auth/pricing pages
  var excluded = ['/', '/index', '/app', '/login', '/signup',
    '/forgot-password', '/reset-password', '/nda', '/pricing'];
  if (excluded.indexOf(pathname) !== -1) return;

  // ── Phase & level config ──────────────────────────────────────────────
  var PHASE_COLORS = {
    1: '#cd7f32',  // Bronze
    2: '#a8b8c8',  // Silver
    3: '#c9a227',  // Gold
    4: '#e5e4e2'   // Platinum
  };

  function getPhase(level) {
    if (level <= 3) return 1;
    if (level <= 6) return 2;
    if (level <= 9) return 3;
    return 4;
  }

  // Features unlocked at each level
  var LEVEL_FEATURES = {
    1:  ['FACTS Ledger & manual tracking', 'Daily Check-in XP', 'Sovereign Dashboard'],
    2:  ['Knowledge Vault (Levels 1–2)', 'Community Feed access', 'Leaderboard visibility'],
    3:  ['Full Free Tier unlocked', 'Scorecard tracking', 'Sovereign Oath access'],
    4:  ['What-if Scenario Planner', 'Net Worth Dashboard', 'CSV Export + Plaid sync'],
    5:  ['Debt Elimination Path', 'Debt Payoff Projections', '2× Streak XP Multipliers'],
    6:  ['Family Incubator (5 sub-accounts)', 'family Linking', 'Breakaway hive-off'],
    7:  ['SDIRA Wealth Hub', 'Vantage Point Dashboard', 'Business community'],
    8:  ['Receipt Scanner', 'Business Dashboard', 'Business Heartbeat Audit'],
    9:  ['Friday Sweep Automation', '5-Pillar Allocation Engine', 'Legacy Strategy Vault'],
    10: ['HELOC Velocity Engine', 'Elite community access', 'Levels 10–12 curriculum'],
    11: ['Interest Recapture Tools', '1-on-1 onboarding call', 'Elite badge + rank'],
    12: ['Sovereign Seal 👑', 'Prestige status — Liberation achieved', 'Lifetime achievement']
  };

  var RANK_EMOJIS = ['', '🌱', '🔭', '⚡', '🛡️', '⚔️', '🎖️', '🧩', '🏛️', '🦅', '🔥', '🌟', '👑'];

  // ── CSS ───────────────────────────────────────────────────────────────
  var css = [
    /* XP bar */
    '#tfr-xp-bar {',
    '  position: sticky; top: 44px; z-index: 9990; width: 100%;',
    '  height: 30px; background: rgba(10,15,26,0.95);',
    '  border-bottom: 1px solid rgba(201,162,39,0.10);',
    '  display: flex; align-items: center; padding: 0 16px; gap: 10px;',
    '  box-sizing: border-box;',
    '  font-family: Inter, "DM Sans", system-ui, sans-serif;',
    '  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);',
    '}',
    '#tfr-xp-bar .xb-level {',
    '  display: flex; align-items: center; gap: 6px; flex-shrink: 0;',
    '}',
    '#tfr-xp-bar .xb-badge {',
    '  padding: 1px 7px; border-radius: 4px;',
    '  font-size: 0.67rem; font-weight: 800; letter-spacing: 0.03em;',
    '}',
    '#tfr-xp-bar .xb-name {',
    '  font-size: 0.67rem; color: rgba(255,255,255,0.38);',
    '  font-weight: 500; white-space: nowrap;',
    '}',
    '@media (max-width: 480px) { #tfr-xp-bar .xb-name { display: none; } }',
    '#tfr-xp-bar .xb-track {',
    '  flex: 1; height: 5px; background: rgba(255,255,255,0.06);',
    '  border-radius: 3px; overflow: hidden;',
    '}',
    '#tfr-xp-bar .xb-fill {',
    '  height: 100%; border-radius: 3px;',
    '  transition: width 0.9s cubic-bezier(0.25, 0.8, 0.25, 1);',
    '}',
    '#tfr-xp-bar .xb-xp {',
    '  flex-shrink: 0; font-size: 0.67rem;',
    '  color: rgba(255,255,255,0.35); white-space: nowrap;',
    '}',
    '@media (max-width: 360px) { #tfr-xp-bar .xb-xp { display: none; } }',
    /* Level-Up Modal */
    '#tfr-levelup-overlay {',
    '  position: fixed; inset: 0; z-index: 99999;',
    '  background: rgba(0,0,0,0.85);',
    '  display: flex; align-items: center; justify-content: center;',
    '  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);',
    '}',
    '#tfr-levelup-overlay .lm-card {',
    '  background: linear-gradient(155deg, #0d1117 0%, #111c2e 100%);',
    '  border: 1px solid rgba(255,255,255,0.07);',
    '  border-radius: 22px; padding: 40px 36px;',
    '  max-width: 460px; width: calc(100% - 32px);',
    '  text-align: center; position: relative; overflow: hidden;',
    '  animation: lm-pop 0.45s cubic-bezier(0.175,0.885,0.32,1.3) both;',
    '}',
    '@keyframes lm-pop {',
    '  from { opacity: 0; transform: scale(0.65) translateY(30px); }',
    '  to   { opacity: 1; transform: scale(1) translateY(0); }',
    '}',
    '.lm-glow {',
    '  position: absolute; top: -80px; left: 50%;',
    '  transform: translateX(-50%);',
    '  width: 260px; height: 260px; border-radius: 50%;',
    '  opacity: 0.12; pointer-events: none; filter: blur(40px);',
    '}',
    '.lm-emoji {',
    '  font-size: 3.8rem; margin-bottom: 14px; display: block;',
    '  animation: lm-bounce 0.6s 0.25s ease both;',
    '}',
    '@keyframes lm-bounce {',
    '  0%   { transform: scale(0.3) rotate(-15deg); opacity: 0; }',
    '  65%  { transform: scale(1.25) rotate(5deg); opacity: 1; }',
    '  100% { transform: scale(1) rotate(0deg); }',
    '}',
    '.lm-title {',
    '  font-family: "Space Grotesk", system-ui, sans-serif;',
    '  font-size: clamp(1.6rem, 5vw, 2rem); font-weight: 800;',
    '  margin-bottom: 4px; letter-spacing: -0.5px;',
    '}',
    '.lm-rank-name {',
    '  font-size: 0.78rem; font-weight: 700; letter-spacing: 0.14em;',
    '  text-transform: uppercase; margin-bottom: 4px;',
    '}',
    '.lm-phase-tag {',
    '  font-size: 0.72rem; color: rgba(255,255,255,0.32);',
    '  margin-bottom: 20px; letter-spacing: 0.07em;',
    '}',
    '.lm-divider {',
    '  height: 1px; background: rgba(255,255,255,0.07); margin: 0 0 18px;',
    '}',
    '.lm-unlock-label {',
    '  font-size: 0.7rem; font-weight: 700; color: rgba(255,255,255,0.35);',
    '  text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px;',
    '}',
    '.lm-features {',
    '  list-style: none; text-align: left; margin-bottom: 26px;',
    '}',
    '.lm-features li {',
    '  display: flex; align-items: flex-start; gap: 9px;',
    '  font-size: 0.875rem; color: rgba(255,255,255,0.82);',
    '  margin-bottom: 9px; line-height: 1.4;',
    '  animation: lm-slidein 0.35s ease both;',
    '}',
    '.lm-features li:nth-child(1) { animation-delay: 0.3s; }',
    '.lm-features li:nth-child(2) { animation-delay: 0.42s; }',
    '.lm-features li:nth-child(3) { animation-delay: 0.54s; }',
    '@keyframes lm-slidein {',
    '  from { opacity: 0; transform: translateX(-12px); }',
    '  to   { opacity: 1; transform: translateX(0); }',
    '}',
    '.lm-features li .li-dot {',
    '  font-size: 0.9rem; flex-shrink: 0; margin-top: 1px;',
    '}',
    '.lm-btns {',
    '  display: flex; gap: 10px;',
    '}',
    '.lm-btn-dismiss {',
    '  flex: 1; padding: 12px; border-radius: 11px;',
    '  background: rgba(255,255,255,0.06);',
    '  border: 1px solid rgba(255,255,255,0.1);',
    '  color: rgba(255,255,255,0.55); font-family: inherit;',
    '  font-size: 0.875rem; font-weight: 600; cursor: pointer;',
    '  transition: background 0.15s;',
    '}',
    '.lm-btn-dismiss:hover { background: rgba(255,255,255,0.1); }',
    '.lm-btn-explore {',
    '  flex: 2; padding: 12px; border-radius: 11px;',
    '  border: none; font-family: inherit;',
    '  font-size: 0.875rem; font-weight: 700;',
    '  cursor: pointer; text-decoration: none;',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  transition: opacity 0.15s;',
    '}',
    '.lm-btn-explore:hover { opacity: 0.88; }',
    /* Confetti */
    '.tfr-confetti-piece {',
    '  position: fixed; pointer-events: none; z-index: 100000;',
    '  animation: tfr-cffall linear forwards;',
    '}',
    '@keyframes tfr-cffall {',
    '  0%   { transform: translateY(-10px) rotate(0deg); opacity: 1; }',
    '  100% { transform: translateY(105vh) rotate(720deg); opacity: 0; }',
    '}'
  ].join('\n');

  // ── Inject CSS ────────────────────────────────────────────────────────
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── Build & inject XP bar ─────────────────────────────────────────────
  function injectXpBar(data) {
    if (!data || !data.rank) return;

    var rank  = data.rank;
    var level = rank.level || 1;
    var phase = getPhase(level);
    var col   = PHASE_COLORS[phase];
    var pct   = Math.min(100, Math.max(0, rank.xp_progress || 0));
    var xp    = (data.stats && data.stats.xp) ? data.stats.xp : 0;
    var nextXp = rank.next_xp_threshold || rank.xp_to_next || 0;

    var bar = document.createElement('div');
    bar.id = 'tfr-xp-bar';
    bar.setAttribute('aria-label', 'Sovereign Level Progress');
    bar.innerHTML =
      '<div class="xb-level">' +
        '<span class="xb-badge" style="background:' + col + '18;color:' + col + ';border:1px solid ' + col + '38;">' +
          'L' + level +
        '</span>' +
        '<span class="xb-name">' + (rank.name || '') + '</span>' +
      '</div>' +
      '<div class="xb-track" title="' + xp.toLocaleString() + ' / ' + nextXp.toLocaleString() + ' XP">' +
        '<div class="xb-fill" style="width:' + pct + '%;background:linear-gradient(90deg,' + col + 'cc,' + col + ');"></div>' +
      '</div>' +
      '<div class="xb-xp">' + xp.toLocaleString() + ' XP</div>';

    // Insert right after the nav bar
    function doInsert() {
      var nav = document.getElementById('tfr-nav');
      if (nav && nav.parentNode) {
        nav.parentNode.insertBefore(bar, nav.nextSibling);
      } else {
        document.body.insertBefore(bar, document.body.firstChild);
      }
      // Push body content down by bar height
      var cur = parseInt(document.body.style.paddingTop) || 0;
      document.body.style.paddingTop = (cur + 30) + 'px';

      // Animate fill in after a tick (so transition fires)
      var fill = document.getElementById('tfr-xb-fill');
      if (fill) {
        fill.style.width = '0%';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            fill.style.width = pct + '%';
          });
        });
      }
    }

    if (document.body) {
      doInsert();
    } else {
      document.addEventListener('DOMContentLoaded', doInsert);
    }

    // Check for level-up
    checkLevelUp(data);
  }

  // ── Level-up detection ────────────────────────────────────────────────
  function checkLevelUp(data) {
    var currentLevel = (data.rank && data.rank.level) ? data.rank.level : 1;
    var stored = parseInt(localStorage.getItem('tfr_last_known_level') || '0');

    if (stored > 0 && currentLevel > stored) {
      showLevelUpModal(data, currentLevel);
    }

    // Always sync stored level
    localStorage.setItem('tfr_last_known_level', String(currentLevel));
  }

  // ── Level-Up Modal ────────────────────────────────────────────────────
  function showLevelUpModal(data, newLevel) {
    var rank     = data.rank || {};
    var phase    = getPhase(newLevel);
    var col      = PHASE_COLORS[phase];
    var features = LEVEL_FEATURES[newLevel] || [];
    var emoji    = RANK_EMOJIS[newLevel] || '🏆';

    // Dark text on light phases (platinum/silver)
    var textOnColor = (phase >= 4) ? '#000' : '#0a0f1a';

    launchConfetti(col);

    var overlay = document.createElement('div');
    overlay.id = 'tfr-levelup-overlay';

    var featuresHtml = features.map(function (f) {
      return '<li><span class="li-dot" style="color:' + col + '">✦</span>' + f + '</li>';
    }).join('');

    var phaseTag = rank.phase
      ? 'Phase ' + rank.phase + (rank.phase_name ? ': ' + rank.phase_name : '')
      : '';

    overlay.innerHTML =
      '<div class="lm-card">' +
        '<div class="lm-glow" style="background:' + col + ';"></div>' +
        '<div style="position:relative;">' +
          '<span class="lm-emoji">' + emoji + '</span>' +
          '<div class="lm-title" style="color:' + col + '">Level ' + newLevel + ' Achieved!</div>' +
          '<div class="lm-rank-name" style="color:' + col + 'bb">' + (rank.name || '') + '</div>' +
          (phaseTag ? '<div class="lm-phase-tag">' + phaseTag + '</div>' : '') +
          '<div class="lm-divider"></div>' +
          (features.length > 0
            ? '<div class="lm-unlock-label">🔓 Now Unlocked</div>' +
              '<ul class="lm-features">' + featuresHtml + '</ul>'
            : '') +
          '<div class="lm-btns">' +
            '<button class="lm-btn-dismiss" id="lm-dismiss-btn">Dismiss</button>' +
            '<a href="/sovereign" class="lm-btn-explore" ' +
               'style="background:' + col + ';color:' + textOnColor + ';">' +
              'Explore New Features →' +
            '</a>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    // Dismiss handlers
    function dismiss() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    document.getElementById('lm-dismiss-btn').addEventListener('click', dismiss);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) dismiss();
    });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', handler); }
    });
  }

  // ── Confetti ──────────────────────────────────────────────────────────
  function launchConfetti(primaryColor) {
    var palette = [primaryColor, '#e8c96a', '#10b981', '#a78bfa', '#f43f5e', '#38bdf8', '#fb923c'];
    for (var i = 0; i < 72; i++) {
      (function () {
        var piece   = document.createElement('div');
        piece.className = 'tfr-confetti-piece';
        var c       = palette[Math.floor(Math.random() * palette.length)];
        var left    = Math.random() * 100;
        var delay   = Math.random() * 0.6;
        var dur     = 1.6 + Math.random() * 2;
        var size    = 6 + Math.random() * 7;
        var radius  = Math.random() > 0.5 ? '50%' : '2px';
        piece.style.cssText =
          'left:' + left + 'vw;top:-10px;' +
          'width:' + size + 'px;height:' + size + 'px;' +
          'background:' + c + ';border-radius:' + radius + ';' +
          'animation-delay:' + delay + 's;animation-duration:' + dur + 's;';
        document.body.appendChild(piece);
        setTimeout(function () {
          if (piece.parentNode) piece.parentNode.removeChild(piece);
        }, Math.ceil((delay + dur) * 1000) + 200);
      }());
    }
  }

  // ── Fetch TFR status ──────────────────────────────────────────────────
  fetch('/api/tfr/status', { credentials: 'same-origin' })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data && data.success && data.rank) {
        injectXpBar(data);
      }
    })
    .catch(function () { /* Non-fatal — page still works */ });

}());
