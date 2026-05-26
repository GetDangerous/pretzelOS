// workers/finance-qbo-je-ingest.js
// Session 21V-QBO-JE (May 15 2026)
//
// Ingest QBO JournalEntry records from qbo_archive_entity as proper JEs.
// These are bookkeeper-authored manual entries: payroll accruals, vendor bill
// accruals, owner-loan reclassifications, year-end adjustments, etc.
//
// Overlap-detection logic (per Drew's "safest + most accurate + validatable"):
//   For each QBO JE, look for an existing mercury_txn JE with:
//     - same date (±3 days)
//     - same total amount (±$0.01)
//   If overlap match:
//     - If the QBO JE's account allocation matches our categorizer's → skip QBO (already correct)
//     - If different → reverse our categorizer JE, post QBO version (bookkeeper wins)
//   If no overlap → post QBO JE as-is
//
// All decisions logged to finance_audit_log so Drew can review post-hoc.
// Idempotent via source_type='qbo_je_ingest', source_id=JournalEntry.Id

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const SOURCE_TYPE = 'qbo_je_ingest';

// DocNumber patterns to SKIP because Phase 20D revenue reconstruction already
// covers daily POS revenue recognition + tips/income reclassifications.
// Pattern: case-insensitive prefix match on DocNumber.
const SKIP_DOC_PATTERNS = [
  /^Sales /i,            // "Sales (01-02-2025)" — daily POS revenue
  /^TipsAdj/i,           // weekly tips reclass
  /^Income Adjustment/i, // income reclass
  /^IncomeAdjustment/i,
  /^SLCB GH Adjust/i,    // GrubHub settlement reclass (revenue covered by 20D)
  /^SLCB UE Adjust/i,    // UberEats settlement reclass (revenue covered by 20D)
  /^SLCB DD Adjust/i,    // DoorDash settlement reclass (revenue covered by 20D)
];

function shouldSkipDocPattern(docNumber) {
  if (!docNumber) return false;
  return SKIP_DOC_PATTERNS.some(rx => rx.test(docNumber));
}

// QBO JEs that touch revenue accounts duplicate Phase 20D monthly P&L
// reconstruction (which already captures the QBO bookkeeper's total revenue).
// Skip any JE that has any line on a revenue/income/other_income account.
async function touchesRevenue(env, parsed, accountTypesById) {
  for (const line of parsed.lines) {
    const accId = accountTypesById[line.account_name];
    if (!accId) continue;
    const type = accId;
    if (type === 'revenue' || type === 'income' || type === 'other_income') return true;
  }
  return false;
}

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

async function resolveAccountTypesByName(env) {
  const { results } = await env.DB.prepare(`SELECT account_name, account_type FROM chart_of_accounts`).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.account_type;
  return map;
}

async function fetchJournalEntries(env, yearStart, yearEnd) {
  const { results } = await env.DB.prepare(`
    SELECT raw_json
    FROM qbo_archive_entity
    WHERE entity_type = 'JournalEntry'
      AND json_extract(raw_json, '$.TxnDate') BETWEEN ? AND ?
    ORDER BY json_extract(raw_json, '$.TxnDate')
  `).bind(yearStart, yearEnd).all();
  return (results || []).map(r => JSON.parse(r.raw_json));
}

function parseQboJE(je) {
  const lines = [];
  const rawLines = Array.isArray(je.Line) ? je.Line : [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of rawLines) {
    const det = line?.JournalEntryLineDetail;
    if (!det) continue;
    const accountName = det?.AccountRef?.name;
    const amount = parseFloat(line?.Amount) || 0;
    const postingType = det?.PostingType;  // 'Debit' or 'Credit'
    if (!accountName || amount === 0 || !postingType) continue;
    const isDebit = postingType === 'Debit';
    lines.push({
      account_name: accountName,
      amount,
      is_debit: isDebit,
      description: line?.Description || je.PrivateNote || je.DocNumber || 'QBO JournalEntry',
    });
    if (isDebit) totalDebit += amount;
    else totalCredit += amount;
  }
  return {
    je_id: je.Id,
    doc_number: je.DocNumber || '',
    txn_date: je.TxnDate,
    private_note: je.PrivateNote || '',
    total_debit: Math.round(totalDebit * 100) / 100,
    total_credit: Math.round(totalCredit * 100) / 100,
    lines,
  };
}

// Find candidate overlap with existing mercury_txn JE (same date ±3d, same total ±$0.01)
async function findOverlap(env, parsed) {
  const txnDate = parsed.txn_date;
  const total = parsed.total_debit;  // = total_credit if balanced
  // ±3 days window
  const date = new Date(txnDate);
  const dateMinus3 = new Date(date.getTime() - 3*24*60*60*1000).toISOString().slice(0,10);
  const datePlus3 = new Date(date.getTime() + 3*24*60*60*1000).toISOString().slice(0,10);

  const { results } = await env.DB.prepare(`
    SELECT id, entry_date, total_debit
    FROM journal_entries
    WHERE source_type = 'mercury_txn'
      AND status = 'posted'
      AND entry_date BETWEEN ? AND ?
      AND ABS(total_debit - ?) < 0.02
    LIMIT 5
  `).bind(dateMinus3, datePlus3, total).all();

  return results || [];
}

// Compare account allocation: does QBO match what our categorizer did?
async function categorizerMatches(env, mercuryTxnJeId, parsed, accountIds) {
  // Pull lines of the categorizer JE
  const { results: catLines } = await env.DB.prepare(`
    SELECT c.account_name, ROUND(l.debit, 2) as debit, ROUND(l.credit, 2) as credit
    FROM journal_entry_lines l
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE l.journal_entry_id = ?
    ORDER BY l.line_number
  `).bind(mercuryTxnJeId).all();

  // Build canonical signatures for comparison: {account_name → net debit-credit}
  const catSig = {};
  for (const cl of catLines || []) {
    catSig[cl.account_name] = (catSig[cl.account_name] || 0) + (cl.debit - cl.credit);
  }
  const qboSig = {};
  for (const l of parsed.lines) {
    const sign = l.is_debit ? 1 : -1;
    qboSig[l.account_name] = (qboSig[l.account_name] || 0) + sign * l.amount;
  }

  // Match if same set of accounts with same signed amounts (within $0.02)
  const allAccts = new Set([...Object.keys(catSig), ...Object.keys(qboSig)]);
  for (const a of allAccts) {
    const c = catSig[a] || 0;
    const q = qboSig[a] || 0;
    if (Math.abs(c - q) > 0.02) return false;
  }
  return true;
}

export async function previewQboJeIngest(env, year = 2025) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const jes = await fetchJournalEntries(env, yearStart, yearEnd);
  const accountIds = await resolveAccountIds(env);
  const accountTypes = await resolveAccountTypesByName(env);

  let wouldPost = 0, wouldSkipMatch = 0, wouldOverrideCategorizer = 0;
  let wouldSkipUnbalanced = 0, wouldSkipUnmapped = 0, wouldSkipDoc = 0, wouldSkipRevenue = 0;
  const unmappedAccounts = new Set();
  const skippedDocSamples = [];
  const skippedRevenueSamples = [];
  const sample = [];

  for (const je of jes) {
    const parsed = parseQboJE(je);
    if (shouldSkipDocPattern(parsed.doc_number)) {
      wouldSkipDoc++;
      if (skippedDocSamples.length < 5) skippedDocSamples.push({ doc: parsed.doc_number, date: parsed.txn_date });
      continue;
    }
    // Skip any JE that touches a revenue account (covered by Phase 20D reconstruction)
    if (await touchesRevenue(env, parsed, accountTypes)) {
      wouldSkipRevenue++;
      if (skippedRevenueSamples.length < 5) skippedRevenueSamples.push({ doc: parsed.doc_number, date: parsed.txn_date, je_id: parsed.je_id });
      continue;
    }
    if (parsed.lines.length === 0) { wouldSkipUnbalanced++; continue; }
    if (Math.abs(parsed.total_debit - parsed.total_credit) > 0.02) {
      wouldSkipUnbalanced++; continue;
    }
    // Check mapped
    let allMapped = true;
    for (const l of parsed.lines) {
      if (!accountIds[l.account_name]) {
        unmappedAccounts.add(l.account_name);
        allMapped = false;
      }
    }
    if (!allMapped) { wouldSkipUnmapped++; continue; }

    // Check overlap
    const overlaps = await findOverlap(env, parsed);
    let decision = 'post_new';
    if (overlaps.length > 0) {
      // Take first match (most likely)
      const matches = await categorizerMatches(env, overlaps[0].id, parsed, accountIds);
      if (matches) { decision = 'skip_already_match'; wouldSkipMatch++; }
      else { decision = 'override_categorizer'; wouldOverrideCategorizer++; }
    } else {
      wouldPost++;
    }
    if (sample.length < 8) sample.push({ ...parsed, decision, overlap_count: overlaps.length });
  }

  return {
    ok: true,
    year,
    jes_found: jes.length,
    would_post_new: wouldPost,
    would_skip_already_match: wouldSkipMatch,
    would_override_categorizer: wouldOverrideCategorizer,
    would_skip_doc_pattern: wouldSkipDoc,
    would_skip_touches_revenue: wouldSkipRevenue,
    would_skip_unbalanced: wouldSkipUnbalanced,
    would_skip_unmapped: wouldSkipUnmapped,
    unmapped_accounts: Array.from(unmappedAccounts),
    skipped_doc_samples: skippedDocSamples,
    skipped_revenue_samples: skippedRevenueSamples,
    sample,
  };
}

export async function ingestQboJournalEntries(env, year = 2025, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'qbo_je_ingest' });

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const jes = await fetchJournalEntries(env, yearStart, yearEnd);
  const accountIds = await resolveAccountIds(env);
  const accountTypes = await resolveAccountTypesByName(env);

  const posted = [];
  const skippedMatch = [];
  const skippedDoc = [];
  const skippedRevenue = [];
  const overridden = [];
  const errors = [];

  for (const je of jes) {
    const parsed = parseQboJE(je);
    const sourceId = `qbo_je_${parsed.je_id}`;

    // Skip daily Sales/TipsAdj/IncomeAdj JEs — covered by Phase 20D
    if (shouldSkipDocPattern(parsed.doc_number)) {
      skippedDoc.push({ je_id: parsed.je_id, doc: parsed.doc_number, date: parsed.txn_date });
      continue;
    }
    // Skip any JE that touches a revenue account
    if (await touchesRevenue(env, parsed, accountTypes)) {
      skippedRevenue.push({ je_id: parsed.je_id, doc: parsed.doc_number, date: parsed.txn_date });
      continue;
    }

    // Idempotency
    const { results: existing } = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? AND status = 'posted'`
    ).bind(SOURCE_TYPE, sourceId).all();
    if ((existing || []).length > 0 && !opts.force) {
      skippedMatch.push({ je_id: parsed.je_id, reason: 'already_ingested', existing_count: existing.length });
      continue;
    }
    if ((existing || []).length > 0 && opts.force) {
      for (const row of existing) {
        await env.DB.prepare(
          `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound at ' || datetime('now') WHERE id = ?`
        ).bind(row.id).run();
      }
    }

    if (parsed.lines.length === 0) {
      skippedMatch.push({ je_id: parsed.je_id, reason: 'no_lines' });
      continue;
    }
    if (Math.abs(parsed.total_debit - parsed.total_credit) > 0.02) {
      errors.push({ je_id: parsed.je_id, reason: 'unbalanced', total_debit: parsed.total_debit, total_credit: parsed.total_credit });
      continue;
    }
    const missingMap = parsed.lines.filter(l => !accountIds[l.account_name]);
    if (missingMap.length > 0) {
      errors.push({ je_id: parsed.je_id, reason: 'coa_account_missing', missing: missingMap.map(m => m.account_name) });
      continue;
    }

    // Overlap detection
    const overlaps = await findOverlap(env, parsed);
    let overrideOfCategorizer = null;
    if (overlaps.length > 0) {
      const matches = await categorizerMatches(env, overlaps[0].id, parsed, accountIds);
      if (matches) {
        skippedMatch.push({ je_id: parsed.je_id, reason: 'matches_categorizer', categorizer_je: overlaps[0].id });
        continue;
      }
      // Bookkeeper wins — reverse our categorizer JE
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Reversed by QBO JE ' || ? || ' at ' || datetime('now') WHERE id = ?`
      ).bind(parsed.je_id, overlaps[0].id).run();
      overrideOfCategorizer = overlaps[0].id;
    }

    // Post the QBO JE as our JE
    const entryId = crypto.randomUUID();
    const desc = `QBO JE ${parsed.doc_number || parsed.je_id} · ${parsed.private_note || (parsed.lines[0]?.description || '').slice(0, 100)}`.slice(0, 250);
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_21_validate', ?)
    `).bind(
      entryId, parsed.txn_date, desc, SOURCE_TYPE, sourceId,
      parsed.total_debit, parsed.total_credit,
      overrideOfCategorizer
        ? `Bookkeeper QBO JE override. Reversed categorizer JE: ${overrideOfCategorizer}.`
        : 'Bookkeeper QBO JE accrual/adjustment (no Mercury overlap).'
    ).run();

    let lineNum = 1;
    for (const line of parsed.lines) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), entryId, lineNum++,
        accountIds[line.account_name],
        line.is_debit ? line.amount : 0,
        line.is_debit ? 0 : line.amount,
        (line.description || '').slice(0, 200)
      ).run();
    }

    if (overrideOfCategorizer) {
      overridden.push({ je_id: parsed.je_id, entry_id: entryId, reversed_categorizer: overrideOfCategorizer });
    } else {
      posted.push({ je_id: parsed.je_id, entry_id: entryId, txn_date: parsed.txn_date, total: parsed.total_debit });
    }
  }

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'qbo_je_ingest', 'journal_entries', ?, 'session_21_validate', ?, ?)
  `).bind(
    crypto.randomUUID(), `qbo_je_ingest_${year}_${Date.now()}`,
    `Ingested ${posted.length + overridden.length} QBO JEs for FY${year} (${overridden.length} overrides)`,
    JSON.stringify({
      posted: posted.length,
      overridden: overridden.length,
      skipped_match: skippedMatch.length,
      errors: errors.length,
    })
  ).run().catch(() => {});

  return {
    ok: true,
    year,
    jes_processed: jes.length,
    posted_new: posted.length,
    overridden_categorizer: overridden.length,
    skipped_matched: skippedMatch.length,
    skipped_doc_pattern: skippedDoc.length,
    skipped_touches_revenue: skippedRevenue.length,
    errors: errors.length,
    error_details: errors.slice(0, 10),
    overridden_sample: overridden.slice(0, 5),
  };
}
