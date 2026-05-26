// workers/finance-capex-reasoner.js
// Sonnet-powered "should this be capitalized?" recommender.
//
// For each capex candidate (Mercury outflow >$2,500 to equipment vendor):
//   1. Build context: vendor history, similar prior decisions, useful life norms
//   2. Ask Sonnet to recommend capitalize vs expense, with reasoning
//   3. Surface as a pending approval in agent_decisions (drew_action=NULL)
//   4. Drew approves → capex flagger creates fixed asset + depreciation schedule
//   5. Drew rejects → mark as expense, proposed_account_id stays
//
// Per Drew's plan decision (v3.1 Q3 = B): propose-and-wait, never auto-apply
// capex without approval (tax implications).
//
// Endpoint: POST /finance/capex/:txn_id/reason — invoke Sonnet on one candidate

import { callAI } from './ai-budget.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

const ASSET_CLASS_DEFAULTS = {
  restaurant_equipment: { useful_life: 7, depreciation: 'MACRS 7-yr' },
  leasehold_improvement: { useful_life: 15, depreciation: 'straight-line 15-yr' },
  office_equipment:     { useful_life: 5, depreciation: 'MACRS 5-yr' },
  vehicle:              { useful_life: 5, depreciation: 'MACRS 5-yr' },
  warmer:               { useful_life: 5, depreciation: 'straight-line 5-yr' },
  signage:              { useful_life: 7, depreciation: 'MACRS 7-yr' },
};

const VENDOR_ASSET_HINTS = [
  { pattern: /webstaurant|katom|chefs|grainger|kitchen/i, class: 'restaurant_equipment' },
  { pattern: /home depot|lowes|menards/i, class: 'leasehold_improvement' },
  { pattern: /apple|dell|hp|costco.*business/i, class: 'office_equipment' },
  { pattern: /uline/i, class: 'restaurant_equipment' },  // pkg or storage
  { pattern: /sign|banner|graphics/i, class: 'signage' },
];

function inferAssetClass(vendor, description) {
  const haystack = `${vendor || ''} ${description || ''}`;
  for (const hint of VENDOR_ASSET_HINTS) {
    if (hint.pattern.test(haystack)) return hint.class;
  }
  return null;
}

// ── Main: reason about a single capex candidate ──────────────────────────
export async function reasonAboutCapex(env, txnId) {
  // Pull the Mercury txn
  const txn = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name, description, proposed_account_id, proposed_account_id, is_reconciled
    FROM mercury_transactions WHERE id = ?
  `).bind(txnId).first();
  if (!txn) return { error: 'txn not found' };
  if (Math.abs(txn.amount) < 500) return { error: 'amount too small for capex consideration ($500 minimum)' };

  // Check cfo_facts for vendor-specific capex rule
  const { lookupFacts } = await import('./finance-cfo-facts.js');
  const facts = await lookupFacts(env, txn.counterparty_name);
  const drewRule = (facts.facts || []).find(f =>
    f.fact_type === 'drew_preference' || f.fact_type === 'capex_threshold'
  );

  // Vendor history for context
  const { lookupVendor } = await import('./finance-vendor-kb.js');
  const vendorKb = await lookupVendor(env, txn.counterparty_name);

  // Similar prior decisions
  const { results: priorDecisions } = await env.DB.prepare(`
    SELECT decision_at, decision, drew_action, reasoning
    FROM agent_decisions
    WHERE decision_type = 'capitalize' AND subject_type = 'mercury_txn'
    ORDER BY decision_at DESC LIMIT 5
  `).all();

  // Infer asset class
  const inferred_class = inferAssetClass(txn.counterparty_name, txn.description);
  const defaults = inferred_class ? ASSET_CLASS_DEFAULTS[inferred_class] : null;

  // Compose prompt
  const prompt = `You are Pretzel OS's capex decision assistant. A new Mercury transaction needs a capitalize-vs-expense recommendation.

TRANSACTION:
- Vendor: ${txn.counterparty_name}
- Amount: $${Math.abs(txn.amount).toFixed(2)}
- Date: ${txn.txn_date.slice(0, 10)}
- Description: ${txn.description || '(none)'}

VENDOR HISTORY (from bookkeeper's QBO records):
${vendorKb.found
  ? `- Bookkeeper categorized this vendor ${Math.round((vendorKb.dominant_share || 0) * 100)}% to ${vendorKb.account_name} across ${vendorKb.total_txns} historical transactions.`
  : '- No prior history with this vendor.'}

DREW'S PRIOR CLARIFICATIONS:
${drewRule ? `- ${drewRule.content}` : '- None on file.'}

INFERRED ASSET CLASS: ${inferred_class || 'unclear'} ${defaults ? `(typical useful life ${defaults.useful_life} years, ${defaults.depreciation})` : ''}

SIMILAR RECENT DECISIONS:
${(priorDecisions || []).slice(0, 3).map(d => `- ${d.decision_at?.slice(0, 10)}: ${d.decision} (Drew: ${d.drew_action || 'pending'})`).join('\n') || '- None'}

ACCOUNTING GUIDELINES:
- IRS Section 179 / De Minimis Safe Harbor allows expensing items up to $2,500 (or $5,000 with applicable financial statements)
- Above thresholds: capitalize as fixed asset, depreciate over useful life
- Repair/maintenance: always expense (not capex)
- Supplies/consumables: always expense even if >$2,500
- Restaurant equipment standard useful life: 5-7 years (MACRS)
- Leasehold improvements: 15 years straight-line

RECOMMEND: capitalize or expense?

Return STRICT JSON (no markdown):
{
  "recommendation": "capitalize" or "expense",
  "confidence": <0.0-1.0>,
  "asset_class": "<from list if capitalizing>" or null,
  "useful_life_years": <number if capitalizing>,
  "depreciation_method": "<e.g. MACRS 7-yr SL>" or null,
  "asset_name_suggestion": "<descriptive name>" or null,
  "reasoning": "<2 sentence explanation>",
  "needs_drew_review": <true if amount > $5K, vendor is new, OR confidence < 0.85>
}`;

  const aiResult = await callAI(env, {
    use_case: 'capex_reasoner',
    model: 'sonnet',           // worth the cost for tax-implication decisions
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
    caller: 'finance-capex-reasoner.js:reasonAboutCapex',
  });

  if (!aiResult.ok) {
    return { error: aiResult.error || aiResult.blocked_reason, txn_id: txnId };
  }

  // Parse JSON
  let parsed;
  try {
    const stripped = (aiResult.content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(stripped);
  } catch (err) {
    return { error: 'failed to parse AI response', raw: aiResult.content, txn_id: txnId };
  }

  // Log decision (drew_action=NULL — pending his approval)
  const decisionId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO agent_decisions (id, decision_type, subject_id, subject_type, decision,
      reasoning, source_used, source_version, confidence, cost_usd)
    VALUES (?, 'capitalize', ?, 'mercury_txn', ?, ?, 'sonnet', ?, ?, ?)
  `).bind(
    decisionId, txnId,
    `${parsed.recommendation}: ${parsed.asset_name_suggestion || ''}`.slice(0, 500),
    parsed.reasoning.slice(0, 1000), aiResult.model_used,
    parsed.confidence, aiResult.cost_usd,
  ).run().catch(() => {});

  return {
    ok: true,
    decision_id: decisionId,
    txn: { id: txn.id, vendor: txn.counterparty_name, amount: Math.abs(txn.amount), date: txn.txn_date.slice(0, 10) },
    recommendation: parsed.recommendation,
    confidence: parsed.confidence,
    asset_class: parsed.asset_class,
    useful_life_years: parsed.useful_life_years,
    depreciation_method: parsed.depreciation_method,
    asset_name_suggestion: parsed.asset_name_suggestion,
    reasoning: parsed.reasoning,
    needs_drew_review: parsed.needs_drew_review,
    cost_usd: aiResult.cost_usd,
  };
}

// ── List pending capex approvals for dashboard inbox ─────────────────────
export async function listPendingCapexApprovals(env) {
  const { results } = await env.DB.prepare(`
    SELECT d.id, d.decision_at, d.decision, d.reasoning, d.confidence, d.subject_id,
           m.counterparty_name, m.amount, m.txn_date, m.description
    FROM agent_decisions d
    LEFT JOIN mercury_transactions m ON m.id = d.subject_id
    WHERE d.decision_type = 'capitalize'
      AND d.drew_action IS NULL
    ORDER BY d.decision_at DESC LIMIT 50
  `).all();
  return { count: (results || []).length, pending: results || [] };
}

// ── Mark a decision approved or rejected ─────────────────────────────────
export async function approveCapexDecision(env, decisionId) {
  await env.DB.prepare(`
    UPDATE agent_decisions SET drew_action = 'approved', drew_action_at = datetime('now')
    WHERE id = ?
  `).bind(decisionId).run();
  // Note: actual capitalization (fixed asset row + depreciation schedule) is
  // handled by the existing capex flagger when triggered separately.
  return { ok: true, decision_id: decisionId };
}

export async function rejectCapexDecision(env, decisionId) {
  await env.DB.prepare(`
    UPDATE agent_decisions SET drew_action = 'overridden', drew_action_at = datetime('now')
    WHERE id = ?
  `).bind(decisionId).run();
  return { ok: true, decision_id: decisionId };
}
