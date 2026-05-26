/**
 * Dangerous Pretzel Co — Qualifier Worker
 * Cloudflare Worker (cron: Monday 7am MT, 1hr after Scout)
 *
 * Reads unqualified venues from D1, sends each to Claude with
 * enriched data and scoring rubric, writes back tier + qual_summary.
 *
 * Key improvement: receives Apollo metadata (industry, description,
 * employee count) for better scoring. Can REJECT venues outright.
 * Tier 3 and rejected venues are auto-archived.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY   — Claude API key
 *   DB                  — D1 binding (pretzel-os)
 */

import { callAI } from './ai-budget.js';

const BATCH_SIZE = 15;

export default {
  async scheduled(event, env, ctx) {
    return runQualifierLoop(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/qualifier/run') {
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
    // Re-qualify ALL prospects (including ones with existing tier)
    // Used to clean up old data scored with minimal info
    if (url.pathname === '/qualifier/requalify') {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM venues WHERE status IN ('prospect', 'hold', 'drew_flag')"
      ).first();
      ctx.waitUntil(requalifyAll(env));
      return new Response(JSON.stringify({
        status: 'requalify started — re-scoring all prospects with enhanced data',
        total: count?.count || 0,
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

  // Get unqualified prospects — now includes Apollo metadata
  const unqualified = await env.DB.prepare(`
    SELECT id, name, category, city, address, website, instagram,
           contact_title, notes,
           apollo_industry, apollo_description, apollo_employees, apollo_revenue,
           avg_rating, review_count
    FROM venues
    WHERE tier IS NULL AND status = 'prospect'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(BATCH_SIZE).all();

  const venues = unqualified.results || [];
  console.log(`[Qualifier] Processing ${venues.length} unqualified venues`);

  let qualified = 0, rejected = 0, archived = 0;

  for (const venue of venues) {
    try {
      // Build enriched venue data package
      const venueData = JSON.stringify({
        name: venue.name,
        category: venue.category,
        city: venue.city,
        address: venue.address,
        website: venue.website,
        contact_title: venue.contact_title,
        notes: venue.notes,
        // NEW: Apollo metadata for better scoring
        industry: venue.apollo_industry || null,
        description: venue.apollo_description || null,
        employee_count: venue.apollo_employees || null,
        revenue: venue.apollo_revenue || null,
        // NEW: Review data
        avg_rating: venue.avg_rating || null,
        review_count: venue.review_count || null,
        instagram: venue.instagram || null,
      });

      const prompt = promptRow.prompt_text.replace('{{venue_data}}', venueData);

      const result = await callClaude(env.ANTHROPIC_API_KEY, promptRow.system_context, prompt, env);

      let parsed;
      try {
        const clean = result.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        console.error(`[Qualifier] Failed to parse response for ${venue.name}:`, result);
        continue;
      }

      const { score, tier, icp_fit, summary } = parsed;
      const resolvedTier = tier === 'reject' ? 0 : (tier || scoreTier(score));
      const resolvedScore = score || 0;

      // ── AUTO-ARCHIVE: Tier 3, rejected, or score < 25 ──
      if (resolvedTier === 0 || resolvedTier >= 3 || resolvedScore < 25) {
        await env.DB.prepare(`
          UPDATE venues
          SET status = 'inactive', tier = ?, qual_score = ?, icp_fit = ?,
              qual_summary = ?, updated_at = datetime('now'),
              notes = COALESCE(notes,'') || char(10) || '[Auto-archived by qualifier: ' || ? || ']'
          WHERE id = ?
        `).bind(
          resolvedTier, resolvedScore,
          icp_fit || 'rejected',
          summary || '',
          summary || 'Low score / rejected',
          venue.id
        ).run();

        // Log to scout_rejections for feedback loop
        try {
          await env.DB.prepare(`
            INSERT INTO scout_rejections (id, apollo_id, name, city, category, industry, description, rejection_source, rejection_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'qualifier', ?)
          `).bind(
            crypto.randomUUID(), venue.id, venue.name, venue.city,
            venue.category, venue.apollo_industry || null,
            (venue.apollo_description || '').slice(0, 500),
            summary || 'Tier 3 / rejected'
          ).run();
        } catch {}

        archived++;
        console.log(`[Qualifier] ✗ ${venue.name}: score=${resolvedScore}, tier=${resolvedTier} — AUTO-ARCHIVED`);
      } else {
        // Tier 1 or 2 — keep in pipeline
        await env.DB.prepare(`
          UPDATE venues
          SET tier = ?, qual_score = ?, icp_fit = ?, qual_summary = ?, updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          resolvedTier, resolvedScore,
          icp_fit || 'unknown',
          summary || '',
          venue.id
        ).run();

        qualified++;
        console.log(`[Qualifier] ✓ ${venue.name}: score=${resolvedScore}, tier=${resolvedTier}`);
      }

      // Track prompt usage
      await env.DB.prepare(`
        UPDATE agent_prompts SET uses = uses + 1 WHERE agent_name = 'qualifier'
      `).run();

    } catch (err) {
      console.error(`[Qualifier] Error on ${venue.name}:`, err.message);
    }
  }

  console.log(`[Qualifier] Done. Qualified: ${qualified}, Auto-archived: ${archived}, Total: ${venues.length}`);
  return { qualified, archived, total: venues.length };
}

async function runQualifierLoop(env) {
  let totalQualified = 0, totalArchived = 0;
  let batchNum = 0;
  const MAX_BATCHES = 25;

  while (batchNum < MAX_BATCHES) {
    batchNum++;
    const result = await runQualifier(env);
    totalQualified += result.qualified;
    totalArchived += result.archived;

    if (result.total === 0) {
      console.log(`[Qualifier] All venues processed after ${batchNum} batches. Qualified: ${totalQualified}, Archived: ${totalArchived}`);
      break;
    }

    console.log(`[Qualifier] Batch ${batchNum}: ${result.qualified} qualified, ${result.archived} archived`);
  }

  return { totalQualified, totalArchived, batches: batchNum };
}

// Re-qualify ALL prospects — used when qualifier prompt/data has been enhanced
// Skips active, contacted, replied venues to not disrupt active conversations
async function requalifyAll(env) {
  const promptRow = await env.DB.prepare(
    "SELECT prompt_text, system_context FROM agent_prompts WHERE agent_name = 'qualifier' AND active = 1"
  ).first();
  if (!promptRow) { console.error('[Qualifier] Prompt not found'); return { error: 'no prompt' }; }

  let totalQualified = 0, totalArchived = 0, totalProcessed = 0;
  let batchNum = 0;
  const MAX_BATCHES = 30;

  while (batchNum < MAX_BATCHES) {
    batchNum++;
    // Fetch prospects that haven't been re-qualified yet in this run
    // Use updated_at check to avoid re-processing within same run
    const batch = await env.DB.prepare(`
      SELECT id, name, category, city, address, website, instagram,
             contact_title, notes,
             apollo_industry, apollo_description, apollo_employees, apollo_revenue,
             avg_rating, review_count, tier, qual_score
      FROM venues
      WHERE status IN ('prospect', 'hold', 'drew_flag')
        AND (updated_at < datetime('now', '-1 minute') OR updated_at IS NULL)
      ORDER BY tier ASC NULLS FIRST, created_at ASC
      LIMIT ?
    `).bind(BATCH_SIZE).all();

    const venues = batch.results || [];
    if (venues.length === 0) {
      console.log(`[Qualifier] Requalify complete after ${batchNum} batches. Qualified: ${totalQualified}, Archived: ${totalArchived}`);
      break;
    }

    for (const venue of venues) {
      try {
        const venueData = JSON.stringify({
          name: venue.name, category: venue.category, city: venue.city,
          address: venue.address, website: venue.website,
          contact_title: venue.contact_title, notes: venue.notes,
          industry: venue.apollo_industry || null,
          description: venue.apollo_description || null,
          employee_count: venue.apollo_employees || null,
          revenue: venue.apollo_revenue || null,
          avg_rating: venue.avg_rating || null,
          review_count: venue.review_count || null,
          instagram: venue.instagram || null,
          previous_tier: venue.tier, previous_score: venue.qual_score,
        });

        const prompt = promptRow.prompt_text.replace('{{venue_data}}', venueData);
        const result = await callClaude(env.ANTHROPIC_API_KEY, promptRow.system_context, prompt, env);

        let parsed;
        try {
          const clean = result.replace(/```json\n?|\n?```/g, '').trim();
          parsed = JSON.parse(clean);
        } catch {
          console.error(`[Qualifier] Parse failed for ${venue.name}:`, result);
          // Mark as processed so we don't retry
          await env.DB.prepare('UPDATE venues SET updated_at = datetime(\'now\') WHERE id = ?').bind(venue.id).run();
          continue;
        }

        const { score, tier, icp_fit, summary } = parsed;
        const resolvedTier = tier === 'reject' ? 0 : (tier || scoreTier(score));
        const resolvedScore = score || 0;

        if (resolvedTier === 0 || resolvedTier >= 3 || resolvedScore < 25) {
          await env.DB.prepare(`
            UPDATE venues
            SET status = 'inactive', tier = ?, qual_score = ?, icp_fit = ?,
                qual_summary = ?, updated_at = datetime('now'),
                notes = COALESCE(notes,'') || char(10) || '[Requalified & archived: ' || ? || ']'
            WHERE id = ?
          `).bind(resolvedTier, resolvedScore, icp_fit || 'rejected', summary || '', summary || 'Low score', venue.id).run();

          try {
            await env.DB.prepare(`
              INSERT INTO scout_rejections (id, apollo_id, name, city, category, industry, description, rejection_source, rejection_reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'qualifier', ?)
            `).bind(crypto.randomUUID(), venue.id, venue.name, venue.city, venue.category,
              venue.apollo_industry || null, (venue.apollo_description || '').slice(0, 500),
              summary || 'Requalified: tier 3 / rejected'
            ).run();
          } catch {}

          totalArchived++;
          console.log(`[Qualifier] ✗ ${venue.name}: ${resolvedScore}/100 tier=${resolvedTier} — ARCHIVED (was tier=${venue.tier})`);
        } else {
          await env.DB.prepare(`
            UPDATE venues
            SET tier = ?, qual_score = ?, icp_fit = ?, qual_summary = ?, updated_at = datetime('now')
            WHERE id = ?
          `).bind(resolvedTier, resolvedScore, icp_fit || 'unknown', summary || '', venue.id).run();
          totalQualified++;
          console.log(`[Qualifier] ✓ ${venue.name}: ${resolvedScore}/100 tier=${resolvedTier} (was tier=${venue.tier})`);
        }

        totalProcessed++;
        await env.DB.prepare('UPDATE agent_prompts SET uses = uses + 1 WHERE agent_name = \'qualifier\'').run();
      } catch (err) {
        console.error(`[Qualifier] Error on ${venue.name}:`, err.message);
        await env.DB.prepare('UPDATE venues SET updated_at = datetime(\'now\') WHERE id = ?').bind(venue.id).run();
      }
    }
    console.log(`[Qualifier] Requalify batch ${batchNum}: processed ${venues.length}`);
  }

  return { totalProcessed, totalQualified, totalArchived, batches: batchNum };
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
  const aiResult = await workerAI(env, systemPrompt, userPrompt);
  if (aiResult) return aiResult;

  // DIF-3 (May 13 2026): wired through ai-budget
  const result = await callAI(env, {
    use_case: 'lead_qualification',
    model: 'haiku',
    caller: 'qualifier-worker.js',
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (!result.ok) {
    throw new Error(`Claude API error: ${result.blocked_reason || result.error || 'unknown'}`);
  }

  return result.content || '';
}

function scoreTier(score) {
  if (score >= 70) return 1;
  if (score >= 45) return 2;
  return 3;
}
