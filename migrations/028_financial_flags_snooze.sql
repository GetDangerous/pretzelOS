-- Migration 028: financial_flags snooze support — V3 Item 2.19
-- Adds a snooze_until column so Drew can defer low-urgency flags without
-- marking them resolved. Open flag queries should filter out snoozed rows
-- while the snooze_until is still in the future.

ALTER TABLE financial_flags ADD COLUMN snooze_until TEXT;
CREATE INDEX IF NOT EXISTS idx_financial_flags_snooze ON financial_flags (snooze_until);
