/**
 * Dangerous Pretzel Co — Brain Loader
 * Shared utility imported by every agent worker.
 *
 * Reads active business_brain entries for a given scope
 * and returns a formatted string to inject into agent system prompts.
 *
 * Usage in any agent:
 *   import { loadBrain } from './brain-loader.js';
 *
 *   // At the start of every agent run:
 *   const brainContext = await loadBrain(env, 'outreach');
 *
 *   // Inject into system prompt:
 *   const fullSystemPrompt = `${AGENT_SYSTEM_PROMPT}\n\n${brainContext}`;
 *
 * The brain is read fresh on every agent run — so when Drew
 * teaches the Coach something new, agents pick it up immediately
 * on their next scheduled run. No redeploy needed.
 */

export async function loadBrain(env, agentScope) {
  try {
    // Fetch entries that apply to this agent or to all agents
    const entries = await env.DB.prepare(`
      SELECT id, scope, category, instruction, entity_name, use_count
      FROM business_brain
      WHERE active = 1
        AND (scope = ? OR scope = 'all')
      ORDER BY
        CASE scope WHEN ? THEN 0 ELSE 1 END,  -- agent-specific first
        CASE category
          WHEN 'avoid'   THEN 0  -- avoid rules first — most critical
          WHEN 'nuance'  THEN 1
          WHEN 'timing'  THEN 2
          WHEN 'voice'   THEN 3
          WHEN 'product' THEN 4
          WHEN 'account' THEN 5
          WHEN 'market'  THEN 6
          ELSE 7
        END,
        created_at DESC
    `).bind(agentScope, agentScope).all();

    const rows = entries.results || [];

    if (rows.length === 0) return '';

    // Update use counts in background (don't await — don't slow agent down)
    const ids = rows.map(r => r.id);
    env.DB.prepare(`
      UPDATE business_brain
      SET use_count = use_count + 1, last_used_at = datetime('now')
      WHERE id IN (${ids.map(() => '?').join(',')})
    `).bind(...ids).run().catch(() => {});  // silent fail OK

    // Format as a clear, readable block for the agent's system prompt
    const grouped = groupByCategory(rows);
    const sections = [];

    if (grouped.avoid?.length) {
      sections.push(
        '⛔ NEVER DO THESE (Drew has explicitly ruled these out):',
        ...grouped.avoid.map(r => formatEntry(r))
      );
    }

    if (grouped.timing?.length) {
      sections.push(
        '⏰ TIMING RULES:',
        ...grouped.timing.map(r => formatEntry(r))
      );
    }

    if (grouped.nuance?.length) {
      sections.push(
        '💡 BUSINESS NUANCES (important context):',
        ...grouped.nuance.map(r => formatEntry(r))
      );
    }

    if (grouped.voice?.length) {
      sections.push(
        '🗣️ VOICE AND TONE:',
        ...grouped.voice.map(r => formatEntry(r))
      );
    }

    if (grouped.product?.length) {
      sections.push(
        '🥨 PRODUCT KNOWLEDGE:',
        ...grouped.product.map(r => formatEntry(r))
      );
    }

    if (grouped.account?.length) {
      sections.push(
        '🏢 ACCOUNT INTELLIGENCE:',
        ...grouped.account.map(r => formatEntry(r))
      );
    }

    if (grouped.market?.length) {
      sections.push(
        '📍 MARKET KNOWLEDGE:',
        ...grouped.market.map(r => formatEntry(r))
      );
    }

    if (grouped.competitor?.length) {
      sections.push(
        '⚔️ COMPETITOR INTEL:',
        ...grouped.competitor.map(r => formatEntry(r))
      );
    }

    // Remaining categories
    const knownCategories = ['avoid', 'timing', 'nuance', 'voice', 'product', 'account', 'market', 'competitor'];
    const remaining = rows.filter(r => !knownCategories.includes(r.category));
    if (remaining.length) {
      sections.push(
        '📋 ADDITIONAL GUIDANCE:',
        ...remaining.map(r => formatEntry(r))
      );
    }

    return [
      '═══════════════════════════════════════',
      'BUSINESS BRAIN — Drew\'s instructions to you',
      'These override default behavior. Follow them precisely.',
      '═══════════════════════════════════════',
      '',
      ...sections,
      '',
      '═══════════════════════════════════════',
    ].join('\n');

  } catch (err) {
    // Brain loading failure should never crash an agent
    console.error('[Brain] Failed to load:', err.message);
    return '';
  }
}

// ── ALSO LOAD PENDING AGENT QUESTIONS ─────────────────────────────────────────
// Agents call this to flag situations they're uncertain about.
// The question gets saved to KV for Drew to answer via the Coach.
export async function flagUncertainty(env, agentName, question, context) {
  try {
    const id = `pq_${agentName}_${Date.now()}`;
    await env.KV.put(
      `pending_question:${id}`,
      JSON.stringify({
        id,
        question,
        context,
        applies_to: agentName,
        asked_at: new Date().toISOString(),
        answered: false,
      }),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );
    console.log(`[Brain] Question flagged by ${agentName}: ${question.slice(0, 60)}`);
  } catch (err) {
    console.error('[Brain] Failed to flag uncertainty:', err.message);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function groupByCategory(rows) {
  return rows.reduce((acc, row) => {
    if (!acc[row.category]) acc[row.category] = [];
    acc[row.category].push(row);
    return acc;
  }, {});
}

function formatEntry(row) {
  const entityPrefix = row.entity_name ? `[Re: ${row.entity_name}] ` : '';
  return `• ${entityPrefix}${row.instruction}`;
}
