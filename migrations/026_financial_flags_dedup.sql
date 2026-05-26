-- Migration 026: financial_flags dedup
-- Fix for V3 Bug 1.4 — 78 open flags, many duplicates (5× for some)
-- 1. Normalize NULL entity_name to '(global)' so unique index works cleanly
-- 2. Add dedupe_count column to track hit frequency
-- 3. Collapse duplicates (keep most recent) by (entity_name, flag_type, week_start)
-- 4. Add unique index to prevent future dups

-- Add dedupe_count column (1 = single hit; incremented on upsert collision)
ALTER TABLE financial_flags ADD COLUMN dedupe_count INTEGER DEFAULT 1;

-- Normalize NULL entity_name so the unique index treats them as equal
UPDATE financial_flags SET entity_name = '(global)' WHERE entity_name IS NULL;

-- Collapse duplicates: keep the most recent per (entity_name, flag_type, week_start),
-- summing the hit count into the surviving row's dedupe_count.
UPDATE financial_flags
SET dedupe_count = (
  SELECT COUNT(*) FROM financial_flags AS f2
  WHERE f2.entity_name = financial_flags.entity_name
    AND f2.flag_type   = financial_flags.flag_type
    AND f2.week_start  = financial_flags.week_start
)
WHERE id IN (
  SELECT id FROM financial_flags AS f3
  WHERE f3.created_at = (
    SELECT MAX(created_at) FROM financial_flags AS f4
    WHERE f4.entity_name = f3.entity_name
      AND f4.flag_type   = f3.flag_type
      AND f4.week_start  = f3.week_start
  )
);

-- Delete all but the most recent per group
DELETE FROM financial_flags
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY entity_name, flag_type, week_start
             ORDER BY created_at DESC
           ) AS rn
    FROM financial_flags
  )
  WHERE rn = 1
);

-- Enforce uniqueness going forward
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_flags_dedup
  ON financial_flags (entity_name, flag_type, week_start);
