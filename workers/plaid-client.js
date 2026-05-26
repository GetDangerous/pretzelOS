// workers/plaid-client.js
// Plaid integration for Chase CC + future bank accounts.
//
// Architecture:
//   1. Browser → loads Plaid Link UI via /finance/plaid/link-token (we mint one)
//   2. User authenticates with Chase → Plaid returns public_token to browser
//   3. Browser → /finance/plaid/exchange (POST with public_token)
//   4. Server exchanges for access_token, encrypts, stores in plaid_items
//   5. Cron: every 4h → /transactions/sync → updates chase_cc_transactions
//   6. Webhook: SYNC_UPDATES_AVAILABLE → triggers immediate sync
//
// Environment vars required:
//   PLAID_CLIENT_ID         — from Plaid Dashboard
//   PLAID_SECRET            — Sandbox or Production secret
//   PLAID_ENV               — 'sandbox' | 'development' | 'production'
//   PLAID_ENCRYPTION_KEY    — 32-byte hex string for AES-GCM access_token storage

const PLAID_URLS = {
  sandbox:     'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production:  'https://production.plaid.com',
};

const PLAID_API_VERSION = '2020-09-14';

function plaidUrl(env, path) {
  const base = PLAID_URLS[env.PLAID_ENV || 'sandbox'];
  return `${base}${path}`;
}

async function plaidFetch(env, path, body = {}) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    throw new Error('Plaid not configured — PLAID_CLIENT_ID and PLAID_SECRET secrets required');
  }
  const fullBody = {
    client_id: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    ...body,
  };
  const resp = await fetch(plaidUrl(env, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Plaid-Version': PLAID_API_VERSION,
    },
    body: JSON.stringify(fullBody),
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`Plaid ${path} ${resp.status}: ${(json.error_message || text).slice(0, 300)}`);
  }
  return json;
}

// ── Encryption helpers for access_token storage ─────────────────────────
async function getEncryptionKey(env) {
  if (!env.PLAID_ENCRYPTION_KEY) throw new Error('PLAID_ENCRYPTION_KEY not set');
  const hex = env.PLAID_ENCRYPTION_KEY;
  if (hex.length !== 64) throw new Error('PLAID_ENCRYPTION_KEY must be 64-char hex (32 bytes)');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptToken(env, accessToken) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(accessToken);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  const ivB64 = btoa(String.fromCharCode(...iv));
  return { encrypted: b64, iv: ivB64 };
}

async function decryptToken(env, encrypted, ivB64) {
  const key = await getEncryptionKey(env);
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// ── Public: create a Link token (browser embeds this) ────────────────────
export async function createLinkToken(env, opts = {}) {
  const userId = opts.user_id || 'pretzel-os-drew';
  const webhookUrl = opts.webhook_url || (env.PUBLIC_WORKER_URL || 'https://pretzel-os.drew-f39.workers.dev') + '/finance/plaid/webhook';
  return plaidFetch(env, '/link/token/create', {
    user: { client_user_id: userId },
    client_name: 'Pretzel OS',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
    webhook: webhookUrl,
  });
}

// ── Public: exchange public_token (from Plaid Link) for access_token ─────
export async function exchangePublicToken(env, publicToken) {
  const exchanged = await plaidFetch(env, '/item/public_token/exchange', { public_token: publicToken });
  const accessToken = exchanged.access_token;
  const itemId = exchanged.item_id;

  // Pull institution + account metadata
  const itemInfo = await plaidFetch(env, '/item/get', { access_token: accessToken });
  let institutionName = 'Unknown';
  if (itemInfo.item?.institution_id) {
    try {
      const inst = await plaidFetch(env, '/institutions/get_by_id', {
        institution_id: itemInfo.item.institution_id,
        country_codes: ['US'],
      });
      institutionName = inst.institution?.name || institutionName;
    } catch {}
  }
  const accounts = await plaidFetch(env, '/accounts/get', { access_token: accessToken });
  const accountIds = (accounts.accounts || []).map(a => a.account_id);

  // Encrypt + store
  const { encrypted, iv } = await encryptToken(env, accessToken);
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO plaid_items (id, plaid_item_id, institution_id, institution_name,
      account_ids, access_token_encrypted, encryption_iv, status, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'good', NULL)
  `).bind(
    id, itemId, itemInfo.item?.institution_id || null, institutionName,
    JSON.stringify(accountIds), encrypted, iv,
  ).run();

  // Seed chase_cc_accounts for each account on the Item
  for (const acct of (accounts.accounts || [])) {
    if (acct.type !== 'credit') continue;  // skip non-CC accounts for now
    const acctId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO chase_cc_accounts (id, plaid_account_id, plaid_item_id,
        account_name, account_type, account_mask, current_balance,
        available_credit, credit_limit, iso_currency, last_synced_at)
      VALUES (?, ?, ?, ?, 'credit_card', ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(plaid_account_id) DO UPDATE SET
        current_balance = excluded.current_balance,
        available_credit = excluded.available_credit,
        last_synced_at = excluded.last_synced_at
    `).bind(
      acctId, acct.account_id, itemId,
      `${institutionName} ${acct.name} ••${acct.mask}`,
      acct.mask, acct.balances?.current || 0,
      acct.balances?.available || 0, acct.balances?.limit || 0,
      acct.balances?.iso_currency_code || 'USD',
    ).run();
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'plaid_item_connected', 'plaid_items', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), id,
    `Connected ${institutionName} via Plaid (${accountIds.length} accounts)`,
    JSON.stringify({ institution_name: institutionName, account_count: accountIds.length }),
  ).run().catch(() => {});

  return {
    ok: true,
    item_id: itemId,
    institution_name: institutionName,
    account_count: accountIds.length,
  };
}

// ── Public: sync transactions for an item ────────────────────────────────
export async function syncItem(env, itemId) {
  const item = await env.DB.prepare(
    `SELECT * FROM plaid_items WHERE plaid_item_id = ? OR id = ?`
  ).bind(itemId, itemId).first();
  if (!item) return { error: 'item_not_found', item_id: itemId };

  const accessToken = await decryptToken(env, item.access_token_encrypted, item.encryption_iv);
  const stats = { added: 0, modified: 0, removed: 0, has_more: false };
  let cursor = item.cursor || '';

  // Paginate through /transactions/sync
  for (let page = 0; page < 10; page++) {  // safety: max 10 pages per run
    let resp;
    try {
      resp = await plaidFetch(env, '/transactions/sync', {
        access_token: accessToken,
        cursor: cursor || undefined,
        count: 500,
      });
    } catch (err) {
      // Item-level error (e.g., login required) — update status + return
      const errMsg = err.message || String(err);
      const isLoginRequired = /ITEM_LOGIN_REQUIRED|INVALID_CREDENTIALS|expired/i.test(errMsg);
      await env.DB.prepare(`
        UPDATE plaid_items SET status = ?, last_error = ?, consecutive_errors = consecutive_errors + 1
        WHERE id = ?
      `).bind(
        isLoginRequired ? 'login_required' : 'error',
        errMsg.slice(0, 500), item.id,
      ).run().catch(() => {});
      return { error: 'plaid_sync_failed', detail: errMsg, item_status: isLoginRequired ? 'login_required' : 'error' };
    }

    // Process added
    for (const txn of (resp.added || [])) {
      await upsertChaseTransaction(env, txn);
      stats.added += 1;
    }
    // Process modified (e.g., pending → posted)
    for (const txn of (resp.modified || [])) {
      await upsertChaseTransaction(env, txn);
      stats.modified += 1;
    }
    // Process removed
    for (const txn of (resp.removed || [])) {
      await env.DB.prepare(
        `DELETE FROM chase_cc_transactions WHERE plaid_transaction_id = ?`
      ).bind(txn.transaction_id).run().catch(() => {});
      stats.removed += 1;
    }

    cursor = resp.next_cursor;
    stats.has_more = !!resp.has_more;
    if (!resp.has_more) break;
  }

  // Update cursor + status + sync time
  await env.DB.prepare(`
    UPDATE plaid_items SET cursor = ?, status = 'good', consecutive_errors = 0,
      last_synced_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).bind(cursor, item.id).run();

  // Heartbeat for trust score
  try {
    const { heartbeat } = await import('./finance-health.js');
    await heartbeat(env, 'chase_sync_plaid', { status: 'green' });
  } catch {}

  return { ok: true, item_id: item.plaid_item_id, ...stats };
}

async function upsertChaseTransaction(env, plaidTxn) {
  // Resolve account
  const acct = await env.DB.prepare(
    `SELECT id FROM chase_cc_accounts WHERE plaid_account_id = ?`
  ).bind(plaidTxn.account_id).first();
  if (!acct) return;  // account not seeded — skip

  await env.DB.prepare(`
    INSERT INTO chase_cc_transactions (id, account_id, plaid_transaction_id,
      txn_date, posted_date, amount, merchant, description, plaid_category,
      pending, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plaid_transaction_id) DO UPDATE SET
      txn_date = excluded.txn_date,
      posted_date = excluded.posted_date,
      amount = excluded.amount,
      merchant = excluded.merchant,
      description = excluded.description,
      pending = excluded.pending,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(), acct.id, plaidTxn.transaction_id,
    plaidTxn.date, plaidTxn.authorized_date || plaidTxn.date,
    plaidTxn.amount,
    plaidTxn.merchant_name || plaidTxn.name,
    plaidTxn.name || '',
    (plaidTxn.personal_finance_category?.primary || (plaidTxn.category || []).join(' / ') || ''),
    plaidTxn.pending ? 1 : 0,
    JSON.stringify(plaidTxn),
  ).run();
}

// ── Public: sync all active items ─────────────────────────────────────────
export async function syncAllItems(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, plaid_item_id, institution_name, status FROM plaid_items
    WHERE status IN ('good', 'login_required')
  `).all();
  const out = [];
  for (const item of (results || [])) {
    if (item.status === 'login_required') {
      out.push({ item_id: item.plaid_item_id, skipped: 'login_required' });
      continue;
    }
    const r = await syncItem(env, item.id);
    out.push({ institution: item.institution_name, ...r });
  }
  return { ok: true, items_processed: out.length, results: out };
}

// ── Public: webhook handler ───────────────────────────────────────────────
export async function handleWebhook(env, payload) {
  // Log webhook
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO plaid_webhooks (id, plaid_item_id, webhook_type, webhook_code, payload)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    id, payload.item_id || null, payload.webhook_type, payload.webhook_code,
    JSON.stringify(payload),
  ).run().catch(() => {});

  // Trigger sync on the right codes
  if (payload.webhook_type === 'TRANSACTIONS' &&
      ['SYNC_UPDATES_AVAILABLE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE'].includes(payload.webhook_code)) {
    const result = await syncItem(env, payload.item_id).catch(err => ({ error: err.message }));
    await env.DB.prepare(
      `UPDATE plaid_webhooks SET processed_at = datetime('now'), process_outcome = ? WHERE id = ?`
    ).bind(JSON.stringify(result).slice(0, 500), id).run().catch(() => {});
    return { ok: true, sync_result: result };
  }

  // Item-level events
  if (payload.webhook_type === 'ITEM' && payload.webhook_code === 'ERROR') {
    await env.DB.prepare(`
      UPDATE plaid_items SET status = ?, last_error = ?
      WHERE plaid_item_id = ?
    `).bind(
      payload.error?.error_code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error',
      JSON.stringify(payload.error).slice(0, 500),
      payload.item_id,
    ).run().catch(() => {});
  }

  await env.DB.prepare(
    `UPDATE plaid_webhooks SET processed_at = datetime('now'), process_outcome = 'logged_only' WHERE id = ?`
  ).bind(id).run().catch(() => {});

  return { ok: true, logged: true };
}

// ── Public: get connection state for dashboard ────────────────────────────
export async function getPlaidStatus(env) {
  const { results: items } = await env.DB.prepare(`
    SELECT id, plaid_item_id, institution_name, status, last_synced_at, last_error,
           (julianday('now') - julianday(last_synced_at)) * 24 as hours_since_sync
    FROM plaid_items ORDER BY created_at DESC
  `).all();
  const { results: accounts } = await env.DB.prepare(`
    SELECT id, plaid_account_id, account_name, current_balance, available_credit,
           credit_limit, last_synced_at
    FROM chase_cc_accounts WHERE is_active = 1
    ORDER BY account_name
  `).all();
  return {
    plaid_configured: !!env.PLAID_CLIENT_ID && !!env.PLAID_SECRET,
    plaid_env: env.PLAID_ENV || 'not_set',
    items: items || [],
    accounts: accounts || [],
  };
}

// ── Public: disconnect an item ────────────────────────────────────────────
export async function disconnectItem(env, itemId) {
  const item = await env.DB.prepare(
    `SELECT id, access_token_encrypted, encryption_iv FROM plaid_items WHERE plaid_item_id = ? OR id = ?`
  ).bind(itemId, itemId).first();
  if (!item) return { error: 'item_not_found' };
  try {
    const accessToken = await decryptToken(env, item.access_token_encrypted, item.encryption_iv);
    await plaidFetch(env, '/item/remove', { access_token: accessToken });
  } catch (err) {
    // Continue with local cleanup even if Plaid API call fails
  }
  await env.DB.prepare(`UPDATE plaid_items SET status = 'pending_disconnect' WHERE id = ?`).bind(item.id).run();
  return { ok: true, status: 'pending_disconnect' };
}
