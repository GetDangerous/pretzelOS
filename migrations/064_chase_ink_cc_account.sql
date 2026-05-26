-- Session 21V-Chase (May 15 2026) — Add Chase Ink ••3178 credit card to COA
-- Drew opened Chase Business CC March 2026. First statement cycle 03/16/26 - 04/04/26.
-- $15,000 credit limit. Linked to Dangerous Pretzel Company LLC.
--
-- Idempotent via account_name existence check.

INSERT INTO chart_of_accounts (id, account_name, account_type, account_subtype)
SELECT lower(hex(randomblob(16))), 'Chase Ink Business (3178)', 'liability', 'current_liability'
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE account_name = 'Chase Ink Business (3178)');

SELECT account_name, account_type, account_subtype FROM chart_of_accounts
WHERE account_name = 'Chase Ink Business (3178)';
