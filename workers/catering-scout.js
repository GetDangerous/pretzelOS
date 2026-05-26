/**
 * Catering Scout (Apollo ICP)
 *
 * Cold-sourcing catering-buyer personas at Utah companies via Apollo.
 * Queries Apollo mixed_people_search for titles that typically own
 * office catering, event catering, or all-hands budgets.
 *
 * ICP:
 *  - Titles: Office Manager, Executive Assistant, People Ops, HR, Events Coordinator, Chief of Staff
 *  - Location: Utah (we deliver locally)
 *  - Company headcount: 51–500 (big enough to have recurring office events,
 *    small enough that one decision-maker can book)
 *
 * Writes to catering_leads with source='apollo'. Dedups by contact_email.
 *
 * Endpoints:
 *   POST /catering-scout/run      → run the scout
 *   GET  /catering-scout/preview  → dry-run search results (no writes)
 *
 * Scheduled via router.js cron: Monday 7am MT (0 13 * * 1)
 */

const ICP_TITLES = [
  'Office Manager',
  'Executive Assistant',
  'Chief of Staff',
  'People Operations',
  'Human Resources Manager',
  'HR Manager',
  'Events Coordinator',
  'Events Manager',
  'Workplace Experience',
];

const LOCATION = 'Utah, United States';
const HEADCOUNT_RANGES = ['51,200', '201,500']; // Apollo format

const MAX_PER_RUN = 20;   // cap insertions per run
const PER_PAGE = 25;       // Apollo page size

async function apolloSearch(env, { titles, page = 1 }) {
  const payload = {
    person_titles: titles,
    include_similar_titles: true,
    person_locations: [LOCATION],
    organization_num_employees_ranges: HEADCOUNT_RANGES,
    per_page: PER_PAGE,
    page,
  };

  const resp = await fetch('https://api.apollo.io/v1/mixed_people/api_search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': env.APOLLO_API_KEY,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Apollo search ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.people || [];
}

async function apolloEnrichPerson(env, personId) {
  try {
    const resp = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': env.APOLLO_API_KEY,
      },
      body: JSON.stringify({ id: personId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.person || null;
  } catch {
    return null;
  }
}

async function alreadySeeded(env, email, orgName) {
  if (email) {
    const byEmail = await env.DB.prepare(
      `SELECT id FROM catering_leads WHERE LOWER(contact_email) = LOWER(?) LIMIT 1`
    ).bind(email).first();
    if (byEmail) return true;
  }
  if (orgName) {
    const byName = await env.DB.prepare(
      `SELECT id FROM catering_leads WHERE LOWER(name) = LOWER(?) LIMIT 1`
    ).bind(orgName).first();
    if (byName) return true;
  }
  return false;
}

function extractPerson(p) {
  const org = p.organization || {};
  const contactName = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null;
  return {
    apollo_id: p.id,
    email: p.email || null,
    has_email: Boolean(p.has_email || p.email),
    contact_name: contactName,
    contact_title: p.title || null,
    linkedin: p.linkedin_url || null,
    org_name: org.name || null,
    org_domain: org.primary_domain || org.website_url || null,
    org_industry: org.industry || null,
    org_employees: org.estimated_num_employees || null,
    org_city: org.city || null,
    org_state: org.state || null,
    org_website: org.website_url || null,
  };
}

async function runCateringScout(env) {
  if (!env.APOLLO_API_KEY) {
    return { error: 'APOLLO_API_KEY missing' };
  }

  const t0 = Date.now();
  console.log('[CateringScout] Starting Apollo pull…');

  // Two passes — one for high-value titles, one for broader ops titles
  const passes = [
    ICP_TITLES.slice(0, 4),   // decision-maker-ish
    ICP_TITLES.slice(4),      // events/ops people
  ];

  const seeded = [];
  let considered = 0;
  let dedup = 0;
  let noEmail = 0;

  for (const titles of passes) {
    if (seeded.length >= MAX_PER_RUN) break;

    let people = [];
    try {
      people = await apolloSearch(env, { titles, page: 1 });
    } catch (err) {
      console.error(`[CateringScout] Apollo search failed:`, err.message);
      continue;
    }
    console.log(`[CateringScout] Pass (${titles.join(', ')}): ${people.length} people`);

    for (const raw of people) {
      if (seeded.length >= MAX_PER_RUN) break;
      considered++;

      const p = extractPerson(raw);

      if (await alreadySeeded(env, p.email, p.org_name)) {
        dedup++;
        continue;
      }

      // Enrich if no email yet
      if (!p.email && p.apollo_id) {
        const enriched = await apolloEnrichPerson(env, p.apollo_id);
        if (enriched?.email) {
          p.email = enriched.email;
          p.contact_name = p.contact_name || enriched.name || null;
          p.contact_title = p.contact_title || enriched.title || null;
        }
        await new Promise(r => setTimeout(r, 300));
      }

      if (!p.email) {
        noEmail++;
        continue;
      }

      // Re-dedup by email after enrichment
      if (await alreadySeeded(env, p.email, null)) {
        dedup++;
        continue;
      }

      const leadId = crypto.randomUUID();
      try {
        await env.DB.prepare(`
          INSERT INTO catering_leads (
            id, name, contact_name, contact_title, contact_email,
            headcount, industry, city, state, website, linkedin,
            source, source_customer_id,
            status, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'apollo', ?, 'prospect', ?, datetime('now'), datetime('now'))
        `).bind(
          leadId,
          p.org_name || p.email.split('@')[1],
          p.contact_name,
          p.contact_title,
          p.email.trim().toLowerCase(),
          p.org_employees || null,
          p.org_industry,
          p.org_city || 'Salt Lake City',
          p.org_state || 'UT',
          p.org_website,
          p.linkedin,
          p.apollo_id,
          `Apollo catering ICP: ${p.contact_title || 'unknown title'} @ ${p.org_name || 'unknown co'} (${p.org_employees || '?'} employees)`,
        ).run();
        seeded.push({ lead_id: leadId, email: p.email, org: p.org_name, title: p.contact_title });
        console.log(`[CateringScout] Seeded ${p.org_name}: ${p.contact_name} <${p.email}> (${p.contact_title})`);
      } catch (err) {
        console.error(`[CateringScout] Insert failed for ${p.email}:`, err.message);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  }

  const summary = {
    considered,
    seeded: seeded.length,
    dedup,
    no_email: noEmail,
    duration_ms: Date.now() - t0,
  };
  console.log(`[CateringScout] Done:`, summary);
  return summary;
}

export default {
  async scheduled(event, env, ctx) {
    return runCateringScout(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/catering-scout/run' && request.method === 'POST') {
      const result = await runCateringScout(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/catering-scout/preview' && request.method === 'GET') {
      try {
        const people = await apolloSearch(env, { titles: ICP_TITLES, page: 1 });
        const preview = people.slice(0, 15).map(p => {
          const e = extractPerson(p);
          return {
            name: e.contact_name,
            title: e.contact_title,
            company: e.org_name,
            headcount: e.org_employees,
            city: e.org_city,
            has_email: e.has_email,
            email: e.email,
          };
        });
        return new Response(JSON.stringify({ count: preview.length, preview }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    return new Response('Catering Scout', { status: 200 });
  },
};
