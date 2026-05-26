// workers/finance-cfo-categorizer.js
// Finance v2 — CFO Agent v2, reactive layer: Mercury transaction categorization.
// Per PRETZEL_OS_FINANCE_V2.md section 3.1.
//
// Strategy:
//   1. Rule-based pre-categorizer handles ~80% of volume instantly (no LLM cost).
//      Patterns are regex-matches on counterparty_name / description.
//   2. Anything not matched → fall back to Claude Haiku with similar historical txns as context.
//   3. Confidence >= 0.90 + rule match → auto-accept (writes proposed_account_id).
//   4. Otherwise → queued for Drew's review on Money page.
//
// Endpoints (registered in finance-worker.js):
//   POST /finance/cfo/categorize[?limit=N]      — batch categorize uncategorized txns
//   POST /finance/cfo/categorize-one?txn_id=X   — single txn (for testing)
//   GET  /finance/cfo/categorize-stats          — breakdown of categorization state
//
// Writes to mercury_transactions: proposed_account_id, proposed_confidence, proposed_reasoning.

// DIF-3: model id now resolved via ai-budget.js (callAI(env, { model: 'haiku' })).

// ── Rule-based categorizer ────────────────────────────────────────────────
// Each rule matches against counterparty_name + description + amount-sign
// and returns an account resolver. Rules are ordered: first match wins.
// Use `|` to join multiple counterparty variants (Mercury sometimes capitalizes
// differently, truncates names, or adds suffixes).
export const CATEGORIZATION_RULES = [
  // ── INFLOWS (positive amount) ──────────────────────────────────────────
  {
    name: 'toast_deposit',
    match: ({ counterparty, amount }) => /^TOAST/i.test(counterparty) && amount > 0,
    target_account_name: 'Clearing Accounts:Cash Clearing',
    reasoning: 'Toast POS deposit (net of fees). Clearing until reconciled to Sales.',
    confidence: 0.97,
  },
  {
    name: 'square_deposit',
    match: ({ counterparty, amount }) => /^Square\s*Inc/i.test(counterparty) && amount > 0,
    target_account_name: 'Clearing Accounts:Square Clearing',
    reasoning: 'Square POS deposit. Clearing until reconciled to Sales.',
    confidence: 0.97,
  },
  {
    name: 'doordash_deposit',
    match: ({ counterparty, amount }) => /doordash/i.test(counterparty) && amount > 0,
    target_account_name: 'Clearing Accounts:Doordash Clearing',
    reasoning: 'DoorDash marketplace deposit. Clearing until commission + tax reconciled.',
    confidence: 0.97,
  },
  {
    name: 'ubereats_deposit',
    match: ({ counterparty, amount }) => /^UBER\b/i.test(counterparty) && amount > 0,
    target_account_name: 'Clearing Accounts:UberEats Clearing',
    reasoning: 'UberEats marketplace deposit. Clearing until reconciled.',
    confidence: 0.97,
  },
  {
    name: 'grubhub_deposit',
    match: ({ counterparty, amount }) => /grubhub/i.test(counterparty) && amount > 0,
    target_account_name: 'Clearing Accounts:Grubhub Clearing',
    reasoning: 'Grubhub marketplace deposit. Clearing until reconciled.',
    confidence: 0.97,
  },
  {
    name: 'mercury_internal_transfer',
    // Between-Mercury-accounts transfers. Mercury's description is literally
    // "Transfer between your Mercury accounts" (no counterparty name).
    // IMPORTANT: only post a JE for the OUTFLOW side. The matching inflow on
    // the other account would otherwise double-count.
    match: ({ counterparty, description, account_name, amount }) => {
      const isTransfer = /transfer\s+between\s+your\s+mercury\s+accounts/i.test(description || '')
        || (/dangerous\s*pretze/i.test((counterparty || '') + ' ' + (description || ''))
            && /mercury/i.test((counterparty || '') + ' ' + (description || '')));
      return isTransfer && amount < 0;  // only fire on the outflow side
    },
    // Cross account: if outflow is FROM Mercury Checking, the DR side is Mercury Savings.
    target_account_resolver: ({ account_name }) =>
      /checking/i.test(account_name || '') ? 'Mercury Savings (5450) - 1' : 'Mercury Checking (0118) - 1',
    reasoning: 'Internal transfer between Mercury accounts (outflow side; inflow on other account is the match).',
    confidence: 0.95,
  },
  {
    name: 'mercury_internal_transfer_inflow_skip',
    // Inflow side of an intercompany transfer — mark as "no-op" so it gets
    // reconciled (matched to the OUTFLOW's JE later) without posting a new JE.
    match: ({ counterparty, description, amount }) => {
      const isTransfer = /transfer\s+between\s+your\s+mercury\s+accounts/i.test(description || '')
        || (/dangerous\s*pretze/i.test((counterparty || '') + ' ' + (description || ''))
            && /mercury/i.test((counterparty || '') + ' ' + (description || '')));
      return isTransfer && amount > 0;
    },
    // Use the receiving Mercury account itself — the JE poster will detect this is
    // self-referential and skip posting (no real cash movement to record).
    target_account_resolver: ({ account_name }) => account_name && /savings/i.test(account_name) ? 'Mercury Savings (5450) - 1' : 'Mercury Checking (0118) - 1',
    skip_je_posting: true,
    reasoning: 'Internal transfer inflow side — matching outflow on other account posts the JE.',
    confidence: 0.95,
  },
  {
    name: 'external_bank_wells_fargo',
    // Wells Fargo transfers come from Drew's personal account → owner contribution.
    match: ({ counterparty, description, amount }) =>
      /wells\s*fargo/i.test((counterparty || '') + ' ' + (description || '')) && amount > 0,
    target_account_name: 'Partner investments:Drew and Lindsay',
    reasoning: 'Wells Fargo inbound transfer — Drew personal account → owner contribution per Drew directive.',
    confidence: 0.95,
  },
  {
    name: 'wholesale_customer_payment_compass_group',
    match: ({ counterparty, amount }) =>
      /compass\s*group/i.test(counterparty || '') && amount > 0,
    target_account_name: 'Clearing Accounts:Cash Clearing',
    reasoning: 'Compass Group wholesale customer payment to Cash Clearing — Phase 20D wholesale reconstruction handles revenue recognition monthly.',
    confidence: 0.95,
  },
  {
    name: 'wholesale_customer_payment_goldminers',
    match: ({ counterparty, amount }) =>
      /goldminer/i.test(counterparty || '') && amount > 0,
    target_account_name: 'Clearing Accounts:Cash Clearing',
    reasoning: 'Goldminer\'s Daughter wholesale customer payment to Cash Clearing — Phase 20D wholesale reconstruction handles revenue recognition.',
    confidence: 0.95,
  },
  {
    name: 'wholesale_customer_payment_ph_club',
    match: ({ counterparty, amount }) =>
      /ph\s*club/i.test(counterparty || '') && amount > 0,
    target_account_name: 'Clearing Accounts:Cash Clearing',
    reasoning: 'PH Club wholesale customer payment to Cash Clearing — Phase 20D wholesale reconstruction handles revenue recognition.',
    confidence: 0.95,
  },
  {
    name: 'state_of_utah_refund',
    match: ({ counterparty, amount }) =>
      /state\s*of\s*utah/i.test(counterparty || '') && amount > 0,
    target_account_name: 'Sales Tax Over/Under',
    reasoning: 'State of Utah refund/credit — sales tax adjustment.',
    confidence: 0.90,
  },

  // INTUIT (QBO Payments) wholesale customer payments — Phase 23-Audit3 May 16 2026:
  // Caught 41 uncategorized INTUIT inflows totaling $55,939. These are wholesale customers
  // paying invoices via QBO Payments. Route to Cash Clearing — qbo_payment_wholesale_reconstruction
  // monthly worker handles revenue recognition (matches Compass/Goldminer/PH Club pattern above).
  {
    name: 'intuit_wholesale_payment',
    match: ({ counterparty, amount }) =>
      /^INTUIT/i.test(counterparty || '') && amount > 100,
    target_account_name: 'Clearing Accounts:Cash Clearing',
    reasoning: 'INTUIT (QBO Payments) wholesale customer payment to Cash Clearing — qbo_payment_wholesale_reconstruction handles revenue recognition monthly.',
    confidence: 0.92,
  },

  // ── OUTFLOWS (negative amount) ─────────────────────────────────────────
  // Food vendors (all to Cost of goods sold:Food Purchases by default)
  {
    name: 'sysco_food',
    match: ({ counterparty }) => /sysco/i.test(counterparty),
    target_account_name: 'Cost of goods sold:Food Purchases',
    reasoning: 'Sysco food vendor — primary wholesale food supplier.',
    confidence: 0.98,
  },
  {
    name: 'us_foods',
    match: ({ counterparty }) => /us\s*foodservice|us\s*foods/i.test(counterparty),
    target_account_name: 'Cost of goods sold:Food Purchases',
    reasoning: 'US Foods — wholesale food distributor.',
    confidence: 0.98,
  },
  {
    name: 'shamrock_foods',
    match: ({ counterparty }) => /shamrock\s*foods/i.test(counterparty),
    target_account_name: 'Cost of goods sold:Food Purchases',
    reasoning: 'Shamrock Foods — wholesale food distributor.',
    confidence: 0.98,
  },
  {
    name: 'pfg_food',
    match: ({ counterparty }) => /^pfg\b|performance\s*food\s*group/i.test(counterparty),
    target_account_name: 'Cost of goods sold:Food Purchases',
    reasoning: 'Performance Food Group — wholesale food distributor.',
    confidence: 0.98,
  },
  {
    name: 'instacart_supplies',
    match: ({ counterparty }) => /instacart/i.test(counterparty),
    target_account_name: 'Cost of goods sold:Food Purchases',
    reasoning: 'Instacart — fill-in grocery delivery for food supplies.',
    confidence: 0.85,  // could be supplies vs food — slightly lower
  },

  // Payroll
  // ─────────────────────────────────────────────────────────────────────
  // Session 26 NOTE (May 18 2026 — other Claude flagged): Toast Payroll and
  // Square Payroll Mercury outflows currently route to the "Payroll Expenses"
  // PARENT account, lumping ~$74K into one bucket without splitting across
  // FOH / BOH / Management / Shift Lead / Payroll Tax / Payroll Fees children.
  //
  // Why we keep parent for now: a single Mercury Payroll outflow represents
  // a full pay-period lump (gross + employer taxes + fees). Splitting it
  // accurately requires Square Labor API lookup for the pay period covered,
  // applying per-shift cost × wage by team_member department. The infrastructure
  // exists (workers/square-labor-sync.js + square_shifts table) but wiring
  // the splitter into the JE poster is its own workstream — deferred to
  // Phase 27. Until then, expense_category='labor' on the parent ensures the
  // P&L still groups it correctly into the Labor subtotal for Prime Cost calc.
  //
  // TODO Phase 27: Build payroll-splitter that queries square_shifts for the
  // 14-day pay period ending on the outflow date, computes per-department $$,
  // posts a multi-line JE: DR FOH $x / DR BOH $y / DR Mgmt $z / DR Shift Lead $a
  // / DR Payroll Taxes $b / DR Payroll Fees $c / CR Mercury Checking $total
  // ─────────────────────────────────────────────────────────────────────
  {
    name: 'toast_payroll',
    match: ({ counterparty }) => /toast\s*payroll/i.test(counterparty),
    target_account_name: 'Clearing Accounts:Payroll Clearing',
    reasoning: 'Toast Payroll cash leg → Payroll Clearing transit account. The accrual leg (DR Salaries by Job + DR Payroll Taxes + DR Tips Payable / CR Payroll Clearing + CR Payroll Tax Payable + CR Manual Checks) is posted by toast_payroll_reconstruction worker from toast_payroll_gl source. Per-cycle clearing nets to ~$0. (Phase 30 Pattern B, May 20 2026.)',
    confidence: 0.95,
  },
  {
    name: 'square_payroll',
    // Match both "Square Payroll" counterparty AND "Square Inc; PAYROLL"
    // description pattern (verified May 13 2026: real Square Payroll txns
    // come through as counterparty="Square Inc" with "PAYROLL" in description).
    match: ({ counterparty, description, amount }) =>
      amount < 0 && (
        /square\s*payroll/i.test(counterparty) ||
        (/^square\s*inc/i.test(counterparty) && /PAYROLL/i.test(description || ''))
      ),
    target_account_name: 'Payroll Expenses',
    reasoning: 'Square Payroll run — gross wages + employer taxes + fees. (Phase 27: split into FOH/BOH/Mgmt children via Square Labor.)',
    confidence: 0.95,
  },

  // LEAF equipment loan payments — approximate 75/25 principal/interest split pending
  // Drew's accountant amortization schedule. Phase 23-LEAF foundational reclass May 15 2026:
  // bookkeeper-era FY2024 interest claim was $10,787 on ~$42K of LEAF payments = 25.7%.
  // Per-loan amount identifies which loan:
  //   $1,523.67 → Pizza Ovens   |  $683.03 → Kemper Bakery
  //   $674.61 → Comm Kitchen 2  |  $591.33 → Commercial Kitchen Supply
  // Single-target rule (Interest paid) here; JE poster manually splits when posting.
  // TODO: when Drew provides exact amortization, swap to per-month-per-loan schedule.
  {
    name: 'leaf_loan',
    match: ({ counterparty }) => /^LEASE\s*SERVICES|^LEAF\b/i.test(counterparty),
    target_account_name: 'Clearing Accounts:LEAF Clearing',
    reasoning: 'LEAF lease cash leg → LEAF Clearing transit account. The accrual leg (DR N/P LEAF <loan> principal + DR Interest paid + DR Sales tax to pay / CR LEAF Clearing) is posted by leaf_amortization_reconstruction worker using actual amortization schedules from the 4 lease agreements. Per-cycle clearing nets to ~$0. (Phase 30 Pattern B, May 20 2026.)',
    confidence: 0.95,
  },

  // Utilities / common services (pattern-matched on name fragments)
  {
    name: 'amazon_supplies',
    match: ({ counterparty }) => /^amazon/i.test(counterparty),
    target_account_name: 'Restaurant Supplies & Equipment',   // best guess; falls back if account absent
    reasoning: 'Amazon purchase — default to Restaurant Supplies. If >$2,500 flag as capex candidate.',
    confidence: 0.75,  // could be many categories; lower confidence for review
  },

  // ── Session 26 Bonus: SaaS / subscription rules to drain Ask My Accountant ──
  // Other Claude (May 18 2026) flagged FY2026 Ask My Accountant climbed to $12.8K
  // because Mercury IO (Chase Ink) charges for OpenAI / Anthropic / Ledger Collective /
  // PayPal / etc. had no categorizer rule and fell through to AMA fallback.
  // These rules route them to Software & apps (proper SaaS expense category).
  {
    name: 'openai_subscription',
    match: ({ counterparty, description }) => /openai/i.test(counterparty + ' ' + description),
    target_account_name: 'Software & apps',
    reasoning: 'OpenAI API/ChatGPT subscription — Software & apps.',
    confidence: 0.95,
  },
  {
    name: 'anthropic_subscription',
    match: ({ counterparty, description }) => /anthropic/i.test(counterparty + ' ' + description),
    target_account_name: 'Software & apps',
    reasoning: 'Anthropic Claude subscription — Software & apps.',
    confidence: 0.95,
  },
  {
    name: 'paypal_charge',
    match: ({ counterparty, description }) => /^paypal\s*(\*|charge)?/i.test(counterparty)
      || /(?:^|\s)paypal\s+\*/i.test(description),
    target_account_name: 'Software & apps',  // Most PayPal charges are SaaS; flag low-confidence for Drew review
    reasoning: 'PayPal charge — usually SaaS/vendor; flagged for Drew review if material.',
    confidence: 0.70,  // intentionally lower than auto-post threshold; surfaces to inbox
  },
  {
    name: 'ledger_collective',
    match: ({ counterparty }) => /ledger\s*collective/i.test(counterparty),
    target_account_name: 'Software & apps',
    reasoning: 'Ledger Collective — accounting software subscription. Software & apps.',
    confidence: 0.90,
  },
  {
    name: 'salt_seek',
    match: ({ counterparty }) => /salt\s*(?:&|and|\s)*seek/i.test(counterparty),
    target_account_name: 'Software & apps',  // best guess; could be marketing — surface to Drew if material
    reasoning: 'Salt & Seek LLC — assumed SaaS/marketing vendor. Flag for Drew if pattern unclear.',
    confidence: 0.70,
  },
  // Common SaaS vendors that often flow through Chase Ink → unrouted today
  {
    name: 'common_saas_subscriptions',
    match: ({ counterparty }) => /\b(slack|notion|airtable|figma|github|gitlab|netlify|vercel|cloudflare|datadog|sentry|linear|asana|trello|zapier|mailchimp|sendgrid|twilio|stripe(?!\s*charge))\b/i.test(counterparty),
    target_account_name: 'Software & apps',
    reasoning: 'Recognized SaaS vendor — Software & apps subscription.',
    confidence: 0.92,
  },

  // Mercury wire fees / bank fees
  {
    name: 'mercury_fee',
    match: ({ counterparty, description }) => /wire\s*fee|mercury\s*fee|returned\s*item/i.test(counterparty + ' ' + description),
    target_account_name: 'Bank fees & service charges',
    reasoning: 'Bank/wire fee or returned item charge.',
    confidence: 0.95,
  },

  // Utah State Tax Commission (sales tax payments)
  // Matches:
  //   - "UTAH801/297-7703" (Mercury format for state tax filing)
  //   - "UTAHTAXES 801.297.22" (Mercury description for state tax — sometimes counterparty shows as "Utah DMV")
  //   - "Utah State Tax Commission"
  //   - "UT TAX COMMISSION", etc.
  //   - "TC-62" (state form ID)
  // Checks BOTH counterparty AND description — Mercury occasionally mislabels counterparty
  // (e.g. "Utah DMV" with UTAHTAXES in description — Phase 23-DMV May 15 2026 finding).
  // (Phase 23-Sales-A + 23-DMV foundational fix: prior regex /utah.*tax|tax\s*commission/i
  //  did not match "UTAH801/..." or "UTAHTAXES ..." formats AND target_account_name 'Sales Tax Payable'
  //  did not exist in COA — actual account name is 'Sales tax to pay'.)
  {
    name: 'utah_tax_commission',
    match: ({ counterparty, description }) => {
      const text = `${counterparty || ''} ${description || ''}`;
      return /utah[\s\-_]?(801|state|tax)|utahtaxes|tax\s*commission|tc[\s\-_]?62|ut[\s\-_]?tax/i.test(text);
    },
    target_account_name: 'Sales tax to pay',
    reasoning: 'Utah State Tax Commission — sales tax remittance (DR Sales tax to pay liability, CR Mercury). Drains accrued sales tax liability.',
    confidence: 0.92,
  },
];

// Fallback account resolver — maps target names to current COA IDs.
// Builds a cache once per request invocation.
let _accountCache = null;
async function resolveAccountId(env, nameOrAlias) {
  if (!_accountCache) {
    const { results } = await env.DB.prepare(
      `SELECT id, account_name FROM chart_of_accounts WHERE is_active = 1`
    ).all();
    _accountCache = new Map();
    for (const row of (results || [])) {
      _accountCache.set(row.account_name.toLowerCase(), row.id);
    }
  }
  // Exact (case-insensitive)
  const exact = _accountCache.get(nameOrAlias.toLowerCase());
  if (exact) return { id: exact, matched: nameOrAlias };
  // Fuzzy: find first account_name containing the alias
  const alias = nameOrAlias.toLowerCase();
  for (const [name, id] of _accountCache.entries()) {
    if (name.includes(alias) || alias.includes(name)) return { id, matched: name };
  }
  return { id: null, matched: null };
}

// ── Haiku fallback ────────────────────────────────────────────────────────
async function haikuCategorize(env, txn, similarPriors) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const { results: accounts } = await env.DB.prepare(
    `SELECT id, account_name, account_type FROM chart_of_accounts WHERE is_active = 1 AND account_type IN ('expense','cogs','asset','liability','revenue','other_income','other_expense') ORDER BY account_type, account_name LIMIT 200`
  ).all();
  const accountList = (accounts || []).map(a => `  - ${a.account_name} (${a.account_type})`).join('\n');

  const prompt = `You are a bookkeeper categorizing a Mercury bank transaction for Dangerous Pretzel Company LLC (single-location food service in Salt Lake City).

TRANSACTION:
- Date: ${txn.txn_date}
- Amount: $${txn.amount} (${txn.amount > 0 ? 'INFLOW' : 'OUTFLOW'})
- Counterparty: ${txn.counterparty_name || '(none)'}
- Description: ${txn.description || '(none)'}
- Mercury category: ${txn.category || '(none)'}

SIMILAR PRIOR TRANSACTIONS (same counterparty, recent):
${similarPriors.length ? similarPriors.map(p => `  - ${p.txn_date} $${p.amount} → proposed: ${p.proposed_account_name || 'not yet categorized'}`).join('\n') : '  (none)'}

CHART OF ACCOUNTS (choose exactly one):
${accountList}

Return STRICT JSON (no markdown fences, no prose):
{
  "account_name": "<exact account_name from the list above>",
  "confidence": <0.0 to 1.0>,
  "reasoning": "<1 sentence why>",
  "needs_review": <true if confidence < 0.90 or the txn is unusual>
}`;

  // Session 0 (May 13 2026): all Anthropic calls go through ai-budget.js
  // for cost tracking + budget enforcement + model routing.
  const { callAI } = await import('./ai-budget.js');
  const aiResult = await callAI(env, {
    use_case: 'categorizer_fallback',
    model: 'haiku',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
    caller: 'finance-cfo-categorizer.js:haikuCategorize',
  });

  if (!aiResult.ok) {
    const errBody = aiResult.error || aiResult.blocked_reason || 'unknown';
    await env.DB.prepare(`
      INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
      VALUES (?, 'haiku_http_error', 'mercury_transactions', ?, 'cfo_agent', ?)
    `).bind(crypto.randomUUID(), txn.id, `Haiku: ${errBody.slice(0, 400)}`).run().catch(() => {});
    return null;
  }
  // ai-budget wrapper already extracted the text content
  const text = aiResult.content || '';
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return parsed;
  } catch (e) {
    await env.DB.prepare(`
      INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
      VALUES (?, 'haiku_parse_error', 'mercury_transactions', ?, 'cfo_agent', ?)
    `).bind(crypto.randomUUID(), txn.id, `Parse failed. Raw (first 400): ${String(text).slice(0, 400)}`).run().catch(() => {});
    return null;
  }
}

// ── Find similar historical txns (same counterparty) for Haiku context ────
async function findSimilarPriors(env, txn, limit = 5) {
  if (!txn.counterparty_name) return [];
  const { results } = await env.DB.prepare(`
    SELECT m.txn_date, m.amount, m.proposed_account_id, c.account_name as proposed_account_name
    FROM mercury_transactions m
    LEFT JOIN chart_of_accounts c ON c.id = m.proposed_account_id
    WHERE m.counterparty_name = ?
      AND m.proposed_account_id IS NOT NULL
      AND m.id != ?
    ORDER BY m.txn_date DESC
    LIMIT ?
  `).bind(txn.counterparty_name, txn.id, limit).all();
  return results || [];
}

// ── Single-txn categorizer (used by batch + manual trigger) ──────────────
export async function categorizeOne(env, txn, opts = {}) {
  const input = {
    counterparty: txn.counterparty_name || '',
    description: txn.description || '',
    amount: Number(txn.amount) || 0,
    date: txn.txn_date,
    account_name: txn.account_name || '',  // Mercury account name (e.g. "Mercury Checking ••0118") — used by intercompany resolver rules
  };

  // ─── V3-B SMART CATEGORIZER STACK (May 13 2026) ──────────────────────
  // Decision precedence:
  //   1. cfo_facts (Drew explicitly clarified this vendor) — confidence 1.0
  //   2. vendor KB (bookkeeper's QBO history pattern) — confidence 0.85-0.98
  //   3. Rule-based (legacy hardcoded patterns) — confidence per-rule
  //   4. Haiku fallback (novel vendors) — confidence varies
  //   5. Unmatched → surface to Drew

  // STEP 1: Check cfo_facts for an explicit vendor_rule the agent has been told
  if (txn.counterparty_name) {
    try {
      const { lookupVendor: vendorKbLookup } = await import('./finance-vendor-kb.js');
      const vendorResult = await vendorKbLookup(env, txn.counterparty_name);
      if (vendorResult.found && vendorResult.source === 'cfo_fact') {
        return {
          rule: 'cfo_fact_override',
          account_id: vendorResult.account_id,
          account_name_resolved: vendorResult.account_name,
          confidence: vendorResult.confidence,
          reasoning: vendorResult.reasoning,
          needs_review: false,
          source: 'cfo_fact',
        };
      }
      // STEP 2: Check vendor KB (bookkeeper history)
      if (vendorResult.found && vendorResult.confidence >= 0.85) {
        return {
          rule: 'vendor_kb',
          account_id: vendorResult.account_id,
          account_name_resolved: vendorResult.account_name,
          confidence: vendorResult.confidence,
          reasoning: vendorResult.reasoning,
          needs_review: vendorResult.confidence < 0.90,
          source: 'vendor_kb',
        };
      }
      // KB found but low dominance — fall through to rules but log
      if (vendorResult.found && vendorResult.confidence < 0.85) {
        await env.DB.prepare(`
          INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
          VALUES (?, 'vendor_kb_low_dominance', 'mercury_transactions', ?, 'cfo_agent', ?)
        `).bind(
          crypto.randomUUID(), txn.id,
          `Vendor "${txn.counterparty_name}" in KB but split: ${Math.round((vendorResult.dominant_share || 0) * 100)}% to ${vendorResult.account_name} across ${vendorResult.total_txns} prior txns. Falling through to rules.`
        ).run().catch(() => {});
      }
    } catch (err) {
      // KB unavailable — fall through silently to rules
    }
  }

  // STEP 3: Try rules (legacy fast path)
  for (const rule of CATEGORIZATION_RULES) {
    if (rule.match(input)) {
      // Resolve target account: either static target_account_name, or a resolver
      // function that uses the txn input (e.g., for intercompany cross-account routing).
      const targetName = rule.target_account_resolver
        ? rule.target_account_resolver(input)
        : rule.target_account_name;
      const { id: accountId, matched } = await resolveAccountId(env, targetName);
      if (accountId) {
        return {
          rule: rule.name,
          account_id: accountId,
          account_name_resolved: matched,
          confidence: rule.confidence,
          reasoning: rule.reasoning,
          needs_review: rule.needs_review === true || rule.confidence < 0.90,
          skip_je_posting: rule.skip_je_posting === true,
          source: 'rule',
        };
      }
    }
  }

  // Haiku fallback (optional — can be skipped for speed)
  if (!opts.skip_ai) {
    const priors = await findSimilarPriors(env, txn);
    const ai = await haikuCategorize(env, txn, priors);
    if (ai && ai.account_name) {
      const { id: accountId, matched } = await resolveAccountId(env, ai.account_name);
      if (accountId) {
        return {
          rule: null,
          account_id: accountId,
          account_name_resolved: matched,
          confidence: Math.min(Math.max(Number(ai.confidence) || 0.5, 0), 1),
          reasoning: ai.reasoning || 'Haiku categorization',
          needs_review: ai.needs_review || (Number(ai.confidence) || 0) < 0.90,
          source: 'haiku',
        };
      } else {
        await env.DB.prepare(`
          INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
          VALUES (?, 'haiku_unresolvable_account', 'mercury_transactions', ?, 'cfo_agent', ?)
        `).bind(crypto.randomUUID(), txn.id, `Haiku suggested account_name "${ai.account_name}" — not found in COA. Conf=${ai.confidence}`).run().catch(() => {});
      }
    }
  }

  // Total miss → queue for Drew with null proposal
  return {
    rule: null,
    account_id: null,
    account_name_resolved: null,
    confidence: 0,
    reasoning: opts.skip_ai ? 'No rule matched (AI skipped). Needs Drew review or Haiku pass.' : 'No rule matched and Haiku could not produce valid categorization. Needs Drew review.',
    needs_review: true,
    source: 'unmatched',
  };
}

// ── Batch categorizer — walks uncategorized mercury_transactions ──────────
export async function categorizeBatch(env, opts = {}) {
  _accountCache = null;  // invalidate per-invocation so COA edits take effect
  const limit = Math.min(opts.limit || 500, 2000);
  // Phase 23-FAILED: skip Mercury txns with status='failed' — money did not move,
  // they should never have JEs. Tier 1 invariant `no_je_for_failed_mercury_txns`
  // enforces this; this filter prevents the bug at-source.
  const { results } = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name, description, category, status
    FROM mercury_transactions
    WHERE proposed_account_id IS NULL
      AND user_overridden = 0
      AND (status IS NULL OR status != 'failed')
    ORDER BY txn_date DESC
    LIMIT ?
  `).bind(limit).all();

  const stats = {
    processed: 0,
    categorized_by_rule: 0,
    categorized_by_ai: 0,
    unmatched: 0,
    auto_posted: 0,          // future: ≥ 0.90 confidence auto-post to GL
    queued_for_review: 0,
    by_rule: {},
    by_account: {},
    errors: [],
  };

  for (const txn of (results || [])) {
    try {
      const result = await categorizeOne(env, txn, { skip_ai: !!opts.skip_ai });
      stats.processed += 1;
      if (result.source === 'rule') stats.categorized_by_rule += 1;
      else if (result.source === 'haiku') stats.categorized_by_ai += 1;
      else stats.unmatched += 1;
      if (result.needs_review) stats.queued_for_review += 1;
      if (result.rule) stats.by_rule[result.rule] = (stats.by_rule[result.rule] || 0) + 1;
      if (result.account_name_resolved) stats.by_account[result.account_name_resolved] = (stats.by_account[result.account_name_resolved] || 0) + 1;

      // Write proposal back to the transaction row (doesn't post a JE yet — that's C-5)
      if (result.account_id) {
        await env.DB.prepare(`
          UPDATE mercury_transactions
          SET proposed_account_id = ?,
              proposed_confidence = ?,
              proposed_reasoning = ?
          WHERE id = ?
        `).bind(result.account_id, result.confidence, result.reasoning, txn.id).run();
      }
    } catch (err) {
      stats.errors.push({ txn_id: txn.id, error: err.message.slice(0, 200) });
    }
  }

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'cfo_categorize_batch', 'mercury_transactions', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `batch_${Date.now()}`,
    `Categorized ${stats.processed} txns: rule=${stats.categorized_by_rule}, ai=${stats.categorized_by_ai}, unmatched=${stats.unmatched}, review=${stats.queued_for_review}`,
    JSON.stringify(stats)
  ).run();

  return stats;
}

// ── Single-txn manual trigger (for debugging) ─────────────────────────────
export async function categorizeOneById(env, txnId) {
  _accountCache = null;
  const txn = await env.DB.prepare(
    `SELECT id, txn_date, amount, counterparty_name, description, category FROM mercury_transactions WHERE id = ?`
  ).bind(txnId).first();
  if (!txn) return { error: 'transaction not found' };
  const result = await categorizeOne(env, txn);
  if (result.account_id) {
    await env.DB.prepare(`
      UPDATE mercury_transactions
      SET proposed_account_id = ?,
          proposed_confidence = ?,
          proposed_reasoning = ?
      WHERE id = ?
    `).bind(result.account_id, result.confidence, result.reasoning, txnId).run();
  }
  return { txn, categorization: result };
}

// ── Stats endpoint ────────────────────────────────────────────────────────
export async function categorizationStats(env) {
  const [overall, byAccount, bySource] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN proposed_account_id IS NOT NULL THEN 1 ELSE 0 END) as categorized,
             SUM(CASE WHEN is_reconciled = 1 THEN 1 ELSE 0 END) as posted_to_gl,
             SUM(CASE WHEN proposed_account_id IS NOT NULL AND proposed_confidence < 0.90 THEN 1 ELSE 0 END) as queued_for_review
      FROM mercury_transactions
    `).first(),
    env.DB.prepare(`
      SELECT c.account_name, COUNT(*) as n, ROUND(SUM(m.amount), 2) as total_amount
      FROM mercury_transactions m
      JOIN chart_of_accounts c ON c.id = m.proposed_account_id
      GROUP BY c.account_name
      ORDER BY n DESC
      LIMIT 20
    `).all(),
    env.DB.prepare(`
      SELECT
        CASE
          WHEN proposed_confidence IS NULL THEN 'uncategorized'
          WHEN proposed_confidence >= 0.95 THEN 'high_confidence'
          WHEN proposed_confidence >= 0.90 THEN 'acceptable'
          WHEN proposed_confidence >= 0.70 THEN 'needs_review'
          ELSE 'low_confidence_review'
        END as bucket,
        COUNT(*) as n
      FROM mercury_transactions
      GROUP BY bucket
      ORDER BY n DESC
    `).all(),
  ]);
  return {
    overall,
    top_accounts: byAccount.results || [],
    by_confidence_bucket: bySource.results || [],
  };
}
