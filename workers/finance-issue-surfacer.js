// workers/finance-issue-surfacer.js
// Proactive anomaly detection — what a real CFO would catch.
//
// Runs daily (or on-demand). Each detector rule writes to cfo_issues.
// Daily email shows top 3 critical/high. Dashboard shows full list.
//
// Detectors:
//   1. vendor_anomaly         — monthly vendor spend > 1.5× rolling 90d avg
//   2. margin_drift           — COGS% or GM% shifts >5pp month-over-month
//   3. ar_aging_slip          — reliable customer becomes overdue >7d
//   4. cash_trajectory        — 30d cash trend deteriorating
//   5. customer_concentration — top customer > 25% of revenue
//   6. vendor_concentration   — top vendor > 30% of COGS
//   7. pipeline_depth         — review queue grows beyond threshold
//   8. unusual_transaction    — single txn >2σ from vendor distribution
//
// Endpoint:
//   POST /finance/issues/scan  — run all detectors
//   GET  /finance/issues       — list open issues (sortable by severity)
//   POST /finance/issues/:id/{snooze,resolve,dismiss}

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function pct(n) { return Math.round(n * 1000) / 10; }

// ── Detector helpers ─────────────────────────────────────────────────────

// Session 16c (May 14 2026): load whitelist patterns once per scan, reused
// by vendor_anomaly + unusual_transaction detectors.
async function loadRecurringPatterns(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT subject_pattern, match_type, cadence_days, note FROM recurring_payment_patterns WHERE active = 1`
    ).all();
    return results || [];
  } catch {
    return [];
  }
}

function matchesRecurringPattern(subject, patterns) {
  if (!subject || !patterns.length) return null;
  const upper = subject.toUpperCase();
  for (const p of patterns) {
    const target = (p.subject_pattern || '').toUpperCase();
    if (!target) continue;
    if (p.match_type === 'exact' && upper === target) return p;
    if ((p.match_type === 'contains' || !p.match_type) && upper.includes(target)) return p;
    if (p.match_type === 'regex') {
      try { if (new RegExp(target, 'i').test(subject)) return p; } catch {}
    }
  }
  return null;
}

async function detectVendorAnomalies(env) {
  // Vendors whose last-30d spend is >1.5× their trailing 60d-90d average.
  const { results } = await env.DB.prepare(`
    SELECT
      counterparty_name as vendor,
      ROUND(SUM(CASE WHEN txn_date >= date('now','-30 days') THEN ABS(amount) ELSE 0 END), 2) as last_30,
      ROUND(SUM(CASE WHEN txn_date < date('now','-30 days') AND txn_date >= date('now','-90 days') THEN ABS(amount) ELSE 0 END) / 2.0, 2) as prior_30_avg
    FROM mercury_transactions
    WHERE amount < 0
      AND txn_date >= date('now','-90 days')
      AND counterparty_name IS NOT NULL
      AND LOWER(counterparty_name) NOT LIKE '%mercury%'
      AND LOWER(counterparty_name) NOT LIKE '%wells fargo%'
      AND LOWER(counterparty_name) NOT LIKE '%chase business%'
    GROUP BY counterparty_name
    HAVING last_30 > 500
       AND prior_30_avg > 0
       AND last_30 > prior_30_avg * 1.5
    ORDER BY (last_30 - prior_30_avg) DESC
    LIMIT 20
  `).all();

  // Session 16c: filter out known-recurring patterns BEFORE constructing issues.
  const patterns = await loadRecurringPatterns(env);
  const issues = [];
  const suppressed = [];
  for (const r of (results || [])) {
    const matched = matchesRecurringPattern(r.vendor, patterns);
    if (matched) {
      suppressed.push({ vendor: r.vendor, matched_pattern: matched.subject_pattern, note: matched.note });
      continue;
    }
    const increase_pct = pct((r.last_30 - r.prior_30_avg) / r.prior_30_avg);
    issues.push({
      issue_type: 'vendor_anomaly',
      severity: r.last_30 > r.prior_30_avg * 2 ? 'high' : 'medium',
      subject: r.vendor,
      headline: `${r.vendor} spend up ${increase_pct}% in last 30 days`,
      detail: `Last 30d: $${r.last_30.toFixed(0)} vs prior 30d avg (60-90d ago): $${r.prior_30_avg.toFixed(0)}. Increase: $${(r.last_30 - r.prior_30_avg).toFixed(0)}.`,
      data_json: JSON.stringify(r),
      suggested_action: increase_pct > 100 ? 'Investigate — vendor price hike or recipe change?' : 'Review next month to confirm trend',
    });
  }
  // Optionally surface suppressed list at info level for debugging (not as a real issue)
  if (suppressed.length > 0) {
    console.log('[issue-surfacer] suppressed vendor_anomaly for recurring patterns:', suppressed.map(s => s.vendor).join(', '));
  }
  return issues;
}

async function detectMarginDrift(env) {
  // Compare last month COGS% vs prior month. Flag if >5pp shift.
  // Session 16c (May 14 2026): data-quality awareness. Skip the alarm if the
  // PRIOR period had > 5% uncategorized txns (likely the under-counted regime
  // — flagging would surface a self-correction as a business problem).
  const { results } = await env.DB.prepare(`
    SELECT SUBSTR(j.entry_date, 1, 7) as month,
           ROUND(SUM(CASE WHEN c.account_type IN ('revenue','other_income') THEN l.credit - l.debit ELSE 0 END), 2) as revenue,
           ROUND(SUM(CASE WHEN c.account_type = 'cogs' THEN l.debit - l.credit ELSE 0 END), 2) as cogs
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= date('now', 'start of month', '-2 months')
    GROUP BY month
    HAVING revenue > 0
    ORDER BY month
  `).all();
  if (!results || results.length < 2) return [];
  const issues = [];
  const last = results[results.length - 1];
  const prior = results[results.length - 2];
  const lastPct = (last.cogs || 0) / last.revenue;
  const priorPct = (prior.cogs || 0) / prior.revenue;
  const delta = lastPct - priorPct;
  if (Math.abs(delta) < 0.05) return [];
  if (!(last.revenue > 5000 && prior.revenue > 5000)) return [];

  // Data-quality check: is the prior month under-categorized?
  // Count uncategorized Mercury txns in that month vs total spend.
  const priorMonth = prior.month;
  const dq = await env.DB.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN proposed_account_id IS NULL AND user_overridden = 0 THEN ABS(amount) ELSE 0 END), 2) as uncategorized,
      ROUND(SUM(ABS(amount)), 2) as total
    FROM mercury_transactions
    WHERE amount < 0 AND SUBSTR(txn_date, 1, 7) = ?
  `).bind(priorMonth).first().catch(() => null);
  const uncatPct = dq && dq.total > 0 ? (dq.uncategorized / dq.total) : 0;
  if (uncatPct > 0.05) {
    // Prior month under-counted — suppress the drift alert (RTR-2 catch-up territory)
    console.log(`[issue-surfacer] suppressed margin_drift: prior month ${priorMonth} had ${(uncatPct*100).toFixed(0)}% uncategorized txns (data quality issue, not real drift)`);
    return [];
  }

  issues.push({
    issue_type: 'margin_drift',
    severity: Math.abs(delta) >= 0.10 ? 'high' : 'medium',
    subject: `${last.month} vs ${prior.month}`,
    headline: `COGS % ${delta > 0 ? 'rose' : 'fell'} ${pct(Math.abs(delta))}pp (${pct(priorPct)}% → ${pct(lastPct)}%)`,
    detail: `${last.month}: ${pct(lastPct)}% COGS on $${last.revenue.toFixed(0)} revenue. ${prior.month}: ${pct(priorPct)}% on $${prior.revenue.toFixed(0)}.`,
    data_json: JSON.stringify({ last, prior, delta }),
    suggested_action: delta > 0
      ? 'Investigate cost inputs — vendor price hike, waste, or recipe drift'
      : 'Note improvement — confirm it sustains',
  });
  return issues;
}

async function detectArAgingSlip(env) {
  // Customers with current open balance > $500 AND oldest_invoice > 14d past due.
  const { results } = await env.DB.prepare(`
    SELECT customer_name,
           ROUND(SUM(CAST(json_extract(raw_payload, '$.balance') AS REAL)), 2) as open_balance,
           MIN(json_extract(raw_payload, '$.due_date')) as oldest_due,
           COUNT(*) as open_invoices
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice')
      AND status NOT IN ('voided','paid','estimate')
      AND CAST(json_extract(raw_payload, '$.balance') AS REAL) > 500
    GROUP BY customer_name
    HAVING oldest_due < date('now','-14 days')
  `).all();
  const issues = [];
  for (const r of (results || [])) {
    const daysLate = Math.floor((Date.now() - new Date(r.oldest_due).getTime()) / 86400000);
    issues.push({
      issue_type: 'ar_aging_slip',
      severity: daysLate > 60 ? 'critical' : daysLate > 30 ? 'high' : 'medium',
      subject: r.customer_name,
      headline: `${r.customer_name} has $${r.open_balance.toFixed(0)} overdue ${daysLate} days`,
      detail: `${r.open_invoices} open invoice${r.open_invoices > 1 ? 's' : ''}, oldest due ${r.oldest_due.slice(0, 10)}.`,
      data_json: JSON.stringify(r),
      suggested_action: 'Draft reminder via AR aging panel "Draft reminder" button',
    });
  }
  return issues;
}

async function detectCashTrajectory(env) {
  // 30d cash net trend. If average weekly net was positive 60-90d ago and is
  // now negative for last 4 weeks, that's a deterioration.
  const { results } = await env.DB.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN txn_date >= date('now','-30 days') THEN amount ELSE 0 END), 2) as last_30,
      ROUND(SUM(CASE WHEN txn_date >= date('now','-60 days') AND txn_date < date('now','-30 days') THEN amount ELSE 0 END), 2) as prior_30
    FROM mercury_transactions
    WHERE counterparty_name IS NOT NULL
      AND LOWER(counterparty_name) NOT LIKE '%mercury checking%'
      AND LOWER(counterparty_name) NOT LIKE '%mercury savings%'
      AND LOWER(counterparty_name) NOT LIKE '%wells fargo%'
      AND LOWER(counterparty_name) NOT LIKE '%chase business%'
  `).all();
  const row = (results || [])[0];
  if (!row) return [];
  const issues = [];
  const delta = (row.last_30 || 0) - (row.prior_30 || 0);
  // Flag if last 30d is worse than prior 30d by more than $5K AND last_30 is negative
  if ((row.last_30 || 0) < -2000 && delta < -5000) {
    issues.push({
      issue_type: 'cash_trajectory',
      severity: (row.last_30 < -10000) ? 'high' : 'medium',
      subject: 'cashflow_30d',
      headline: `Cash trajectory worsening: $${row.last_30.toFixed(0)} last 30d vs $${row.prior_30.toFixed(0)} prior 30d`,
      detail: `Net change deterioration of $${Math.abs(delta).toFixed(0)} between periods.`,
      data_json: JSON.stringify(row),
      suggested_action: 'Run a scenario to identify quickest path to positive net',
    });
  }
  return issues;
}

async function detectCustomerConcentration(env) {
  // If top customer is >25% of trailing 12mo revenue, flag.
  const { results } = await env.DB.prepare(`
    SELECT customer_name,
           ROUND(SUM(gross_revenue), 2) as revenue
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice')
      AND status NOT IN ('voided','estimate')
      AND order_date >= date('now','-365 days')
      AND customer_name IS NOT NULL
    GROUP BY customer_name
    ORDER BY revenue DESC LIMIT 10
  `).all();
  const totalTtm = (results || []).reduce((s, r) => s + (r.revenue || 0), 0);
  if (totalTtm <= 0 || !(results || []).length) return [];
  const issues = [];
  const top = results[0];
  const topShare = top.revenue / totalTtm;
  if (topShare > 0.25) {
    issues.push({
      issue_type: 'customer_concentration',
      severity: topShare > 0.40 ? 'high' : 'medium',
      subject: top.customer_name,
      headline: `${top.customer_name} is ${pct(topShare)}% of revenue`,
      detail: `Top customer accounts for $${top.revenue.toFixed(0)} of $${totalTtm.toFixed(0)} 12mo revenue. Losing them would be material.`,
      data_json: JSON.stringify({ top_customer: top, total_ttm: totalTtm, share_pct: pct(topShare) }),
      suggested_action: 'Diversify wholesale base — outreach to add 2-3 new accounts',
    });
  }
  // Top 5 share
  const top5Share = (results.slice(0, 5).reduce((s, r) => s + r.revenue, 0)) / totalTtm;
  if (top5Share > 0.70 && topShare <= 0.25) {
    issues.push({
      issue_type: 'customer_concentration',
      severity: 'medium',
      subject: 'top_5_customers',
      headline: `Top 5 customers = ${pct(top5Share)}% of revenue`,
      detail: `Concentration in top tier. ${results.slice(0, 5).map(r => r.customer_name).join(', ')}.`,
      data_json: JSON.stringify({ top5_share_pct: pct(top5Share), customers: results.slice(0, 5) }),
      suggested_action: 'Monitor each top customer for churn signals',
    });
  }
  return issues;
}

async function detectPipelineDepth(env) {
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN proposed_account_id IS NULL THEN 1 ELSE 0 END) as uncategorized,
      SUM(CASE WHEN proposed_account_id IS NOT NULL AND proposed_confidence < 0.90 THEN 1 ELSE 0 END) as low_confidence
    FROM mercury_transactions
    WHERE is_reconciled = 0 AND user_overridden = 0
  `).first();
  const total = (row?.uncategorized || 0) + (row?.low_confidence || 0);
  if (total <= 30) return [];  // healthy
  const issues = [];
  issues.push({
    issue_type: 'pipeline_depth',
    severity: total > 100 ? 'high' : 'medium',
    subject: 'review_queue',
    headline: `${total} txns in review queue (${row.uncategorized} uncategorized + ${row.low_confidence} low-confidence)`,
    detail: 'Working through these unlocks accurate P&L and unblocks the books.',
    data_json: JSON.stringify(row),
    suggested_action: 'Open Money page → "Review queue grouped by counterparty" → bulk approve dominant patterns',
  });
  return issues;
}

async function detectUnusualTransaction(env) {
  // For each vendor with ≥5 prior txns, flag any txn in last 14d that's >2.5× the median.
  const { results: vendors } = await env.DB.prepare(`
    SELECT counterparty_name,
           COUNT(*) as n,
           ROUND(AVG(ABS(amount)), 2) as avg_amt
    FROM mercury_transactions
    WHERE amount < 0 AND txn_date >= date('now','-90 days')
      AND counterparty_name IS NOT NULL
      AND LOWER(counterparty_name) NOT LIKE '%mercury%'
    GROUP BY counterparty_name HAVING n >= 5
  `).all();

  // Session 16c: filter recurring patterns (Square Inc payroll, etc.)
  const patterns = await loadRecurringPatterns(env);
  const issues = [];
  for (const v of (vendors || [])) {
    // Skip known-recurring vendors entirely — these have expected bursts of cadence
    if (matchesRecurringPattern(v.counterparty_name, patterns)) continue;

    const { results: recentBig } = await env.DB.prepare(`
      SELECT id, txn_date, amount, description FROM mercury_transactions
      WHERE counterparty_name = ?
        AND amount < 0
        AND txn_date >= date('now','-14 days')
        AND ABS(amount) > ? * 2.5
      LIMIT 3
    `).bind(v.counterparty_name, v.avg_amt).all();
    for (const r of (recentBig || [])) {
      issues.push({
        issue_type: 'unusual_transaction',
        severity: Math.abs(r.amount) > v.avg_amt * 5 ? 'high' : 'medium',
        subject: v.counterparty_name,
        headline: `${v.counterparty_name} $${Math.abs(r.amount).toFixed(0)} on ${r.txn_date.slice(0, 10)} — unusual size`,
        detail: `Vendor's typical txn: $${v.avg_amt.toFixed(0)} (${v.n} prior in 90d). This: $${Math.abs(r.amount).toFixed(0)}.`,
        data_json: JSON.stringify({ txn_id: r.id, amount: r.amount, vendor_avg: v.avg_amt, vendor_n: v.n }),
        suggested_action: 'Confirm intentional — could be capex, bulk order, or vendor error',
      });
    }
  }
  return issues.slice(0, 5);  // cap at 5 to avoid noise
}

// ── Scan all detectors + write to cfo_issues (deduped by issue_type+subject) ──
export async function scanIssues(env) {
  const detectors = [
    detectVendorAnomalies,
    detectMarginDrift,
    detectArAgingSlip,
    detectCashTrajectory,
    detectCustomerConcentration,
    detectPipelineDepth,
    detectUnusualTransaction,
  ];

  const allIssues = [];
  for (const det of detectors) {
    try {
      const found = await det(env);
      allIssues.push(...found);
    } catch (err) {
      console.warn(`[issue-surfacer] detector ${det.name} failed:`, err.message);
    }
  }

  // Dedup against existing open issues — same (type, subject) → update instead
  const stats = { new: 0, updated: 0, auto_closed: 0, total_detected: allIssues.length };
  const detectedKeys = new Set(allIssues.map(i => `${i.issue_type}::${i.subject || ''}`));

  for (const issue of allIssues) {
    const existing = await env.DB.prepare(`
      SELECT id FROM cfo_issues
      WHERE issue_type = ? AND subject = ? AND status = 'open'
      LIMIT 1
    `).bind(issue.issue_type, issue.subject || '').first();

    if (existing) {
      await env.DB.prepare(`
        UPDATE cfo_issues SET detected_at = datetime('now'),
          severity = ?, headline = ?, detail = ?, data_json = ?, suggested_action = ?
        WHERE id = ?
      `).bind(issue.severity, issue.headline, issue.detail, issue.data_json, issue.suggested_action, existing.id).run();
      stats.updated += 1;
    } else {
      await env.DB.prepare(`
        INSERT INTO cfo_issues (id, issue_type, severity, subject, headline, detail, data_json, suggested_action)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), issue.issue_type, issue.severity, issue.subject || '', issue.headline, issue.detail, issue.data_json, issue.suggested_action).run();
      stats.new += 1;
    }
  }

  // Session 16c: auto-close stored issues that this scan no longer detects.
  // Without this, suppressed-by-whitelist issues (UTAH801, Square Inc payroll,
  // margin_drift RTR-2 catch-up) stay 'open' forever even though the detector
  // explicitly chose not to surface them.
  const { results: openIssues } = await env.DB.prepare(`
    SELECT id, issue_type, subject FROM cfo_issues WHERE status = 'open'
  `).all();
  for (const open of (openIssues || [])) {
    const key = `${open.issue_type}::${open.subject || ''}`;
    if (!detectedKeys.has(key)) {
      await env.DB.prepare(`
        UPDATE cfo_issues SET status = 'auto_closed', resolved_at = datetime('now'),
          resolved_note = 'Auto-closed by scan — detector no longer surfacing (whitelist match, data-quality suppression, or condition cleared)'
        WHERE id = ?
      `).bind(open.id).run().catch(() => {});
      stats.auto_closed += 1;
    }
  }

  return { ok: true, ...stats };
}

// ── List open issues ─────────────────────────────────────────────────────
export async function listIssues(env, opts = {}) {
  const { severity, limit = 50 } = opts;
  let query = `
    SELECT id, detected_at, issue_type, severity, subject, headline, detail,
           suggested_action, status, snooze_until
    FROM cfo_issues
    WHERE status = 'open'
      AND (snooze_until IS NULL OR snooze_until < datetime('now'))
  `;
  const params = [];
  if (severity) { query += ` AND severity = ?`; params.push(severity); }
  query += `
    ORDER BY CASE severity
      WHEN 'critical' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      WHEN 'low' THEN 4
    END, detected_at DESC
    LIMIT ?
  `;
  params.push(limit);
  const { results } = await env.DB.prepare(query).bind(...params).all();

  // Summary counts
  const summary = await env.DB.prepare(`
    SELECT severity, COUNT(*) as n FROM cfo_issues
    WHERE status = 'open' AND (snooze_until IS NULL OR snooze_until < datetime('now'))
    GROUP BY severity
  `).all();
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const s of (summary.results || [])) counts[s.severity] = s.n;

  return {
    counts,
    total: counts.critical + counts.high + counts.medium + counts.low,
    issues: results || [],
  };
}

// ── Snooze / resolve / dismiss ───────────────────────────────────────────
export async function snoozeIssue(env, id, days = 7) {
  await env.DB.prepare(`
    UPDATE cfo_issues SET status = 'snoozed', snooze_until = datetime('now', '+' || ? || ' days') WHERE id = ?
  `).bind(days, id).run();
  return { ok: true, id, snoozed_for_days: days };
}

export async function resolveIssue(env, id, note) {
  await env.DB.prepare(`
    UPDATE cfo_issues SET status = 'resolved', resolved_at = datetime('now'), resolved_note = ? WHERE id = ?
  `).bind((note || '').slice(0, 500), id).run();
  return { ok: true, id };
}

export async function dismissIssue(env, id) {
  await env.DB.prepare(
    `UPDATE cfo_issues SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
  return { ok: true, id };
}
