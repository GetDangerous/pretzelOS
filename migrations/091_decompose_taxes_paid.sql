-- migrations/091_decompose_taxes_paid.sql
-- Phase 31-A3: Decompose Taxes Paid by reclassing non-LEAF tax remittances to proper liability accounts.
--
-- BACKGROUND:
-- Taxes paid had $63K of mercury_txn DR (mis-categorized) on top of $2.4K LEAF tax (correct).
-- The $63K breakdown:
--   - UTAH801/297-7703 sales tax remittances: 3 JEs, $14,561.14 (should drain Sales tax to pay liability)
--   - STRATEGY EXECUTI payroll tax remittances: 46 JEs, $45,326.20 (should drain Payroll tax to pay liability)
--   - PNP BILLPAYMENT (single Apr 2025 txn $3,120.49) — KEPT as Taxes paid (unknown purpose, safer to leave)
--
-- ROOT CAUSE: Mercury categorizer rules routed both Utah sales tax remits AND Strategy Executive
-- payroll tax service payments to the 'Taxes paid' expense account. But:
--   - Sales tax was already accrued as a LIABILITY (Sales tax to pay) when POS collected it from
--     customers via bookkeeper_tips_tax_accrual. The Utah remittance should drain that liability,
--     not be a new expense.
--   - Payroll taxes (employer FICA, Medicare, FUTA, SUTA) were already accrued as a LIABILITY
--     (Payroll Liabilities:Payroll tax to pay) by toast_payroll_reconstruction. The Strategy
--     Executive remittances should drain that liability, not be a new expense.
--
-- IMPACT: $59,887 of double-counted expense removed from FY2025 P&L. NI improves by $59,887
-- (from -$399,793 to ~-$339,906).
--
-- Approach: UPDATE the line's account_id directly (preserves date + JE structure + audit trail).

UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='31-A3', unlocked_by='phase_31_a3' WHERE unlocked_at IS NULL;

UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='1c86c711-0c31-4953-9a1b-12e396a1e45d';  -- 2025-01-16 Mercury outflow · STRATEGY EXECUTI $953.81
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='44d4d650-7641-4c81-9dc3-3eb5aededae7';  -- 2025-01-23 Mercury outflow · STRATEGY EXECUTI $972.78
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='a60f4bd3-204b-46ae-a192-e14224d30634';  -- 2025-01-31 Mercury outflow · STRATEGY EXECUTI $715.37
UPDATE journal_entry_lines SET account_id='b9aa9dc6-be2d-4447-9787-b2e5be83c388' WHERE id='af3dc371-5572-4733-b9a1-a0304f373f07';  -- 2025-02-06 Mercury outflow · UTAH801/297-7703 $1287.91
UPDATE journal_entry_lines SET account_id='b9aa9dc6-be2d-4447-9787-b2e5be83c388' WHERE id='4fc9ec7c-1e00-4f72-a8bf-fb1bde8b8b7a';  -- 2025-02-06 Mercury outflow · UTAH801/297-7703 $165.58
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='49989dca-16fb-4560-b1d1-97b15b00e600';  -- 2025-02-06 Mercury outflow · STRATEGY EXECUTI $784.02
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='41b54b5f-99c8-485b-9dc1-369253685087';  -- 2025-02-13 Mercury outflow · STRATEGY EXECUTI $744.06
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='595d4f4f-171e-4171-90ce-cccb64cc971d';  -- 2025-02-20 Mercury outflow · STRATEGY EXECUTI $1101.72
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='e99db25a-4a1c-45cb-ace4-2277139204ad';  -- 2025-02-27 Mercury outflow · STRATEGY EXECUTI $1217
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='16c217b0-4a78-46f9-85ff-b50723732292';  -- 2025-03-06 Mercury outflow · STRATEGY EXECUTI $1106.91
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='4577c8ea-4053-4ae3-9cf6-1f9f28534b16';  -- 2025-03-14 Mercury outflow · STRATEGY EXECUTI $1308.58
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='0b891571-6eb9-4e0a-89b1-c5ba3b90e0e5';  -- 2025-03-20 Mercury outflow · STRATEGY EXECUTI $1101.25
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='f6a89d4c-2724-46d2-ac18-c71f3a5ae01b';  -- 2025-03-27 Mercury outflow · STRATEGY EXECUTI $1235.44
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='542cd6da-d81f-4dd1-9972-65e827074b21';  -- 2025-04-03 Mercury outflow · STRATEGY EXECUTI $1262.42
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='98c22c69-38ca-4e71-b0bf-fb1525df4598';  -- 2025-04-10 Mercury outflow · STRATEGY EXECUTI $1210.52
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='e619b4e2-37cb-42cb-9d69-cc22563b8631';  -- 2025-04-17 Mercury outflow · STRATEGY EXECUTI $1040.81
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='ea9449d5-d8a8-4013-b438-a4f037774521';  -- 2025-04-24 Mercury outflow · STRATEGY EXECUTI $679.59
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='d8c72c02-82b8-4bc0-880e-d527977f7bc8';  -- 2025-05-01 Mercury outflow · STRATEGY EXECUTI $1015.18
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='c1dbc155-9d86-42e1-9d95-86a921d07fb2';  -- 2025-05-08 Mercury outflow · STRATEGY EXECUTI $875.81
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='d3e9a0c3-a5fe-4089-a31f-af72d8ffe0eb';  -- 2025-05-15 Mercury outflow · STRATEGY EXECUTI $917.19
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='92fd16cc-1a52-4b67-be97-f4cdedc1e14f';  -- 2025-05-22 Mercury outflow · STRATEGY EXECUTI $1047.94
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='ea393e37-c1ee-4fc5-9f5e-0dc9191f2a38';  -- 2025-05-29 Mercury outflow · STRATEGY EXECUTI $773.47
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='363219f9-d599-45e5-a391-91fcddb03430';  -- 2025-06-05 Mercury outflow · STRATEGY EXECUTI $896.39
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='675a84dd-db67-416f-8036-294d03b05b5d';  -- 2025-06-12 Mercury outflow · STRATEGY EXECUTI $943.62
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='659f6cf5-3ff6-453a-ade1-786261348101';  -- 2025-06-20 Mercury outflow · STRATEGY EXECUTI $914.38
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='301cc10d-7f2b-43ec-986d-b843a14500e8';  -- 2025-06-26 Mercury outflow · STRATEGY EXECUTI $957.6
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='7612c5d0-a032-4de2-9108-253e9b1d2522';  -- 2025-07-02 Mercury outflow · STRATEGY EXECUTI $838.13
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='b5c323c1-3b4d-49bb-b77c-6b981476124b';  -- 2025-07-10 Mercury outflow · STRATEGY EXECUTI $994.5
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='59590b7c-481a-4cee-9a37-5389a61427da';  -- 2025-07-17 Mercury outflow · STRATEGY EXECUTI $927.67
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='d5db7abd-0844-49fa-9385-2656cea1b112';  -- 2025-07-24 Mercury outflow · STRATEGY EXECUTI $991.12
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='d5d43ee8-a74b-4d79-b96d-8f6e9fd8f87b';  -- 2025-07-31 Mercury outflow · STRATEGY EXECUTI $915.53
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='22d95258-f65d-427f-b0c4-39b5ed118fa9';  -- 2025-08-08 Mercury outflow · STRATEGY EXECUTI $864.48
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='bc0e8957-bc39-4930-a213-63fd3535a19a';  -- 2025-08-14 Mercury outflow · STRATEGY EXECUTI $921.18
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='cc4afd02-654d-4f19-8ba7-917c240fdbc5';  -- 2025-08-21 Mercury outflow · STRATEGY EXECUTI $1083.96
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='f51665e5-a8a1-4a85-8379-bf9eb2d588e2';  -- 2025-08-28 Mercury outflow · STRATEGY EXECUTI $863.59
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='2ea6c142-6a16-4f07-8d7f-c63de160b3f1';  -- 2025-09-04 Mercury outflow · STRATEGY EXECUTI $871.01
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='38bf0a32-942d-400f-a865-403db15c9838';  -- 2025-09-11 Mercury outflow · STRATEGY EXECUTI $980.53
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='7a6a6332-7acc-4678-bf97-1b69c799e39d';  -- 2025-09-18 Mercury outflow · STRATEGY EXECUTI $904.36
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='6a433eb3-f0b0-4eb0-9c1a-58b300d61c13';  -- 2025-09-25 Mercury outflow · STRATEGY EXECUTI $1016.04
UPDATE journal_entry_lines SET account_id='b9aa9dc6-be2d-4447-9787-b2e5be83c388' WHERE id='c7c144a1-be8c-42e5-8ec0-19952d33a49c';  -- 2025-09-30 Mercury outflow · Utah DMV $13107.65
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='ba582a94-d41d-4aed-a25e-0bef1bc33aa6';  -- 2025-10-03 Mercury outflow · STRATEGY EXECUTI $1019.65
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='dc7fd948-1005-44c7-92bb-ecc3d6dd5ccd';  -- 2025-10-10 Mercury outflow · STRATEGY EXECUTI $1002.74
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='62017a67-87c0-4cfe-af3a-31eabca4ba00';  -- 2025-10-16 Mercury outflow · STRATEGY EXECUTI $895.13
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='ba85ea7a-8c87-4e1c-99ff-72fdea994d9e';  -- 2025-10-23 Mercury outflow · STRATEGY EXECUTI $1067.88
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='7e4fbc7a-cc59-4db8-8906-7e35602aea8b';  -- 2025-10-31 Mercury outflow · STRATEGY EXECUTI $1166.76
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='c9543e3c-ad1f-4afe-ab00-a564d580b979';  -- 2025-11-07 Mercury outflow · STRATEGY EXECUTI $896.29
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='c5a3d71f-c301-4609-b59f-ddcbfc4ffe75';  -- 2025-11-13 Mercury outflow · STRATEGY EXECUTI $902.78
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='5b58206c-4796-45bb-bc48-e1e36fec45fe';  -- 2025-11-20 Mercury outflow · STRATEGY EXECUTI $1271.34
UPDATE journal_entry_lines SET account_id='778ebcee-d206-457c-bfa5-4f340acb3933' WHERE id='5721eb0d-b9b9-4af0-a892-539bce7db342';  -- 2025-12-01 Mercury outflow · STRATEGY EXECUTI $1155.67

-- Annotate parent JEs with reclass marker
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 31-A3 reclass 2026-05-20: Taxes paid line repointed to proper liability drain (Sales tax to pay or Payroll tax to pay)' WHERE id IN (SELECT DISTINCT journal_entry_id FROM journal_entry_lines WHERE account_id IN ('b9aa9dc6-be2d-4447-9787-b2e5be83c388','778ebcee-d206-457c-bfa5-4f340acb3933') AND id IN ('1c86c711-0c31-4953-9a1b-12e396a1e45d','44d4d650-7641-4c81-9dc3-3eb5aededae7','a60f4bd3-204b-46ae-a192-e14224d30634','af3dc371-5572-4733-b9a1-a0304f373f07','4fc9ec7c-1e00-4f72-a8bf-fb1bde8b8b7a','49989dca-16fb-4560-b1d1-97b15b00e600','41b54b5f-99c8-485b-9dc1-369253685087','595d4f4f-171e-4171-90ce-cccb64cc971d','e99db25a-4a1c-45cb-ace4-2277139204ad','16c217b0-4a78-46f9-85ff-b50723732292','4577c8ea-4053-4ae3-9cf6-1f9f28534b16','0b891571-6eb9-4e0a-89b1-c5ba3b90e0e5','f6a89d4c-2724-46d2-ac18-c71f3a5ae01b','542cd6da-d81f-4dd1-9972-65e827074b21','98c22c69-38ca-4e71-b0bf-fb1525df4598','e619b4e2-37cb-42cb-9d69-cc22563b8631','ea9449d5-d8a8-4013-b438-a4f037774521','d8c72c02-82b8-4bc0-880e-d527977f7bc8','c1dbc155-9d86-42e1-9d95-86a921d07fb2','d3e9a0c3-a5fe-4089-a31f-af72d8ffe0eb','92fd16cc-1a52-4b67-be97-f4cdedc1e14f','ea393e37-c1ee-4fc5-9f5e-0dc9191f2a38','363219f9-d599-45e5-a391-91fcddb03430','675a84dd-db67-416f-8036-294d03b05b5d','659f6cf5-3ff6-453a-ade1-786261348101','301cc10d-7f2b-43ec-986d-b843a14500e8','7612c5d0-a032-4de2-9108-253e9b1d2522','b5c323c1-3b4d-49bb-b77c-6b981476124b','59590b7c-481a-4cee-9a37-5389a61427da','d5db7abd-0844-49fa-9385-2656cea1b112','d5d43ee8-a74b-4d79-b96d-8f6e9fd8f87b','22d95258-f65d-427f-b0c4-39b5ed118fa9','bc0e8957-bc39-4930-a213-63fd3535a19a','cc4afd02-654d-4f19-8ba7-917c240fdbc5','f51665e5-a8a1-4a85-8379-bf9eb2d588e2','2ea6c142-6a16-4f07-8d7f-c63de160b3f1','38bf0a32-942d-400f-a865-403db15c9838','7a6a6332-7acc-4678-bf97-1b69c799e39d','6a433eb3-f0b0-4eb0-9c1a-58b300d61c13','c7c144a1-be8c-42e5-8ec0-19952d33a49c','ba582a94-d41d-4aed-a25e-0bef1bc33aa6','dc7fd948-1005-44c7-92bb-ecc3d6dd5ccd','62017a67-87c0-4cfe-af3a-31eabca4ba00','ba85ea7a-8c87-4e1c-99ff-72fdea994d9e','7e4fbc7a-cc59-4db8-8906-7e35602aea8b','c9543e3c-ad1f-4afe-ab00-a564d580b979','c5a3d71f-c301-4609-b59f-ddcbfc4ffe75','5b58206c-4796-45bb-bc48-e1e36fec45fe','5721eb0d-b9b9-4af0-a892-539bce7db342'));

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason='31-A3';
