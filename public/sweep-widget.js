/**
 * sweep-widget.js — Revolutionary Sweep Notification Widget
 *
 * Injects a floating sweep potential card on the FACTS dashboard.
 * Shows when Sovereignty-tier users have SSC surplus available to sweep.
 * Dismissable per-session. "Sweep Now" executes via mod_sweep API.
 *
 * Vault Unlock: shows 🔓 banner on first SSC login post-upgrade.
 *
 * © T-Dagsis LLC. All rights reserved.
 */
(function () {
  'use strict';

  // Only run once
  if (window.__sweepWidgetLoaded) return;
  window.__sweepWidgetLoaded = true;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const STYLES = `
    #sweep-notify-bar {
      position: fixed;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 100%;
      max-width: 600px;
      z-index: 9000;
      pointer-events: none;
    }

    #sweep-notify-inner {
      margin: 0 12px 12px;
      background: linear-gradient(135deg, #1a1000 0%, #0d0a00 100%);
      border: 1px solid rgba(245,158,11,0.5);
      border-radius: 8px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: all;
      box-shadow: 0 4px 24px rgba(245,158,11,0.15);
      animation: sweepSlideIn 0.35s ease;
    }

    @keyframes sweepSlideIn {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    #sweep-notify-inner.hidden {
      display: none;
    }

    .sweep-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sweep-label {
      font-size: 9px;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: rgba(245,158,11,0.8);
      font-family: 'SF Mono', 'Courier New', monospace;
    }

    .sweep-dismiss {
      background: none;
      border: none;
      color: #555;
      font-size: 16px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .sweep-dismiss:hover { color: #888; }

    .sweep-amount-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    .sweep-dollars {
      font-size: 32px;
      font-weight: 700;
      color: #f59e0b;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      font-family: 'Space Grotesk', 'DM Sans', sans-serif;
    }

    .sweep-sublabel {
      font-size: 11px;
      color: #666;
    }

    .sweep-breakdown {
      font-size: 9px;
      color: #555;
      letter-spacing: 1px;
      font-family: 'SF Mono', 'Courier New', monospace;
    }

    .sweep-cta-row {
      display: flex;
      gap: 8px;
    }

    .sweep-btn-primary {
      flex: 1;
      background: #f59e0b;
      color: #000;
      border: none;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      padding: 10px;
      cursor: pointer;
      border-radius: 4px;
      font-family: inherit;
      transition: opacity 0.15s;
    }
    .sweep-btn-primary:hover { opacity: 0.9; }
    .sweep-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .sweep-btn-secondary {
      background: none;
      border: 1px solid #222;
      color: #555;
      font-size: 9px;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 10px 14px;
      cursor: pointer;
      border-radius: 4px;
      font-family: inherit;
    }
    .sweep-btn-secondary:hover { border-color: #444; color: #888; }

    /* Vault unlock banner */
    #vault-unlock-banner {
      position: fixed;
      top: 70px;
      left: 50%;
      transform: translateX(-50%);
      width: calc(100% - 24px);
      max-width: 580px;
      z-index: 8900;
      background: linear-gradient(135deg, #0d1a1a 0%, #060d10 100%);
      border: 1px solid rgba(6,182,212,0.4);
      border-radius: 8px;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 4px 20px rgba(6,182,212,0.12);
      animation: sweepSlideIn 0.35s ease;
    }

    #vault-unlock-banner.hidden { display: none; }

    .vault-icon { font-size: 22px; flex-shrink: 0; }
    .vault-text { flex: 1; }
    .vault-title {
      font-size: 11px;
      font-weight: 700;
      color: #06b6d4;
      letter-spacing: 1px;
      margin-bottom: 2px;
    }
    .vault-sub {
      font-size: 10px;
      color: #666;
    }
    .vault-dismiss {
      background: none;
      border: none;
      color: #555;
      font-size: 18px;
      cursor: pointer;
      flex-shrink: 0;
    }
  `;

  // ── Inject styles ────────────────────────────────────────────────────────────
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);

  // ── Inject HTML ──────────────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.id = 'sweep-notify-bar';
  container.innerHTML = `
    <div id="sweep-notify-inner" class="hidden">
      <div class="sweep-top-row">
        <span class="sweep-label">⚡ REVOLUTIONARY SWEEP</span>
        <button class="sweep-dismiss" onclick="window.__sweepWidget.dismiss()">×</button>
      </div>
      <div class="sweep-amount-row">
        <span class="sweep-dollars" id="sw-dollars">$0.00</span>
        <span class="sweep-sublabel">ready to deploy</span>
      </div>
      <div class="sweep-breakdown" id="sw-breakdown"></div>
      <div class="sweep-cta-row">
        <button class="sweep-btn-primary" id="sw-sweep-btn" onclick="window.__sweepWidget.execute()">
          SWEEP TO VELOCITY →
        </button>
        <button class="sweep-btn-secondary" onclick="window.__sweepWidget.goToSSC()">
          VIEW LEDGER
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(container);

  // Vault unlock banner (separate)
  const vaultBanner = document.createElement('div');
  vaultBanner.id = 'vault-unlock-banner';
  vaultBanner.className = 'hidden';
  vaultBanner.innerHTML = `
    <div class="vault-icon">🔓</div>
    <div class="vault-text">
      <div class="vault-title" id="vault-title">VAULT UNLOCKED!</div>
      <div class="vault-sub" id="vault-sub">Your locked XP has been converted to spendable Wallet points.</div>
    </div>
    <button class="vault-dismiss" onclick="document.getElementById('vault-unlock-banner').classList.add('hidden')">×</button>
  `;
  document.body.appendChild(vaultBanner);

  // ── Session dismiss state ────────────────────────────────────────────────────
  let _dismissed = false;
  let _sweepPotentialCents = 0;
  let _executing = false;

  // ── API calls ────────────────────────────────────────────────────────────────
  async function loadSweep() {
    if (_dismissed) return;
    try {
      const res = await fetch('/api/mod_sweep/potential');
      if (!res.ok) return;
      const data = await res.json();

      if (data.sweep_potential_cents > 0) {
        _sweepPotentialCents = data.sweep_potential_cents;

        const dollars = (data.sweep_potential_cents / 100).toFixed(2);
        const contrib = (data.eligible_buckets || [])
          .map(b => `${b.bucket.toUpperCase().slice(0,3)} +$${(b.surplus_cents/100).toFixed(2)}`)
          .join(' · ');

        document.getElementById('sw-dollars').textContent = `$${dollars}`;
        document.getElementById('sw-breakdown').textContent = contrib;

        document.getElementById('sweep-notify-inner').classList.remove('hidden');
      } else {
        document.getElementById('sweep-notify-inner').classList.add('hidden');
      }
    } catch (e) {
      // Sweep module not available — silent fail
    }
  }

  async function checkVault() {
    try {
      const res = await fetch('/api/mod_sweep/vault-status');
      if (!res.ok) return;
      const data = await res.json();

      if (data.show_notification) {
        // Auto-unlock
        const unlockRes = await fetch('/api/mod_sweep/vault-unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const unlockData = await unlockRes.json();

        if (unlockData.unlocked && unlockData.minted_points > 0) {
          document.getElementById('vault-title').textContent =
            `🔓 VAULT UNLOCKED! +${unlockData.minted_points} POINTS`;
          document.getElementById('vault-sub').textContent =
            `Your ${unlockData.locked_points} locked XP have been converted to spendable Wallet points.`;
          document.getElementById('vault-unlock-banner').classList.remove('hidden');
          // Auto-dismiss after 8 seconds
          setTimeout(() => {
            document.getElementById('vault-unlock-banner').classList.add('hidden');
          }, 8000);
        }
      }
    } catch (e) {
      // Non-fatal
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__sweepWidget = {
    dismiss() {
      _dismissed = true;
      document.getElementById('sweep-notify-inner').classList.add('hidden');
    },

    goToSSC() {
      window.location.href = '/ssc';
    },

    async execute() {
      if (_executing) return;
      _executing = true;

      const btn = document.getElementById('sw-sweep-btn');
      btn.disabled = true;
      btn.textContent = '⟳ EXECUTING SWEEP...';

      try {
        const res = await fetch('/api/mod_sweep/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();

        if (res.ok && data.executed) {
          btn.textContent = `✓ $${data.total_swept_dollars} SWEPT TO ${(data.target_bucket || 'velocity').toUpperCase()}`;
          setTimeout(() => {
            document.getElementById('sweep-notify-inner').classList.add('hidden');
          }, 2500);
        } else {
          btn.textContent = 'SWEEP NOW →';
          btn.disabled = false;
        }
      } catch (e) {
        btn.textContent = 'SWEEP NOW →';
        btn.disabled = false;
      } finally {
        _executing = false;
      }
    },

    refresh: loadSweep
  };

  // ── Auto-init (delayed to not compete with page load) ─────────────────────────
  // Only run when user is logged in (check via a lightweight endpoint)
  async function autoInit() {
    try {
      // Check auth first
      const meRes = await fetch('/api/auth/me');
      if (!meRes.ok) return;
      const me = await meRes.json();
      if (!me.user) return;

      // Check tier — only run for Sovereignty users
      const tier = (me.user.pricing_tier || me.user.subscription_tier || me.user.plan || '').toLowerCase();
      const isSovereignty = tier.includes('sovereignty') || tier.includes('sovereign');
      if (!isSovereignty) return;

      // Check vault first (one-time banner)
      await checkVault();

      // Then load sweep potential
      await loadSweep();

      // Refresh every 5 minutes while on the page
      setInterval(loadSweep, 5 * 60 * 1000);

    } catch (e) {
      // Not logged in or not Sovereignty — no widget
    }
  }

  // Run after page settles
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(autoInit, 1500));
  } else {
    setTimeout(autoInit, 1500);
  }
})();
