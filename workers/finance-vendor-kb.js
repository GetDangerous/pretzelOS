// workers/finance-vendor-kb.js
// Vendor Knowledge Base — built from the bookkeeper's QBO Purchase + Bill +
// JournalEntry history. Lets the categorizer use a year of human-verified
// categorizations as ground truth, instead of guessing fresh.
//
// USAGE:
//   import { lookupVendor, buildVendorKB } from './finance-vendor-kb.js';
//
//   const result = await lookupVendor(env, 'Sysco Corporation');
//   // Returns: { found, dominant_account_id, dominant_account_name,
//   //           dominant_share, dominant_dollar_share, total_txns, history }
//
//   // To rebuild (run on initial setup + weekly cron):
//   await buildVendorKB(env);
//
// Endpoints (wired in finance-worker.js):
//   POST /finance/vendor-kb/build          — rebuild from QBO archive
//   GET  /finance/vendor-kb/:vendor_name   — lookup
//   GET  /finance/vendor-kb/summary        — top vendors with their patterns

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function normalizeName(s) {
  return (s || '').toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').slice(0, 100);
}

// ── Build / refresh the KB ────────────────────────────────────────────────
// Reads every QBO Purchase + Bill + JournalEntry from qbo_archive_entity,
// extracts (vendor, expense_account, amount, date), and aggregates into the
// vendor_categorization_history table. Then refreshes vendor_kb_summary.
export async function buildVendorKB(env, opts = {}) {
  const stats = {
    purchases_processed: 0,
    journal_entries_processed: 0,
    bills_processed: 0,
    rows_written: 0,
    unique_vendors: 0,
    coa_unmapped: 0,
    errors: [],
  };

  // Load COA mapping: qbo_account_id (numeric string) → our chart_of_accounts.id
  const { results: coaRows } = await env.DB.prepare(
    `SELECT id, account_name, account_type, qbo_account_id FROM chart_of_accounts
     WHERE qbo_account_id IS NOT NULL`
  ).all();
  const coaByQbo = new Map();
  for (const r of coaRows || []) coaByQbo.set(String(r.qbo_account_id), r);

  // Aggregate in memory; bulk-write at end.
  // Key: normalizedVendor|accountId
  const agg = new Map();

  function record(vendorDisplay, accountQboId, amount, date) {
    if (!vendorDisplay || !accountQboId) return;
    const acct = coaByQbo.get(String(accountQboId));
    if (!acct) { stats.coa_unmapped += 1; return; }
    const vendorNorm = normalizeName(vendorDisplay);
    if (!vendorNorm) return;
    const key = vendorNorm + '|' + acct.id;
    const existing = agg.get(key);
    if (existing) {
      existing.count_seen += 1;
      existing.total_amount = r2(existing.total_amount + Math.abs(amount || 0));
      if (date && (!existing.first_seen || date < existing.first_seen)) existing.first_seen = date;
      if (date && (!existing.last_seen || date > existing.last_seen)) existing.last_seen = date;
    } else {
      agg.set(key, {
        vendor_name: vendorNorm,
        vendor_display: vendorDisplay,
        account_id: acct.id,
        account_name: acct.account_name,
        account_type: acct.account_type,
        count_seen: 1,
        total_amount: r2(Math.abs(amount || 0)),
        first_seen: date,
        last_seen: date,
      });
    }
  }

  // PURCHASES — most common in Pretzel's books
  const { results: purchases } = await env.DB.prepare(`
    SELECT raw_json FROM qbo_archive_entity WHERE entity_type = 'Purchase'
  `).all();
  for (const p of purchases || []) {
    try {
      const raw = JSON.parse(p.raw_json);
      const vendor = raw.EntityRef?.name;
      const date = raw.TxnDate;
      // Each Purchase can have multiple lines, each with its own AccountRef
      for (const line of (raw.Line || [])) {
        const ad = line.AccountBasedExpenseLineDetail;
        if (!ad) continue;
        const acctQbo = ad.AccountRef?.value;
        const amount = line.Amount;
        record(vendor, acctQbo, amount, date);
      }
      stats.purchases_processed += 1;
    } catch (err) {
      stats.errors.push({ entity: 'Purchase', error: err.message.slice(0, 150) });
    }
  }

  // BILLS — same shape as Purchase
  const { results: bills } = await env.DB.prepare(`
    SELECT raw_json FROM qbo_archive_entity WHERE entity_type = 'Bill'
  `).all();
  for (const b of bills || []) {
    try {
      const raw = JSON.parse(b.raw_json);
      const vendor = raw.VendorRef?.name;
      const date = raw.TxnDate;
      for (const line of (raw.Line || [])) {
        const ad = line.AccountBasedExpenseLineDetail;
        if (!ad) continue;
        record(vendor, ad.AccountRef?.value, line.Amount, date);
      }
      stats.bills_processed += 1;
    } catch (err) {
      stats.errors.push({ entity: 'Bill', error: err.message.slice(0, 150) });
    }
  }

  // JOURNAL ENTRIES — multi-line, debit/credit. Vendor often in description.
  const { results: jes } = await env.DB.prepare(`
    SELECT raw_json FROM qbo_archive_entity WHERE entity_type = 'JournalEntry'
  `).all();
  for (const je of jes || []) {
    try {
      const raw = JSON.parse(je.raw_json);
      const date = raw.TxnDate;
      // Vendor inference: look for Entity ref on lines OR PrivateNote
      // JE lines are different — they're [{Amount, JournalEntryLineDetail: {PostingType, AccountRef, Entity}}]
      for (const line of (raw.Line || [])) {
        const jeDetail = line.JournalEntryLineDetail;
        if (!jeDetail) continue;
        const acctQbo = jeDetail.AccountRef?.value;
        const entity = jeDetail.Entity?.EntityRef?.name;
        const amount = line.Amount;
        if (entity) {
          record(entity, acctQbo, amount, date);
        }
      }
      stats.journal_entries_processed += 1;
    } catch (err) {
      stats.errors.push({ entity: 'JournalEntry', error: err.message.slice(0, 150) });
    }
  }

  // Bulk write to vendor_categorization_history
  // Idempotent — delete existing 'qbo' source rows and re-insert fresh.
  await env.DB.prepare(
    `DELETE FROM vendor_categorization_history WHERE source = 'qbo'`
  ).run();

  for (const v of agg.values()) {
    await env.DB.prepare(`
      INSERT INTO vendor_categorization_history (id, vendor_name, vendor_display,
        account_id, account_name, account_type, count_seen, total_amount,
        first_seen, last_seen, source, last_refreshed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'qbo', datetime('now'))
    `).bind(
      crypto.randomUUID(), v.vendor_name, v.vendor_display,
      v.account_id, v.account_name, v.account_type,
      v.count_seen, v.total_amount,
      v.first_seen, v.last_seen,
    ).run().catch(err => stats.errors.push({ entity: 'history_write', vendor: v.vendor_display, error: err.message.slice(0, 150) }));
    stats.rows_written += 1;
  }

  // Recompute vendor_kb_summary
  await env.DB.prepare(`DELETE FROM vendor_kb_summary`).run();

  // Build summary per vendor: dominant_account = the one with most count_seen
  const vendors = new Map();
  for (const r of agg.values()) {
    if (!vendors.has(r.vendor_name)) {
      vendors.set(r.vendor_name, {
        vendor_name: r.vendor_name,
        vendor_display: r.vendor_display,
        accounts: [],
        total_txns: 0,
        total_dollar: 0,
      });
    }
    const v = vendors.get(r.vendor_name);
    v.accounts.push({
      account_id: r.account_id,
      account_name: r.account_name,
      count: r.count_seen,
      dollar: r.total_amount,
    });
    v.total_txns += r.count_seen;
    v.total_dollar += r.total_amount;
  }

  for (const v of vendors.values()) {
    const sorted = v.accounts.sort((a, b) => b.count - a.count);
    const dom = sorted[0];
    const domDollarShare = v.total_dollar > 0 ? r2(dom.dollar / v.total_dollar) : 0;
    await env.DB.prepare(`
      INSERT INTO vendor_kb_summary (vendor_name, vendor_display, total_txns,
        total_dollar_volume, dominant_account_id, dominant_account_name,
        dominant_share, dominant_dollar_share, account_count, last_refreshed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      v.vendor_name, v.vendor_display, v.total_txns,
      r2(v.total_dollar), dom.account_id, dom.account_name,
      r2(dom.count / v.total_txns), domDollarShare,
      v.accounts.length,
    ).run().catch(() => {});
  }

  stats.unique_vendors = vendors.size;

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'vendor_kb_built', 'vendor_kb', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `build_${Date.now()}`,
    `Built vendor KB from QBO archive: ${stats.unique_vendors} unique vendors, ${stats.rows_written} (vendor,account) pairs`,
    JSON.stringify({ ...stats, errors: stats.errors.slice(0, 5) }),
  ).run().catch(() => {});

  return { ok: true, ...stats, errors: stats.errors.slice(0, 10) };
}

// ── Lookup a single vendor ────────────────────────────────────────────────
export async function lookupVendor(env, vendorName) {
  if (!vendorName) return { found: false, reason: 'no vendor name provided' };
  const norm = normalizeName(vendorName);

  // First check cfo_facts for an explicit Drew rule (always wins over QBO patterns)
  const fact = await env.DB.prepare(`
    SELECT id, content, structured_data FROM cfo_facts
    WHERE active = 1 AND fact_type = 'vendor_rule' AND subject_normalized = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(norm).first().catch(() => null);

  if (fact) {
    try {
      const structured = JSON.parse(fact.structured_data || '{}');
      if (structured.account_id) {
        const acct = await env.DB.prepare(
          `SELECT id, account_name, account_type FROM chart_of_accounts WHERE id = ?`
        ).bind(structured.account_id).first();
        if (acct) {
          return {
            found: true,
            source: 'cfo_fact',
            account_id: acct.id,
            account_name: acct.account_name,
            account_type: acct.account_type,
            confidence: 1.0,
            reasoning: `Drew clarified: ${fact.content}`,
            fact_id: fact.id,
          };
        }
      }
    } catch {}
  }

  // Then check vendor_kb_summary
  const summary = await env.DB.prepare(`
    SELECT * FROM vendor_kb_summary WHERE vendor_name = ? LIMIT 1
  `).bind(norm).first();

  if (!summary) {
    // Try fuzzy match against contains
    const { results: fuzzy } = await env.DB.prepare(`
      SELECT * FROM vendor_kb_summary
      WHERE vendor_name LIKE '%' || ? || '%' OR ? LIKE '%' || vendor_name || '%'
      ORDER BY total_dollar_volume DESC LIMIT 1
    `).bind(norm, norm).all();
    if (!fuzzy?.[0]) return { found: false, vendor_name: norm };
    return _summaryToResult(env, fuzzy[0], 'qbo_kb_fuzzy_match');
  }

  return _summaryToResult(env, summary, 'qbo_kb_exact_match');
}

async function _summaryToResult(env, summary, source) {
  // Pull full history for this vendor so caller can see edge cases
  const { results: history } = await env.DB.prepare(`
    SELECT account_id, account_name, account_type, count_seen, total_amount
    FROM vendor_categorization_history
    WHERE vendor_name = ?
    ORDER BY count_seen DESC, total_amount DESC
  `).bind(summary.vendor_name).all();

  return {
    found: true,
    source,
    vendor_display: summary.vendor_display,
    account_id: summary.dominant_account_id,
    account_name: summary.dominant_account_name,
    dominant_share: summary.dominant_share,
    dominant_dollar_share: summary.dominant_dollar_share,
    total_txns: summary.total_txns,
    total_dollar: summary.total_dollar_volume,
    account_count: summary.account_count,
    history: history || [],
    // Confidence calculation: dominant_share = how strong the pattern is
    confidence: summary.dominant_share >= 0.95 ? 0.98
             : summary.dominant_share >= 0.80 ? 0.95
             : summary.dominant_share >= 0.60 ? 0.85
             : 0.70,
    reasoning: `Bookkeeper categorized ${summary.vendor_display} to ${summary.dominant_account_name} ${Math.round(summary.dominant_share * 100)}% of the time across ${summary.total_txns} historical transactions ($${summary.total_dollar_volume.toFixed(2)} total)`,
  };
}

// ── List top vendors by historical volume ────────────────────────────────
export async function listTopVendors(env, limit = 50) {
  const { results } = await env.DB.prepare(`
    SELECT vendor_display, total_txns, total_dollar_volume, dominant_account_name,
           dominant_share, dominant_dollar_share, account_count
    FROM vendor_kb_summary
    ORDER BY total_dollar_volume DESC
    LIMIT ?
  `).bind(limit).all();
  return { count: (results || []).length, vendors: results || [] };
}
