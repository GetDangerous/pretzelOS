-- migrations/057_recurring_payment_patterns.sql
-- Session 16c (May 14, 2026): whitelist for recurring/expected payments.
--
-- Issue surfacer's vendor_anomaly detector flags spend spikes > X% as "high
-- severity." But many spikes are explainable + recurring: quarterly sales tax,
-- annual insurance renewals, seasonal vendor restocks. Drew called this out:
--   "UTAH801 +124%" is a known Q1 sales tax payment. Surfacing it as critical
--   is noise. The system should KNOW.
--
-- This table holds known recurring patterns. Issue surfacer queries before
-- flagging. Patterns can be:
--   - Pre-seeded (initial setup — sales tax, IRS, insurance renewals)
--   - Drew-confirmed at chat time (via cfo_facts of type 'recurring_payment')
--   - Auto-inferred over time (after 2+ occurrences with consistent cadence)

CREATE TABLE IF NOT EXISTS recurring_payment_patterns (
  id TEXT PRIMARY KEY,
  subject_pattern TEXT NOT NULL,        -- e.g., 'UTAH801', 'IRS', 'Selective Insurance'
  match_type TEXT NOT NULL DEFAULT 'contains',  -- 'contains' | 'exact' | 'regex'
  cadence_days INTEGER,                 -- e.g., 90 for quarterly, 365 for annual
  last_seen_date TEXT,
  expected_next_date TEXT,
  source TEXT NOT NULL,                 -- 'seed' | 'cfo_fact' | 'auto_inferred'
  source_ref TEXT,                      -- cfo_facts.id if from chat
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recurring_payment_active ON recurring_payment_patterns (active, subject_pattern);

-- ── Pre-seed: known recurring payments ────────────────────────────────────

INSERT INTO recurring_payment_patterns (id, subject_pattern, match_type, cadence_days, source, note)
VALUES
  (lower(hex(randomblob(16))), 'UTAH801',           'contains', 90,  'seed', 'Utah State quarterly sales tax (TC-62) — every 90d'),
  (lower(hex(randomblob(16))), 'UTAH SALES TAX',    'contains', 90,  'seed', 'Utah quarterly sales tax'),
  (lower(hex(randomblob(16))), 'STATE OF UTAH',     'contains', 90,  'seed', 'Utah state payments — quarterly'),
  (lower(hex(randomblob(16))), 'IRS USATAXPYMT',    'contains', 90,  'seed', 'IRS quarterly estimated tax payment'),
  (lower(hex(randomblob(16))), 'IRS',               'contains', 90,  'seed', 'IRS payments (quarterly estimated, FICA, payroll tax)'),
  (lower(hex(randomblob(16))), 'TC-62',             'contains', 90,  'seed', 'Utah Sales & Use Tax Return'),
  (lower(hex(randomblob(16))), 'SPF FORM',          'contains', 90,  'seed', 'Utah Sales Prepared Food Return'),
  (lower(hex(randomblob(16))), 'BB BILLBOARD',      'contains', 30,  'seed', 'Monthly rent — recurring'),
  (lower(hex(randomblob(16))), 'TOAST PAYROLL',     'contains', 14,  'seed', 'Bi-weekly payroll'),
  (lower(hex(randomblob(16))), 'SQUARE INC',        'contains', 14,  'seed', 'Square Payroll (post-Toast cutover) — bi-weekly'),
  (lower(hex(randomblob(16))), 'SELECTIVE',         'contains', 30,  'seed', 'Monthly business insurance'),
  (lower(hex(randomblob(16))), 'TRAVELERS',         'contains', 30,  'seed', 'Monthly insurance premium'),
  (lower(hex(randomblob(16))), 'LEASE SERVICES',    'contains', 30,  'seed', 'LEAF equipment loan payments — monthly'),
  (lower(hex(randomblob(16))), 'LEAF',              'contains', 30,  'seed', 'LEAF Capital — monthly equipment financing'),
  (lower(hex(randomblob(16))), 'TAXES PAID',        'contains', 90,  'seed', 'General tax payments — quarterly cadence');
