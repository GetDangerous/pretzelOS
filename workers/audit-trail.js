// workers/audit-trail.js
// Phase A Week 1 Task B1 — audit_trail helper module.
//
// Purpose: single entry point for writing audit_trail rows from any worker.
// Every JE-posting path (per JE_POSTING_PATHS_CATALOG.md, the 9 active paths)
// MUST call writeAuditEntry() after a successful JE insert.
//
// Convention reminders (per AUDIT_TRAIL_DESIGN.md):
//   - actor format: 'drew' (lowercase) | 'system:<source_type>' | 'agent:<name>'
//   - source_metadata: free-form JSON
//   - commit_hash: read from env.DEPLOY_COMMIT_HASH (set in wrangler.toml [vars])
//
// Append-only enforcement: triggers in D1. This helper only INSERTs.
//
// Usage:
//   import { writeAuditEntry } from './audit-trail.js';
//
//   const auditId = await writeAuditEntry(env, {
//     actor: 'system:mercury_txn',
//     action_type: 'post_je',
//     entity_type: 'journal_entry',
//     entity_id: jeData.id,
//     after_state: { id: jeData.id, total_debit, total_credit, source_type },
//     source_metadata: { categorizer_rule: 'sysco_food', confidence: 0.98 },
//     related_je_id: jeData.id,
//   });
//
// The helper returns the new audit_trail.id for chaining via related_audit_id.

/**
 * Write a single audit_trail entry.
 *
 * @param {object} env - Cloudflare Worker env (provides DB binding + DEPLOY_COMMIT_HASH var)
 * @param {object} entry - audit entry data
 * @param {string} entry.actor - REQUIRED. 'drew' | 'system:<src>' | 'agent:<name>'
 * @param {string} entry.action_type - REQUIRED. See AUDIT_TRAIL_DESIGN.md §4
 * @param {string} entry.entity_type - REQUIRED. 'journal_entry' | 'mercury_txn' | etc.
 * @param {string} entry.entity_id - REQUIRED. ID of the affected entity
 * @param {object} [entry.before_state] - optional snapshot pre-action (serialized to JSON)
 * @param {object} [entry.after_state] - optional snapshot post-action (serialized to JSON)
 * @param {string} [entry.reason_note] - optional free-form text
 * @param {object} [entry.source_metadata] - optional structured context (serialized to JSON)
 * @param {string} [entry.related_je_id] - optional FK to journal_entries.id
 * @param {string} [entry.related_audit_id] - optional FK to audit_trail.id (chains)
 * @returns {Promise<string>} the new audit_trail.id (UUID)
 */
export async function writeAuditEntry(env, entry) {
  // Validation — refuse silent failures
  if (!entry || typeof entry !== 'object') {
    throw new Error('writeAuditEntry: entry object required');
  }
  if (!entry.actor || typeof entry.actor !== 'string') {
    throw new Error('writeAuditEntry: entry.actor required (string)');
  }
  if (!entry.action_type || typeof entry.action_type !== 'string') {
    throw new Error('writeAuditEntry: entry.action_type required (string)');
  }
  if (!entry.entity_type || typeof entry.entity_type !== 'string') {
    throw new Error('writeAuditEntry: entry.entity_type required (string)');
  }
  if (!entry.entity_id || typeof entry.entity_id !== 'string') {
    throw new Error('writeAuditEntry: entry.entity_id required (string)');
  }

  const id = entry.id || crypto.randomUUID();
  const commitHash = entry.commit_hash || env.DEPLOY_COMMIT_HASH || null;

  // Serialize JSON fields safely
  const beforeStateJson = entry.before_state ? JSON.stringify(entry.before_state) : null;
  const afterStateJson = entry.after_state ? JSON.stringify(entry.after_state) : null;
  const sourceMetadataJson = entry.source_metadata ? JSON.stringify(entry.source_metadata) : null;

  await env.DB.prepare(`
    INSERT INTO audit_trail
      (id, actor, action_type, entity_type, entity_id,
       before_state, after_state, reason_note, source_metadata,
       commit_hash, related_je_id, related_audit_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    entry.actor,
    entry.action_type,
    entry.entity_type,
    entry.entity_id,
    beforeStateJson,
    afterStateJson,
    entry.reason_note || null,
    sourceMetadataJson,
    commitHash,
    entry.related_je_id || null,
    entry.related_audit_id || null,
  ).run();

  return id;
}

/**
 * Convenience wrapper: write a post_je audit entry from a JE that was just inserted.
 * Used by all 9 active JE-posting paths to standardize the pattern.
 *
 * @param {object} env
 * @param {object} args
 * @param {string} args.je_id - the journal_entries.id that was just posted
 * @param {string} args.source_type - the source_type used on the JE (becomes actor suffix unless overridden)
 * @param {object} [args.je_data] - optional full JE snapshot (entry_date, total_debit, total_credit, description)
 * @param {object} [args.metadata] - optional structured context (rule_matched, confidence, etc.)
 * @param {string} [args.actor] - override default 'system:<source_type>' actor
 * @returns {Promise<string>} audit_trail.id
 */
export async function auditPostJe(env, args) {
  if (!args || !args.je_id) throw new Error('auditPostJe: je_id required');

  return writeAuditEntry(env, {
    actor: args.actor || ('system:' + (args.source_type || 'unknown')),
    action_type: 'post_je',
    entity_type: 'journal_entry',
    entity_id: args.je_id,
    before_state: null,
    after_state: args.je_data || { je_id: args.je_id },
    source_metadata: args.metadata || null,
    related_je_id: args.je_id,
  });
}

/**
 * Convenience wrapper: write a reverse_je audit entry.
 */
export async function auditReverseJe(env, args) {
  if (!args || !args.je_id) throw new Error('auditReverseJe: je_id required');

  return writeAuditEntry(env, {
    actor: args.actor || ('system:' + (args.source_type || 'unknown')),
    action_type: 'reverse_je',
    entity_type: 'journal_entry',
    entity_id: args.je_id,
    before_state: { status: 'posted' },
    after_state: { status: 'reversed' },
    reason_note: args.reason || null,
    source_metadata: args.metadata || null,
    related_je_id: args.je_id,
    related_audit_id: args.related_audit_id || null,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Read helpers for Surface 7 — Audit Trail / Activity History
// ──────────────────────────────────────────────────────────────────────────

/**
 * Get recent audit_trail entries (timeline view).
 * @param {object} env
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.actor] - filter by actor
 * @param {string} [opts.action_type] - filter by action_type
 * @param {string} [opts.entity_type] - filter by entity_type
 * @param {string} [opts.entity_id] - filter by entity_id (with entity_type for performance)
 * @param {string} [opts.since] - ISO timestamp lower bound
 * @returns {Promise<Array>} audit entries with JSON columns parsed
 */
export async function getAuditTimeline(env, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit || 50, 10), 1), 500);
  const where = ['1=1'];
  const binds = [];
  if (opts.actor) { where.push('actor = ?'); binds.push(opts.actor); }
  if (opts.action_type) { where.push('action_type = ?'); binds.push(opts.action_type); }
  if (opts.entity_type) { where.push('entity_type = ?'); binds.push(opts.entity_type); }
  if (opts.entity_id) { where.push('entity_id = ?'); binds.push(opts.entity_id); }
  if (opts.since) { where.push('occurred_at >= ?'); binds.push(opts.since); }

  const sql = `
    SELECT id, occurred_at, actor, action_type, entity_type, entity_id,
           before_state, after_state, reason_note, source_metadata,
           commit_hash, related_je_id, related_audit_id
    FROM audit_trail
    WHERE ${where.join(' AND ')}
    ORDER BY occurred_at DESC
    LIMIT ?
  `;
  binds.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results || []).map(row => ({
    ...row,
    before_state: row.before_state ? safeParse(row.before_state) : null,
    after_state: row.after_state ? safeParse(row.after_state) : null,
    source_metadata: row.source_metadata ? safeParse(row.source_metadata) : null,
  }));
}

/**
 * Get full audit chain for a specific JE (every audit entry that touches it).
 */
export async function getAuditChainForJe(env, jeId) {
  const { results } = await env.DB.prepare(`
    SELECT * FROM audit_trail
    WHERE related_je_id = ? OR (entity_type = 'journal_entry' AND entity_id = ?)
    ORDER BY occurred_at ASC
  `).bind(jeId, jeId).all();
  return (results || []).map(row => ({
    ...row,
    before_state: row.before_state ? safeParse(row.before_state) : null,
    after_state: row.after_state ? safeParse(row.after_state) : null,
    source_metadata: row.source_metadata ? safeParse(row.source_metadata) : null,
  }));
}

function safeParse(text) {
  try { return JSON.parse(text); }
  catch { return { _parse_error: true, raw: text }; }
}
