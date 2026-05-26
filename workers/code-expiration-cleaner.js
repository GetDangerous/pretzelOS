// code-expiration-cleaner.js
// Daily cleaner cron — runs 11:30pm MT (`30 5 * * *` UTC).
//
// Job description (post-May-11 loyalty migration, post-C.3 fix):
// 1. PRIMARY: for `retail_campaign_sends` rows with expires_at past AND no return:
//    a. If `loyalty_reward_id IS NOT NULL`: DELETE the Square Loyalty reward via API.
//       This refunds points to the customer's loyalty account but removes THIS specific
//       reward — so they can't apply it at checkout after the expiration date.
//    b. Mark the row `outcome='expired'` in our DB.
// 2. SECONDARY (legacy): for any pre-May-11 `retail_campaign_discounts` rows
//    with `valid_until < today` AND `status='active'` AND `square_catalog_id`:
//    DELETE the Square catalog object + mark row as 'expired'. Cleans up
//    orphan Catalog DISCOUNTs that no longer apply.
//
// IMPORTANT: Square Loyalty rewards do NOT have a server-side `expires_at` field. This
// cron is the ONLY thing that prevents stranded rewards from being redeemed forever.
//
// Tracked in `cron_runs` via the router's `trackedRun` wrapper.

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

async function deleteSquareReward(env, rewardId) {
  // Returns { ok: bool, status, body?: string }
  try {
    const resp = await fetch(`${SQUARE_API_BASE}/loyalty/rewards/${rewardId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
      },
    });
    if (resp.ok || resp.status === 404) return { ok: true, status: resp.status };
    const body = await resp.text().catch(() => '');
    return { ok: false, status: resp.status, body: body.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, body: err.message };
  }
}

export default {
  async scheduled(event, env, ctx) {
    const t0 = Date.now();
    const stats = {
      sends_expired_with_loyalty: 0,
      sends_expired_without_loyalty: 0,
      loyalty_rewards_deleted: 0,
      loyalty_delete_failures: 0,
      catalog_objects_deleted: 0,
      catalog_delete_failures: 0,
      errors: [],
    };

    // ── PRIMARY A: expire rows WITH loyalty_reward_id → DELETE the Square reward first ──
    try {
      const expiringLoyalty = await env.DB.prepare(`
        SELECT id, loyalty_reward_id FROM retail_campaign_sends
        WHERE expires_at IS NOT NULL
          AND expires_at < date('now')
          AND returned_at IS NULL
          AND outcome IN ('sent', 'delivered', 'pending')
          AND loyalty_reward_id IS NOT NULL
        LIMIT 200
      `).all();
      for (const row of (expiringLoyalty.results || [])) {
        const result = await deleteSquareReward(env, row.loyalty_reward_id);
        if (result.ok) {
          await env.DB.prepare("UPDATE retail_campaign_sends SET outcome='expired' WHERE id=?")
            .bind(row.id).run();
          stats.loyalty_rewards_deleted++;
          stats.sends_expired_with_loyalty++;
        } else {
          stats.loyalty_delete_failures++;
          console.error(`[CodeExpirationCleaner] DELETE loyalty/rewards/${row.loyalty_reward_id} → ${result.status}: ${result.body}`);
          // Don't mark expired in DB — retry tomorrow
        }
        // Throttle: 200ms per delete to stay under Square's rate limits
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      stats.errors.push(`loyalty_expire: ${err.message}`);
      console.error(`[CodeExpirationCleaner] loyalty_expire failed: ${err.message}`);
    }

    // ── PRIMARY B: expire rows WITHOUT loyalty_reward_id (no Square reward to delete) ──
    // Pre-C.1 sends, or holdouts, or rows where reward issuance failed but row was inserted.
    try {
      const expiredOther = await env.DB.prepare(`
        UPDATE retail_campaign_sends
        SET outcome = 'expired'
        WHERE expires_at IS NOT NULL
          AND expires_at < date('now')
          AND returned_at IS NULL
          AND outcome IN ('sent', 'delivered', 'pending')
          AND loyalty_reward_id IS NULL
      `).run();
      stats.sends_expired_without_loyalty = expiredOther.meta?.changes || 0;
    } catch (err) {
      stats.errors.push(`other_expire: ${err.message}`);
      console.error(`[CodeExpirationCleaner] other_expire failed: ${err.message}`);
    }

    console.log(`[CodeExpirationCleaner] Loyalty: ${stats.loyalty_rewards_deleted} deleted, ${stats.loyalty_delete_failures} failed | Other: ${stats.sends_expired_without_loyalty} expired DB-only`);

    // ── SECONDARY: delete stale Catalog DISCOUNT objects ──
    // Pre-May-11 codes only. Loyalty rewards are not touched (Square handles).
    try {
      const stale = await env.DB.prepare(`
        SELECT id, code, square_catalog_id, valid_until
        FROM retail_campaign_discounts
        WHERE valid_until IS NOT NULL
          AND valid_until < date('now')
          AND status = 'active'
          AND square_catalog_id IS NOT NULL
        LIMIT 50
      `).all();

      for (const row of (stale.results || [])) {
        try {
          const resp = await fetch(`${SQUARE_API_BASE}/catalog/object/${row.square_catalog_id}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
              'Square-Version': '2024-10-17',
            },
          });
          if (resp.ok) {
            await env.DB.prepare(
              "UPDATE retail_campaign_discounts SET status='expired' WHERE id=?"
            ).bind(row.id).run();
            stats.catalog_objects_deleted++;
            console.log(`[CodeExpirationCleaner] Deleted Catalog ${row.square_catalog_id} (code ${row.code})`);
          } else {
            const body = await resp.text().catch(() => '');
            stats.catalog_delete_failures++;
            // 404 = already gone. Mark expired so we stop trying.
            if (resp.status === 404) {
              await env.DB.prepare(
                "UPDATE retail_campaign_discounts SET status='expired' WHERE id=?"
              ).bind(row.id).run();
            } else {
              console.error(`[CodeExpirationCleaner] DELETE ${row.square_catalog_id} → ${resp.status}: ${body.slice(0, 200)}`);
            }
          }
        } catch (err) {
          stats.catalog_delete_failures++;
          stats.errors.push(`catalog_delete:${row.code}: ${err.message}`);
        }
      }
    } catch (err) {
      stats.errors.push(`catalog_scan: ${err.message}`);
      console.error(`[CodeExpirationCleaner] catalog_scan failed: ${err.message}`);
    }

    const duration = Date.now() - t0;
    console.log(`[CodeExpirationCleaner] Done in ${duration}ms — ${JSON.stringify(stats)}`);
    return stats;
  },

  // GET /retail/code-expiration-cleaner/run — manual trigger for testing
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const stats = await this.scheduled(null, env, ctx);
    return new Response(JSON.stringify(stats, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
