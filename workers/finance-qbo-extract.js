// workers/finance-qbo-extract.js
// Finance v2 Wave 0/2 — QBO extraction.
//
// Two main jobs:
//   1. extractChartOfAccounts()  — pulls Account entities from QBO, seeds chart_of_accounts table
//                                  with parent hierarchy. Per spec section 2.1.
//   2. extract2025Archive()      — pulls Invoice/Bill/Payment/JournalEntry/Purchase/
//                                  Customer/Vendor/Item/Account/Employee for the 2025
//                                  reporting year. Writes to qbo_archive_entity (migration 035).
//                                  Per spec section 0.1.
//
// Both use the exported qboSqlQuery helper from qbo-client.js. Pagination: QBO caps at
// 1000 rows per query; we use STARTPOSITION to page. Rate limit: 500/min per realm;
// sleep 150ms between calls to stay safe.

import { qboSqlQuery } from './qbo-client.js';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Chart of accounts ──────────────────────────────────────────────────────
const ACCOUNT_TYPE_MAP = {
  // QBO AccountType → our account_type enum.
  'Bank': 'asset',
  'Accounts Receivable': 'asset',
  'Other Current Asset': 'asset',
  'Fixed Asset': 'asset',
  'Other Asset': 'asset',
  'Accounts Payable': 'liability',
  'Credit Card': 'liability',
  'Other Current Liability': 'liability',
  'Long Term Liability': 'liability',
  'Equity': 'equity',
  'Income': 'revenue',
  'Other Income': 'other_income',
  'Cost of Goods Sold': 'cogs',
  'Expense': 'expense',
  'Other Expense': 'other_expense',
};

const ACCOUNT_SUBTYPE_MAP = {
  'Bank': 'current_asset',
  'Accounts Receivable': 'current_asset',
  'Other Current Asset': 'current_asset',
  'Fixed Asset': 'fixed_asset',
  'Other Asset': 'other_asset',
  'Accounts Payable': 'current_liability',
  'Credit Card': 'current_liability',
  'Other Current Liability': 'current_liability',
  'Long Term Liability': 'long_term_liability',
};

// Accounts the spec says to clean up during import.
// Exact-match (case-insensitive) on FullyQualifiedName to avoid over-matching
// e.g. "Partner investments:Drew and Lindsay" which is a legit equity sub-account.
const RECLASSIFY_TO_EQUITY = new Set([
  'note payable - drew & lindsay',
  'note payable - drew and lindsay',
  'note payable drew & lindsay',
].map(s => s.toLowerCase()));
const MARK_INACTIVE_EXITED = new Set([
  'note payable - todd and amanda',
  'note payable - todd & amanda',
].map(s => s.toLowerCase()));

export async function extractChartOfAccounts(env) {
  // QBO caps at 1000 rows — chart of accounts rarely exceeds this.
  const result = await qboSqlQuery(env, `SELECT * FROM Account MAXRESULTS 1000`);
  const accounts = result?.QueryResponse?.Account || [];

  // First pass: insert every account (parent refs resolved in second pass via qbo_account_id).
  let inserted = 0;
  let updated = 0;
  let reclassified = 0;
  let inactivated = 0;

  for (const a of accounts) {
    const qboId = String(a.Id);
    const name = a.FullyQualifiedName || a.Name;
    const acctType = ACCOUNT_TYPE_MAP[a.AccountType] || 'expense';
    const acctSubtype = ACCOUNT_SUBTYPE_MAP[a.AccountType] || null;
    let isActive = a.Active === false ? 0 : 1;
    let notes = null;

    // Spec cleanups — exact-match on full name.
    const lower = name.toLowerCase();
    if (RECLASSIFY_TO_EQUITY.has(lower)) {
      isActive = 0;
      notes = 'RECLASSIFY_TO_EQUITY — handled at opening balance load (Wave 2.17)';
      reclassified++;
    } else if (MARK_INACTIVE_EXITED.has(lower)) {
      isActive = 0;
      notes = 'EXITED_PARTNER — Todd & Amanda paid off, zero at opening balance';
      inactivated++;
    }

    const existing = await env.DB.prepare(
      `SELECT id FROM chart_of_accounts WHERE qbo_account_id = ?`
    ).bind(qboId).first();

    if (existing) {
      await env.DB.prepare(`
        UPDATE chart_of_accounts
        SET account_name = ?, account_type = ?, account_subtype = ?, detail_type = ?,
            is_active = ?, description = COALESCE(description, ?), notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        name, acctType, acctSubtype, a.AccountSubType || null,
        isActive, a.Description || null, notes, existing.id
      ).run();
      updated++;
    } else {
      await env.DB.prepare(`
        INSERT INTO chart_of_accounts (
          id, account_number, account_name, account_type, account_subtype,
          parent_account_id, detail_type, is_active, is_system, qbo_account_id, description, notes
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        a.AcctNum ? parseInt(a.AcctNum, 10) : null,
        name, acctType, acctSubtype,
        a.AccountSubType || null,
        isActive,
        qboId,
        a.Description || null,
        notes
      ).run();
      inserted++;
    }
    await sleep(20); // light pacing
  }

  // Second pass: resolve parent links via QBO ParentRef.
  let parentsLinked = 0;
  for (const a of accounts) {
    if (!a.ParentRef?.value) continue;
    const parentQboId = String(a.ParentRef.value);
    const selfQboId = String(a.Id);
    const parentRow = await env.DB.prepare(`SELECT id FROM chart_of_accounts WHERE qbo_account_id = ?`).bind(parentQboId).first();
    const selfRow = await env.DB.prepare(`SELECT id FROM chart_of_accounts WHERE qbo_account_id = ?`).bind(selfQboId).first();
    if (parentRow && selfRow) {
      await env.DB.prepare(`UPDATE chart_of_accounts SET parent_account_id = ? WHERE id = ?`).bind(parentRow.id, selfRow.id).run();
      parentsLinked++;
    }
  }

  // Add the spec-mandated new account: Equipment Placed at Customer Locations (warmers).
  const warmerExists = await env.DB.prepare(
    `SELECT id FROM chart_of_accounts WHERE account_name = 'Equipment Placed at Customer Locations'`
  ).first();
  if (!warmerExists) {
    await env.DB.prepare(`
      INSERT INTO chart_of_accounts (
        id, account_name, account_type, account_subtype, detail_type, is_active, is_system, description, notes
      ) VALUES (?, 'Equipment Placed at Customer Locations', 'asset', 'fixed_asset', 'Machinery & Equipment', 1, 1,
               'Pretzel warmers loaned to venues. Tracked in fixed_assets with customer_id.',
               'Added per Finance v2 spec section 2.1')
    `).bind(crypto.randomUUID()).run();
  }

  // Audit log.
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'qbo_coa_extracted', 'chart_of_accounts', 'all', 'system', ?, ?)
  `).bind(
    crypto.randomUUID(),
    `COA extract: ${inserted} new, ${updated} updated, ${parentsLinked} parent links, ${reclassified} reclassified, ${inactivated} inactivated`,
    JSON.stringify({ qbo_total: accounts.length, inserted, updated, parentsLinked, reclassified, inactivated })
  ).run();

  return {
    ok: true,
    qbo_accounts: accounts.length,
    inserted,
    updated,
    parent_links_set: parentsLinked,
    reclassified_to_equity: reclassified,
    inactivated_exited: inactivated,
    added_system_accounts: warmerExists ? 0 : 1,
  };
}

// ── 2025 archive extraction ────────────────────────────────────────────────
export async function extract2025Archive(env) {
  const startDate = '2025-01-01';
  const endDate = '2025-12-31';
  const counts = {};

  const entities = [
    { name: 'Invoice',      sql: `SELECT * FROM Invoice      WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'` },
    { name: 'Bill',         sql: `SELECT * FROM Bill         WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'` },
    { name: 'Payment',      sql: `SELECT * FROM Payment      WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'` },
    { name: 'JournalEntry', sql: `SELECT * FROM JournalEntry WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'` },
    { name: 'Purchase',     sql: `SELECT * FROM Purchase     WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'` },
    { name: 'BillPayment',  sql: `SELECT * FROM BillPayment  WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'` },
    { name: 'Deposit',      sql: `SELECT * FROM Deposit      WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'` },
    // Reference entities (full history, not date-filtered)
    { name: 'Customer',     sql: `SELECT * FROM Customer` },
    { name: 'Vendor',       sql: `SELECT * FROM Vendor` },
    { name: 'Item',         sql: `SELECT * FROM Item` },
    { name: 'Employee',     sql: `SELECT * FROM Employee` },
  ];

  for (const { name, sql } of entities) {
    counts[name] = 0;
    let start = 1;
    const pageSize = 500;
    for (let page = 0; page < 20; page++) { // up to 10k per entity
      const pagedSql = `${sql} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
      let result;
      try {
        result = await qboSqlQuery(env, pagedSql);
      } catch (err) {
        console.error(`[qbo-extract] ${name} page ${page} failed: ${err.message}`);
        break;
      }
      const rows = result?.QueryResponse?.[name] || [];
      if (!rows.length) break;

      for (const row of rows) {
        const qboId = String(row.Id);
        const txnDate = row.TxnDate || row.MetaData?.CreateTime?.slice(0, 10) || null;
        await env.DB.prepare(`
          INSERT INTO qbo_archive_entity (id, entity_type, qbo_id, txn_date, raw_json, fetched_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(entity_type, qbo_id) DO UPDATE SET
            txn_date = excluded.txn_date,
            raw_json = excluded.raw_json,
            fetched_at = excluded.fetched_at
        `).bind(crypto.randomUUID(), name, qboId, txnDate, JSON.stringify(row)).run();
        counts[name]++;
      }

      if (rows.length < pageSize) break;
      start += pageSize;
      await sleep(150); // 500/min QBO rate limit cushion
    }
  }

  // Reports (store raw JSON alongside for the memo generator)
  const reports = [
    { name: 'ProfitAndLoss_2025', endpoint: `reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&accounting_method=Cash` },
    { name: 'BalanceSheet_2025_end', endpoint: `reports/BalanceSheet?as_of=${endDate}` },
    { name: 'AgedReceivables_2025_end', endpoint: `reports/AgedReceivables?as_of=${endDate}` },
  ];
  const reportCounts = {};
  for (const { name } of reports) {
    reportCounts[name] = 'skipped_in_v1'; // Reports use qboQuery not qboSqlQuery; defer to Phase B memo generator
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'qbo_2025_extract', 'qbo_archive_entity', '2025', 'system', ?, ?)
  `).bind(
    crypto.randomUUID(),
    `QBO 2025 extract: ${Object.values(counts).reduce((a, b) => a + b, 0)} total rows across ${entities.length} entity types`,
    JSON.stringify({ counts, reports: reportCounts })
  ).run();

  return { ok: true, entity_counts: counts, reports: reportCounts };
}
