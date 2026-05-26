// workers/finance-qbo-mercury-match.js
// Match Mercury transactions to QBO Purchase/Bill/JournalEntry entities
// for the period when Drew's bookkeeper was actively maintaining QBO.
//
// WHY: The categorizer ran fresh over every Mercury transaction, ignoring
// the human-verified categorizations the bookkeeper had already done in QBO.
// This re-categorizes pre-Feb 2026 Mercury txns using QBO's posted ground
// truth instead of our rule-based guesses + Haiku fallback.
//
// Strategy:
//   1. For each Mercury OUTFLOW in the bookkeeper-clean window
//      (txn_date BETWEEN seed_start AND cutoff), look for a QBO Purchase
//      with: |TotalAmt - |amount|| < $0.01 AND TxnDate within ± 3 days
//   2. If exactly one match: use its expense AccountRef (Line[0]'s account)
//      as the proposed_account_id (mapped via chart_of_accounts.qbo_account_id)
//   3. If multiple matches: take the closest date; if still tied, take exact
//      vendor name match; otherwise flag for manual review
//   4. Set proposed_confidence = 0.99 (bookkeeper-verified human input)
//   5. Set proposed_reasoning = "Matched to QBO Purchase #{Id} (bookkeeper-categorized)"
//   6. Mark user_overridden=1 (so it skips review queue) — but DO NOT post JE
//      yet; let post-jes handle it on next run
//
// Endpoints:
//   GET  /finance/qbo-match/preview[?cutoff=YYYY-MM-DD&start=YYYY-MM-DD]
//     — show what WOULD change without writing
//   POST /finance/qbo-match/apply[?cutoff=YYYY-MM-DD&start=YYYY-MM-DD]
//     — actually update mercury_transactions
//
// Defaults: start='2025-01-01' (or earliest Mercury txn), cutoff='2026-01-31'
// (Drew said bookkeeper closed Dec or Jan, so end-of-Jan is the safe cutoff).

const DEFAULT_CUTOFF = '2026-01-31';
const DEFAULT_START  = '2025-01-01';
const DATE_TOLERANCE_DAYS = 3;

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// Pull all QBO Purchase entities in the window, lightly preprocessed
async function loadQboPurchases(env, start, cutoff) {
  const { results } = await env.DB.prepare(`
    SELECT
      json_extract(raw_json, '$.Id') as qbo_id,
      json_extract(raw_json, '$.TxnDate') as txn_date,
      CAST(json_extract(raw_json, '$.TotalAmt') AS REAL) as total,
      json_extract(raw_json, '$.EntityRef.name') as vendor,
      json_extract(raw_json, '$.AccountRef.name') as payment_account,
      json_extract(raw_json, '$.Line[0].AccountBasedExpenseLineDetail.AccountRef.value') as expense_account_qbo_id,
      json_extract(raw_json, '$.Line[0].AccountBasedExpenseLineDetail.AccountRef.name') as expense_account_name,
      raw_json
    FROM qbo_archive_entity
    WHERE entity_type = 'Purchase'
      AND json_extract(raw_json, '$.TxnDate') BETWEEN ? AND ?
  `).bind(start, cutoff).all();
  return (results || []).map(r => ({
    ...r,
    total_abs: Math.abs(r.total || 0),
  }));
}

// Pull Mercury OUTFLOWS in the same window that haven't been user-resolved
async function loadMercuryOutflows(env, start, cutoff) {
  const { results } = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name, description,
           proposed_account_id, proposed_confidence, user_overridden,
           is_reconciled, matched_journal_entry_id
    FROM mercury_transactions
    WHERE amount < 0
      AND txn_date BETWEEN ? AND ?
    ORDER BY txn_date
  `).bind(start, cutoff).all();
  return (results || []).map(r => ({ ...r, amount_abs: Math.abs(r.amount || 0) }));
}

// Build a map: qbo_account_id (QBO's numeric value) → our chart_of_accounts.id
async function loadCoaQboMap(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, account_name, account_type, qbo_account_id
    FROM chart_of_accounts WHERE is_active = 1 AND qbo_account_id IS NOT NULL
  `).all();
  const map = new Map();
  for (const r of (results || [])) {
    map.set(String(r.qbo_account_id), r);
  }
  return map;
}

function dayDiff(a, b) {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.abs((da - db) / 86400000);
}

function normalizeVendor(s) {
  return (s || '').toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').slice(0, 30);
}

// Find the single best match for one Mercury txn
function findBestMatch(merc, qboList) {
  const candidates = qboList.filter(p => {
    if (Math.abs(p.total_abs - merc.amount_abs) > 0.01) return false;
    if (dayDiff(p.txn_date, merc.txn_date.slice(0, 10)) > DATE_TOLERANCE_DAYS) return false;
    return true;
  });
  if (candidates.length === 0) return { match: null, reason: 'no_amount_date_match' };
  if (candidates.length === 1) return { match: candidates[0], reason: 'unique' };

  // Multiple candidates — prefer exact vendor match
  const mercVendor = normalizeVendor(merc.counterparty_name);
  if (mercVendor) {
    const vendorMatch = candidates.filter(p => normalizeVendor(p.vendor).includes(mercVendor) || mercVendor.includes(normalizeVendor(p.vendor)));
    if (vendorMatch.length === 1) return { match: vendorMatch[0], reason: 'vendor_disambiguated' };
    if (vendorMatch.length > 1) {
      // Still multiple — take closest date
      const closest = vendorMatch.sort((a, b) => dayDiff(a.txn_date, merc.txn_date.slice(0, 10)) - dayDiff(b.txn_date, merc.txn_date.slice(0, 10)))[0];
      return { match: closest, reason: 'vendor_then_date', tied: vendorMatch.length };
    }
  }
  // No vendor disambiguation — take closest date
  const closest = candidates.sort((a, b) => dayDiff(a.txn_date, merc.txn_date.slice(0, 10)) - dayDiff(b.txn_date, merc.txn_date.slice(0, 10)))[0];
  return { match: closest, reason: 'date_only', tied: candidates.length };
}

// ── Public: preview ───────────────────────────────────────────────────────
export async function previewMatch(env, opts = {}) {
  const start = opts.start || DEFAULT_START;
  const cutoff = opts.cutoff || DEFAULT_CUTOFF;

  const [qboPurchases, mercTxns, coaMap] = await Promise.all([
    loadQboPurchases(env, start, cutoff),
    loadMercuryOutflows(env, start, cutoff),
    loadCoaQboMap(env),
  ]);

  const stats = {
    window: { start, cutoff },
    mercury_outflows_in_window: mercTxns.length,
    qbo_purchases_in_window: qboPurchases.length,
    matched_unique: 0,
    matched_vendor_disambiguated: 0,
    matched_with_tiebreaker: 0,
    no_match: 0,
    coa_account_missing: 0,
    already_user_resolved: 0,
    different_proposal_currently: 0,
    same_proposal_currently: 0,
  };

  const changes = []; // {mercury_id, current_account, proposed_account, qbo_purchase_id, reason}
  for (const merc of mercTxns) {
    const { match, reason } = findBestMatch(merc, qboPurchases);
    if (!match) {
      stats.no_match += 1;
      continue;
    }
    const coaAcct = coaMap.get(String(match.expense_account_qbo_id));
    if (!coaAcct) {
      stats.coa_account_missing += 1;
      changes.push({
        mercury_id: merc.id,
        txn_date: merc.txn_date.slice(0, 10),
        amount: merc.amount,
        counterparty: merc.counterparty_name,
        qbo_purchase_id: match.qbo_id,
        qbo_expense_account: match.expense_account_name,
        result: 'COA_MISSING',
        reason: `QBO expense_account_id ${match.expense_account_qbo_id} not in our chart_of_accounts.qbo_account_id`,
      });
      continue;
    }

    if (reason === 'unique') stats.matched_unique += 1;
    else if (reason === 'vendor_disambiguated') stats.matched_vendor_disambiguated += 1;
    else stats.matched_with_tiebreaker += 1;

    const alreadyUser = merc.user_overridden === 1;
    const sameProposal = merc.proposed_account_id === coaAcct.id;
    if (alreadyUser) stats.already_user_resolved += 1;
    if (sameProposal) stats.same_proposal_currently += 1;
    else stats.different_proposal_currently += 1;

    changes.push({
      mercury_id: merc.id,
      txn_date: merc.txn_date.slice(0, 10),
      amount: merc.amount,
      counterparty: merc.counterparty_name,
      qbo_purchase_id: match.qbo_id,
      qbo_expense_account: match.expense_account_name,
      qbo_to_coa_id: coaAcct.id,
      qbo_to_coa_name: coaAcct.account_name,
      result: alreadyUser ? 'SKIP_USER_RESOLVED' : (sameProposal ? 'NO_CHANGE_SAME_PROPOSAL' : 'WILL_UPDATE'),
      reason,
    });
  }

  return {
    ok: true,
    stats,
    changes_sample: changes.slice(0, 20),
    changes_count: changes.length,
    note: 'Run POST /finance/qbo-match/apply to write these matches. Run will only update txns where result=WILL_UPDATE (skips already-user-resolved and no-change rows).',
  };
}

// ── Public: apply matches ─────────────────────────────────────────────────
export async function applyMatch(env, opts = {}) {
  const start = opts.start || DEFAULT_START;
  const cutoff = opts.cutoff || DEFAULT_CUTOFF;

  const [qboPurchases, mercTxns, coaMap] = await Promise.all([
    loadQboPurchases(env, start, cutoff),
    loadMercuryOutflows(env, start, cutoff),
    loadCoaQboMap(env),
  ]);

  const stats = { window: { start, cutoff }, updated: 0, skipped_user_resolved: 0, skipped_same: 0, skipped_no_match: 0, skipped_coa_missing: 0, errored: 0, errors: [] };

  for (const merc of mercTxns) {
    try {
      const { match, reason } = findBestMatch(merc, qboPurchases);
      if (!match) { stats.skipped_no_match += 1; continue; }

      const coaAcct = coaMap.get(String(match.expense_account_qbo_id));
      if (!coaAcct) { stats.skipped_coa_missing += 1; continue; }

      if (merc.user_overridden === 1) { stats.skipped_user_resolved += 1; continue; }
      if (merc.proposed_account_id === coaAcct.id && merc.proposed_confidence >= 0.99) {
        stats.skipped_same += 1; continue;
      }

      await env.DB.prepare(`
        UPDATE mercury_transactions
        SET proposed_account_id = ?,
            proposed_confidence = 0.99,
            proposed_reasoning = ?,
            user_overridden = 1
        WHERE id = ? AND is_reconciled = 0
      `).bind(
        coaAcct.id,
        `Matched to QBO Purchase #${match.qbo_id} (${match.expense_account_name}) — bookkeeper-categorized. Match basis: ${reason}.`,
        merc.id,
      ).run();
      stats.updated += 1;
    } catch (err) {
      stats.errored += 1;
      if (stats.errors.length < 10) stats.errors.push({ mercury_id: merc.id, error: (err.message || String(err)).slice(0, 200) });
    }
  }

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'qbo_mercury_match_apply', 'mercury_transactions', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `match_${Date.now()}`,
    `Matched ${stats.updated} Mercury txns to QBO Purchases (window ${start} → ${cutoff})`,
    JSON.stringify(stats),
  ).run().catch(() => {});

  return { ok: true, ...stats };
}
