/**
 * Dangerous Pretzel Co — Scout Worker
 * Cloudflare Worker (cron: every Monday 6am MT)
 *
 * Hits Apollo.io Organization search for SLC venue categories,
 * deduplicates against D1, writes new prospects.
 *
 * Uses chunked execution: HTTP /scout/run does all categories,
 * or /scout/run?category=brewery for a single category.
 * Cron trigger fires all categories sequentially via waitUntil.
 *
 * Env vars required:
 *   APOLLO_API_KEY      — Apollo.io API key
 *   DB                  — D1 binding (pretzel-os)
 */

const VENUE_SEARCHES = [
  { category: 'brewery',       keywords: ['brewery','taproom','brewing company'] },
  { category: 'ski_resort',    keywords: ['ski resort','ski lodge','mountain resort'] },
  { category: 'event_venue',   keywords: ['event venue','event center','banquet hall'] },
  { category: 'theater',       keywords: ['theater','performing arts','concert hall'] },
  { category: 'hotel_bar',     keywords: ['hotel','resort hotel'] },
  { category: 'golf',          keywords: ['golf club','country club'] },
  { category: 'stadium',       keywords: ['stadium','arena','amphitheater'] },
  { category: 'entertainment', keywords: ['bowling','axe throwing','arcade','entertainment center','escape room'] },
  { category: 'summer_venue',  keywords: ['amphitheater','outdoor concert series','summer concert','festival grounds','fairgrounds','outdoor stage','outdoor theater'] },
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

// Extended geography for summer venues: SLC metro + Utah County + Weber County + resorts
const SUMMER_LOCATIONS = [
  // SLC metro
  'Salt Lake City, Utah',
  'Sandy, Utah',
  'West Valley City, Utah',
  'Murray, Utah',
  'Draper, Utah',
  'Cottonwood Heights, Utah',
  // Resorts
  'Park City, Utah',
  'Snowbird, Utah',
  // Utah County
  'Provo, Utah',
  'Orem, Utah',
  'American Fork, Utah',
  'Lehi, Utah',
  'Saratoga Springs, Utah',
  'Spanish Fork, Utah',
  'Springville, Utah',
  // Weber County
  'Ogden, Utah',
  'Roy, Utah',
  'Riverdale, Utah',
];

export default {
  // Cron trigger: 0 12 * * 1  (Monday 6am MT = 12pm UTC)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllCategories(env));
  },

  // Also callable via HTTP for manual runs/testing
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/scout/run') {
      const category = url.searchParams.get('category');

      if (category) {
        // Run a single category
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

      // Run all categories
      const result = await runAllCategories(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Enrich Tier 1-2 venues with contact emails via Apollo People Search
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
  // Find Tier 1-2 venues missing contact email
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
      // Extract domain from website if available
      let domain = null;
      if (venue.website) {
        try { domain = new URL(venue.website).hostname.replace('www.', ''); } catch {}
      }

      // Search Apollo for people at this company
      const targetTitles = ['General Manager', 'Owner', 'Manager', 'Director of Operations',
                            'Event Manager', 'Events Director', 'Taproom Manager', 'Bar Manager',
                            'Food and Beverage Manager', 'F&B Director'];

      // Step 1: Search for people at this venue (same auth pattern as working searchApollo)
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

      // Pick the best contact — prefer someone with has_email
      const best = people.find(p => p.has_email || p.email) || people[0];
      let email = best.email || null;
      let contactName = [best.first_name, best.last_name].filter(Boolean).join(' ');
      let title = best.title || null;

      // If search found a person but no email, enrich them to reveal it
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
          await new Promise(r => setTimeout(r, 300)); // rate limit
        } catch {}
      }

      if (!email) {
        console.log(`[Scout] Found people but no email for ${venue.name}`);
        skipped++;
        results.push({ name: venue.name, status: 'no_email', contact: contactName });
        continue;
      }

      // Save to D1
      await env.DB.prepare(`
        UPDATE venues
        SET contact_email = ?, contact_name = ?, contact_title = ?
        WHERE id = ?
      `).bind(email, contactName, title, venue.id).run();

      enriched++;
      results.push({ name: venue.name, status: 'enriched', email, contact: contactName, title });
      console.log(`[Scout] Enriched ${venue.name}: ${contactName} <${email}> (${title})`);

      // Rate limit — Apollo allows 5 req/sec on basic plans
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

async function runAllCategories(env) {
  console.log('[Scout] Starting SLC venue search — all categories...');
  let totalNew = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const search of VENUE_SEARCHES) {
    try {
      const result = await runCategory(env, search);
      totalNew += result.new;
      totalSkipped += result.skipped;
    } catch (err) {
      console.error(`[Scout] Category ${search.category} failed:`, err.message);
      totalErrors++;
    }
  }

  console.log(`[Scout] Done. New: ${totalNew}, Skipped: ${totalSkipped}, Errors: ${totalErrors}`);

  // Write a performance log entry
  await env.DB.prepare(`
    INSERT OR IGNORE INTO performance_metrics (id, week_start, created_at)
    VALUES (?, date('now', 'weekday 1', '-7 days'), datetime('now'))
  `).bind(crypto.randomUUID()).run();

  return { status: 'scout complete', new: totalNew, skipped: totalSkipped, errors: totalErrors };
}

async function runCategory(env, search) {
  console.log(`[Scout] Searching category: ${search.category}`);
  let newCount = 0;
  let skippedCount = 0;

  // Summer venues use extended geography (SLC + Utah County + Weber County)
  const locationList = search.category === 'summer_venue' ? SUMMER_LOCATIONS : SLC_LOCATIONS;

  // Fire all location+keyword combos — but only first keyword per location to stay fast
  for (const locationStr of locationList) {
    const city = locationStr.split(',')[0].trim();

    for (const keyword of search.keywords) {
      try {
        const orgs = await searchApollo(env.APOLLO_API_KEY, keyword, locationStr);

        for (const org of orgs) {
          const existing = await env.DB.prepare(
            'SELECT id FROM venues WHERE id = ? OR (name = ? AND city = ?)'
          ).bind(org.id, org.name, city).first();

          if (existing) {
            skippedCount++;
            continue;
          }

          await env.DB.prepare(`
            INSERT INTO venues (
              id, name, category, status, campaign,
              contact_phone, address, city, state, zip,
              website, instagram,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'prospect', ?, ?, ?, ?, 'UT', ?, ?, ?, datetime('now'), datetime('now'))
          `).bind(
            org.id || crypto.randomUUID(),
            org.name,
            search.category,
            search.category === 'summer_venue' ? 'summer_2026' : null,
            org.phone || null,
            org.address || null,
            city,
            org.zip || null,
            org.website || null,
            org.instagram || null
          ).run();

          newCount++;
          console.log(`[Scout] + ${org.name} (${search.category}, ${city})`);
        }
      } catch (err) {
        console.error(`[Scout] Error: ${keyword} in ${city}:`, err.message);
      }
    }
  }

  console.log(`[Scout] ${search.category}: ${newCount} new, ${skippedCount} skipped`);
  return { category: search.category, new: newCount, skipped: skippedCount };
}

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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apollo API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const organizations = data.organizations || [];

  return organizations.map(org => ({
    id: `apollo_${org.id}`,
    name: org.name,
    phone: org.sanitized_phone || org.phone || null,
    address: org.street_address || null,
    zip: org.postal_code || null,
    website: org.website_url || null,
    instagram: extractInstagram(org),
  }));
}

function extractInstagram(org) {
  const urls = [org.facebook_url, org.twitter_url, org.linkedin_url, org.blog_url, org.angellist_url].filter(Boolean);
  const ig = urls.find(u => u.includes('instagram.com'));
  return ig || null;
}
