# LLM Categorization Layer Design (Phase A Week 1 Task B2)

**Generated:** 2026-05-27 (Day 3)
**Status:** Design + skeleton. Drift test scaffold ready; live drift run + full build is Day 4 deliverable.
**Mode:** SHADOW (writes audit_trail with LLM suggestion, does NOT auto-post JEs in production)
**Companion:** `workers/llm-categorizer.js` (skeleton — to be completed Day 4)

---

## Purpose

The existing rule-based categorizer (`workers/finance-cfo-categorizer.js`) has 30 hardcoded rules covering the highest-volume vendors. Anything that doesn't match a rule stays in the review queue with `proposed_account_id = NULL`. The LLM layer fills that gap: when a transaction has no matching rule, Claude Sonnet proposes a category with confidence + reasoning, logged to `audit_trail`.

Week 1 ships SHADOW mode — LLM runs and writes audit entries, no JEs auto-posted. Validates accuracy before auto-post is enabled (Week 2+).

---

## Architecture

```
Mercury txn arrives
        │
        ▼
┌─────────────────────────────────────┐
│ Existing rule-based categorizer    │
│  (workers/finance-cfo-categorizer)  │
│  30 hardcoded rules                 │
└────────────────┬────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
   Rule matched?     No match
   (proposed_id      (proposed_id = NULL)
    set)                 │
        │                ▼
        │       ┌──────────────────────┐
        │       │ NEW: LLM Categorizer │
        │       │  workers/llm-        │
        │       │  categorizer.js      │
        │       │                      │
        │       │ Sonnet 4.6 call:     │
        │       │ - txn details        │
        │       │ - vendor history     │
        │       │ - COA list           │
        │       │ - cfo_facts          │
        │       │                      │
        │       │ Returns:             │
        │       │  { account_name,     │
        │       │    confidence,       │
        │       │    reasoning }       │
        │       └──────────┬───────────┘
        │                  │
        │                  ▼
        │       ┌──────────────────────┐
        │       │ Confidence tier      │
        │       │  routing:            │
        │       │ ≥0.95 → AUTO         │
        │       │ 0.80-0.95 → AUTO+    │
        │       │            FLAG      │
        │       │ 0.60-0.80 → QUEUE    │
        │       │ <0.60 → LOW-CONF     │
        │       │            QUEUE     │
        │       │ Disagrees rule →     │
        │       │  ALWAYS QUEUE        │
        │       └──────────┬───────────┘
        │                  │
        │                  ▼
        │       ┌──────────────────────┐
        │       │ WEEK 1 SHADOW MODE   │
        │       │ Write audit_trail    │
        │       │  with full LLM       │
        │       │  metadata.           │
        │       │ DO NOT auto-post.    │
        │       │ All suggestions →    │
        │       │  review queue.       │
        │       └──────────────────────┘
        ▼
existing JE poster
(unchanged for rule-matched txns)
```

---

## Prompt design (Sonnet 4.6)

### System prompt

```
You are the categorization assistant for Dangerous Pretzel Company LLC, a small
fast-casual restaurant in Salt Lake City, Utah. The owner Drew has fired his
bookkeeper and is rebuilding accurate books in a system called Pretzel OS.

Your job: given a single bank transaction that the rule-based categorizer
couldn't classify, propose ONE account from the chart of accounts where it
should be posted, plus a confidence score (0-100) and one-sentence reasoning.

Business context:
- 3 revenue channels: Retail (in-store + Toast/Square POS), Wholesale
  (Compass Group, breweries, etc.), Catering (events, weddings)
- 4 LEAF equipment loans active
- Typical expense categories: COGS:Food Purchases (Sysco, US Foods),
  COGS:Paper Packaging, Payroll Expenses, Rent, Insurance, Software & apps,
  Restaurant Supplies, Utilities, Mercury fees, Advertising & marketing
- Owner-related counterparties: "Drew Sparks", "Drew and Lindsay", "Wells Fargo"
  → these are owner equity (Partner investments) not expense
- Marketplace settlements (DoorDash, UberEats, Grubhub) → Clearing Accounts:[name] Clearing
- Capex candidates (>$2,500 equipment purchases) → flag for review, do NOT
  propose direct expense

Output JSON ONLY, no markdown:
{
  "proposed_account_name": "<exact account_name from CoA list>",
  "confidence": <0-100 integer>,
  "reasoning": "<one sentence, ≤200 chars>",
  "alternative_account_name": "<second-best guess, or null>",
  "rule_conflict": <true if proposal conflicts with an obvious existing rule, else false>
}

Rules:
- proposed_account_name MUST be exactly one entry from the provided CoA list
- If you genuinely can't tell, return confidence < 60 with "alternative_account_name" filled
- Never propose deleted accounts (marked is_active=0)
- Never propose direct revenue or expense for transfers between own accounts
- For ambiguous between supplies vs food: lean food if vendor is grocery-style
```

### User prompt template

```
Transaction:
  Date: {txn_date}
  Amount: {amount} ({direction: 'inflow' or 'outflow'})
  Counterparty: {counterparty_name}
  Description: {description}
  Source: {mercury / chase_ink / mercury_io}

Vendor history (last 10 txns from same counterparty, if any):
  {vendor_history_table — date / amount / proposed_account_name / status}

cfo_facts for this vendor (if any):
  {cfo_facts_text}

Active chart of accounts:
  {COA list — id : account_name (account_type)}

Propose categorization as JSON.
```

### Cost estimate

Per categorization call:
- System prompt: ~600 tokens
- User prompt: ~800 tokens (COA list is ~400 tokens of the 800; rest is txn context)
- Response: ~150 tokens
- Total: ~1,550 tokens per call
- Sonnet 4.6 pricing: ~$3/M input + $15/M output ≈ $0.005-0.008 per call

**Monthly cost projection:**
- 1,830 Mercury txns/90d = ~610/month
- ~80% match existing rules (per categorizer success rate observed in Week 1 forensic) → ~120/month hit LLM
- 120 calls/mo × $0.007 = **~$0.85/month**

Well below the $50 monthly cap. Per `ai-budget.js`, this routes through `callAI()` so cost is auto-tracked + capped.

**Drift-test estimate (Day 4):**
- 100 historical txns × $0.007 = ~$0.70 one-time

---

## Confidence tier routing

Per Phase A Week 1 prompt §B2 acceptance criteria:

| Confidence | Disposition | Audit entry written? |
|---|---|---|
| ≥0.95 AND no rule conflict | **AUTO-POST** (Week 2+ only; SHADOW in Week 1) | YES — `action_type='ai_decision_applied'` |
| 0.80-0.95 | **AUTO-POST + flag for spot-check** (Week 2+); SHADOW in Week 1 | YES — same + `metadata.spot_check_recommended=true` |
| 0.60-0.80 | **QUEUE for explicit review** | YES — `action_type='ai_decision_queued'` |
| <0.60 | **LOW-CONF QUEUE** (warning) | YES — same + `metadata.low_confidence_warning=true` |
| Conflicts with an existing rule | **ALWAYS QUEUE with conflict warning** (never auto-post) | YES — `action_type='ai_decision_conflict'` |

**Week 1 SHADOW mode:** the disposition column above governs Week 2+ behavior. Week 1: everything queues, but the audit_trail captures the LLM's full proposal + would-have-been disposition.

---

## Shadow-mode implementation outline

`workers/llm-categorizer.js` (DRAFT skeleton — completed Day 4):

```js
// workers/llm-categorizer.js
import { callAI } from './ai-budget.js';
import { writeAuditEntry } from './audit-trail.js';
import { lookupVendor } from './finance-vendor-kb.js';
import { lookupCfoFacts } from './finance-cfo-facts.js';

const SHADOW_MODE = true; // Week 1: never auto-post

export async function llmCategorize(env, txn, options = {}) {
  // 1. Skip if rule already matched
  if (txn.proposed_account_id) return { skipped: 'rule_matched' };

  // 2. Gather context
  const vendorHistory = await lookupVendor(env, txn.counterparty_name);
  const cfoFacts = await lookupCfoFacts(env, txn.counterparty_name);
  const coa = await getActiveCoaList(env);

  // 3. Build prompt + call Sonnet
  const result = await callAI(env, {
    use_case: 'llm_categorizer',
    model: 'sonnet',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(txn, vendorHistory, cfoFacts, coa) }],
  });

  // 4. Parse JSON response
  let proposal;
  try {
    proposal = JSON.parse(result.content);
  } catch {
    return { error: 'invalid_json_response', raw: result.content };
  }

  // 5. Validate proposed_account_name exists in CoA
  const matchedAccount = coa.find(a => a.account_name === proposal.proposed_account_name);
  if (!matchedAccount) {
    return { error: 'proposed_account_not_in_coa', proposal };
  }

  // 6. Tier routing (determines audit action_type)
  const tier = tierFromConfidence(proposal.confidence, proposal.rule_conflict);

  // 7. Write audit_trail entry (shadow mode — always queue, never auto-post)
  await writeAuditEntry(env, {
    actor: 'agent:llm_categorizer',
    action_type: tier.audit_action_type,
    entity_type: 'mercury_txn',
    entity_id: txn.id,
    before_state: { proposed_account_id: null, status: 'pending' },
    after_state: SHADOW_MODE ? { proposed_account_id: null, status: 'pending_shadow' } : {
      proposed_account_id: matchedAccount.id,
      proposed_confidence: proposal.confidence / 100,
      proposed_reasoning: proposal.reasoning,
    },
    source_metadata: {
      llm_proposal: proposal,
      vendor_history_count: vendorHistory.length,
      cfo_facts_count: cfoFacts.length,
      tier: tier.name,
      shadow_mode: SHADOW_MODE,
      cost_usd: result.cost_usd,
      tokens: { input: result.input_tokens, output: result.output_tokens },
    },
  });

  // 8. In SHADOW: do NOT update mercury_transactions or post JE.
  //    In production (Week 2+): update proposed_* fields if tier is AUTO.

  return { proposal, tier: tier.name, shadow_mode: SHADOW_MODE };
}

// Helper: confidence → tier
function tierFromConfidence(confidence, ruleConflict) {
  if (ruleConflict) return { name: 'rule_conflict', audit_action_type: 'ai_decision_conflict' };
  if (confidence >= 95) return { name: 'auto_high_confidence', audit_action_type: 'ai_decision_applied' };
  if (confidence >= 80) return { name: 'auto_with_flag', audit_action_type: 'ai_decision_applied' };
  if (confidence >= 60) return { name: 'queue_review', audit_action_type: 'ai_decision_queued' };
  return { name: 'low_confidence', audit_action_type: 'ai_decision_queued' };
}
```

---

## Drift test plan (Day 4 execution)

Per Phase A Week 1 prompt B2 §Test plan, run the LLM against 100 historical Mercury txns + compare to their existing categorization.

**Test selection:**
- Pull 100 txns with `proposed_account_id IS NOT NULL` (i.e., they were categorized — either by rule or by Drew manually)
- Spread across counterparties + amounts (not all Sysco)
- Skip internal-transfer + obvious rule-matched ones (low signal)

**Run:**
- Each txn goes through LLM as if it were uncategorized
- Compare LLM `proposed_account_name` to existing categorization
- Cost ~$0.70 total

**Output:**
- Agreement rate (LLM matched existing categorization exactly)
- Disagreement breakdown (LLM proposed different account)
- Per-confidence-bin accuracy (e.g., "of LLM proposals at ≥95% confidence, X% matched")
- Surface to Drew before flipping shadow mode → auto-post (Week 2+)

**Pass threshold per prompt:** agreement rate ≥70%. Below threshold → prompt needs tuning before useful.

---

## What Drew needs to know

1. **Cost projection: ~$0.85/month** for LLM categorization. Well under $50 cap.
2. **Shadow mode in Week 1**: nothing auto-posts. Every LLM call writes an audit entry but the proposal stays in audit_trail only; mercury_transactions stays in review queue as before.
3. **Drift test result needed before auto-post enable**: Week 2+ decision based on accuracy.

## Day 4 execution plan

- [ ] Complete `workers/llm-categorizer.js` (currently skeleton)
- [ ] Add endpoint `POST /finance/categorizer/llm-shadow-batch?limit=N`
- [ ] Run drift test against 100 historical txns
- [ ] Report agreement rate + accuracy by confidence bin
- [ ] If ≥70% agreement: proceed with Surface 1 Activity Feed
- [ ] If <70%: pause + prompt tuning before Week 2 auto-post decision

End of LLM design doc.
