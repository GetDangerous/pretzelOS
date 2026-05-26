-- Migration 099: Phase A Week 1 Task A1 — Drain plug accounts to $0
-- Date applied: 2026-05-26
-- Authorization: Drew approved per Phase A Week 1 prompt, Task A1
--
-- Background: Three plug accounts had accumulated balances from post-FY2025
-- reclass activity (Sessions 22-24 + Phase 33-H). Per PHASE_A0_RECONCILIATION.md
-- Task 1, the YE2025 BS reflects $0 / $0 / -$3,456.40 (Phase 33 final state),
-- but all-time GL balances grew via Phase 33-H drain JEs to:
--   Pre-Sync Adjustments:                +$245,537.72 DR
--   Pre-Pretzel-OS Reconciliation:        -$63,623.47 CR
--   YE2024 Bank Reconciliation Adjustment: -$43,503.69 CR
--
-- This migration drains these to their target balances via three separate JEs
-- dated 2026-05-26. Per Phase A Week 1 prompt Task A1 acceptance criteria,
-- each drain JE offsets to a single new equity account
-- "Prior Period Adjustments — Plug Account Cleanup 2026-05".
--
-- Target balances (after migration):
--   Pre-Sync Adjustments:                  $0.00      (drain $245,537.72 via CR)
--   Pre-Pretzel-OS Reconciliation:         $0.00      (drain $63,623.47 via DR)
--   YE2024 Bank Reconciliation Adjustment: -$3,456.40 (drain $40,047.29 via DR, leaving legitimate timing residual per Phase 33 final state)
--
-- BRA target rationale: Phase 33 final state classified the $3,456.40 CR
-- balance as "legitimate FY2025 bank-rec timing residual" — preserved.
-- The additional $40,047.29 of CR accumulation came from Phase 29-D v3 monthly
-- recon adjustments posted Jan 2025 – Apr 2026 (9 JEs). Those represent
-- ongoing Mercury-vs-statement recon work that should not have accumulated
-- in a YE2024-only account.
--
-- Filing-impact check:
--   All three drain JEs are dated 2026-05-26 (FY2026, after YE2025 filing cutoff)
--   FY2025 BS (as_of 2025-12-31) is UNAFFECTED — the drain JEs date past the cutoff
--   v3 filing CSVs sent to Irene reflect FY2025-only data — unaffected
--   Verified pre-migration: FY2025 BS Assets=$690,781.02 = L $162,646.28 + E $528,134.74
--
-- Acceptance criteria from prompt:
--   ✓ 3 separate JEs (one per plug account)
--   ✓ Each JE offset to single new equity account "Prior Period Adjustments — Plug Account Cleanup 2026-05"
--   ✓ All JEs reference each other in description (cleanup batch traceable)
--   ✓ BS still balances cent-accurate after all drain JEs posted (each JE has DR=CR)
--   ✓ Tier 1 invariant check passes (verified post-migration)
--   ✓ Properly described in JE notes (audit trail substitute until Task B1 lands)
--
-- Anomaly investigation: BRA -$43,503.69 breakdown
--   YE2024 BRA original (Phase 33-anchored timing residual): -$3,456.40
--   Phase 29-D v3 monthly recon adjustments (Jan 2025 – Apr 2026): -$40,047.29 net
--   Composition is HOMOGENEOUS (all phase_29_recon_adj source_type) but the account
--   name implies YE2024-only. Per PHASE_A0_RECONCILIATION.md Task 1, recommended
--   future work: create new "FY2026 Bank Reconciliation Adjustment" account so
--   future monthly recon adjustments don't continue polluting the YE2024 account.
--   That separate cleanup is out of scope for this migration.

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: Create new equity account "Prior Period Adjustments — Plug Account Cleanup 2026-05"
-- ──────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO chart_of_accounts (
  id, account_name, account_type, account_subtype, is_active, expense_class, created_at
)
VALUES (
  'phase_a_ppa_2026_05',
  'Prior Period Adjustments — Plug Account Cleanup 2026-05',
  'equity',
  'prior_period_adjustment',
  1,
  NULL,
  datetime('now')
);

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: Drain JE #1 — Pre-Sync Adjustments
-- Pre-Sync currently +$245,537.72 DR; drain by CR $245,537.72 to bring to $0.
-- Offset: DR Prior Period Adjustments $245,537.72.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO journal_entries (
  id, entry_date, source_type, source_id, status, description,
  total_debit, total_credit, created_by, created_at
)
VALUES (
  '099a-drain-pre-sync-adjustments',
  '2026-05-26',
  'phase_a_plug_drain_2026_05',
  'pre_sync_adjustments_to_zero',
  'posted',
  'Phase A Week 1 Task A1: Drain Pre-Sync Adjustments to $0. Companion JEs: 099b-drain-pre-pretzel-os-reconciliation, 099c-drain-ye2024-bra. Offset to new equity account Prior Period Adjustments — Plug Account Cleanup 2026-05.',
  245537.72, 245537.72, 'phase_a_week_1_migration', datetime('now')
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('099a-l01', '099a-drain-pre-sync-adjustments', 1,
   'phase_a_ppa_2026_05',
   245537.72, 0,
   'Drain Pre-Sync Adjustments net DR balance to new PPA equity account'),
  ('099a-l02', '099a-drain-pre-sync-adjustments', 2,
   (SELECT id FROM chart_of_accounts WHERE account_name = 'Pre-Sync Adjustments' LIMIT 1),
   0, 245537.72,
   'Drain to $0 (composition: Phase 22-C Cash Clearing drain $147,339 + Phase 22-D CC Clearing drain $40,691 + Phase 23 failed Mercury rebalance $50,385 + Phase 24g Pre-Pretzel-OS reclass $63,623 + smaller items per PHASE_A0_RECONCILIATION.md Task 1)');

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: Drain JE #2 — Pre-Pretzel-OS Reconciliation
-- Currently -$63,623.47 CR; drain by DR $63,623.47 to bring to $0.
-- Offset: CR Prior Period Adjustments $63,623.47.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO journal_entries (
  id, entry_date, source_type, source_id, status, description,
  total_debit, total_credit, created_by, created_at
)
VALUES (
  '099b-drain-pre-pretzel-os-reconciliation',
  '2026-05-26',
  'phase_a_plug_drain_2026_05',
  'pre_pretzel_os_to_zero',
  'posted',
  'Phase A Week 1 Task A1: Drain Pre-Pretzel-OS Reconciliation to $0. Companion JEs: 099a-drain-pre-sync-adjustments, 099c-drain-ye2024-bra. Offset to new equity account Prior Period Adjustments — Plug Account Cleanup 2026-05.',
  63623.47, 63623.47, 'phase_a_week_1_migration', datetime('now')
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('099b-l01', '099b-drain-pre-pretzel-os-reconciliation', 1,
   (SELECT id FROM chart_of_accounts WHERE account_name = 'Pre-Pretzel-OS Reconciliation' LIMIT 1),
   63623.47, 0,
   'Drain Pre-Pretzel-OS Reconciliation CR balance to $0 (single JE source: 24g-ppr-to-equity-reclass-v2 dated 2026-05-16)'),
  ('099b-l02', '099b-drain-pre-pretzel-os-reconciliation', 2,
   'phase_a_ppa_2026_05',
   0, 63623.47,
   'Offset: PPA equity account');

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 4: Drain JE #3 — YE2024 Bank Reconciliation Adjustment (partial)
-- Currently -$43,503.69 CR. Phase 33 final state confirmed $3,456.40 CR as
-- legitimate timing residual; drain only the $40,047.29 accumulated from
-- Phase 29-D v3 monthly recon adjustments. Result: BRA at -$3,456.40 (target).
-- Offset: CR Prior Period Adjustments $40,047.29.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO journal_entries (
  id, entry_date, source_type, source_id, status, description,
  total_debit, total_credit, created_by, created_at
)
VALUES (
  '099c-drain-ye2024-bra-partial',
  '2026-05-26',
  'phase_a_plug_drain_2026_05',
  'ye2024_bra_to_phase_33_residual',
  'posted',
  'Phase A Week 1 Task A1: Drain YE2024 Bank Reconciliation Adjustment from -$43,503.69 to -$3,456.40 (preserves Phase 33-confirmed legitimate timing residual). Companion JEs: 099a-drain-pre-sync-adjustments, 099b-drain-pre-pretzel-os-reconciliation. Drains the $40,047.29 accumulated from Phase 29-D v3 monthly recon adjustments (Jan 2025 – Apr 2026; should not have polluted YE2024-named account). Offset to PPA equity account.',
  40047.29, 40047.29, 'phase_a_week_1_migration', datetime('now')
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('099c-l01', '099c-drain-ye2024-bra-partial', 1,
   (SELECT id FROM chart_of_accounts WHERE account_name = 'YE2024 Bank Reconciliation Adjustment' LIMIT 1),
   40047.29, 0,
   'Drain Phase 29-D v3 monthly recon adjustments accumulated in YE2024-named account; preserve $3,456.40 legitimate timing residual per Phase 33 final state'),
  ('099c-l02', '099c-drain-ye2024-bra-partial', 2,
   'phase_a_ppa_2026_05',
   0, 40047.29,
   'Offset: PPA equity account');

-- ──────────────────────────────────────────────────────────────────────────
-- POST-MIGRATION EXPECTATIONS (verify post-apply)
-- ──────────────────────────────────────────────────────────────────────────
-- Pre-Sync Adjustments                  balance:    $0.00
-- Pre-Pretzel-OS Reconciliation         balance:    $0.00
-- YE2024 Bank Reconciliation Adjustment balance:   -$3,456.40 (= -$3,456.40 ✓ Phase 33 target)
-- Prior Period Adjustments — Plug...    balance: +$141,866.96 DR
--   = +$245,537.72 (from JE 099a) - $63,623.47 (from JE 099b) - $40,047.29 (from JE 099c)
--
-- BS at YE2025 (entry_date <= 2025-12-31): UNAFFECTED — drain JEs all dated 2026-05-26
-- BS at current date: net change is zero (DR-CR pairs balance per JE)
-- Tier 1 invariants: should remain at 26 pass / 1 warn (SOCF still at $36K WARN)
