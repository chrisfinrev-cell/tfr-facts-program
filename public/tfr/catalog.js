/**
 * TFR public catalog — education, programs, modules, tools.
 * Shared by the TFR site (window.TFR_CATALOG) and mod_sites (module.exports).
 */
(function (root) {
  'use strict';

  var FACTS_APP = 'https://app.factsmoney.com';
  var FACTS_WEB = 'https://factsmoney.com';

  var CATALOG = {
    brand: {
      name: 'The Financial Revolution',
      short: 'TFR',
      domain: 'thefinancialrevolution.net',
      tagline: 'The doctrine. The programs. The tools.',
      engineName: 'FACTS',
      engineDomain: 'factsmoney.com',
      engineUrl: FACTS_WEB,
      appUrl: FACTS_APP
    },

    library: [
      {
        id: 'manifesto',
        title: 'The Manifesto',
        type: 'guide',
        read_time: '8 min',
        icon: '⚔️',
        access: 'public',
        desc: 'FACTS is not a budget app. It is a declaration of financial independence — a protocol for people who refuse to stay broke.',
        body:
          '<p>FACTS is not a budget app. It is a <strong>declaration of financial independence</strong> — a system designed to break the cycle of living paycheck-to-paycheck and replace it with a disciplined, structured protocol for building wealth.</p>' +
          '<h3>Core beliefs</h3><ul>' +
          '<li><strong>Financial literacy is a right, not a privilege.</strong> The system has gatekept this long enough.</li>' +
          '<li><strong>Debt is the enemy of freedom.</strong> We do not accept it as normal. We fight it until it is gone.</li>' +
          '<li><strong>Every dollar must have a mission.</strong> Unallocated money is money lost.</li>' +
          '<li><strong>Discipline compounds.</strong> Small, consistent actions create extraordinary results.</li>' +
          '<li><strong>Community accelerates progress.</strong> Revolutionaries move faster together.</li></ul>' +
          '<h3>The mission</h3><p>Create one million financially sovereign individuals who control their money, eliminate debt, and build generational wealth — one level at a time.</p>' +
          '<p class="note">The protocol is taught here. The engine that runs it lives at factsmoney.com.</p>'
      },
      {
        id: 'facts-method',
        title: 'The FACTS Method',
        type: 'guide',
        read_time: '7 min',
        icon: '⚖️',
        access: 'public',
        desc: 'Financial Allocation Control & Tracking System. Every dollar gets a purpose before it arrives.',
        body:
          '<p>FACTS stands for <strong>Financial Allocation Control &amp; Tracking System</strong>. It is zero-based allocation — every dollar is assigned before it is spent.</p>' +
          '<h3>The six buckets</h3><ol>' +
          '<li><strong>Necessities (50%)</strong> — Housing, food, utilities, transportation. The baseline that keeps the system running.</li>' +
          '<li><strong>Reserve (10%)</strong> — Liquidity and security. The buffer that stops one emergency from becoming a crisis.</li>' +
          '<li><strong>Velocity (10%)</strong> — Debt reduction and interest recovery. Capital that moves instead of sitting still.</li>' +
          '<li><strong>Growth (10%)</strong> — Assets and wealth multiplication.</li>' +
          '<li><strong>Lifestyle (10%)</strong> — Quality of life. The system serves you, not the other way around.</li>' +
          '<li><strong>Legacy (10%)</strong> — Impact, mentorship, and the transfer of value.</li></ol>' +
          '<p>Percentages flex with income. The rule that never flexes: allocations always total 100%.</p>'
      },
      {
        id: 'day-zero',
        title: 'Day Zero: Your Debt Baseline',
        type: 'guide',
        read_time: '6 min',
        icon: '📸',
        access: 'public',
        desc: 'Before you fight your way out, document every dollar of debt that exists. That snapshot is Day Zero.',
        body:
          '<p>Day Zero is the moment you commit — and write down every dollar of debt that exists.</p>' +
          '<h3>What to document</h3><ul>' +
          '<li>Every credit card balance and interest rate</li>' +
          '<li>Every auto loan and remaining term</li>' +
          '<li>Student loans, federal and private, separately</li>' +
          '<li>Medical debt, personal loans, HELOC / second mortgage</li></ul>' +
          '<p>The most important number is <strong>Total Monthly Debt Service</strong> — how much of your income is already spoken for before you live.</p>' +
          '<p class="note">In the FACTS engine you can upload a credit report and let the system parse the baseline for you.</p>'
      },
      {
        id: 'four-phases',
        title: 'The Four Phases',
        type: 'strategy',
        read_time: '9 min',
        icon: '🗺️',
        access: 'public',
        desc: 'Resistance. Uprising. Expansion. Liberation. Four phases, twelve levels, one destination.',
        body:
          '<p>The protocol maps the journey across four phases. Each has its own character, tools, and milestones.</p>' +
          '<h3>Phase I — Resistance (L1–3)</h3><p>Know the enemy. Map the debt. Build the tracking habit. Stop the bleeding before you advance.</p>' +
          '<h3>Phase II — Uprising (L4–6)</h3><p>Automate. Eliminate leaks. Deploy debt velocity. Individual tools come online.</p>' +
          '<h3>Phase III — Expansion (L7–9)</h3><p>Business allocation, tax posture, Friday Sweep. Money starts working for you.</p>' +
          '<h3>Phase IV — Liberation (L10–12)</h3><p>HELOC velocity, wealth acceleration, prestige status. You are no longer fighting debt — you are building the architecture that outlives you.</p>'
      },
      {
        id: 'sovereign-protocol',
        title: 'Sovereign Protocol: 12 Levels',
        type: 'strategy',
        read_time: '12 min',
        icon: '🏆',
        access: 'public',
        desc: 'The full 12-level map from Awakening to Sovereign. Progress is earned through action, not time.',
        body:
          '<p>The Sovereign Protocol is the 12-level progression that maps the entire journey from Day Zero to financial sovereignty.</p>' +
          '<ol class="levels">' +
          '<li><strong>L1 Awakening</strong> — Accept the mission. Set up tracking. Document Day Zero.</li>' +
          '<li><strong>L2 Foundation</strong> — Build the allocation framework. First month allocated.</li>' +
          '<li><strong>L3 Resistance</strong> — Kill phantom charges. Build a $1,000 starter reserve.</li>' +
          '<li><strong>L4 Uprising</strong> — Deploy debt velocity. Automate savings and payments.</li>' +
          '<li><strong>L5 Momentum</strong> — Credit architecture. Eliminate high-interest debt.</li>' +
          '<li><strong>L6 Breakthrough</strong> — Full emergency fund. Begin index investing.</li>' +
          '<li><strong>L7 Expansion</strong> — Business allocation. Six-bucket protocol activated.</li>' +
          '<li><strong>L8 Command</strong> — Tax posture. Friday Sweep fully operational.</li>' +
          '<li><strong>L9 Dominion</strong> — Multiple income streams. Business revenue exceeds wages.</li>' +
          '<li><strong>L10 Liberation</strong> — HELOC velocity. Mortgage acceleration begins.</li>' +
          '<li><strong>L11 Ascension</strong> — Equity acceleration. Real estate and asset scaling.</li>' +
          '<li><strong>L12 Sovereign</strong> — Legacy architecture. Generational systems in place.</li></ol>' +
          '<p class="note">Levels, XP, and gates run inside the FACTS engine. This page is the map.</p>'
      },
      {
        id: 'allocation-basics',
        title: 'Allocation Methodology',
        type: 'guide',
        read_time: '8 min',
        icon: '📐',
        access: 'public',
        desc: 'Why 50/10/10/10/10/10 works, when to customize, and the one rule that never changes.',
        body:
          '<p>Every dollar of income is allocated <strong>before it is spent</strong>. The default split is 50 / 10 / 10 / 10 / 10 / 10 across Necessities, Reserve, Velocity, Growth, Lifestyle, and Legacy.</p>' +
          '<h3>Why this works</h3><p>Percentages flex with income. Earn more, every bucket grows. Income drops, cuts distribute proportionally. You do not rewrite a budget every month — you run a system.</p>' +
          '<h3>Custom splits</h3><p>The default is a starting point. Debt-heavy seasons raise Velocity. Wealth seasons raise Growth and Legacy. Business revenue uses a different split (profit, tax, owner pay, operating). The key rule: <strong>allocations must always total 100%.</strong></p>'
      },
      {
        id: 'heartbeat',
        title: 'The Heartbeat Audit',
        type: 'guide',
        read_time: '6 min',
        icon: '💓',
        access: 'public',
        desc: 'Accountability that separates a protocol from a passive app. Daily, weekly, monthly rhythm.',
        body:
          '<p>The Heartbeat Audit verifies that you are following the protocol — not just signed up, but engaged.</p>' +
          '<ol><li><strong>Daily check-in</strong> — Confirm the day. Earn XP. Keep the streak.</li>' +
          '<li><strong>Weekly review</strong> — Allocation accuracy. Are you hitting the percentages?</li>' +
          '<li><strong>Monthly pulse</strong> — Reconcile actual vs allocated. Adjust for the next cycle.</li></ol>' +
          '<p>Miss too many heartbeats and progression stalls. Stay consistent and the system rewards you.</p>'
      },
      {
        id: 'friday-sweep',
        title: 'The Friday Sweep',
        type: 'strategy',
        read_time: '7 min',
        icon: '🧹',
        access: 'public',
        desc: 'The weekly cash ritual that keeps leftover money working the moment you stop spending.',
        body:
          '<p>Every Friday, surplus is swept out of operating cash and into its assigned buckets. Personal users send leftovers to Velocity, Reserve, or Growth. Business users run profit / tax / owner pay first.</p>' +
          '<h3>Why Friday</h3><p>You can see the week. Weekend noise is low. The balance is honest. The ritual sets the weekend instead of the weekend setting you.</p>' +
          '<p class="note">The engine automates surplus math. The doctrine is here: leftover money must never sit idle.</p>'
      },
      {
        id: 'heloc-velocity',
        title: 'HELOC Velocity (Overview)',
        type: 'masterclass',
        read_time: '10 min',
        icon: '⚡',
        access: 'public',
        desc: 'Educational overview of using a HELOC as a cash-flow rail to recapture mortgage interest.',
        body:
          '<p>HELOC Velocity is an educational framework: park income against a home-equity line so daily simple interest is calculated on a lower average balance, then chunk principal back to the mortgage.</p>' +
          '<p>This is <strong>not lending advice, not a product offer, and not a recommendation to open credit.</strong> It is a model. Requirements, rates, and risk are yours to evaluate with licensed professionals.</p>' +
          '<p class="note">Model the numbers in the FACTS HELOC Velocity Engine. Decide nothing from this page alone.</p>'
      }
    ],

    programs: [
      {
        id: 'facts-personal',
        title: 'FACTS Personal',
        eyebrow: 'Core program',
        icon: '₣',
        desc: 'The allocation engine for individuals. Six buckets, paycheck entry, tracking, and the path through the first six levels.',
        includes: ['6-bucket allocations', 'Paycheck & spend tracking', 'Sovereign Score', 'Allocation Coach (tiered)'],
        cta: { label: 'Open the engine', href: FACTS_APP + '/signup.html' }
      },
      {
        id: 'facts-business',
        title: 'FACTS Business',
        eyebrow: 'Operators',
        icon: '🏛️',
        desc: 'Profit-first allocation for operators. Friday Sweep, tax reserve, owner pay, and business heartbeat compliance.',
        includes: ['10/10/10/70 business split', 'Friday Sweep ritual', 'Receipt capture', 'Heartbeat escrow logic'],
        cta: { label: 'Business onboarding', href: FACTS_APP + '/business-pro-onboarding.html' }
      },
      {
        id: 'sovereign-protocol',
        title: 'Sovereign Protocol',
        eyebrow: '12 levels',
        icon: '🏆',
        desc: 'The full progression system. XP, gates, decay, and the four phases from Resistance to Liberation.',
        includes: ['12-level map', 'XP & streaks', 'Level-gated training', 'Sovereign dashboard'],
        cta: { label: 'See the map', href: 'article.html?id=sovereign-protocol' }
      },
      {
        id: 'phase-zero',
        title: 'Phase Zero',
        eyebrow: 'Intake',
        icon: '🌅',
        desc: 'The forensic intake that builds your Day Zero picture — income, bleed, and the first allocation draft — before the engine is fully live.',
        includes: ['Income & bleed snapshot', 'Forensic questions', 'Rule-based allocation draft'],
        cta: { label: 'Start Phase Zero', href: FACTS_APP + '/phase-zero.html' }
      },
      {
        id: 'benefits-masterclass',
        title: 'Benefits Masterclass',
        eyebrow: 'Compensation',
        icon: '💼',
        desc: 'Interactive calculators for 401(k), HSA, dental, education rebate, total comp, and a 30-day action plan.',
        includes: ['Six calculators', 'Total-comp picture', '30-day plan'],
        cta: { label: 'Open the masterclass', href: '/benefits-masterclass.html' }
      },
      {
        id: 'freedom-engine',
        title: 'The Freedom Engine',
        eyebrow: 'Affiliate residual engine',
        icon: '⚙️',
        desc: 'The automated passive residual engine for active dues-paying FACTS members. Keep your membership active, stay financially disciplined, and turn network growth into predictable residual income.',
        includes: ['5-level residuals', 'Referral link unlock', 'Sovereign dashboard'],
        cta: { label: 'Open The Freedom Engine', href: FACTS_APP + '/freedom-engine.html' }
      }
    ],

    modules: [
      { id: 'ai-coach', title: 'Allocation Coach', icon: '🧠', status: 'engine', desc: 'Allocation strategist grounded in your FACTS patterns. Educational output only — not advice.', href: FACTS_APP + '/app.html' },
      { id: 'rate-radar', title: 'Rate Radar', icon: '📡', status: 'engine', desc: 'Recurring-bill scan with alternative illustrations and a 7-day comparison window.', href: FACTS_APP + '/rate-radar.html' },
      { id: 'forensic-credit', title: 'Forensic Credit Scan', icon: '🔍', status: 'tool', desc: 'Penny-accurate interest-leak breakdown from a credit report upload.', href: '/credit-analysis.html' },
      { id: 'shopping', title: 'Shopping & Receipts', icon: '🛒', status: 'engine', desc: 'GPS store radar, community prices, receipt scan, and bucket sweep of trip savings.', href: FACTS_APP + '/shopping-calculator.html' },
      { id: 'friday-sweep', title: 'Friday Sweep', icon: '🧹', status: 'engine', desc: 'End-of-week surplus calculation and cascade into the six buckets.', href: 'article.html?id=friday-sweep' },
      { id: 'heloc', title: 'HELOC Velocity Engine', icon: '⚡', status: 'engine', desc: 'Educational modeler for interest recapture. Not a loan product.', href: FACTS_APP + '/heloc-velocity-engine.html' },
      { id: 'legacy-lens', title: 'Legacy Lens', icon: '🔭', status: 'elite', desc: 'Entity hierarchy, sovereign health score, and equity across digital assets and IP.', href: FACTS_APP + '/legacy-lens.html' },
      { id: 'lending-desk', title: 'Sovereign Lending', icon: '⚡', status: 'elite', desc: 'Educational 9-pod lending architecture and behavioral underwriting desk.', href: FACTS_APP + '/lending-desk.html' },
      { id: 'sanitized-importer', title: 'Sanitized Importer', icon: '🛡️', status: 'elite', desc: 'Bulk CSV portfolio import with a Zero-PII firewall between brokerage data and identity.', href: FACTS_APP + '/elite-bundles.html' },
      { id: 'vault', title: 'Document Vault', icon: '🏛️', status: 'engine', desc: 'Credit reports, receipts, milestone PDFs — the paper trail of Day Zero forward.', href: FACTS_APP + '/document-vault.html' },
      { id: 'brokerage', title: 'Brokerage Tracker', icon: '📈', status: 'engine', desc: 'Positions, discipline rules, and growth-bucket visibility.', href: FACTS_APP + '/brokerage-tracker.html' },
      { id: 'household', title: 'Household', icon: '👨‍👩‍👧‍👦', status: 'engine', desc: 'Shared allocations, invites, and junior command for the next generation.', href: FACTS_APP + '/household-dashboard.html' }
    ],

    tools: [
      {
        id: 'stolen-wealth',
        title: 'Stolen Wealth Estimator',
        icon: '🩸',
        minutes: '3 min',
        desc: 'Estimate bank-interest bleed and unlock a private forensic snapshot. Public, educational, no account required to start.',
        href: '/facts-funnel.html'
      },
      {
        id: 'credit-scan',
        title: 'Forensic Credit Scan',
        icon: '🔍',
        minutes: '5 min',
        desc: 'Upload a credit report. Get a leak map across the debt portfolio. Educational illustration only.',
        href: '/credit-analysis.html'
      },
      {
        id: 'shopping-calc',
        title: 'Shopping Calculator',
        icon: '🛒',
        minutes: 'Anytime',
        desc: 'Compare community price data and see how a trip hits the Necessities bucket.',
        href: '/shopping-calculator.html'
      },
      {
        id: 'benefits',
        title: 'Benefits Calculators',
        icon: '💼',
        minutes: '15 min',
        desc: '401(k), HSA, dental, education rebate, total compensation, and a 30-day action plan.',
        href: '/benefits-masterclass.html'
      },
      {
        id: 'facts-engine',
        title: 'FACTS Allocation Engine',
        icon: '₣',
        minutes: 'Live',
        desc: 'The operating system. Paychecks, buckets, sweeps, score, and the 12-level protocol — on factsmoney.com.',
        href: FACTS_WEB,
        primary: true
      }
    ]
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CATALOG;
  }
  root.TFR_CATALOG = CATALOG;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
