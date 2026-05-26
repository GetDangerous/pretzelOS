-- migrations/040_cfo_facts.sql
-- Drew-clarified knowledge that persists forever.
--
-- When Drew clarifies a transaction or vendor in chat ("LEASE SERVICES is
-- pizza oven loan, split 80% principal / 20% interest"), the agent saves the
-- fact here. Categorizer + chat agent ALWAYS consult cfo_facts before making
-- decisions. The agent never re-asks the same question twice.
--
-- Also: cfo_conversations stores chat history with persistent memory across
-- sessions. The agent can reference past chats.

CREATE TABLE IF NOT EXISTS cfo_facts (
  id              TEXT PRIMARY KEY,
  fact_type       TEXT NOT NULL,                -- 'vendor_rule' | 'customer_term' | 'drew_preference' | 'business_fact' | 'capex_threshold' | 'correction'
  subject         TEXT NOT NULL,                -- the entity this fact is about (vendor name, customer name, etc.)
  subject_normalized TEXT NOT NULL,             -- lowercase + trimmed for matching
  content         TEXT NOT NULL,                -- the fact itself, human-readable
  structured_data TEXT,                         -- JSON with structured fields if applicable
  source          TEXT NOT NULL,                -- 'drew_chat' | 'drew_dashboard' | 'auto_inferred' | 'qbo_pattern'
  confidence      REAL    NOT NULL DEFAULT 1.0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  superseded_by   TEXT,                         -- if Drew updates the fact, point to new id
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_cfo_facts_subject ON cfo_facts(subject_normalized) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_cfo_facts_type ON cfo_facts(fact_type, active);

CREATE TABLE IF NOT EXISTS cfo_conversations (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,                -- groups messages into a single thread
  message_id      TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL,                -- 'user' | 'assistant' | 'system' | 'tool'
  content         TEXT,
  tool_calls      TEXT,                         -- JSON if assistant called tools
  tool_use_id     TEXT,                         -- if role='tool', which tool_use it responds to
  cost_usd        REAL,                         -- denormalized from ai_calls
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cfo_conv_thread ON cfo_conversations(conversation_id, created_at);

-- Agent decisions log — every autonomous decision the agent makes. Drew can
-- audit + override. Trust score's "decision_quality" reads this.
CREATE TABLE IF NOT EXISTS agent_decisions (
  id              TEXT PRIMARY KEY,
  decision_at     TEXT NOT NULL DEFAULT (datetime('now')),
  decision_type   TEXT NOT NULL,                -- 'categorize' | 'capitalize' | 'sweep' | 'post_je' | 'flag' | etc.
  subject_id      TEXT,                         -- e.g., mercury_txn id, je id, etc.
  subject_type    TEXT,                         -- 'mercury_txn' | 'je' | 'capex_candidate' | etc.
  decision        TEXT NOT NULL,                -- what was decided (account name, action taken)
  reasoning       TEXT,                         -- agent's explanation
  source_used     TEXT,                         -- 'qbo_match' | 'kb_lookup' | 'rule' | 'haiku' | 'sonnet' | 'cfo_fact'
  source_version  TEXT,                         -- worker version that made the call (for rollback)
  confidence      REAL,
  drew_action     TEXT,                         -- NULL | 'approved' | 'overridden' | 'reverted'
  drew_action_at  TEXT,
  cost_usd        REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_at ON agent_decisions(decision_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_subject ON agent_decisions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_action ON agent_decisions(drew_action, decision_at DESC) WHERE drew_action IS NOT NULL;
