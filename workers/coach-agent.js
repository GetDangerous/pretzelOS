/**
 * Dangerous Pretzel Co — Business Coach Agent
 * Cloudflare Worker (HTTP only — no cron)
 *
 * A dedicated conversational agent whose only job is to deeply
 * understand the business and teach that understanding to the
 * other agents. This is NOT the general chat interface — it is
 * a structured knowledge-building conversation.
 *
 * Three modes:
 *   1. TEACH — Drew explains something, Coach asks follow-up questions,
 *              extracts precise instructions, saves to business_brain
 *   2. REVIEW — Drew reviews what the brain currently knows,
 *               edits, archives outdated entries
 *   3. QUESTIONS — Drew answers questions agents have flagged
 *                  when they encountered uncertain situations
 *
 * Endpoints:
 *   POST /coach/teach     → {message, session_id?} → conversational interview
 *   POST /coach/review    → {scope?} → show brain entries, accept edits
 *   GET  /coach/questions → pending agent questions for Drew to answer
 *   POST /coach/answer    → {question_id, answer} → save answer to brain
 *   GET  /coach/brain     → full brain contents, filterable by scope
 *   POST /coach/archive   → {brain_id} → deactivate an entry
 *   POST /coach/edit      → {brain_id, instruction} → update an entry
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   DB, KV
 */

const COACH_SESSION_TTL = 60 * 60 * 4;  // 4 hours — longer than chat sessions

// ── COACH TOOLS ───────────────────────────────────────────────────────────────
const COACH_TOOLS = [
  {
    name: 'save_to_brain',
    description: 'Save a piece of business knowledge or instruction to the business brain. Only call this after you have asked enough follow-up questions to be confident the instruction is precise and complete. Always show Drew what you are about to save and confirm before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Which agent(s) this applies to: all | outreach | catering | retail | cfo | optimizer | account',
        },
        category: {
          type: 'string',
          description: 'Type of knowledge: nuance | avoid | timing | voice | product | account | market | competitor | pricing | logistics',
        },
        instruction: {
          type: 'string',
          description: 'The instruction in plain English, written as a direct statement an agent can act on. Specific and unambiguous. One idea per entry.',
        },
        entity_name: {
          type: 'string',
          description: 'If this applies to a specific venue, account, or lead — their name. Otherwise omit.',
        },
        reasoning: {
          type: 'string',
          description: 'Why this matters — the context Drew gave that explains this instruction. Stored for reference but not shown to agents.',
        },
      },
      required: ['scope', 'category', 'instruction'],
    },
  },
  {
    name: 'read_brain',
    description: 'Read existing business brain entries. Use this to check what the system already knows before asking Drew to repeat himself, or to show Drew what is currently saved.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Filter by scope: all | outreach | catering | retail | cfo | account' },
        category: { type: 'string', description: 'Filter by category' },
        search: { type: 'string', description: 'Keyword to search instruction text' },
      },
    },
  },
  {
    name: 'flag_uncertainty',
    description: 'Save a question from an agent — something the agent encountered and was uncertain about. Drew will see this and can answer it. Use when Drew mentions something that other agents might also encounter and need guidance on.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The specific question, phrased as if the agent is asking Drew directly' },
        context: { type: 'string', description: 'The situation that prompted the question' },
        applies_to: { type: 'string', description: 'Which agent would benefit from the answer' },
      },
      required: ['question', 'context'],
    },
  },
  {
    name: 'archive_brain_entry',
    description: 'Archive (deactivate) a brain entry that is outdated or incorrect. Call this when Drew says something like "that\'s no longer true" or "we changed that."',
    input_schema: {
      type: 'object',
      properties: {
        brain_id: { type: 'string', description: 'The ID of the entry to archive' },
        reason: { type: 'string', description: 'Why it is being archived' },
      },
      required: ['brain_id'],
    },
  },
  {
    name: 'update_brain_entry',
    description: 'Update the instruction text of an existing brain entry. Use when Drew says something like "that\'s mostly right but..." and wants to refine rather than replace.',
    input_schema: {
      type: 'object',
      properties: {
        brain_id: { type: 'string', description: 'The ID of the entry to update' },
        new_instruction: { type: 'string', description: 'The updated instruction text' },
        reason: { type: 'string', description: 'What changed and why' },
      },
      required: ['brain_id', 'new_instruction'],
    },
  },
  {
    name: 'get_pending_questions',
    description: 'Get questions that agents have flagged — situations they were uncertain about and need Drew to clarify.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'answer_question',
    description: 'Save Drew\'s answer to a pending agent question as a brain entry.',
    input_schema: {
      type: 'object',
      properties: {
        question_id: { type: 'string' },
        answer: { type: 'string', description: 'Drew\'s answer — will be saved as a brain instruction' },
        scope: { type: 'string', description: 'Which agent this answer applies to' },
      },
      required: ['question_id', 'answer', 'scope'],
    },
  },
];

// ── COACH SYSTEM PROMPT ───────────────────────────────────────────────────────
const COACH_SYSTEM_PROMPT = `You are the Business Coach for Dangerous Pretzel Co. Your job is to deeply understand this business and translate that understanding into precise instructions the other agents can act on.

You are NOT a general assistant. You are specifically focused on extracting, refining, and organizing business knowledge. Think of yourself as conducting an onboarding interview with Drew — the kind of deep conversation where you pull out the nuances, edge cases, and institutional knowledge that only he has.

ABOUT DANGEROUS PRETZEL CO:
- Premium SLC soft pretzel brand. "RUIN DINNER."
- Three channels: retail (352 W 600 S shop), wholesale (free warmer program at venues), catering (corporate events)
- Anchor accounts: Delta Center (NBA Jazz), Powder Mountain, Alta Ski, SLC Bees, Union Event Center, Pioneer Theater, 4 breweries
- Switching from Toast to Square. Payroll external.
- High close rate when in front of people — the challenge is volume and reach
- SLC is a small, connected market — reputation matters enormously

YOUR APPROACH:

When Drew tells you something:
1. Don't just take notes — ask follow-up questions to understand the WHY
2. Surface edge cases: "Does that apply to all breweries or just taprooms?"
3. Check for contradictions with what's already in the brain (use read_brain)
4. Extract the precise, actionable instruction from the context Drew gives
5. Before saving, show Drew EXACTLY what you plan to save and ask if it captures it correctly
6. One idea per brain entry — never combine multiple instructions into one

When Drew says something vague:
- "We don't do hotel bars" → ask: "Is that all hotels, or specifically hotel bars without food programs? What about hotel lobby setups or rooftop bars?"
- "The Spicy Bee sells itself" → ask: "Do you mean you lead with it in all pitches, or only certain venue types? Does it work better with certain customer demographics?"
- "Breweries are our best accounts" → ask: "What specifically makes them convert — is it the alcohol/pretzel pairing, the culture, the GM decision-making speed, or something else?"

When Drew wants to review what agents know:
- Read the brain for the relevant scope
- Walk him through each entry conversationally
- Ask if anything has changed or needs updating
- Flag anything that might be outdated based on what he's told you

When answering agent questions:
- Read the pending question carefully
- Ask Drew any clarifying questions before saving the answer
- Make sure the answer is specific enough that the agent won't need to ask again

WHAT MAKES A GOOD BRAIN ENTRY:
Good: "Do not pitch hotel bars. After 12 contacts with zero closes over 3 months, this category does not convert. Redirect Scout budget to entertainment venues."
Bad: "Hotel bars don't work."

Good: "When emailing breweries, reference a specific beer style or recent release visible on their website or Instagram. Pairing the Spicy Bee (chili-cheddar, hot honey, candied jalapeños) with a Hazy IPA or West Coast IPA lands well. This specificity signals we actually know their product."
Bad: "Personalize brewery emails."

Good: "Law firms in SLC are effectively closed January 1-15 as partners ski. Catering outreach to legal industry should pause January 1 and resume January 16 with a tax season angle."
Bad: "Don't email law firms in January."

TONE:
Conversational, curious, sharp. You are genuinely trying to understand the business — not filling out a form. Ask follow-up questions naturally. When Drew gives you a rich answer, reflect it back to make sure you got it right. When something he says contradicts something already in the brain, flag it directly: "That's different from what I have saved — you previously said X. Should I update that?"

CONFIRMATION BEFORE SAVING:
Always show Drew what you plan to save before calling save_to_brain. Format it clearly:

"Here's what I'm going to save:
→ Applies to: [scope]
→ Category: [category]
→ Instruction: [exact text]

Does that capture it correctly, or would you like to adjust anything?"

Only call save_to_brain after Drew confirms.`;

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    let response;

    if (path === '/coach/teach' && request.method === 'POST') {
      response = await handleTeach(request, env);
    } else if (path === '/coach/questions') {
      response = await handleGetQuestions(env);
    } else if (path === '/coach/answer' && request.method === 'POST') {
      response = await handleAnswerQuestion(request, env);
    } else if (path === '/coach/brain') {
      response = await handleGetBrain(request, env);
    } else if (path === '/coach/review' && request.method === 'POST') {
      // Review mode: return brain entries grouped by category, filterable by scope
      const body = await request.json().catch(() => ({}));
      const scope = body.scope || 'all';
      const query = scope === 'all'
        ? `SELECT * FROM business_brain WHERE active = 1 ORDER BY category, created_at DESC`
        : `SELECT * FROM business_brain WHERE active = 1 AND (scope = ? OR scope = 'all') ORDER BY category, created_at DESC`;
      const results = scope === 'all'
        ? await env.DB.prepare(query).all()
        : await env.DB.prepare(query).bind(scope).all();
      // Group by category
      const grouped = {};
      for (const entry of (results.results || [])) {
        if (!grouped[entry.category]) grouped[entry.category] = [];
        grouped[entry.category].push(entry);
      }
      response = new Response(JSON.stringify({ scope, categories: grouped, total: results.results?.length || 0 }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else if (path === '/coach/archive' && request.method === 'POST') {
      response = await handleArchive(request, env);
    } else if (path === '/coach/edit' && request.method === 'POST') {
      response = await handleEdit(request, env);
    } else {
      response = new Response(JSON.stringify({
        name: 'Business Coach',
        modes: ['/coach/teach', '/coach/questions', '/coach/brain'],
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    Object.entries(cors).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  }
};

// ── TEACH MODE ────────────────────────────────────────────────────────────────
async function handleTeach(request, env) {
  const body = await request.json();
  const { message, session_id } = body;

  if (!message?.trim()) {
    return json({ error: 'Message required' }, 400);
  }

  const sessionId = session_id || crypto.randomUUID();
  const sessionKey = `coach_session:${sessionId}`;
  let history = [];

  try {
    const stored = await env.KV.get(sessionKey);
    if (stored) history = JSON.parse(stored);
  } catch {}

  // Trim to last 30 turns (coach conversations can be long)
  if (history.length > 60) history = history.slice(-60);

  history.push({ role: 'user', content: message });
  const messages = [...history];

  let reply = '';
  let saved = [];
  let archived = [];
  let loops = 0;

  while (loops < 8) {
    loops++;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: COACH_SYSTEM_PROMPT,
        tools: COACH_TOOLS,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return json({ error: err }, 500);
    }

    const data = await response.json();
    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn') {
      const textBlock = data.content.find(b => b.type === 'text');
      reply = textBlock?.text || '';
      break;
    }

    if (data.stop_reason === 'tool_use') {
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeCoachTool(toolUse.name, toolUse.input, env);
        if (toolUse.name === 'save_to_brain' && result.id) saved.push(result);
        if (toolUse.name === 'archive_brain_entry') archived.push(toolUse.input.brain_id);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  // Save clean history
  const storableHistory = messages
    .filter(m => typeof m.content === 'string' ||
      (Array.isArray(m.content) && m.content.some(b => b.type === 'text')))
    .map(m => {
      if (Array.isArray(m.content)) {
        const text = m.content.find(b => b.type === 'text')?.text || '';
        return { role: m.role, content: text };
      }
      return m;
    })
    .slice(-60);

  await env.KV.put(sessionKey, JSON.stringify(storableHistory), {
    expirationTtl: COACH_SESSION_TTL,
  });

  return json({ reply, session_id: sessionId, saved, archived });
}

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeCoachTool(toolName, input, env) {
  switch (toolName) {

    case 'save_to_brain': {
      const id = `bb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await env.DB.prepare(`
        INSERT INTO business_brain (
          id, scope, category, instruction, entity_name, source,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'coach', 1, datetime('now'), datetime('now'))
      `).bind(
        id,
        input.scope || 'all',
        input.category || 'nuance',
        input.instruction,
        input.entity_name || null
      ).run();

      // Also store reasoning in KV for reference (not shown to agents)
      if (input.reasoning) {
        await env.KV.put(
          `brain_reasoning:${id}`,
          input.reasoning,
          { expirationTtl: 60 * 60 * 24 * 365 }
        );
      }

      console.log(`[Coach] Saved to brain: ${id} — ${input.instruction.slice(0, 60)}...`);
      return { success: true, id, instruction: input.instruction };
    }

    case 'read_brain': {
      let query = 'SELECT * FROM business_brain WHERE active = 1';
      const params = [];

      if (input.scope && input.scope !== 'all') {
        query += ' AND (scope = ? OR scope = "all")';
        params.push(input.scope);
      }
      if (input.category) {
        query += ' AND category = ?';
        params.push(input.category);
      }
      if (input.search) {
        query += ' AND instruction LIKE ?';
        params.push(`%${input.search}%`);
      }

      query += ' ORDER BY scope, category, created_at DESC';

      const entries = params.length
        ? await env.DB.prepare(query).bind(...params).all()
        : await env.DB.prepare(query).all();

      return { entries: entries.results || [], count: entries.results?.length || 0 };
    }

    case 'flag_uncertainty': {
      const id = `pq_${Date.now()}`;
      await env.KV.put(
        `pending_question:${id}`,
        JSON.stringify({
          id,
          question: input.question,
          context: input.context,
          applies_to: input.applies_to || 'all',
          asked_at: new Date().toISOString(),
          answered: false,
        }),
        { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
      );
      return { success: true, id };
    }

    case 'archive_brain_entry': {
      await env.DB.prepare(`
        UPDATE business_brain
        SET active = 0, updated_at = datetime('now')
        WHERE id = ?
      `).bind(input.brain_id).run();

      if (input.reason) {
        await env.KV.put(
          `brain_archived:${input.brain_id}`,
          JSON.stringify({ reason: input.reason, archived_at: new Date().toISOString() })
        );
      }

      return { success: true, archived_id: input.brain_id };
    }

    case 'update_brain_entry': {
      await env.DB.prepare(`
        UPDATE business_brain
        SET instruction = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(input.new_instruction, input.brain_id).run();

      if (input.reason) {
        await env.KV.put(
          `brain_update:${input.brain_id}:${Date.now()}`,
          JSON.stringify({ reason: input.reason, updated_at: new Date().toISOString() })
        );
      }

      return { success: true, updated_id: input.brain_id };
    }

    case 'get_pending_questions': {
      const keys = await env.KV.list({ prefix: 'pending_question:' });
      const questions = [];

      for (const key of (keys.keys || []).slice(0, 20)) {
        try {
          const raw = await env.KV.get(key.name);
          if (raw) {
            const q = JSON.parse(raw);
            if (!q.answered) questions.push(q);
          }
        } catch {}
      }

      return { questions, count: questions.length };
    }

    case 'answer_question': {
      // Save answer as brain entry
      const brainId = `bb_ans_${Date.now()}`;
      await env.DB.prepare(`
        INSERT INTO business_brain (
          id, scope, category, instruction, source, active, created_at, updated_at
        ) VALUES (?, ?, 'nuance', ?, 'coach_answer', 1, datetime('now'), datetime('now'))
      `).bind(brainId, input.scope || 'all', input.answer).run();

      // Mark question as answered
      try {
        const raw = await env.KV.get(`pending_question:${input.question_id}`);
        if (raw) {
          const q = JSON.parse(raw);
          q.answered = true;
          q.answered_at = new Date().toISOString();
          q.brain_id = brainId;
          await env.KV.put(
            `pending_question:${input.question_id}`,
            JSON.stringify(q)
          );
        }
      } catch {}

      return { success: true, brain_id: brainId };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── ENDPOINT HANDLERS ─────────────────────────────────────────────────────────
async function handleGetQuestions(env) {
  const keys = await env.KV.list({ prefix: 'pending_question:' });
  const questions = [];

  for (const key of (keys.keys || []).slice(0, 30)) {
    try {
      const raw = await env.KV.get(key.name);
      if (raw) {
        const q = JSON.parse(raw);
        if (!q.answered) questions.push(q);
      }
    } catch {}
  }

  return json({ questions, count: questions.length });
}

async function handleAnswerQuestion(request, env) {
  const body = await request.json();
  const { question_id, answer, scope } = body;

  if (!question_id || !answer) {
    return json({ error: 'question_id and answer required' }, 400);
  }

  const result = await executeCoachTool('answer_question', { question_id, answer, scope }, env);
  return json(result);
}

async function handleGetBrain(request, env) {
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope');
  const category = url.searchParams.get('category');

  const result = await executeCoachTool('read_brain', { scope, category }, env);
  return json(result);
}

async function handleArchive(request, env) {
  const body = await request.json();
  const result = await executeCoachTool('archive_brain_entry', body, env);
  return json(result);
}

async function handleEdit(request, env) {
  const body = await request.json();
  const result = await executeCoachTool('update_brain_entry', body, env);
  return json(result);
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
