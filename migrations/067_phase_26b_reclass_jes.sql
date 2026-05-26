-- migrations/067_phase_26b_reclass_jes.sql
-- Session 26-B (May 18, 2026): Post Delivery Fees → Channel Adjustments reclass.
--
-- WHY: 5 Delivery Fees:* accounts ($25,307 FY2025 + $315 FY2026) sit in
-- Operating Expenses but ASC 606 says marketplace facilitator commissions /
-- refunds / processing fees should be contra-revenue when marketplace is
-- principal (DoorDash/Uber/Grubhub).
--
-- STRUCTURE (per fiscal year):
--   JE A: source_type='channel_fees_reclass_v1' — moves $ from old expense to
--         new contra-revenue. Visible in P&L (filter allows this source_type).
--   JE B: source_type='fiscal_year_close' — mirrors JE A in reverse to keep
--         GL balances zero at year-end (since the original FY-close already
--         zero'd the old accounts). Hidden from P&L (filter excludes).
--
-- NET P&L IMPACT FY2025: Revenue -$25,307, Expense -$25,307, NI unchanged
-- NET GL IMPACT: All 5 old accounts stay at $0, all 3 new accounts stay at $0
--                (proper YE2025 close behavior preserved)
--
-- FY2026 (open period): Only JE C (reclass) needed — no close mirror yet
-- because FY2026 hasn't been closed. Next FY-close will pick up new accounts.
--
-- ACCOUNT IDs (from migration 066 + existing COA):
--   Sources (5 old):
--     59c8fe56-cb71-463c-844a-5ea9e32fdecb = Delivery Fees:Commission
--     d4116e24-62ba-466e-847a-a38fe8b33e68 = Delivery Fees:Delivery Commission
--     831aaaa5-12fd-48eb-be78-d2d33804f47f = Delivery Fees:Merchant / Processing Fees
--     57d69f3e-3e5c-4b5a-9ca2-f7c52fbc990b = Delivery Fees:Refunds & Discounts
--     2dba4fba-9997-4dd3-a16d-0705fbad382b = Delivery Fees:Amendments / Adjustments
--   Targets (3 new):
--     68ff33c4e283e7f406632472cd0c7a77 = Sales:Channel Adjustments:Marketplace Commission
--     e16e7d5678176f7f9ea7feab538f725f = Sales:Channel Adjustments:Marketplace Processing Fees
--     cd6104dfc8b774c4b117a26f71f79a68 = Sales:Channel Adjustments:Marketplace Refunds & Adjustments

-- ── Step 1: Unlock FY2025 ─────────────────────────────────────────────────
UPDATE closed_periods
   SET unlocked_at = datetime('now'),
       unlock_reason = 'Phase 26-B reclass — post Channel Adjustments reclass JEs for FY2025'
 WHERE period_start = '2025-01-01' AND period_end = '2025-12-31';

-- ── Step 2: JE A — FY2025 Reclass (channel_fees_reclass_v1) ───────────────
-- Variable holder via CTE-style INSERT with predetermined UUID for traceability

INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '26b-fy2025-reclass-channel',
  '2025-12-31',
  'Phase 26-B: Reclass Delivery Fees → Channel Adjustments (ASC 606 contra-revenue) FY2025',
  'channel_fees_reclass_v1',
  '2025_phase26b',
  25307.08,
  25307.08,
  'posted',
  'session_26b',
  'Reclassifies marketplace commissions ($14,542), processing fees ($8,278), and refunds/adjustments ($2,487) from Operating Expenses to contra-revenue per ASC 606. NI unchanged.'
);

-- Reclass lines: DR new contra-revenue, CR old expense
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 1, '68ff33c4e283e7f406632472cd0c7a77', 14542.18, 0, 'Marketplace commission FY2025 (Commission $14,073.73 + Delivery Commission $468.45)'),
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 2, '59c8fe56-cb71-463c-844a-5ea9e32fdecb', 0, 14073.73, 'Reclass out of Delivery Fees:Commission FY2025'),
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 3, 'd4116e24-62ba-466e-847a-a38fe8b33e68', 0, 468.45, 'Reclass out of Delivery Fees:Delivery Commission FY2025'),
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 4, 'e16e7d5678176f7f9ea7feab538f725f', 8277.81, 0, 'Marketplace processing fees FY2025'),
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 5, '831aaaa5-12fd-48eb-be78-d2d33804f47f', 0, 8277.81, 'Reclass out of Delivery Fees:Merchant / Processing Fees FY2025'),
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 6, 'cd6104dfc8b774c4b117a26f71f79a68', 2487.09, 0, 'Marketplace refunds & adjustments FY2025 (Refunds $1,964.09 + Amendments $523.00)'),
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 7, '57d69f3e-3e5c-4b5a-9ca2-f7c52fbc990b', 0, 1964.09, 'Reclass out of Delivery Fees:Refunds & Discounts FY2025'),
  (lower(hex(randomblob(16))), '26b-fy2025-reclass-channel', 8, '2dba4fba-9997-4dd3-a16d-0705fbad382b', 0, 523.00, 'Reclass out of Delivery Fees:Amendments / Adjustments FY2025');

-- ── Step 3: JE B — FY2025 FY-close mirror (fiscal_year_close) ─────────────
-- Mirrors JE A in reverse — keeps GL balances at $0 (since original FY-close
-- already zero'd the old accounts; we need to re-zero post-reclass)

INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '26b-fy2025-close-mirror',
  '2025-12-31',
  'Phase 26-B: FY-close mirror for Channel Adjustments reclass (zeros GL balances at YE2025)',
  'fiscal_year_close',
  '2025_phase26b_close_mirror',
  25307.08,
  25307.08,
  'posted',
  'session_26b',
  'Mirrors JE 26b-fy2025-reclass-channel to keep GL balances at $0. Excluded from P&L by source_type filter.'
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 1, '59c8fe56-cb71-463c-844a-5ea9e32fdecb', 14073.73, 0, 'FY-close re-zero Delivery Fees:Commission'),
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 2, 'd4116e24-62ba-466e-847a-a38fe8b33e68', 468.45, 0, 'FY-close re-zero Delivery Fees:Delivery Commission'),
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 3, '831aaaa5-12fd-48eb-be78-d2d33804f47f', 8277.81, 0, 'FY-close re-zero Delivery Fees:Merchant / Processing Fees'),
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 4, '57d69f3e-3e5c-4b5a-9ca2-f7c52fbc990b', 1964.09, 0, 'FY-close re-zero Delivery Fees:Refunds & Discounts'),
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 5, '2dba4fba-9997-4dd3-a16d-0705fbad382b', 523.00, 0, 'FY-close re-zero Delivery Fees:Amendments / Adjustments'),
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 6, '68ff33c4e283e7f406632472cd0c7a77', 0, 14542.18, 'FY-close zero Marketplace Commission to RE'),
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 7, 'e16e7d5678176f7f9ea7feab538f725f', 0, 8277.81, 'FY-close zero Marketplace Processing Fees to RE'),
  (lower(hex(randomblob(16))), '26b-fy2025-close-mirror', 8, 'cd6104dfc8b774c4b117a26f71f79a68', 0, 2487.09, 'FY-close zero Marketplace Refunds & Adjustments to RE');

-- ── Step 4: JE C — FY2026 Reclass (no close mirror, FY still open) ────────

INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '26b-fy2026-reclass-channel',
  '2026-05-18',
  'Phase 26-B: Reclass Delivery Fees → Channel Adjustments FY2026 YTD',
  'channel_fees_reclass_v1',
  '2026_phase26b',
  315.60,
  315.60,
  'posted',
  'session_26b',
  'Reclassifies FY2026 YTD marketplace commissions ($307.44), processing fees ($0.71), and refunds ($7.45).'
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))), '26b-fy2026-reclass-channel', 1, '68ff33c4e283e7f406632472cd0c7a77', 307.44, 0, 'Marketplace commission FY2026 YTD'),
  (lower(hex(randomblob(16))), '26b-fy2026-reclass-channel', 2, '59c8fe56-cb71-463c-844a-5ea9e32fdecb', 0, 307.44, 'Reclass out of Delivery Fees:Commission FY2026'),
  (lower(hex(randomblob(16))), '26b-fy2026-reclass-channel', 3, 'e16e7d5678176f7f9ea7feab538f725f', 0.71, 0, 'Marketplace processing fees FY2026'),
  (lower(hex(randomblob(16))), '26b-fy2026-reclass-channel', 4, '831aaaa5-12fd-48eb-be78-d2d33804f47f', 0, 0.71, 'Reclass out of Delivery Fees:Merchant / Processing Fees FY2026'),
  (lower(hex(randomblob(16))), '26b-fy2026-reclass-channel', 5, 'cd6104dfc8b774c4b117a26f71f79a68', 7.45, 0, 'Marketplace refunds FY2026'),
  (lower(hex(randomblob(16))), '26b-fy2026-reclass-channel', 6, '2dba4fba-9997-4dd3-a16d-0705fbad382b', 0, 7.45, 'Reclass out of Delivery Fees:Amendments / Adjustments FY2026');

-- ── Step 5: Re-lock FY2025 ────────────────────────────────────────────────
UPDATE closed_periods
   SET locked_at = datetime('now'),
       unlocked_at = NULL,
       unlock_reason = NULL
 WHERE period_start = '2025-01-01' AND period_end = '2025-12-31';

-- ── Step 6: Deactivate the 5 old Delivery Fees:* accounts ────────────────
-- (Delivery Fees parent account stays active; Marketing Spend + TDS Toast & Uber Fees stay active)
UPDATE chart_of_accounts
   SET is_active = 0,
       expense_category = 'channel_fees_inactive_replaced'
 WHERE account_name IN (
   'Delivery Fees:Commission',
   'Delivery Fees:Delivery Commission',
   'Delivery Fees:Merchant / Processing Fees',
   'Delivery Fees:Refunds & Discounts',
   'Delivery Fees:Amendments / Adjustments'
 );
