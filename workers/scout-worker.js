/**
 * Dangerous Pretzel Co — Scout Worker
 * Cloudflare Worker (cron: every Monday 6am MT)
 *
 * Hits Apollo.io Organization search for SLC venue categories,
 * runs AI pre-qualification gate (Claude Haiku) to filter junk,
 * deduplicates against D1, writes only validated prospects.
 *
 * Key improvement: every Apollo result passes through hard filters
 * (country, state, industry) and an AI gate before insertion.
 * Rejected venues are logged to scout_rejections for feedback.
 *
 * Env vars required:
 *   APOLLO_API_KEY      — Apollo.io API key
 *   ANTHROPIC_API_KEY   — Claude API key (for AI gate)
 *   DB                  — D1 binding (pretzel-os)
 */

import { callAI } from './ai-budget.js';

// ── SEARCH CATEGORIES (refined by conversion data) ─────────────────────────
// Tier A: Highest conversion rate (4 of 10 active accounts are breweries)
// Tier B: Proven converters (stadiums, ski lodges, theaters)
// Tier C: Strong potential (golf, bowling, summer venues)
//
// REMOVED: hotel_bar (95 venues, 0 scored, 0 contacts, 0 conversions)
// REMOVED: entertainment catch-all (replaced by specific 'bowling')
// REMOVED: event_venue (most already have full catering)
const VENUE_SEARCHES = [
  // Tier A — search every run
  { category: 'brewery',       keywords: ['brewery','taproom','brewing company','brewpub','craft brewery'], tier: 'A' },
  // Tier B — search every run
  { category: 'ski_resort',    keywords: ['ski lodge','ski resort lodge','mountain lodge'], tier: 'B' },
  { category: 'stadium',       keywords: ['stadium','arena','sports venue'], tier: 'B' },
  { category: 'theater',       keywords: ['performing arts center','concert hall','live music venue','playhouse'], tier: 'B' },
  // Tier C — search every run but lower priority
  { category: 'golf',          keywords: ['golf club','country club'], tier: 'C' },
  { category: 'bowling',       keywords: ['bowling alley','bowling center'], tier: 'C' },
  { category: 'summer_venue',  keywords: ['amphitheater','outdoor concert venue','festival grounds','fairgrounds'], tier: 'C' },
];

// Industries that are definitely NOT food/beverage venues
const BAD_INDUSTRIES = [
  'software', 'consulting', 'technology', 'education', 'financial services',
  'real estate', 'construction', 'manufacturing', 'marketing', 'design',
  'media production', 'healthcare', 'legal', 'insurance', 'accounting',
  'staffing', 'recruiting', 'telecommunications', 'mining', 'agriculture',
  'automotive', 'transportation', 'logistics', 'government', 'military',
  'nonprofit', 'religious', 'publishing', 'printing', 'photography',
  'computer', 'information technology', 'internet', 'e-commerce',
];

// Standard SLC metro locations
const SLC_LOCATIONS = [
  'Salt Lake City, Utah',
  'Park City, Utah',
  'Ogden, Utah',
  'Provo, Utah',
  'Sandy, Utah',
  'Draper, Utah',
  'Murray, Utah',
  'West Valley City, Utah',
];

// Extended geography for summer venues
const SUMMER_LOCATIONS = [
  'Salt Lake City, Utah', 'Sandy, Utah', 'West Valley City, Utah',
  'Murray, Utah', 'Draper, Utah', 'Cottonwood Heights, Utah',
  'Park City, Utah', 'Snowbird, Utah',
  'Provo, Utah', 'Orem, Utah', 'American Fork, Utah',
  'Lehi, Utah', 'Saratoga Springs, Utah', 'Spanish Fork, Utah', 'Springville, Utah',
  'Ogden, Utah', 'Roy, Utah', 'Riverdale, Utah',
];

export default {
  async scheduled(event, env, ctx) {
    return runAllCategories(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/scout/run') {
      const category = url.searchParams.get('category');
      if (category) {
        const search = VENUE_SEARCHES.find(s => s.category === category);
        if (!search) {
          return new Response(JSON.stringify({ error: `Unknown category: ${category}` }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
          });
        }
        const result = await runCategory(env, search);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const result = await runAllCategories(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/scout/enrich') {
      const result = await enrichVenueContacts(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Dangerous Pretzel Scout Worker', { status: 200 });
  }
};

// ── APOLLO PEOPLE ENRICHMENT ────────────────────────────────────────────────
async function enrichVenueContacts(env) {
  const venues = await env.DB.prepare(`
    SELECT id, name, category, website
    FROM venues
    WHERE tier IN (1, 2)
      AND status = 'prospect'
      AND (contact_email IS NULL OR contact_email = '')
    ORDER BY tier, name
  `).all();

  const toEnrich = venues.results || [];
  console.log(`[Scout] Enriching ${toEnrich.length} venues via Apollo People Search`);

  let enriched = 0, failed = 0, skipped = 0;
  const results = [];

  for (const venue of toEnrich) {
    try {
      let domain = null;
      if (venue.website) {
        try { domain = new URL(venue.website).hostname.replace('www.', ''); } catch {}
      }

      const targetTitles = ['General Manager', 'Owner', 'Manager', 'Director of Operations',
                            'Event Manager', 'Events Director', 'Taproom Manager', 'Bar Manager',
                            'Food and Beverage Manager', 'F&B Director'];

      const searchBody = {
        person_titles: targetTitles,
        include_similar_titles: true,
        person_locations: ['Utah, United States'],
        per_page: 5,
      };

      if (domain) {
        searchBody.q_organization_domains_list = [domain];
      } else {
        searchBody.q_organization_name = venue.name;
        searchBody.organization_locations = ['Salt Lake City, Utah'];
      }

      const resp = await fetch('https://api.apollo.io/v1/mixed_people/api_search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': env.APOLLO_API_KEY,
        },
        body: JSON.stringify(searchBody),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => 'no body');
        console.error(`[Scout] Apollo search failed for ${venue.name}: ${resp.status} — ${errBody}`);
        failed++;
        results.push({ name: venue.name, status: 'apollo_error', code: resp.status, error: errBody.slice(0, 200) });
        continue;
      }

      const data = await resp.json();
      const people = data.people || [];

      if (people.length === 0) {
        console.log(`[Scout] No contacts found for ${venue.name}`);
        skipped++;
        results.push({ name: venue.name, status: 'no_contacts' });
        continue;
      }

      const best = people.find(p => p.has_email || p.email) || people[0];
      let email = best.email || null;
      let contactName = [best.first_name, best.last_name].filter(Boolean).join(' ');
      let title = best.title || null;

      if (!email && best.id) {
        try {
          const enrichResp = await fetch('https://api.apollo.io/v1/people/match', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache',
              'X-Api-Key': env.APOLLO_API_KEY,
            },
            body: JSON.stringify({ id: best.id }),
            signal: AbortSignal.timeout(10000),
          });
          if (enrichResp.ok) {
            const enrichData = await enrichResp.json();
            const person = enrichData.person;
            if (person?.email) {
              email = person.email;
              contactName = person.name || contactName;
              title = person.title || title;
            }
          }
          await new Promise(r => setTimeout(r, 300));
        } catch {}
      }

      if (!email) {
        console.log(`[Scout] Found people but no email for ${venue.name}`);
        skipped++;
        results.push({ name: venue.name, status: 'no_email', contact: contactName });
        continue;
      }

      await env.DB.prepare(`
        UPDATE venues
        SET contact_email = ?, contact_name = ?, contact_title = ?
        WHERE id = ?
      `).bind(email, contactName, title, venue.id).run();

      enriched++;
      results.push({ name: venue.name, status: 'enriched', email, contact: contactName, title });
      console.log(`[Scout] Enriched ${venue.name}: ${contactName} <${email}> (${title})`);
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.error(`[Scout] Error enriching ${venue.name}: ${err.message}`);
      failed++;
      results.push({ name: venue.name, status: 'error', message: err.message });
    }
  }

  console.log(`[Scout] Enrichment complete: ${enriched} enriched, ${skipped} no data, ${failed} failed`);
  return { total: toEnrich.length, enriched, skipped, failed, results };
}

// ── MAIN SCOUT FLOW ─────────────────────────────────────────────────────────
async function runAllCategories(env) {
  console.log('[Scout] Starting SLC venue search — all categories...');
  const DEADLINE = Date.now() + 12 * 60 * 1000; // 12-minute hard ceiling

  // Load exclusion list from scout_rejections + pipeline_feedback
  const exclusions = await loadExclusionList(env);

  let totalNew = 0, totalSkipped = 0, totalRejected = 0, totalErrors = 0;

  for (const search of VENUE_SEARCHES) {
    if (Date.now() > DEADLINE) {
      console.log(`[Scout] Hit 12-minute time ceiling, stopping with ${totalNew} new venues`);
      break;
    }
    try {
      const result = await runCategory(env, search, exclusions);
      totalNew += result.new;
      totalSkipped += result.skipped;
      totalRejected += result.rejected;
    } catch (err) {
      console.error(`[Scout] Category ${search.category} failed:`, err.message);
      totalErrors++;
    }
  }

  console.log(`[Scout] Done. New: ${totalNew}, Skipped: ${totalSkipped}, Rejected: ${totalRejected}, Errors: ${totalErrors}`);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO performance_metrics (id, week_start, created_at)
    VALUES (?, date('now', 'weekday 1', '-7 days'), datetime('now'))
  `).bind(crypto.randomUUID()).run();

  return { status: 'scout complete', new: totalNew, skipped: totalSkipped, rejected: totalRejected, errors: totalErrors };
}

async function runCategory(env, search, exclusions = new Set()) {
  console.log(`[Scout] Searching category: ${search.category}`);
  let newCount = 0, skippedCount = 0, rejectedCount = 0;

  const locationList = search.category === 'summer_venue' ? SUMMER_LOCATIONS : SLC_LOCATIONS;

  // Collect all candidates from Apollo, then batch through AI gate
  const allCandidates = [];

  for (const locationStr of locationList) {
    const city = locationStr.split(',')[0].trim();

    for (const keyword of search.keywords) {
      try {
        const orgs = await searchApollo(env.APOLLO_API_KEY, keyword, locationStr);

        for (const org of orgs) {
          // ── HARD FILTER 1: Already in DB ──
          const existing = await env.DB.prepare(
            'SELECT id FROM venues WHERE id = ? OR (LOWER(name) = LOWER(?) AND LOWER(city) = LOWER(?))'
          ).bind(org.id, org.name, city).first();
          if (existing) { skippedCount++; continue; }

          // ── HARD FILTER 2: Already rejected ──
          if (exclusions.has(org.name.toLowerCase())) { skippedCount++; continue; }

          // ── HARD FILTER 3: Not in US ──
          if (org.country && org.country !== 'United States') {
            await logRejection(env, org, search.category, 'hard_filter', `Non-US country: ${org.country}`);
            rejectedCount++; continue;
          }

          // ── HARD FILTER 4: Not in Utah ──
          if (org.state && org.state !== 'Utah' && org.state !== 'UT') {
            await logRejection(env, org, search.category, 'hard_filter', `Non-Utah state: ${org.state}`);
            rejectedCount++; continue;
          }

          // ── HARD FILTER 5: Bad industry ──
          if (org.industry && BAD_INDUSTRIES.some(b => org.industry.toLowerCase().includes(b))) {
            await logRejection(env, org, search.category, 'hard_filter', `Bad industry: ${org.industry}`);
            rejectedCount++; continue;
          }

          // Passes hard filters — add to AI gate batch
          allCandidates.push({ ...org, city, searchCategory: search.category });
        }
      } catch (err) {
        console.error(`[Scout] Error: ${keyword} in ${city}:`, err.message);
      }
    }
  }

  if (allCandidates.length === 0) {
    console.log(`[Scout] ${search.category}: no new candidates after hard filters`);
    return { category: search.category, new: 0, skipped: skippedCount, rejected: rejectedCount };
  }

  // ── AI PRE-QUALIFICATION GATE ──
  // Process in batches of 10
  for (let i = 0; i < allCandidates.length; i += 10) {
    const batch = allCandidates.slice(i, i + 10);

    try {
      const decisions = await runAIGate(env, batch);

      for (let j = 0; j < batch.length; j++) {
        const candidate = batch[j];
        const decision = decisions[j];

        if (!decision || decision.decision === 'REJECT') {
          const reason = decision?.reason || 'AI gate rejected (no specific reason)';
          await logRejection(env, candidate, candidate.searchCategory, 'ai_gate', reason);
          rejectedCount++;
          console.log(`[Scout] ✗ REJECTED: ${candidate.name} — ${reason}`);
          continue;
        }

        // ── ACCEPTED — Insert into D1 ──
        await env.DB.prepare(`
          INSERT INTO venues (
            id, name, category, status, campaign,
            contact_phone, address, city, state, zip,
            website, instagram,
            apollo_industry, apollo_description, apollo_employees, apollo_revenue,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'prospect', ?, ?, ?, ?, 'UT', ?, ?, ?,  ?, ?, ?, ?,  datetime('now'), datetime('now'))
        `).bind(
          candidate.id || crypto.randomUUID(),
          candidate.name,
          candidate.searchCategory,
          candidate.searchCategory === 'summer_venue' ? 'summer_2026' : null,
          candidate.phone || null,
          candidate.address || null,
          candidate.city,
          candidate.zip || null,
          candidate.website || null,
          candidate.instagram || null,
          candidate.industry || null,
          candidate.description || null,
          candidate.employees || null,
          candidate.revenue || null,
        ).run();

        newCount++;
        console.log(`[Scout] ✓ ACCEPTED: ${candidate.name} (${candidate.searchCategory}, ${candidate.city}) — ${decision.reason}`);
      }
    } catch (err) {
      console.error(`[Scout] AI gate batch error:`, err.message);
      // On AI gate failure, skip the batch rather than inserting unvalidated data
      rejectedCount += batch.length;
    }
  }

  console.log(`[Scout] ${search.category}: ${newCount} new, ${skippedCount} skipped, ${rejectedCount} rejected`);
  return { category: search.category, new: newCount, skipped: skippedCount, rejected: rejectedCount };
}

// ── AI PRE-QUALIFICATION GATE ───────────────────────────────────────────────
async function runAIGate(env, candidates) {
  const prompt = `You are a lead qualification gate for Dangerous Pretzel Co, which sells pretzel warmers ($7-8 per pretzel) to food/beverage venues in the Salt Lake City, Utah metro area.

Our PROVEN customers (use as benchmark):
- HK Brewing, Hopkins Brewery, ROHA Brewing, TF Brewery (breweries/taprooms — no kitchen, captive 60-90min)
- Delta Center, SLC Bees Stadium (stadiums/arenas — massive captive audiences, concession stands)
- Powder Mountain, Alta Ski - Goldminers Daughter (ski resort lodges — captive all-day, lodge bar)
- Pioneer Theater Company (theater — intermission concessions)
- Sandy Amphitheater (outdoor venue — seasonal event crowds)

ACCEPT venues that are SIMILAR to our proven customers:
- Physical venues where people gather and STAY for 60+ minutes (captive audience)
- Alcohol is served or could be (pretzels pair with beer)
- No or limited existing food program (they need a simple food add-on like us)
- Independent/local ownership preferred (faster purchasing decisions)
- Located in Utah

REJECT anything that is:
- Not actually a physical venue where people gather (agencies, studios, suppliers, consultants, offices)
- A chain hotel without a notable bar/lounge (Days Inn, Comfort Inn, Holiday Inn, etc.)
- A full-service restaurant with its own kitchen (they don't need us)
- Permanently closed, inactive, or just a corporate headquarters
- Outside Utah
- A training facility, school, or class-based business (circus school, acting class, etc.)
- A retail store, equipment supplier, or online business
- A parking facility, management company, or holding entity

For each venue, respond ACCEPT or REJECT with a brief reason (10 words max).

Venues:
${candidates.map((c, i) => `${i + 1}. "${c.name}" | industry: ${c.industry || 'unknown'} | description: "${c.description || 'none'}" | search category: ${c.searchCategory} | city: ${c.city}, Utah`).join('\n')}

Return ONLY a JSON array: [{"index": 1, "decision": "ACCEPT", "reason": "Craft brewery with taproom, strong ICP fit"}]`;

  try {
    // DIF-3 (May 13 2026): wired through ai-budget
    // NOTE: original fetch had AbortSignal.timeout(20000); wrapper does not currently expose a per-call timeout.
    const aiResult = await callAI(env, {
      use_case: 'venue_discovery',
      model: 'haiku',
      caller: 'scout-worker.js',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    if (!aiResult.ok) {
      throw new Error(`Claude API error: ${aiResult.blocked_reason || aiResult.error || 'unknown'}`);
    }

    const text = aiResult.content || '[]';
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const decisions = JSON.parse(clean);

    // Map decisions back to candidates by index
    const mappedDecisions = candidates.map((_, i) => {
      const d = decisions.find(d => d.index === i + 1);
      return d || { index: i + 1, decision: 'REJECT', reason: 'No decision returned' };
    });

    return mappedDecisions;
  } catch (err) {
    console.error(`[Scout] AI gate error:`, err.message);
    // On error, reject all (fail safe — don't insert unvalidated data)
    return candidates.map((_, i) => ({ index: i + 1, decision: 'REJECT', reason: `AI gate error: ${err.message}` }));
  }
}

// ── APOLLO SEARCH ───────────────────────────────────────────────────────────
async function searchApollo(apiKey, keyword, locationStr) {
  const payload = {
    q_organization_name: keyword,
    organization_locations: [locationStr],
    per_page: 25,
    page: 1,
  };

  const response = await fetch('https://api.apollo.io/v1/organizations/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apollo API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const organizations = data.organizations || [];

  // Extract ALL useful fields from Apollo (not just name/phone like before)
  return organizations.map(org => ({
    id: `apollo_${org.id}`,
    name: org.name,
    phone: org.sanitized_phone || org.phone || null,
    address: org.street_address || null,
    city: org.city || null,
    state: org.state || null,
    country: org.country || null,
    zip: org.postal_code || null,
    website: org.website_url || null,
    instagram: extractInstagram(org),
    // NEW: Rich metadata for AI gate and qualifier
    industry: org.industry || null,
    keywords: org.keywords || [],
    description: org.short_description || org.seo_description || null,
    employees: org.estimated_num_employees || null,
    revenue: org.annual_revenue_printed || null,
    founded_year: org.founded_year || null,
  }));
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function extractInstagram(org) {
  const urls = [org.facebook_url, org.twitter_url, org.linkedin_url, org.blog_url, org.angellist_url].filter(Boolean);
  const ig = urls.find(u => u.includes('instagram.com'));
  return ig || null;
}

async function logRejection(env, org, category, source, reason) {
  try {
    await env.DB.prepare(`
      INSERT INTO scout_rejections (id, apollo_id, name, city, category, industry, description, rejection_source, rejection_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      org.id || null,
      org.name,
      org.city || null,
      category,
      org.industry || null,
      (org.description || '').slice(0, 500),
      source,
      reason,
    ).run();
  } catch (err) {
    console.error(`[Scout] Failed to log rejection for ${org.name}:`, err.message);
  }
}

async function loadExclusionList(env) {
  try {
    const rows = await env.DB.prepare(`
      SELECT LOWER(name) as name FROM scout_rejections WHERE rejection_source IN ('ai_gate', 'drew')
      UNION
      SELECT LOWER(venue_name) as name FROM pipeline_feedback WHERE action IN ('flagged_junk', 'archived')
    `).all();
    return new Set((rows.results || []).map(r => r.name).filter(Boolean));
  } catch {
    return new Set();
  }
}
