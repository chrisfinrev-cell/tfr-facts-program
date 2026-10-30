/**
 * ToolboxVaultCard — vanilla mount for GET /api/vault/eligibility/:userId
 * Levels 1–6: hidden. Below 12-week streak: locked silhouette. 12+: unlocked Elite/Business.
 */
(function (global) {
  'use strict';

  var STYLE_ID = 'toolbox-vault-card-css';
  var CSS = [
    '.tvc{padding:1.5rem;border-radius:0.5rem;margin-bottom:1.5rem;font-family:Inter,system-ui,sans-serif}',
    '.tvc-loading{padding:1rem;border:1px solid #1e2d4a;border-radius:0.5rem;color:#94a3b8;background:#0d1528}',
    '.tvc-locked{border:1px solid #374151;background:#111827;color:#9ca3af;opacity:0.9}',
    '.tvc-open{border:1px solid #10b981;background:#111827;color:#fff;box-shadow:0 10px 24px rgba(16,185,129,0.12)}',
    '.tvc-head{display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:1rem}',
    '.tvc-title{font-size:1.25rem;font-weight:700;margin:0}',
    '.tvc-open .tvc-title{color:#34d399}',
    '.tvc-badge{font-size:0.75rem;padding:0.25rem 0.75rem;border-radius:0.25rem;white-space:nowrap}',
    '.tvc-badge-lock{background:#1f2937;color:#9ca3af}',
    '.tvc-badge-open{background:#022c22;color:#34d399;border:1px solid #065f46}',
    '.tvc-copy{font-size:0.875rem;margin:0 0 1rem;line-height:1.5}',
    '.tvc-open .tvc-copy{color:#d1d5db}',
    '.tvc-bar{width:100%;background:#1f2937;border-radius:999px;height:0.75rem;margin-bottom:0.5rem;overflow:hidden}',
    '.tvc-bar-fill{background:#eab308;height:100%;border-radius:999px;transition:width 0.3s}',
    '.tvc-meta{font-size:0.75rem;text-align:right;color:#6b7280}',
    '.tvc-foot{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:0.75rem;border-top:1px solid #1f2937;flex-wrap:wrap}',
    '.tvc-cost{font-size:1.125rem;font-weight:600;color:#6ee7b7}',
    '.tvc-btn{padding:0.5rem 1rem;background:#059669;color:#fff;font-weight:700;border:none;border-radius:0.375rem;cursor:pointer}',
    '.tvc-btn:hover{background:#10b981}'
  ].join('');

  function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 401) {
          var err = new Error('Unauthorized');
          err.status = 401;
          throw err;
        }
        if (!res.ok) throw new Error('Network error ' + res.status);
        return res.json();
      });
  }

  function renderLocked(el, eligibility) {
    var weeks = (eligibility && eligibility.streakWeeks) || 0;
    var pct = Math.min(100, (weeks / 12) * 100);
    el.innerHTML =
      '<div class="tvc tvc-locked">' +
        '<div class="tvc-head">' +
          '<h3 class="tvc-title">🔒 Sovereign Lending Desk</h3>' +
          '<span class="tvc-badge tvc-badge-lock">Locked Silhouette</span>' +
        '</div>' +
        '<p class="tvc-copy">Complete a 12-week Friday Sweep streak to unlock access to the Sovereign Lending Desk and 9 Funding Pods.</p>' +
        '<div class="tvc-bar"><div class="tvc-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="tvc-meta">Streak Progress: ' + esc(weeks) + ' / 12 Weeks</div>' +
      '</div>';
  }

  function renderOpen(el, eligibility, onUnlock) {
    el.innerHTML =
      '<div class="tvc tvc-open">' +
        '<div class="tvc-head">' +
          '<h3 class="tvc-title">🔓 Sovereign Lending Desk</h3>' +
          '<span class="tvc-badge tvc-badge-open">' + esc(eligibility.tier) + '</span>' +
        '</div>' +
        '<p class="tvc-copy">Behavioral gate passed! Access 9 Funding Pods, Asset Shields, and Truth in Lending document orchestration.</p>' +
        '<div class="tvc-foot">' +
          '<span class="tvc-cost">Add-on: ' + esc(eligibility.unlockCost) + '</span>' +
          '<button type="button" class="tvc-btn" data-tvc-unlock>Unlock Orchestration</button>' +
        '</div>' +
      '</div>';
    var btn = el.querySelector('[data-tvc-unlock]');
    if (btn && typeof onUnlock === 'function') {
      btn.addEventListener('click', onUnlock);
    }
  }

  function mountToolboxVaultCard(container, options) {
    if (!container) return Promise.resolve();
    ensureCss();
    options = options || {};
    container.innerHTML = '<div class="tvc-loading">Loading Toolbox...</div>';

    return fetchJson('/api/auth/me').then(function (me) {
      if (!me || !me.authenticated || !me.user) {
        container.innerHTML = '';
        if (options.redirectOnAuth === false) return;
        window.location.href = '/login';
        return;
      }
      var userId = options.userId || me.user.id;
      var levelPromise = options.userLevel != null
        ? Promise.resolve(options.userLevel)
        : fetchJson('/api/mod_gamification/user/' + userId + '/status')
          .then(function (s) { return s && s.current_level != null ? Number(s.current_level) : 1; })
          .catch(function () { return 1; });

      return levelPromise.then(function (userLevel) {
        if (userLevel <= 6) {
          container.innerHTML = '';
          container.setAttribute('data-tvc-hidden', 'level');
          return;
        }
        return fetchJson('/api/vault/eligibility/' + userId).then(function (eligibility) {
          if (!eligibility || !eligibility.eligible) {
            renderLocked(container, eligibility);
          } else {
            renderOpen(container, eligibility, options.onUnlock);
          }
        });
      });
    }).catch(function (err) {
      console.error('Failed to load vault eligibility:', err);
      if (err && err.status === 401) {
        container.innerHTML = '';
        if (options.redirectOnAuth !== false) window.location.href = '/login';
        return;
      }
      container.innerHTML = '<div class="tvc-loading">Unable to load Toolbox.</div>';
    });
  }

  global.mountToolboxVaultCard = mountToolboxVaultCard;
})(typeof window !== 'undefined' ? window : this);
