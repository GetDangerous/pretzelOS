/**
 * Catering Crossover Scout
 *
 * Finds retail customers (Square POS buyers) who are likely catering buyers:
 *  - Lifetime value >= $50
 *  - Last visit within 60 days (still engaged)
 *  - Has an email on a business domain (not gmail/yahoo/etc.)
 *  - Not already seeded into catering_leads
 *
 * These are gold: they already love the product. Highest intent signal
 * a cold pipeline can produce.
 *
 * Writes to catering_leads with source='retail_crossover', then marks
 * retail_customers.catering_lead_id so we never double-seed.
 *
 * Endpoints:
 *   POST /catering-crossover/run  → manual trigger
 *   GET  /catering-crossover/preview → dry-run listing (no writes)
 *
 * Scheduled via router.js cron: daily 6am MT (0 12 * * *) [light work]
 */

// Personal email domains — if customer used one of these, skip
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'msn.com', 'me.com', 'live.com', 'comcast.net', 'att.net',
  'verizon.net', 'proton.me', 'protonmail.com', 'mail.com', 'gmx.com',
  'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.ca',
]);

const MIN_LIFETIME_VALUE = 50;
const LOOKBACK_DAYS = 60;
const MAX_PER_RUN = 15;        // don't flood; pace the pipeline
const SEARCH_LOOKBACK_DAYS = 180; // deeper search for candidates to consider

function isBusinessDomain(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1].toLowerCase().trim();
  if (!domain) return false;
  if (PERSONAL_DOMAINS.has(domain)) return false;
  // Basic sanity — domain must have a dot and no spaces
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false;
  return true;
}

function deriveCompanyName(email, firstName, lastName) {
  const domain = email.split('@')[1].toLowerCase();
  // Strip TLD + common suffixes to produce a crude company label
  const base = domain.replace(/\.(com|org|net|co|io|us|biz|info)$/i, '')
                     .replace(/^(mail|email|contact|info|hello)\./i, '');
  // Title-case
  const pretty = base.split(/[-.]/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return pretty || domain;
}

async function findCrossoverCandidates(env) {
  // Pull engaged retail customers with business email, not already a catering lead
  const rows = await env.DB.prepare(`
    SELECT id, email, first_name, last_name,
           total_lifetime_value, visit_count, last_visit_date,
           favorite_sku, largest_single_order, segment, is_group_buyer
    FROM retail_customers
    WHERE email IS NOT NULL
      AND email != ''
      AND total_lifetime_value >= ?
      AND last_visit_date >= date('now', '-${SEARCH_LOOKBACK_DAYS} days')
      AND (catering_lead_id IS NULL OR catering_lead_id = '')
    ORDER BY
      CASE WHEN is_group_buyer = 1 THEN 0 ELSE 1 END,
      total_lifetime_value DESC
    LIMIT 200
  `).bind(MIN_LIFETIME_VALUE).all();

  const candidates = [];
  for (const r of (rows.results || [])) {
    if (!isBusinessDomain(r.email)) continue;

    // Dedup against existing catering_leads by contact_email
    const existing = await env.DB.prepare(
      `SELECT id FROM catering_leads WHERE LOWER(contact_email) = LOWER(?) LIMIT 1`
    ).bind(r.email).first();
    if (existing) {
      // Link back so we never reconsider
      await env.DB.prepare(
        `UPDATE retail_customers SET catering_lead_id = ? WHERE id = ?`
      ).bind(existing.id, r.id).run().catch(() => {});
      continue;
    }

    candidates.push(r);
    if (candidates.length >= MAX_PER_RUN) break;
  }
  return candidates;
}

async function seedFromCandidate(env, cust) {
  const email = cust.email.trim().toLowerCase();
  const contactName = [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() || null;
  const companyName = deriveCompanyName(email, cust.first_name, cust.last_name);

  const leadId = crypto.randomUUID();
  const notes = [
    `Retail crossover: LTV $${Number(cust.total_lifetime_value || 0).toFixed(2)}`,
    `${cust.visit_count || 0} visits`,
    cust.favorite_sku ? `fav: ${cust.favorite_sku}` : null,
    cust.largest_single_order ? `largest order: ${cust.largest_single_order} units` : null,
    cust.is_group_buyer ? 'flagged as group_buyer' : null,
  ].filter(Boolean).join(' · ');

  // Higher headcount is a proxy — we don't know it yet; leave NULL, let Apollo enrich later
  await env.DB.prepare(`
    INSERT INTO catering_leads (
      id, name, contact_name, contact_email,
      source, source_customer_id,
      status, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'retail_crossover', ?, 'prospect', ?, datetime('now'), datetime('now'))
  `).bind(leadId, companyName, contactName, email, cust.id, notes).run();

  await env.DB.prepare(
    `UPDATE retail_customers SET catering_lead_id = ?, catering_flagged = 1 WHERE id = ?`
  ).bind(leadId, cust.id).run().catch(() => {});

  return { leadId, email, companyName, contactName, ltv: cust.total_lifetime_value };
}

async function runCrossoverScout(env) {
  const t0 = Date.now();
  console.log('[CrossoverScout] Starting…');

  const candidates = await findCrossoverCandidates(env);
  console.log(`[CrossoverScout] ${candidates.length} eligible business-email retail customers`);

  const seeded = [];
  for (const c of candidates) {
    try {
      const row = await seedFromCandidate(env, c);
      seeded.push(row);
      console.log(`[CrossoverScout] Seeded ${row.companyName} <${row.email}> (LTV $${Number(row.ltv || 0).toFixed(2)})`);
    } catch (err) {
      console.error(`[CrossoverScout] Failed to seed ${c.email}:`, err.message);
    }
  }

  const summary = { considered: candidates.length, seeded: seeded.length, duration_ms: Date.now() - t0 };
  console.log(`[CrossoverScout] Done:`, summary);
  return summary;
}

export default {
  async scheduled(event, env, ctx) {
    return runCrossoverScout(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/catering-crossover/run' && request.method === 'POST') {
      const result = await runCrossoverScout(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/catering-crossover/preview' && request.method === 'GET') {
      const candidates = await findCrossoverCandidates(env);
      return new Response(JSON.stringify({
        count: candidates.length,
        candidates: candidates.map(c => ({
          email: c.email,
          name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          ltv: c.total_lifetime_value,
          visits: c.visit_count,
          last_visit: c.last_visit_date,
          group_buyer: c.is_group_buyer === 1,
        })),
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Catering Crossover Scout', { status: 200 });
  },
};
