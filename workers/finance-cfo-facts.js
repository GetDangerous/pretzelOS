// workers/finance-cfo-facts.js
// Drew-clarified knowledge that persists forever.
// When Drew clarifies something, the agent saves it here.
// Future categorizations + chat answers consult cfo_facts BEFORE deciding.
//
// Endpoints:
//   POST /finance/cfo-facts          — record a new fact
//   GET  /finance/cfo-facts/:subject — lookup facts about a subject
//   GET  /finance/cfo-facts          — list all active facts
//   POST /finance/cfo-facts/:id/supersede — mark stale, point to new
//   DELETE /finance/cfo-facts/:id    — deactivate

function normalizeSubject(s) {
  return (s || '').toLowerCase().trim().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').slice(0, 100);
}

const VALID_FACT_TYPES = new Set([
  'vendor_rule',          // "Sysco is always Food Purchases"
  'customer_term',        // "SLC Bees is Net 15 terms"
  'drew_preference',      // "always capitalize Webstaurant >$1K"
  'business_fact',        // "Toast retired May 1 2026"
  'capex_threshold',      // "treat $500+ as capex"
  'correction',           // Drew explicitly corrected an agent decision
  'loan_term',            // "LEASE SERVICES = pizza oven loan, 80/20 P/I split"
]);

// ── Record a fact ─────────────────────────────────────────────────────────
export async function recordFact(env, opts = {}) {
  const { fact_type, subject, content, structured_data, source = 'drew_chat', confidence = 1.0 } = opts;

  if (!VALID_FACT_TYPES.has(fact_type)) {
    return { error: `invalid fact_type. Must be one of: ${[...VALID_FACT_TYPES].join(', ')}` };
  }
  if (!subject || !content) return { error: 'subject and content required' };

  const id = crypto.randomUUID();
  const subjectNorm = normalizeSubject(subject);
  await env.DB.prepare(`
    INSERT INTO cfo_facts (id, fact_type, subject, subject_normalized, content,
      structured_data, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, fact_type, subject, subjectNorm, content,
    structured_data ? JSON.stringify(structured_data) : null,
    source, confidence,
  ).run();

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'cfo_fact_recorded', 'cfo_facts', ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), id, source,
    `Recorded ${fact_type} fact about "${subject}": ${content.slice(0, 200)}`,
    JSON.stringify({ fact_type, subject, content, structured_data }),
  ).run().catch(() => {});

  return { ok: true, id, fact_type, subject, content };
}

// ── Lookup facts about a subject ──────────────────────────────────────────
export async function lookupFacts(env, subject, factType = null) {
  if (!subject) return { facts: [] };
  const norm = normalizeSubject(subject);

  let query = `
    SELECT id, fact_type, subject, content, structured_data, source, confidence, created_at
    FROM cfo_facts
    WHERE active = 1 AND subject_normalized = ?
  `;
  const params = [norm];
  if (factType) { query += ` AND fact_type = ?`; params.push(factType); }
  query += ` ORDER BY created_at DESC`;

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return {
    subject,
    count: (results || []).length,
    facts: (results || []).map(f => ({
      ...f,
      structured_data: f.structured_data ? JSON.parse(f.structured_data) : null,
    })),
  };
}

// ── List all active facts ─────────────────────────────────────────────────
export async function listFacts(env, opts = {}) {
  const { fact_type, limit = 100 } = opts;
  let query = `
    SELECT id, fact_type, subject, content, source, confidence, created_at
    FROM cfo_facts WHERE active = 1
  `;
  const params = [];
  if (fact_type) { query += ` AND fact_type = ?`; params.push(fact_type); }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return { count: (results || []).length, facts: results || [] };
}

// ── Supersede / deactivate ────────────────────────────────────────────────
export async function supersedeFact(env, factId, newFactId) {
  await env.DB.prepare(`
    UPDATE cfo_facts SET superseded_by = ?, active = 0 WHERE id = ?
  `).bind(newFactId, factId).run();
  return { ok: true, id: factId, superseded_by: newFactId };
}

export async function deactivateFact(env, factId) {
  await env.DB.prepare(
    `UPDATE cfo_facts SET active = 0 WHERE id = ?`
  ).bind(factId).run();
  return { ok: true, id: factId };
}
