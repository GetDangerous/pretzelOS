-- migrations/056_expense_class.sql
-- Session 16-pre (May 14, 2026): tag chart_of_accounts with expense_class.
--
-- WHY: burn calc currently treats every expense JE in the last 30d equally,
-- so Q1 sales tax catch-up ($13K) + IRS payment ($4.5K) inflate the runway
-- denominator. Drew sees "6.4 weeks TIGHT" when recurring burn is more like
-- $7-8K/week → ~10 week runway. We need to flag one-time expenses so the
-- recurring-burn calc can exclude them.
--
-- WHERE: on `chart_of_accounts` (not journal_entry_lines) because:
--   - The categorizer routes each txn to an account
--   - Account-level classification flows through cleanly without per-txn tagging
--   - Backfill is small (162 accounts) vs huge (10000+ JEs)
--
-- VALUES:
--   'recurring'  — expense fires on a known cadence (rent, payroll, insurance)
--   'one_time'   — sales tax catch-up, IRS payment, lawyer one-off, etc.
--   'capex'      — equipment purchases that become fixed assets
--   'variable'   — variable cost of doing business (food, supplies, marketing)
--   NULL         — not yet classified; treated as 'variable' by the calc

ALTER TABLE chart_of_accounts ADD COLUMN expense_class TEXT;
CREATE INDEX IF NOT EXISTS idx_coa_expense_class ON chart_of_accounts (expense_class) WHERE expense_class IS NOT NULL;

-- ── Seed classifications ──────────────────────────────────────────────────
-- Conservative seed: only the OBVIOUS one-time accounts get tagged.
-- Everything else stays NULL (= variable by default in the burn calc).
-- Drew can refine via cfo_facts as patterns emerge.

UPDATE chart_of_accounts SET expense_class = 'one_time'
WHERE LOWER(account_name) LIKE '%sales tax%'
   OR LOWER(account_name) LIKE '%state tax%'
   OR LOWER(account_name) LIKE '%federal tax%'
   OR LOWER(account_name) LIKE '%irs%'
   OR LOWER(account_name) LIKE '%use tax%'
   OR LOWER(account_name) LIKE '%fica%'
   OR LOWER(account_name) LIKE '%payroll tax%'
   OR LOWER(account_name) LIKE '%futa%'
   OR LOWER(account_name) LIKE '%suta%'
   OR LOWER(account_name) = 'taxes paid'
   OR LOWER(account_name) LIKE '%tax payment%'
   OR LOWER(account_name) LIKE '%quarterly tax%';

UPDATE chart_of_accounts SET expense_class = 'recurring'
WHERE LOWER(account_name) LIKE '%rent%'
   OR LOWER(account_name) LIKE 'payroll expenses%'
   OR LOWER(account_name) LIKE '%insurance%'
   OR LOWER(account_name) LIKE '%software%'
   OR LOWER(account_name) LIKE '%subscription%'
   OR LOWER(account_name) LIKE '%loan%principal%'
   OR LOWER(account_name) LIKE '%loan%interest%'
   OR LOWER(account_name) LIKE '%lease%';

UPDATE chart_of_accounts SET expense_class = 'capex'
WHERE account_subtype = 'fixed_asset'
   OR LOWER(account_name) LIKE '%equipment%'
   OR LOWER(account_name) LIKE '%fixed asset%';

UPDATE chart_of_accounts SET expense_class = 'variable'
WHERE expense_class IS NULL
  AND account_type IN ('expense', 'cogs', 'other_expense');
