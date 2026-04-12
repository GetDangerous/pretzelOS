/**
 * Dangerous Pretzel Co — Qualifier Worker
 * Cloudflare Worker (cron: Monday 7am MT, 1hr after Scout)
 *
 * Reads unqualified venues from D1, sends each to Claude with
 * scoring rubric, writes back tier + qual_summary.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY   — Claude API key
 *   DB                  — D1 binding (pretzel-os)
 */

const BATCH_SIZE = 10; // Claude calls per run — fits in 30s Worker limit

export default {
  async scheduled(event, env, ctx) {
    // Cron: run multiple batches back-to-back
    ctx.waitUntil(runQualifierLoop(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/qualifier/run') {
      // Fire and return immediately — Worker continues in background
      ctx.waitUntil(runQualifier(env));
      const remaining = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM venues WHERE tier IS NULL AND status = 'prospect'"
      ).first();
      return new Response(JSON.stringify({
        status: 'qualifier started',
        batch_size: BATCH_SIZE,
        remaining: remaining?.count || 0,
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // Run all unqualified in batches (for manual catch-up)
    if (url.pathname === '/qualifier/run-all') {
      ctx.waitUntil(runQualifierLoop(env));
      const remaining = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM venues WHERE tier IS NULL AND status = 'prospect'"
      ).first();
      return new Response(JSON.stringify({
        status: 'qualifier loop started',
        remaining: remaining?.count || 0,
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Dangerous Pretzel Qualifier Worker', { status: 200 });
  }
};

async function runQualifier(env) {
  // Fetch the live prompt from D1 (optimizer can update this)
  const promptRow = await env.DB.prepare(
    "SELECT prompt_text, system_context FROM agent_prompts WHERE agent_name = 'qualifier' AND active = 1"
  ).first();

  if (!promptRow) {
    throw new Error('Qualifier prompt not found in agent_prompts table');
  }

  // Get unqualified prospects
  const unqualified = await env.DB.prepare(`
    SELECT id, name, category, city, address, website, instagram, contact_title, notes
    FROM venues
    WHERE tier IS NULL AND status = 'prospect'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(BATCH_SIZE).all();

  const venues = unqualified.results || [];
  console.log(`[Qualifier] Processing ${venues.length} unqualified venues`);

  let qualified = 0;

  for (const venue of venues) {
    try {
      const venueData = JSON.stringify({
        name: venue.name,
        category: venue.category,
        city: venue.city,
        address: venue.address,
        website: venue.website,
        contact_title: venue.contact_title,
        notes: venue.notes,
      });

      const prompt = promptRow.prompt_text.replace('{{venue_data}}', venueData);

      const result = await callClaude(env.ANTHROPIC_API_KEY, promptRow.system_context, prompt, env);

      // Parse Claude's JSON response
      let parsed;
      try {
        // Strip any markdown fences if present
        const clean = result.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        console.error(`[Qualifier] Failed to parse response for ${venue.name}:`, result);
        continue;
      }

      const { score, tier, icp_fit, summary } = parsed;

      await env.DB.prepare(`
        UPDATE venues
        SET tier = ?, qual_score = ?, icp_fit = ?, qual_summary = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        tier || scoreTier(score),
        score || 0,
        icp_fit || 'unknown',
        summary || '',
        venue.id
      ).run();

      // Track prompt usage
      await env.DB.prepare(`
        UPDATE agent_prompts SET uses = uses + 1 WHERE agent_name = 'qualifier'
      `).run();

      qualified++;

    } catch (err) {
      console.error(`[Qualifier] Error on ${venue.name}:`, err.message);
    }
  }

  console.log(`[Qualifier] Done. Qualified: ${qualified}/${venues.length}`);
  return { qualified, total: venues.length };
}

async function runQualifierLoop(env) {
  // Keep running batches until all venues are qualified
  let totalQualified = 0;
  let batchNum = 0;
  const MAX_BATCHES = 25; // safety limit: 25 × 10 = 250 venues max

  while (batchNum < MAX_BATCHES) {
    batchNum++;
    const result = await runQualifier(env);
    totalQualified += result.qualified;

    if (result.total === 0) {
      console.log(`[Qualifier] All venues qualified after ${batchNum} batches. Total: ${totalQualified}`);
      break;
    }

    console.log(`[Qualifier] Batch ${batchNum} done: ${result.qualified}/${result.total}`);
  }

  return { totalQualified, batches: batchNum };
}

async function workerAI(env, systemPrompt, userPrompt) {
  if (!env.AI) return null;
  try {
    const resp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 300,
    });
    return resp?.response || null;
  } catch { return null; }
}

async function callClaude(apiKey, systemPrompt, userPrompt, env) {
  // Try Workers AI first (free, no egress) — fall back to claude-haiku
  const aiResult = await workerAI(env, systemPrompt, userPrompt);
  if (aiResult) return aiResult;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

function scoreTier(score) {
  if (score >= 70) return 1;
  if (score >= 45) return 2;
  return 3;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
