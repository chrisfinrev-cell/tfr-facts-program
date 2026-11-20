/**
 * Allocation Coach Widget — FACTS Financial Coach
 *
 * Injects a floating chat widget into any page that includes this script.
 * Tier-gated: Free gets nudge-only, Individual+ gets chat.
 *
 * Usage: <script src="/js/ai-coach.js" defer></script>
 *
 * The widget auto-loads, checks tier, and renders appropriately.
 */

(function () {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────────
  const WIDGET_ID = 'facts-ai-coach';
  const STORAGE_KEY = 'facts_coach_open';
  const NUDGE_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes between nudges
  const NUDGE_STORAGE_KEY = 'facts_coach_last_nudge';

  // ─── Styles ────────────────────────────────────────────────────────────────
  const STYLES = `
    #${WIDGET_ID}-btn {
      position: fixed;
      bottom: 90px;
      right: 20px;
      width: 56px;
      height: 56px;
      min-width: 56px;
      min-height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #f59e0b, #d97706);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(245,158,11,.4);
      z-index: 9995;
      transition: transform .2s, box-shadow .2s;
      font-size: 24px;
      line-height: 1;
      overflow: visible;
      box-sizing: border-box;
      -webkit-appearance: none;
      padding: 0;
      margin: 0;
      /* WHY: clip-path:none prevents any ancestor clip from hiding the button */
      clip-path: none !important;
      /* WHY: contain:layout clips the button on Android Chrome — explicit none required */
      contain: none !important;
    }
    /* Push coach button above mobile tab bar (tab bar height ~64px + safe-area).
       WHY: hard 80px avoids max()/env() browser compat issues (3rd attempt). */
    @media (max-width: 768px) {
      #${WIDGET_ID}-btn {
        bottom: 80px !important;
        right: 16px !important;
        width: 56px !important;
        height: 56px !important;
        min-width: 56px !important;
        min-height: 56px !important;
        z-index: 9995 !important;
        overflow: visible !important;
        transform: none !important;
      }
    }
    #${WIDGET_ID}-btn:hover { transform: scale(1.08); }
    #${WIDGET_ID}-btn .coach-badge {
      position: absolute;
      top: -3px;
      right: -3px;
      width: 14px;
      height: 14px;
      background: #10b981;
      border-radius: 50%;
      border: 2px solid #0a0f1a;
      display: none;
    }
    #${WIDGET_ID}-btn .coach-badge.show { display: block; }

    #${WIDGET_ID}-panel {
      position: fixed;
      bottom: 86px;
      right: 16px;
      width: min(380px, calc(100vw - 32px));
      height: min(520px, calc(100vh - 120px));
      background: #111827;
      border: 1px solid #1e293b;
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0,0,0,.6);
      z-index: 9996;
      transform: scale(.92) translateY(12px);
      opacity: 0;
      pointer-events: none;
      transition: all .2s cubic-bezier(.34,1.56,.64,1);
      overflow: hidden;
    }
    @media (max-width: 768px) {
      #${WIDGET_ID}-panel {
        bottom: 140px;
        bottom: max(140px, calc(130px + env(safe-area-inset-bottom, 0px)));
        height: min(420px, calc(100vh - 200px));
        z-index: 9996 !important;
      }
    }
    #${WIDGET_ID}-panel.open {
      transform: scale(1) translateY(0);
      opacity: 1;
      pointer-events: auto;
    }

    .coach-header {
      background: linear-gradient(135deg, #1a1500, #111827);
      border-bottom: 1px solid #1e293b;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .coach-header-left { display: flex; align-items: center; gap: 10px; }
    .coach-avatar {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #f59e0b, #d97706);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
    }
    .coach-name { font-family: 'Space Grotesk', sans-serif; font-size: 14px; font-weight: 700; color: #f1f5f9; }
    .coach-sub { font-size: 11px; color: #64748b; }
    .coach-close {
      background: none; border: none; color: #64748b;
      font-size: 18px; cursor: pointer; padding: 4px;
      transition: color .2s; line-height: 1;
    }
    .coach-close:hover { color: #f1f5f9; }

    .coach-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
    }
    .coach-msg {
      max-width: 88%;
      padding: 10px 13px;
      border-radius: 12px;
      font-size: 13.5px;
      line-height: 1.5;
      color: #cbd5e1;
      word-break: break-word;
    }
    .coach-msg.assistant {
      background: #1a2332;
      border-bottom-left-radius: 3px;
      align-self: flex-start;
      color: #cbd5e1;
    }
    .coach-msg.user {
      background: linear-gradient(135deg, #1a1500, #292200);
      border: 1px solid #3d2f00;
      color: #fcd34d;
      align-self: flex-end;
      border-bottom-right-radius: 3px;
    }
    .coach-msg.system-msg {
      background: #0f1923;
      border: 1px solid #1e293b;
      border-radius: 8px;
      align-self: center;
      max-width: 100%;
      font-size: 12px;
      color: #64748b;
      text-align: center;
    }
    .coach-msg.nudge-msg {
      background: linear-gradient(135deg, #0a1f15, #111827);
      border: 1px solid #064e3b;
      color: #a7f3d0;
      align-self: stretch;
      max-width: 100%;
      border-radius: 10px;
    }
    .coach-msg.upgrade-hook {
      background: #0f0a1a;
      border: 1px solid #4c1d95;
      align-self: stretch;
      max-width: 100%;
      border-radius: 10px;
      color: #c4b5fd;
    }
    .upgrade-hook-cta {
      display: inline-block;
      margin-top: 8px;
      padding: 6px 14px;
      background: #8b5cf6;
      color: #fff;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }

    .coach-limit-bar {
      padding: 8px 14px;
      background: #0a0f1a;
      border-top: 1px solid #1e293b;
      font-size: 11px;
      color: #64748b;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .limit-track {
      height: 3px;
      background: #1e293b;
      border-radius: 2px;
      flex: 1;
      margin: 0 10px;
      overflow: hidden;
    }
    .limit-fill {
      height: 100%;
      background: #f59e0b;
      border-radius: 2px;
      transition: width .3s;
    }

    .coach-input-area {
      border-top: 1px solid #1e293b;
      padding: 10px;
      display: flex;
      gap: 8px;
      align-items: flex-end;
      flex-shrink: 0;
      background: #0d1421;
    }
    .coach-input {
      flex: 1;
      background: #1a2332;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 9px 12px;
      color: #f1f5f9;
      font-size: 13.5px;
      font-family: 'DM Sans', sans-serif;
      resize: none;
      max-height: 80px;
      line-height: 1.4;
      outline: none;
      transition: border-color .2s;
    }
    .coach-input:focus { border-color: #f59e0b40; }
    .coach-input::placeholder { color: #374151; }
    .coach-send {
      width: 36px; height: 36px;
      background: #f59e0b;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      transition: all .2s;
      flex-shrink: 0;
    }
    .coach-send:hover { background: #d97706; }
    .coach-send:disabled { opacity: .4; cursor: not-allowed; }

    .coach-typing {
      display: flex;
      gap: 4px;
      padding: 10px 13px;
      background: #1a2332;
      border-radius: 12px;
      border-bottom-left-radius: 3px;
      align-self: flex-start;
    }
    .coach-typing span {
      width: 6px; height: 6px;
      background: #475569;
      border-radius: 50%;
      animation: bounce 1.2s ease-in-out infinite;
    }
    .coach-typing span:nth-child(2) { animation-delay: .2s; }
    .coach-typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }

    /* Locked state */
    .coach-locked {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
    }
    .coach-locked-icon { font-size: 36px; margin-bottom: 12px; }
    .coach-locked-title { font-family: 'Space Grotesk', sans-serif; font-size: 16px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px; }
    .coach-locked-sub { font-size: 13px; color: #64748b; margin-bottom: 18px; line-height: 1.5; }
    .coach-locked-cta {
      padding: 11px 22px;
      background: #f59e0b;
      color: #000;
      font-size: 13px;
      font-weight: 700;
      border-radius: 10px;
      text-decoration: none;
      font-family: 'Space Grotesk', sans-serif;
    }
    .coach-tip {
      margin-top: 16px;
      padding: 12px;
      background: #0d1421;
      border: 1px solid #1e293b;
      border-radius: 8px;
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.5;
      width: 100%;
    }
    .coach-tip strong { color: #f59e0b; }
  `;

  // ─── State ─────────────────────────────────────────────────────────────────
  let isOpen = sessionStorage.getItem(STORAGE_KEY) === '1';
  let tierData = null;
  let limitsData = null;
  let isSending = false;

  // ─── DOM injection ─────────────────────────────────────────────────────────
  function inject() {
    if (document.getElementById(WIDGET_ID + '-btn')) return;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    // Toggle button
    const btn = document.createElement('button');
    btn.id = WIDGET_ID + '-btn';
    btn.setAttribute('aria-label', 'Open Allocation Coach');
    btn.innerHTML = '🧠<span class="coach-badge" id="coach-notif-badge"></span>';
    btn.addEventListener('click', togglePanel);
    document.body.appendChild(btn);

    // Panel
    const panel = document.createElement('div');
    panel.id = WIDGET_ID + '-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'FACTS Allocation Coach');
    panel.innerHTML = `
      <div class="coach-header">
        <div class="coach-header-left">
          <div class="coach-avatar">🎯</div>
          <div>
            <div class="coach-name">FACTS Coach</div>
            <div class="coach-sub" id="coach-tier-label">Educational only — not advice</div>
          </div>
        </div>
        <button class="coach-close" onclick="document.getElementById('${WIDGET_ID}-panel').classList.remove('open');sessionStorage.setItem('${STORAGE_KEY}','0')">✕</button>
      </div>
      <div class="coach-messages" id="coach-msgs"></div>
      <div class="coach-limit-bar" id="coach-limit-bar" style="display:none">
        <span id="limit-used">0</span>
        <div class="limit-track"><div class="limit-fill" id="limit-fill" style="width:0%"></div></div>
        <span id="limit-total">10</span>
      </div>
      <div class="coach-input-area" id="coach-input-area">
        <textarea class="coach-input" id="coach-input" placeholder="Ask about FACTS allocation education..." rows="1"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._factsCoachSend()}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,80)+'px'"></textarea>
        <button class="coach-send" id="coach-send-btn" onclick="window._factsCoachSend()">➤</button>
      </div>
    `;
    document.body.appendChild(panel);

    if (isOpen) panel.classList.add('open');

    // Global send handler
    window._factsCoachSend = sendMessage;

    init();
  }

  async function init() {
    try {
      const [tierRes, limitsRes] = await Promise.all([
        fetch('/api/mod_subscription/current'),
        fetch('/api/mod_ai_coach/limits'),
      ]);

      if (tierRes.ok) tierData = await tierRes.json();
      if (limitsRes.ok) limitsData = await limitsRes.json();

      renderState();
      loadNudge();
    } catch (e) {
      // Not logged in or API error — hide widget
      const btn = document.getElementById(WIDGET_ID + '-btn');
      if (btn) btn.style.display = 'none';
    }
  }

  function renderState() {
    if (!tierData) return;

    const tier = tierData.current_tier;
    const label = document.getElementById('coach-tier-label');
    if (label) label.textContent = (tierData.display_name || 'FACTS') + ' · Educational only';

    // Free tier — show locked state
    if (tier === 'free' || (limitsData && limitsData.limit === 0)) {
      renderLocked();
      return;
    }

    // Update limit bar
    if (limitsData && limitsData.limit > 0) {
      const limitBar = document.getElementById('coach-limit-bar');
      if (limitBar) {
        limitBar.style.display = 'flex';
        document.getElementById('limit-used').textContent = limitsData.used_today || 0;
        document.getElementById('limit-total').textContent = limitsData.limit;
        const pct = Math.round(((limitsData.used_today || 0) / limitsData.limit) * 100);
        const fill = document.getElementById('limit-fill');
        if (fill) {
          fill.style.width = pct + '%';
          fill.style.background = pct >= 80 ? '#f43f5e' : pct >= 60 ? '#f59e0b' : '#10b981';
        }
      }
    }

    // Load chat history
    loadHistory();
  }

  function renderLocked() {
    const msgsEl = document.getElementById('coach-msgs');
    const inputArea = document.getElementById('coach-input-area');
    if (!msgsEl) return;

    if (inputArea) inputArea.style.display = 'none';

    msgsEl.innerHTML = `
      <div class="coach-locked">
        <div class="coach-locked-icon">🔒</div>
        <div class="coach-locked-title">Coaching Locked</div>
        <div class="coach-locked-sub">Personalized allocation coaching is available for Individual tier and above. Get coaching grounded in your FACTS allocations and financial archetype.</div>
        <a href="/tier-upgrade" class="coach-locked-cta">Unlock for $9.99/mo →</a>
        <div class="coach-tip" id="free-coach-tip"><strong>💡 Today's Tip</strong><br>Loading your tip...</div>
      </div>
    `;
  }

  async function loadNudge() {
    try {
      const r = await fetch('/api/mod_ai_coach/nudge');
      if (!r.ok) return;
      const data = await r.json();

      if (tierData?.current_tier === 'free') {
        // Update the free tip
        const tipEl = document.getElementById('free-coach-tip');
        if (tipEl) tipEl.innerHTML = `<strong>💡 Today's Tip</strong><br>${data.nudge}`;
        return;
      }

      // For paid tiers, show nudge in chat if it's time
      const lastNudge = parseInt(localStorage.getItem(NUDGE_STORAGE_KEY) || '0');
      if (Date.now() - lastNudge < NUDGE_INTERVAL_MS) return;

      addMessage({ role: 'nudge', content: data.nudge });
      localStorage.setItem(NUDGE_STORAGE_KEY, Date.now().toString());

      // Show badge on closed widget
      if (!isOpen) {
        const badge = document.getElementById('coach-notif-badge');
        if (badge) badge.classList.add('show');
      }
    } catch (e) {}
  }

  async function loadHistory() {
    try {
      const r = await fetch('/api/mod_ai_coach/chat/history?per_page=20');
      if (!r.ok) return;
      const data = await r.json();

      const msgsEl = document.getElementById('coach-msgs');
      if (!msgsEl) return;

      // Clear and show welcome if no history
      if (!data.messages || data.messages.length === 0) {
        addMessage({
          role: 'assistant',
          content: `Hi! I'm your FACTS financial coach. I can help you optimize your 6-bucket allocations, review your spending patterns, and guide you toward financial sovereignty.\n\nWhat's on your mind?`,
        });
        return;
      }

      // Render last 10 messages
      data.messages.slice(-10).forEach(msg => addMessage(msg));
    } catch (e) {
      addMessage({ role: 'assistant', content: 'Hello! I\'m your FACTS coach. How can I help you today?' });
    }
  }

  function addMessage({ role, content }) {
    const msgsEl = document.getElementById('coach-msgs');
    if (!msgsEl) return;

    // Remove typing indicator if present
    const typing = document.getElementById('coach-typing-indicator');
    if (typing) typing.remove();

    const div = document.createElement('div');
    if (role === 'nudge') {
      div.className = 'coach-msg nudge-msg';
      div.innerHTML = `<strong style="font-size:11px;color:#34d399;text-transform:uppercase;letter-spacing:.05em">💡 Coach Insight</strong><br><br>${escapeHtml(content)}`;
    } else if (role === 'upgrade') {
      div.className = 'coach-msg upgrade-hook';
      div.innerHTML = escapeHtml(content) + `<br><a href="/tier-upgrade" class="upgrade-hook-cta">View Plans →</a>`;
    } else {
      div.className = `coach-msg ${role}`;
      div.textContent = content;
    }

    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function showTyping() {
    const msgsEl = document.getElementById('coach-msgs');
    if (!msgsEl || document.getElementById('coach-typing-indicator')) return;
    const div = document.createElement('div');
    div.id = 'coach-typing-indicator';
    div.className = 'coach-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function sendMessage() {
    if (isSending) return;
    const input = document.getElementById('coach-input');
    const sendBtn = document.getElementById('coach-send-btn');
    if (!input) return;

    const msg = input.value.trim();
    if (!msg) return;

    isSending = true;
    input.value = '';
    input.style.height = 'auto';
    if (sendBtn) sendBtn.disabled = true;

    addMessage({ role: 'user', content: msg });
    showTyping();

    try {
      const r = await fetch('/api/mod_ai_coach/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });

      const data = await r.json();

      if (r.status === 429) {
        // Rate limited
        addMessage({
          role: 'upgrade',
          content: data.message || 'You\'ve reached your daily message limit. Upgrade your plan for more allocation coaching.',
        });
      } else if (!r.ok) {
        addMessage({ role: 'assistant', content: data.error || 'Something went wrong. Please try again.' });
      } else {
        addMessage({ role: 'assistant', content: data.reply });

        // Update limit bar
        if (data.remaining !== undefined && data.remaining !== -1 && limitsData) {
          limitsData.used_today = (limitsData.used_today || 0) + 1;
          const pct = Math.round((limitsData.used_today / data.limit) * 100);
          document.getElementById('limit-used').textContent = limitsData.used_today;
          const fill = document.getElementById('limit-fill');
          if (fill) {
            fill.style.width = pct + '%';
            fill.style.background = pct >= 80 ? '#f43f5e' : pct >= 60 ? '#f59e0b' : '#10b981';
          }
        }

        // Show upgrade hook if surface
        if (data.upgrade_hook?.show) {
          setTimeout(() => addMessage({ role: 'upgrade', content: data.upgrade_hook.message }), 800);
        }
      }
    } catch (e) {
      addMessage({ role: 'assistant', content: 'Network error. Please check your connection and try again.' });
    } finally {
      isSending = false;
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  }

  function togglePanel() {
    const panel = document.getElementById(WIDGET_ID + '-panel');
    if (!panel) return;
    isOpen = !panel.classList.contains('open');
    panel.classList.toggle('open');
    sessionStorage.setItem(STORAGE_KEY, isOpen ? '1' : '0');
    // Clear badge
    const badge = document.getElementById('coach-notif-badge');
    if (badge) badge.classList.remove('show');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
