// square-customer-sync.js
// Pulls Square's full customer database into D1's `square_customers` table.
// Powers email reach expansion (Cohorts A/B/C — see plan).
//
// - Initial backfill: ~7,708 customers, ~80 pages, ~30s per page = ~30s total (cursor-paginated, 100 per page).
// - Incremental sync: updated_filter on MetaData.LastUpdatedTime keeps API cost down to a few hundred rows per cycle.
//
// Triggered:
//   - Cron `0 */6 * * *` every 6 hours via router.js
//   - Manual `POST /retail/square-customers/sync` (full-rebuild query param: ?mode=full)

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

async function squareCustomersSearch(env, body) {
  const resp = await fetch(`${SQUARE_API_BASE}/customers/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-10-17',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Square /customers/search ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return resp.json();
}

// Map Square customer JSON → D1 row. Defensive against missing fields.
function customerRow(c) {
  return {
    square_customer_id: c.id,
    email: c.email_address || null,
    phone: c.phone_number || null,
    given_name: c.given_name || null,
    family_name: c.family_name || null,
    creation_source: c.creation_source || null,
    email_unsubscribed: c.preferences?.email_unsubscribed ? 1 : 0,
    created_at: c.created_at || null,
    updated_at: c.updated_at || null,
  };
}

// Upsert a single customer. Preserves bounce/unsub flags we set locally —
// Square's email_unsubscribed only flips ON if Square sees it; we layer our own
// unsubscribe state on top via the OR.
async function upsertCustomer(env, c) {
  const row = customerRow(c);
  await env.DB.prepare(`
    INSERT INTO square_customers (
      square_customer_id, email, phone, given_name, family_name,
      creation_source, email_unsubscribed, created_at, updated_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(square_customer_id) DO UPDATE SET
      email           = excluded.email,
      phone           = excluded.phone,
      given_name      = excluded.given_name,
      family_name     = excluded.family_name,
      creation_source = excluded.creation_source,
      -- Preserve our local unsubscribe state if it's already 1 (don't reset to 0 just because Square hasn't seen it)
      email_unsubscribed = CASE WHEN square_customers.email_unsubscribed = 1 THEN 1 ELSE excluded.email_unsubscribed END,
      updated_at      = excluded.updated_at,
      synced_at       = datetime('now')
  `).bind(
    row.square_customer_id, row.email, row.phone, row.given_name, row.family_name,
    row.creation_source, row.email_unsubscribed, row.created_at, row.updated_at,
  ).run();
}

// After all customers are upserted, refresh the denormalized order count + last_order_date
// from the `orders` table. Used for Cohort B segmentation. One pass, indexed lookup.
async function refreshOrderStats(env) {
  // Pre-aggregate orders into a {sqc → count, max_date} map first, then do a single
  // UPDATE per matching customer. Avoids a correlated subquery over 7,639 customers
  // × 160 orders that times out D1 at ~30s.
  //
  // Two ID systems coexist in `orders`:
  //   - `customer_id` column = our `rc_*` internal customer key (links to retail_customers)
  //   - `raw_payload.$.customer_id` = Square's customer ID (links to square_customers)
  // We need the SECOND for this denormalization.
  const stats = await env.DB.prepare(`
    SELECT json_extract(raw_payload, '$.customer_id') as sqc,
           COUNT(*) as cnt,
           MAX(order_date) as last_date
    FROM orders
    WHERE source IN ('square','square_delivery')
      AND json_extract(raw_payload, '$.customer_id') IS NOT NULL
    GROUP BY sqc
  `).all();

  // Reset all counters first so customers who used to have orders but were removed
  // get zeroed out (D1 doesn't have left-join-update; this is the simplest correct path).
  await env.DB.prepare(
    `UPDATE square_customers SET square_order_count = 0, last_square_order_date = NULL`
  ).run();

  let updated = 0;
  for (const row of (stats.results || [])) {
    if (!row.sqc) continue;
    await env.DB.prepare(
      `UPDATE square_customers SET square_order_count = ?, last_square_order_date = ? WHERE square_customer_id = ?`
    ).bind(row.cnt, row.last_date, row.sqc).run();
    updated++;
  }
  return { aggregated_keys: (stats.results || []).length, updated };
}

// Loyalty enrollment sync — cheap (~tens of rows). Runs alongside customer sync.
async function syncLoyaltyAccounts(env) {
  let cursor = null;
  let total = 0;
  while (true) {
    const body = { limit: 200 };
    if (cursor) body.cursor = cursor;
    const resp = await fetch(`${SQUARE_API_BASE}/loyalty/accounts/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-10-17',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      // Loyalty may not be enabled — log and continue. Cohort C exclusion just won't
      // filter anyone out, which is safe (means everyone gets the welcome email even
      // if they happen to be loyalty members; minor over-sending, no compliance issue).
      console.warn(`[loyalty-sync] /loyalty/accounts/search returned ${resp.status} — skipping`);
      return { synced: 0, skipped_reason: `${resp.status}` };
    }
    const data = await resp.json();
    const accounts = data.loyalty_accounts || [];
    for (const a of accounts) {
      await env.DB.prepare(`
        INSERT INTO loyalty_accounts (loyalty_account_id, square_customer_id, program_id, balance, enrolled_at, synced_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(loyalty_account_id) DO UPDATE SET
          balance = excluded.balance,
          synced_at = datetime('now')
      `).bind(a.id, a.customer_id || null, a.program_id || null, a.balance || 0, a.created_at || null).run();
      total++;
    }
    cursor = data.cursor || null;
    if (!cursor) break;
  }
  return { synced: total };
}

// Main sync entrypoint. Mode 'full' pulls everything, 'incremental' only customers
// updated in the last 6 hours (matching cron cadence + 1h slop for clock skew).
export async function syncSquareCustomers(env, mode = 'full') {
  let cursor = null, totalUpserted = 0, totalSeen = 0, pages = 0;
  const tStart = Date.now();
  const filter = mode === 'incremental' ? {
    query: {
      filter: {
        updated_at: {
          start_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString(),  // 7h window for slop
        },
      },
    },
  } : {};

  while (true) {
    const body = { limit: 100, ...filter };
    if (cursor) body.cursor = cursor;
    const data = await squareCustomersSearch(env, body);
    const customers = data.customers || [];
    for (const c of customers) {
      await upsertCustomer(env, c);
      totalUpserted++;
    }
    totalSeen += customers.length;
    cursor = data.cursor || null;
    pages++;
    if (!cursor) break;
  }

  await refreshOrderStats(env);
  const loyaltyResult = await syncLoyaltyAccounts(env);

  return {
    mode,
    pages,
    seen: totalSeen,
    upserted: totalUpserted,
    loyalty: loyaltyResult,
    duration_ms: Date.now() - tStart,
  };
}

// Default export — used as a worker module from router.js cron + endpoint dispatch.
export default {
  async scheduled(event, env, ctx) {
    // Cron-triggered = incremental (every 6h via 0 */6 * * *)
    return syncSquareCustomers(env, 'incremental');
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/retail/square-customers/sync' && request.method === 'POST') {
      const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'incremental';
      const result = await syncSquareCustomers(env, mode);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Denorm-only endpoint — runs the order-count rollup without re-pulling from Square.
    // Useful after fixing a denorm bug or after a manual customer_id correction.
    if (url.pathname === '/retail/square-customers/denorm' && request.method === 'POST') {
      const result = await refreshOrderStats(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  },
};
