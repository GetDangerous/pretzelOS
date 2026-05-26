// workers/mercury-client.js
// Mercury API wrapper for Pretzel OS Finance v2.
// API docs: https://docs.mercury.com/reference
// Auth: Bearer env.MERCURY_API_TOKEN (set via `wrangler secret put MERCURY_API_TOKEN`)
// Rate limit: 60 req/min — this module sleeps 1100ms between paginated calls to stay safe.

const MERCURY_BASE = 'https://api.mercury.com/api/v1';

function mercuryHeaders(env) {
  if (!env.MERCURY_API_TOKEN) throw new Error('MERCURY_API_TOKEN not set — run `wrangler secret put MERCURY_API_TOKEN`');
  return {
    'Accept': 'application/json',
    'Authorization': `Bearer ${env.MERCURY_API_TOKEN}`,
  };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Accounts ──────────────────────────────────────────────────────────────
export async function getAccounts(env) {
  const resp = await fetch(`${MERCURY_BASE}/accounts`, { headers: mercuryHeaders(env) });
  if (!resp.ok) throw new Error(`Mercury accounts failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return data.accounts || [];
}

// ── Transactions (paginated) ──────────────────────────────────────────────
// Mercury pagination: supports `start`, `end` (ISO YYYY-MM-DD), `limit` (default 500, max 500), `offset`.
// Returns a single flat array across all pages.
export async function getTransactions(env, accountId, since, until, { maxPages = 200 } = {}) {
  const all = [];
  let offset = 0;
  const limit = 500;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (since) qs.set('start', since);
    if (until) qs.set('end', until);
    const resp = await fetch(`${MERCURY_BASE}/account/${accountId}/transactions?${qs}`, { headers: mercuryHeaders(env) });
    if (!resp.ok) throw new Error(`Mercury txns failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const batch = data.transactions || [];
    all.push(...batch);
    if (batch.length < limit) break; // last page
    offset += limit;
    await sleep(1100); // rate-limit cushion
  }
  return all;
}

// ── Sync: pull accounts + upsert balances ─────────────────────────────────
export async function syncAccountsToD1(env) {
  const accounts = await getAccounts(env);
  let upserted = 0;
  for (const a of accounts) {
    // Mercury account shape: { id, name, accountNumber, routingNumber, status, type, currentBalance, availableBalance, ... }
    await env.DB.prepare(`
      INSERT INTO mercury_accounts (id, mercury_account_id, account_name, account_type, current_balance, available_balance, last_synced_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(mercury_account_id) DO UPDATE SET
        account_name = excluded.account_name,
        account_type = excluded.account_type,
        current_balance = excluded.current_balance,
        available_balance = excluded.available_balance,
        last_synced_at = excluded.last_synced_at,
        is_active = excluded.is_active
    `).bind(
      crypto.randomUUID(),
      a.id,
      a.name || a.accountNumber || 'Mercury account',
      a.type || a.kind || 'checking',
      Number(a.currentBalance ?? a.balance ?? 0),
      Number(a.availableBalance ?? a.available ?? 0),
      a.status === 'active' ? 1 : 0
    ).run();
    upserted++;
  }
  return { accounts_synced: upserted, accounts };
}

// ── Sync: pull transactions for a date range across ALL accounts ──────────
export async function syncTransactionsToD1(env, since, until) {
  const accounts = await getAccounts(env);
  let inserted = 0;
  let skipped = 0;
  const perAccount = {};
  for (const a of accounts) {
    const txns = await getTransactions(env, a.id, since, until);
    perAccount[a.name || a.id] = txns.length;
    for (const t of txns) {
      // Mercury txn shape: { id, amount, postedAt, createdAt, counterpartyName, note, status, kind, category, ... }
      // Amount is positive for inflows, negative for outflows in Mercury's convention.
      const newStatus = t.status || 'posted';
      const existing = await env.DB.prepare(
        `SELECT id, status, matched_journal_entry_id FROM mercury_transactions WHERE mercury_txn_id = ?`
      ).bind(t.id).first();

      if (existing) {
        // Phase 23-FAILED+ foundational fix: when Mercury txn status changes
        // (pending→sent, pending→failed, sent→failed), update our row + reverse
        // any JE if the new status is 'failed'. Tier 2 checks for stale pending.
        if (existing.status !== newStatus) {
          await env.DB.prepare(
            `UPDATE mercury_transactions SET status = ? WHERE id = ?`
          ).bind(newStatus, existing.id).run();
          // If transitioned to failed and has JE, reverse it (failed = money didn't move)
          if (newStatus === 'failed' && existing.matched_journal_entry_id) {
            await env.DB.prepare(
              `UPDATE journal_entries SET status='reversed',
                 notes = COALESCE(notes,'') || ' | Auto-reversed: Mercury txn transitioned to failed status'
               WHERE id = ?`
            ).bind(existing.matched_journal_entry_id).run();
            await env.DB.prepare(
              `UPDATE mercury_transactions SET matched_journal_entry_id = NULL, is_reconciled = 0 WHERE id = ?`
            ).bind(existing.id).run();
          }
        }
        skipped++;
        continue;
      }

      const amount = Number(t.amount ?? 0);
      const postedAt = t.postedAt || t.createdAt || t.estimatedDeliveryDate || null;
      const txnDate = postedAt ? postedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

      await env.DB.prepare(`
        INSERT INTO mercury_transactions (
          id, mercury_txn_id, account_id, account_name, txn_date, amount,
          description, counterparty_name, category, status, is_reconciled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).bind(
        crypto.randomUUID(),
        t.id,
        a.id,
        a.name || 'Mercury',
        txnDate,
        amount,
        t.note || t.bankDescription || t.externalMemo || null,
        t.counterpartyName || t.externalCounterpartyName || null,
        t.category || t.kind || null,
        newStatus
      ).run();
      inserted++;
    }
    await sleep(300);
  }
  return { since, until, inserted, skipped, per_account: perAccount };
}

// ── Probe: try various Mercury API endpoints to find credit card data ────
// Phase 21V-MC-fwd investigation: Mercury IO Credit card isn't returned by
// /accounts. Probe to find which paths (if any) expose credit card txns/balances.
export async function probeMercuryEndpoints(env) {
  const paths = [
    '/accounts',
    '/cards',
    '/credit-cards',
    '/credit/cards',
    '/credit/accounts',
    '/credit/transactions',
    '/io',
    '/io/cards',
    '/io/transactions',
    '/io/credit',
    '/io/statements',
    '/account/credit',
    '/user',
    '/users/me',
    '/me',
  ];
  const results = [];
  for (const p of paths) {
    try {
      const r = await fetch(`${MERCURY_BASE}${p}`, { headers: mercuryHeaders(env) });
      const text = await r.text();
      results.push({
        path: p,
        status: r.status,
        ok: r.ok,
        body_preview: text.slice(0, 500),
      });
    } catch (e) {
      results.push({ path: p, status: 'error', error: e.message });
    }
  }
  return { ok: true, base: MERCURY_BASE, results };
}

// ── Status: show last sync + variance against QBO ─────────────────────────
export async function syncStatus(env) {
  const accounts = await env.DB.prepare(
    `SELECT account_name, current_balance, available_balance, last_synced_at FROM mercury_accounts WHERE is_active = 1`
  ).all();
  const lastTxn = await env.DB.prepare(
    `SELECT MAX(txn_date) as last_date, COUNT(*) as total FROM mercury_transactions`
  ).first();
  return {
    accounts: accounts.results || [],
    last_transaction_date: lastTxn?.last_date || null,
    total_transactions: lastTxn?.total || 0,
  };
}
