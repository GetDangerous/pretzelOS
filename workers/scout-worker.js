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
  { category: 'brewery',      keywords: ['brewery','taproom','brewing company'] },
  { category: 'ski_resort',   keywords: ['ski resort','ski lodge','mountain resort'] },
  { category: 'event_venue',  keywords: ['event venue','event center','banquet hall'] },
  { category: 'theater',      keywords: ['theater','performing arts','concert hall'] },
  { category: 'hotel_bar',    keywords: ['hotel','resort hotel'] },
  { category: 'golf',         keywords: ['golf club','country club'] },
  { category: 'stadium',      keywords: ['stadium','arena','amphitheater'] },
  { category: 'entertainment',keywords: ['bowling','axe throwing','arcade','entertainment center','escape room'] },
];

// Use broader metro location strings — Apollo handles radius matching
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

    return new Response('Dangerous Pretzel Scout Worker', { status: 200 });
  }
};

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

  // Fire all location+keyword combos — but only first keyword per location to stay fast
  for (const locationStr of SLC_LOCATIONS) {
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
              id, name, category, status,
              contact_phone, address, city, state, zip,
              website, instagram,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'prospect', ?, ?, ?, 'UT', ?, ?, ?, datetime('now'), datetime('now'))
          `).bind(
            org.id || crypto.randomUUID(),
            org.name,
            search.category,
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
