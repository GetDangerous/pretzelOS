/**
 * Dangerous Pretzel Co — QBO Direct API Client
 * No Make, no middleware. Direct to Intuit REST API.
 *
 * Env vars required:
 *   QBO_CLIENT_ID       — from Intuit Developer portal
 *   QBO_CLIENT_SECRET   — from Intuit Developer portal
 *   QBO_REFRESH_TOKEN   — from OAuth flow
 *   QBO_REALM_ID        — your QBO company ID
 *   KV                  — Cloudflare KV for token caching
 *
 * Token lifecycle:
 *   - Access tokens expire in 1 hour — we cache in KV and auto-refresh
 *   - Refresh tokens expire in 101 days — wrangler secret put QBO_REFRESH_TOKEN
 */

const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_BASE_URL  = 'https://quickbooks.api.intuit.com/v3/company';
const QBO_TOKEN_KV_KEY = 'qbo_access_token';

// ── TOKEN MANAGEMENT ──────────────────────────────────────────────────────────
export async function getQBOToken(env) {
  // Check KV cache first
  try {
    const cached = await env.KV.get(QBO_TOKEN_KV_KEY);
    if (cached) {
      const { token, expires_at } = JSON.parse(cached);
      if (Date.now() < expires_at - 300000) {
        return token;
      }
    }
  } catch {}

  // KV refresh token takes precedence over wrangler secret (OAuth flow stores here)
  const kvRefreshToken = await env.KV.get('qbo_refresh_token');
  const refreshToken = kvRefreshToken || env.QBO_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error('No QBO refresh token found. Visit /qbo/oauth to connect.');
  }

  // Refresh the token
  const response = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`)}`,
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`QBO token refresh failed ${response.status}: ${err}`);
  }

  const data = await response.json();
  const token = data.access_token;
  const expiresIn = (data.expires_in || 3600) * 1000;

  await env.KV.put(
    QBO_TOKEN_KV_KEY,
    JSON.stringify({ token, expires_at: Date.now() + expiresIn }),
    { expirationTtl: Math.floor(expiresIn / 1000) - 300 }
  );

  // Auto-rotate: if QBO issued a new refresh token, store it in KV
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await env.KV.put('qbo_refresh_token', data.refresh_token);
    console.log('[QBO] Refresh token rotated and stored in KV');
  }

  return token;
}

// ── CORE QUERY ────────────────────────────────────────────────────────────────
async function qboQuery(env, endpoint, params = {}) {
  const token   = await getQBOToken(env);
  const kvRealmId = await env.KV.get('qbo_realm_id');
  const realmId = kvRealmId || env.QBO_REALM_ID;

  const queryString = Object.entries({ ...params, minorversion: 65 })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `${QBO_BASE_URL}/${realmId}/${endpoint}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`QBO API error ${response.status} (${endpoint}): ${err}`);
  }

  return response.json();
}

// ── SQL-STYLE QUERY (for Invoice, Estimate, Customer queries) ─────────────────
async function qboSqlQuery(env, sql) {
  const token   = await getQBOToken(env);
  const kvRealmId = await env.KV.get('qbo_realm_id');
  const realmId = kvRealmId || env.QBO_REALM_ID;
  const url = `${QBO_BASE_URL}/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=65`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`QBO query error ${response.status}: ${err}`);
  }

  return response.json();
}

// ── REPORT HELPERS ────────────────────────────────────────────────────────────
export async function getProfitAndLoss(env, startDate, endDate) {
  try {
    return await qboQuery(env, 'reports/ProfitAndLoss', {
      start_date: startDate,
      end_date: endDate,
      summarize_column_by: 'Week',
    });
  } catch (err) {
    return { error: err.message, report: 'ProfitAndLoss' };
  }
}

export async function getCashFlow(env, startDate, endDate) {
  try {
    return await qboQuery(env, 'reports/CashFlow', {
      start_date: startDate,
      end_date: endDate,
    });
  } catch (err) {
    return { error: err.message, report: 'CashFlow' };
  }
}

export async function getARaging(env, asOfDate) {
  try {
    return await qboQuery(env, 'reports/AgedReceivables', {
      report_date: asOfDate || new Date().toISOString().split('T')[0],
    });
  } catch (err) {
    return { error: err.message, report: 'AgedReceivables' };
  }
}

export async function getExpenses(env, startDate, endDate) {
  try {
    return await qboQuery(env, 'reports/ProfitAndLoss', {
      start_date: startDate,
      end_date: endDate,
      summarize_column_by: 'Week',
    });
  } catch (err) {
    return { error: err.message, report: 'Expenses' };
  }
}

export async function getBalanceSheet(env, asOfDate) {
  try {
    return await qboQuery(env, 'reports/BalanceSheet', {
      report_date: asOfDate || new Date().toISOString().split('T')[0],
    });
  } catch (err) {
    return { error: err.message, report: 'BalanceSheet' };
  }
}

export async function getTransactions(env, startDate, endDate, accountType) {
  try {
    return await qboQuery(env, 'reports/TransactionList', {
      start_date: startDate,
      end_date: endDate,
      account_type: accountType || '',
    });
  } catch (err) {
    return { error: err.message, report: 'TransactionList' };
  }
}

// ── NEW: ESTIMATE + INVOICE + CUSTOMER QUERIES ────────────────────────────────

export async function getEstimates(env, status, maxResults = 20) {
  try {
    // TxnStatus not queryable in QBO SQL — fetch all, filter client-side
    const sql = `SELECT * FROM Estimate ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS ${maxResults}`;
    const data = await qboSqlQuery(env, sql);
    let estimates = data?.QueryResponse?.Estimate || [];

    // Client-side status filter
    if (status) {
      const s = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
      estimates = estimates.filter(e => e.TxnStatus === s);
    }

    return estimates.map(e => ({
      id: e.Id,
      doc_number: e.DocNumber,
      date: e.TxnDate,
      status: e.TxnStatus,
      customer: e.CustomerRef?.name,
      customer_id: e.CustomerRef?.value,
      total: e.TotalAmt,
      line_count: e.Line?.filter(l => l.DetailType === 'SalesItemLineDetail').length || 0,
      linked_invoice: e.LinkedTxn?.find(t => t.TxnType === 'Invoice')?.TxnId || null,
      items: (e.Line || [])
        .filter(l => l.DetailType === 'SalesItemLineDetail')
        .map(l => ({
          description: l.Description,
          amount: l.Amount,
          qty: l.SalesItemLineDetail?.Qty,
          unit_price: l.SalesItemLineDetail?.UnitPrice,
          item: l.SalesItemLineDetail?.ItemRef?.name,
        })),
    }));
  } catch (err) {
    return { error: err.message };
  }
}

export async function getInvoices(env, { unpaidOnly, recentDays, maxResults = 20 } = {}) {
  try {
    let sql = `SELECT * FROM Invoice`;
    const conditions = [];
    if (unpaidOnly) conditions.push(`Balance > '0'`);
    if (recentDays) {
      const since = new Date(Date.now() - recentDays * 86400000).toISOString().split('T')[0];
      conditions.push(`MetaData.LastUpdatedTime > '${since}'`);
    }
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS ${maxResults}`;

    const data = await qboSqlQuery(env, sql);
    const invoices = data?.QueryResponse?.Invoice || [];

    return invoices.map(inv => ({
      id: inv.Id,
      doc_number: inv.DocNumber,
      date: inv.TxnDate,
      due_date: inv.DueDate,
      customer: inv.CustomerRef?.name,
      customer_id: inv.CustomerRef?.value,
      total: inv.TotalAmt,
      balance: inv.Balance,
      paid: inv.Balance === 0,
      terms: inv.SalesTermRef?.name,
      email: inv.BillEmail?.Address,
      payment_method: inv.PaymentMethodRef?.name || null,
      allows_cc: inv.AllowOnlineCreditCardPayment || false,
      allows_ach: inv.AllowOnlineACHPayment || false,
      days_outstanding: inv.DueDate
        ? Math.max(0, Math.floor((Date.now() - new Date(inv.DueDate)) / 86400000))
        : null,
      linked_estimates: (inv.LinkedTxn || [])
        .filter(t => t.TxnType === 'Estimate')
        .map(t => t.TxnId),
      line_items: (inv.Line || [])
        .filter(l => l.DetailType === 'SalesItemLineDetail')
        .map(l => ({
          description: l.Description,
          amount: l.Amount,
          qty: l.SalesItemLineDetail?.Qty,
          unit_price: l.SalesItemLineDetail?.UnitPrice,
          item: l.SalesItemLineDetail?.ItemRef?.name,
        })),
    }));
  } catch (err) {
    return { error: err.message };
  }
}

export async function getCustomerBalances(env) {
  try {
    const data = await qboSqlQuery(env,
      `SELECT * FROM Customer WHERE Balance > '0' ORDERBY Balance DESC MAXRESULTS 50`
    );
    const customers = data?.QueryResponse?.Customer || [];

    return customers.map(c => ({
      id: c.Id,
      name: c.DisplayName,
      company: c.CompanyName,
      balance: c.Balance,
      email: c.PrimaryEmailAddr?.Address,
      phone: c.PrimaryPhone?.FreeFormNumber,
      payment_method: c.PaymentMethodRef?.name || null,
    }));
  } catch (err) {
    return { error: err.message };
  }
}

// ── QBO → D1 SYNC (wholesale invoices + account health) ─────────────────────
// Pulls invoices from QBO and writes them to D1 orders table as wholesale revenue.
// Also updates active_accounts with last order date, lifetime rev, monthly rev.
// Run daily after Toast sync to keep D1 as the single source of truth.

export async function syncQBOInvoicesToD1(env) {
  console.log('[QBO] Syncing invoices to D1...');

  // Pull all invoices from last 120 days
  const sql = `SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime > '${
    new Date(Date.now() - 120 * 86400000).toISOString().split('T')[0]
  }' ORDERBY TxnDate DESC MAXRESULTS 500`;

  const data = await qboSqlQuery(env, sql);
  const invoices = data?.QueryResponse?.Invoice || [];
  console.log(`[QBO] Found ${invoices.length} invoices in last 120 days`);

  let inserted = 0, updated = 0, skipped = 0;

  for (const inv of invoices) {
    const orderId = `qbo_inv_${inv.Id}`;
    const customerName = inv.CustomerRef?.name || 'Unknown';
    const amount = parseFloat(inv.TotalAmt) || 0;
    const date = inv.TxnDate || new Date().toISOString().split('T')[0];
    const status = inv.Balance === 0 ? 'paid' : (inv.DueDate && new Date(inv.DueDate) < new Date() ? 'overdue' : 'open');

    // Upsert into orders table
    try {
      const existing = await env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(orderId).first();

      if (existing) {
        // Update status/amount in case it changed
        await env.DB.prepare(`
          UPDATE orders SET gross_revenue = ?, net_revenue = ?, raw_payload = ?
          WHERE id = ?
        `).bind(amount, amount, JSON.stringify({ status, doc_number: inv.DocNumber, balance: inv.Balance, due_date: inv.DueDate }), orderId).run();
        updated++;
      } else {
        // Find matching account
        const account = await fuzzyMatchAccount(customerName, env);

        await env.DB.prepare(`
          INSERT INTO orders (id, account_id, venue_id, source, order_date, gross_revenue, net_revenue, customer_name, raw_payload, created_at)
          VALUES (?, ?, ?, 'qbo_wholesale', ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          orderId,
          account?.accountId || null,
          account?.venueId || null,
          date,
          amount,
          amount,
          customerName,
          JSON.stringify({ invoice_id: inv.Id, doc_number: inv.DocNumber, status, balance: inv.Balance, due_date: inv.DueDate, line_items: (inv.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail').length })
        ).run();
        inserted++;
      }
    } catch (err) {
      console.error(`[QBO] Invoice sync error for ${customerName}:`, err.message);
      skipped++;
    }
  }

  // Now update active_accounts from the synced data
  console.log('[QBO] Updating account health from invoices...');
  const accounts = await env.DB.prepare('SELECT id, venue_id FROM active_accounts').all();

  for (const acct of (accounts.results || [])) {
    try {
      const stats = await env.DB.prepare(`
        SELECT
          MAX(order_date) as last_order,
          SUM(gross_revenue) as lifetime_rev,
          COUNT(*) as order_count
        FROM orders
        WHERE account_id = ?
      `).bind(acct.id).first();

      if (stats?.last_order) {
        const monthsActive = Math.max(1, Math.ceil(
          (Date.now() - new Date(stats.last_order).getTime()) / (30 * 86400000) + 1
        ));
        const avgMonthly = (stats.lifetime_rev || 0) / Math.min(monthsActive, 3); // Use last ~3 months

        const daysSinceOrder = Math.floor((Date.now() - new Date(stats.last_order).getTime()) / 86400000);
        const health = daysSinceOrder > 35 ? 'red' : daysSinceOrder > 21 ? 'yellow' : 'green';

        await env.DB.prepare(`
          UPDATE active_accounts
          SET last_order_date = ?,
              total_rev_lifetime = ?,
              avg_monthly_rev = ?,
              health_status = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(stats.last_order, stats.lifetime_rev || 0, Math.round(avgMonthly * 100) / 100, health, acct.id).run();
      }
    } catch {}
  }

  console.log(`[QBO] Invoice sync complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped`);
  return { inserted, updated, skipped, total_invoices: invoices.length };
}

// Fuzzy match QBO customer name to D1 venue/account
async function fuzzyMatchAccount(customerName, env) {
  if (!customerName) return null;
  const normalize = str => str.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const nameWords = normalize(customerName);

  const venues = await env.DB.prepare(`
    SELECT v.id as venue_id, aa.id as account_id, v.name
    FROM venues v
    LEFT JOIN active_accounts aa ON aa.venue_id = v.id
    WHERE v.status = 'active' OR aa.id IS NOT NULL
  `).all();

  let bestMatch = null;
  let bestScore = 0;

  for (const venue of (venues.results || [])) {
    const venueWords = normalize(venue.name);
    const overlap = nameWords.filter(w => venueWords.includes(w)).length;
    const score = overlap / Math.max(nameWords.length, venueWords.length);
    if (score > bestScore && score >= 0.3) {
      bestScore = score;
      bestMatch = venue;
    }
  }

  return bestMatch ? { venueId: bestMatch.venue_id, accountId: bestMatch.account_id } : null;
}

// ── PARSED HELPERS ────────────────────────────────────────────────────────────
export function extractPLNumbers(pnlReport) {
  const result = {
    total_revenue: 0,
    total_cogs: 0,
    gross_profit: 0,
    total_expenses: 0,
    net_income: 0,
    revenue_by_category: {},
    expense_by_category: {},
    raw: pnlReport,
  };

  if (pnlReport?.error || !pnlReport?.Rows) return result;

  function extractRow(row) {
    if (!row) return;
    if (row.type === 'Section' && row.Rows) {
      row.Rows.Row?.forEach(extractRow);
    }
    if (row.type === 'DataRow' && row.ColData) {
      const label = row.ColData[0]?.value || '';
      const amount = parseFloat(row.ColData[1]?.value || '0');
      if (!isNaN(amount)) {
        const l = label.toLowerCase();
        if (l.includes('income') || l.includes('sales') || l.includes('revenue')) {
          result.total_revenue += amount;
          result.revenue_by_category[label] = amount;
        } else if (l.includes('cost of') || l.includes('cogs')) {
          result.total_cogs += amount;
        } else if (l.includes('gross profit')) {
          result.gross_profit = amount;
        } else if (l.includes('net income') || l.includes('net profit')) {
          result.net_income = amount;
        } else {
          result.expense_by_category[label] = amount;
          result.total_expenses += amount;
        }
      }
    }
    if (row.Summary?.ColData) {
      const label = row.Summary.ColData[0]?.value || '';
      const amount = parseFloat(row.Summary.ColData[1]?.value || '0');
      if (label.toLowerCase().includes('gross profit')) result.gross_profit = amount;
      if (label.toLowerCase().includes('net income')) result.net_income = amount;
    }
  }

  pnlReport.Rows?.Row?.forEach(extractRow);

  if (result.gross_profit === 0 && result.total_revenue > 0) {
    result.gross_profit = result.total_revenue - result.total_cogs;
  }

  return result;
}

export function extractCashPosition(balanceSheetOrCashFlow) {
  let cash = 0;
  function scan(row) {
    if (!row) return;
    if (row.ColData) {
      const label = (row.ColData[0]?.value || '').toLowerCase();
      const amount = parseFloat(row.ColData[1]?.value || '0');
      if ((label.includes('cash') || label.includes('checking') || label.includes('bank'))
          && !isNaN(amount)) {
        cash += Math.abs(amount);
      }
    }
    if (row.Rows?.Row) row.Rows.Row.forEach(scan);
  }
  if (balanceSheetOrCashFlow?.Rows?.Row) {
    balanceSheetOrCashFlow.Rows.Row.forEach(scan);
  }
  return cash;
}

export function extractAROverdue(arAgingReport) {
  const overdue = [];
  if (!arAgingReport?.Rows?.Row) return overdue;

  arAgingReport.Rows.Row.forEach(row => {
    if (row.type !== 'DataRow' && !row.ColData) return;
    if (!row.ColData) return;
    const name = row.ColData[0]?.value || '';
    const current = parseFloat(row.ColData[1]?.value || '0');
    const days1_30 = parseFloat(row.ColData[2]?.value || '0');
    const days31_60 = parseFloat(row.ColData[3]?.value || '0');
    const days61_90 = parseFloat(row.ColData[4]?.value || '0');
    const days91plus = parseFloat(row.ColData[5]?.value || '0');
    const total = parseFloat(row.ColData[6]?.value || '0');
    const totalOverdue = days31_60 + days61_90 + days91plus;

    if (total > 0) {
      overdue.push({
        name,
        current,
        days1_30,
        days31_60,
        days61_90,
        days91plus,
        total,
        total_overdue: totalOverdue,
        most_overdue_bucket: days91plus > 0 ? '91+' : days61_90 > 0 ? '61-90' : days31_60 > 0 ? '31-60' : 'current',
      });
    }
  });

  return overdue.sort((a, b) => b.total_overdue - a.total_overdue);
}

// ── OAUTH FLOW (one-time setup + token refresh) ──────────────────────────────
// Step 1: Visit /qbo/oauth → redirects to Intuit authorization
// Step 2: Intuit redirects back to /qbo/oauth/callback with auth code
// Step 3: We exchange code for tokens, store refresh token in KV
//
// After initial setup, the refresh token auto-rotates on each use.
// If it ever expires (101 days), just visit /qbo/oauth again.

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_SCOPES = 'com.intuit.quickbooks.accounting';

function getRedirectUri(request) {
  const url = new URL(request.url);
  return `${url.origin}/qbo/oauth/callback`;
}

async function handleOAuthStart(request, env) {
  const redirectUri = getRedirectUri(request);
  const state = crypto.randomUUID();

  // Store state in KV for CSRF validation (5 min TTL)
  await env.KV.put('qbo_oauth_state', state, { expirationTtl: 300 });

  const authUrl = new URL(QBO_AUTH_URL);
  authUrl.searchParams.set('client_id', env.QBO_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', QBO_SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const realmId = url.searchParams.get('realmId');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code || !state) {
    return new Response('Missing code or state parameter', { status: 400 });
  }

  // Validate CSRF state
  const savedState = await env.KV.get('qbo_oauth_state');
  if (state !== savedState) {
    return new Response('Invalid state — possible CSRF. Try /qbo/oauth again.', { status: 403 });
  }
  await env.KV.delete('qbo_oauth_state');

  // Exchange auth code for tokens
  const redirectUri = getRedirectUri(request);
  const tokenResp = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`)}`,
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    return new Response(`Token exchange failed: ${err}`, { status: 500 });
  }

  const data = await tokenResp.json();

  // Cache the access token
  const expiresIn = (data.expires_in || 3600) * 1000;
  await env.KV.put(
    QBO_TOKEN_KV_KEY,
    JSON.stringify({ token: data.access_token, expires_at: Date.now() + expiresIn }),
    { expirationTtl: Math.floor(expiresIn / 1000) - 300 }
  );

  // Store the refresh token in KV (primary source going forward)
  // This replaces the wrangler secret — KV token takes precedence
  await env.KV.put('qbo_refresh_token', data.refresh_token);

  // Store realm ID if returned
  if (realmId) {
    await env.KV.put('qbo_realm_id', realmId);
  }

  const html = `<!DOCTYPE html>
<html><head><title>QBO Connected</title></head>
<body style="font-family:system-ui;max-width:600px;margin:80px auto;text-align:center">
  <h1>✅ QuickBooks Connected</h1>
  <p>Refresh token stored in KV. Access token cached.</p>
  <p><strong>Realm ID:</strong> ${realmId || env.QBO_REALM_ID}</p>
  <p>The CFO agent can now pull financial data.</p>
  <p style="margin-top:40px"><a href="/qbo/test">→ Run connection test</a></p>
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

// ── WORKER ENDPOINT (test + debug + oauth) ───────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // OAuth flow
    if (url.pathname === '/qbo/oauth' && !url.pathname.includes('callback')) {
      return handleOAuthStart(request, env);
    }
    if (url.pathname === '/qbo/oauth/callback') {
      return handleOAuthCallback(request, env);
    }

    if (url.pathname === '/qbo/test') {
      try {
        const token = await getQBOToken(env);
        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
        const pnl = await getProfitAndLoss(env, weekAgo, today);
        const numbers = extractPLNumbers(pnl);
        return new Response(JSON.stringify({
          status: 'connected',
          realm_id: env.QBO_REALM_ID,
          token_preview: token.slice(0, 20) + '...',
          last_week_revenue: numbers.total_revenue,
          last_week_cogs: numbers.total_cogs,
          last_week_net: numbers.net_income,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/qbo/pnl') {
      const params = Object.fromEntries(url.searchParams);
      const today = new Date().toISOString().split('T')[0];
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      try {
        const pnl = await getProfitAndLoss(env, params.start || weekAgo, params.end || today);
        return new Response(JSON.stringify(extractPLNumbers(pnl), null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    if (url.pathname === '/qbo/ar') {
      try {
        const ar = await getARaging(env, null);
        return new Response(JSON.stringify(extractAROverdue(ar), null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    if (url.pathname === '/qbo/estimates') {
      try {
        const status = url.searchParams.get('status') || null;
        const estimates = await getEstimates(env, status);
        return new Response(JSON.stringify(estimates, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    if (url.pathname === '/qbo/invoices') {
      try {
        const unpaid = url.searchParams.get('unpaid') === '1';
        const days = parseInt(url.searchParams.get('days') || '30');
        const invoices = await getInvoices(env, { unpaidOnly: unpaid, recentDays: days });
        return new Response(JSON.stringify(invoices, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    if (url.pathname === '/qbo/balances') {
      try {
        const balances = await getCustomerBalances(env);
        return new Response(JSON.stringify(balances, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // QBO → D1 invoice sync (manual trigger or daily cron)
    if (url.pathname === '/qbo/sync') {
      try {
        const result = await syncQBOInvoicesToD1(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    return new Response('QBO Client — Pretzel OS', { status: 200 });
  }
};
