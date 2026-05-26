-- migrations/072_phase29_ob_correction.sql
-- Session 29-B (May 19, 2026): Reset Mercury OB at YE2024 to actual statement values.
--
-- THE CORE FINDING (verified via Mercury Dec 2024 statements):
--   Mercury Checking 0118 actual @ 2024-12-31: $34,961.75
--   Mercury Savings 5450 actual @ 2024-12-31: $0.00
--   Mercury Credit IO actual @ 2024-12-31: $0.00
--
-- Our existing qbo_opening_balance_seed JE seeded from QBO bookkeeper BS, which had:
--   Mercury Checking: $92,617.86 (overstated by $57,656.11)
--   Mercury Savings: $22,899.24 (Savings didn't even exist — overstated by $22,899.24)
--   Mercury Credit: $1,408.07 liability (overstated — auto-pay cleared to $0)
--
-- Approach: KEEP the original OB seed JE as audit record. Post a SEPARATE
-- adjustment JE dated 2024-12-31 that brings Mercury balances to actual.
-- Offset goes to a new transparent equity account "YE2024 Bank Reconciliation
-- Adjustment" — NOT lumped into Pre-Sync Adjustments. This is auditable for Irene.

-- ── Create the adjustment equity account ─────────────────────────────────
INSERT INTO chart_of_accounts (id, account_name, account_type, account_subtype, expense_class, revenue_channel, is_active, is_system, created_at, notes)
VALUES (
  lower(hex(randomblob(16))),
  'YE2024 Bank Reconciliation Adjustment',
  'equity',
  'retained_earnings',
  NULL, NULL, 1, 0, datetime('now'),
  'Phase 29-B (May 19 2026): One-time adjustment to align Mercury Checking + Savings + Credit OB to actual Dec 2024 bank statements. Bookkeeper QBO BS was overstated by $79,147.28 vs actual bank. This delta is NOT prior-year profit — it represents QBO bookkeeping reconciliation errors that the bookkeeper never resolved. Drew + Irene to review.'
);

-- ── Post adjustment JE ───────────────────────────────────────────────────
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '29b-ob-correction-mercury',
  '2024-12-31',
  'Phase 29-B: Correct Mercury OB to actual bank statements (Dec 2024)',
  'phase_29_ob_correction',
  '2024-12-31_mercury_ob_correction',
  80555.35,
  80555.35,
  'posted',
  'session_29b',
  'Brings Mercury Checking ($92,617.86 → $34,961.75), Mercury Savings ($22,899.24 → $0.00), and Mercury Credit ($1,408.07 → $0.00) to actual Dec 2024 statement balances. Offset to YE2024 Bank Reconciliation Adjustment equity account. Sources: dangerous-pretzel-company-llc-0118-monthly-statement-2024-12.pdf, choice-sweep-2024-12.pdf, credit-2024-12-01.pdf.'
);

-- ── JE lines ─────────────────────────────────────────────────────────────
-- DR side: $79,147.28 (equity adjustment) + $1,408.07 (Mercury Credit liability reduction) = $80,555.35
-- CR side: $57,656.11 (Mercury Checking) + $22,899.24 (Mercury Savings) = $80,555.35
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))), '29b-ob-correction-mercury', 1,
    (SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),
    79147.28, 0,
    'Bookkeeper QBO BS overstated equity by this amount via Mercury OB phantom; YE2024 reconciliation adjustment'),
  (lower(hex(randomblob(16))), '29b-ob-correction-mercury', 2,
    (SELECT id FROM chart_of_accounts WHERE account_name='Mercury Credit (0000) - 1'),
    1408.07, 0,
    'Reduce Mercury Credit liability from $1,408.07 → $0.00 per Dec 2024 statement (auto-pay cleared)'),
  (lower(hex(randomblob(16))), '29b-ob-correction-mercury', 3,
    (SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),
    0, 57656.11,
    'Reduce Mercury Checking from QBO bookkeeper $92,617.86 to actual statement $34,961.75'),
  (lower(hex(randomblob(16))), '29b-ob-correction-mercury', 4,
    (SELECT id FROM chart_of_accounts WHERE account_name='Mercury Savings (5450) - 1'),
    0, 22899.24,
    'Reduce Mercury Savings from QBO bookkeeper $22,899.24 to actual $0.00 (Savings account empty until May 2025)');
