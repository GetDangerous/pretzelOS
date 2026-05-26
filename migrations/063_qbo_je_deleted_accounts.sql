-- Session 21V-QBO-JE (May 15 2026) — Add deleted accounts referenced by historical
-- QBO JournalEntry records. These were bookkeeper-era accounts since deleted,
-- but their historical JEs reference them. Adding so JE ingest can post.
--
-- Idempotent via account_name existence check.

INSERT INTO chart_of_accounts (id, account_name, account_type, account_subtype)
SELECT lower(hex(randomblob(16))), 'Payroll Clearing (deleted)', 'liability', 'current_liability'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_name = 'Payroll Clearing (deleted)');

INSERT INTO chart_of_accounts (id, account_name, account_type, account_subtype)
SELECT lower(hex(randomblob(16))), 'Note Payable - Todd and Amanda (deleted)', 'liability', 'long_term_liability'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_name = 'Note Payable - Todd and Amanda (deleted)');

SELECT account_name, account_type, account_subtype FROM chart_of_accounts
WHERE account_name LIKE '%(deleted)%';
