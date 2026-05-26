-- migrations/089b_mercury_payroll_leaf_clearing_repoint.sql
-- Phase 30 Pattern B step 2: repoint historical Mercury Toast Payroll + LEAF
-- outflow JEs' DR side from the old expense/liability accounts to clearing accounts.
--
-- BEFORE: Mercury Toast Payroll JE → DR Payroll Expenses / CR Mercury Checking
-- AFTER:  Mercury Toast Payroll JE → DR Payroll Clearing / CR Mercury Checking
--
-- BEFORE: Mercury LEAF JE → DR N/P LEAF <loan> / CR Mercury Checking
-- AFTER:  Mercury LEAF JE → DR LEAF Clearing / CR Mercury Checking
--
-- The toast_payroll_reconstruction + leaf_amortization_reconstruction workers will
-- then CR these clearing accounts on the accrual side, netting per-cycle clearing
-- to ~$0. This is the standard accountant pattern (matches QBO's Payroll Clearing).
--
-- Scope: 43 Toast Payroll DR-side lines ($123,174.75) +
--        48 LEAF DR-side lines ($41,671.68)

-- Step 1: Unlock closed_periods (since some lines are dated to closed periods)
UPDATE closed_periods
   SET unlocked_at=datetime('now'),
       unlock_reason='Phase 30 Pattern B: repoint Mercury Toast Payroll + LEAF DR to clearing',
       unlocked_by='phase_30_clearing_repoint'
 WHERE unlocked_at IS NULL;

-- Step 2: Repoint 43 Toast Payroll DR lines → Payroll Clearing
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='2478bd08-a4f3-401a-9805-62253bfbeb7b';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='04ea7e9d-0518-4ead-bc75-45bc06e40b7c';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='5e080a96-9bb8-4411-b463-c2830521b302';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='b42c3f50-72ba-4304-acea-db05e9815e51';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='4646a91c-45ca-4370-b968-7fa8751d9dbd';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='9aec1c81-6be5-4bfc-8270-bf3d09c06b0d';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='f3b35337-ea07-473b-b86e-715e49b02dea';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='071ff8d7-e2ee-4788-a700-821200895d40';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='0accccc3-526b-4017-b7e8-dc7a62620da8';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='398c22e0-0211-493d-870a-40e75d7651d1';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='2958c212-5880-437b-b25a-6c1c75fd9b17';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='ba08e7d2-00f7-4ff6-8b28-9e7fccfa3817';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='20de2d8e-dd2b-4901-b265-b5c4159968bd';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='a47cd7c6-d9b7-459b-a734-7fb36fe4927d';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='9a183494-08fd-4a71-8b66-9cc6efe1b5df';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='cffa8333-218e-47b1-a17d-021a6c0f2ec3';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='7f9dbff6-4675-4048-bd5a-192cec9ddc16';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='36b275ad-852c-414e-befe-76d6d6ee61ce';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='1a69b39f-dd04-4400-9e0a-b632f0c90376';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='a3f01a53-507e-4a67-93c5-34d9e850565b';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='2add747a-d2b9-4f86-9b0f-4493e2f400b9';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='c306c7a8-9413-48ba-a303-77209c8dd63e';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='e6b251fc-1abd-4a88-9d1a-a633e4b73ca8';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='84cb6b36-d427-4f1e-a822-5a32e78e9195';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='91f05590-b361-42e7-8d90-a2eeacfb72c3';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='8c8f09cf-e293-4680-b2f4-f7028a349767';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='158d4fdf-79ca-454f-98ae-5689d6f6ad59';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='680e43e2-2058-4587-b38b-efd4edec2817';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='542c91b3-44b4-4b1a-9ceb-e1fc18212b4e';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='4b0be356-3e3a-47b9-a983-1608f8850912';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='e4b3302c-cada-4b9f-8a2c-2b213bfd6ca8';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='e0fe5d46-d0a2-453e-99df-1fc5d99d085e';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='066a51ca-d014-4d52-9234-28bfb68558c0';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='48e549af-65fa-43a3-b50f-7f5834df4cb4';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='0e5460fa-3593-4af2-a447-dc23a7c1fdde';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='919ee6b3-72e6-42ed-832f-4be6d5c04701';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='3e22072f-4a61-4f99-a18f-c0a122197066';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='b0217956-1ac7-46e0-83db-fc775eafa8c2';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='23dc3a16-5392-499f-b31e-2bb6fb94dcc7';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='73d2309e-55bc-4bd6-b1b1-f742199c2c6a';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='4becc634-2ed4-4a51-be31-adde65e6f913';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='2649b42b-6725-4da3-bc1d-dc3f1b9a1c55';
UPDATE journal_entry_lines SET account_id='50000-payroll-clearing' WHERE id='ed148602-7e5d-40c0-ac87-9253ea341ff4';

-- Step 3: Repoint 48 LEAF DR lines → LEAF Clearing
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='3b55d23a-0696-47a5-a38a-5b16c8593a86';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='61433bd3-12eb-4956-8008-d6ec8613a813';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='c3da406f-ca6c-4884-afb5-3e0f63b65fa0';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='8f4d7441-6fab-4f95-9975-35bcd7b2144c';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='33dc61c4-555a-424b-85e4-6b9c737705b5';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='5a09a032-e341-4232-89ed-98deab3be188';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='714eebb8-f36a-44b5-98a0-b6b363f6a716';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='5a070904-93cc-4157-9e49-a15ecf72fbec';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='9acdd1c6-cfce-4a33-bfda-7f4690499bce';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='797847d1-e1dc-4c54-a3b0-d90dfaa0db9b';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='6553d3ac-668f-47ec-9692-7281ae4c8eae';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='650c6763-15b6-44f7-866e-17341f89c4c0';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='2b8d2bc2-7d84-43f6-8593-186426899ec1';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='11ef4403-5fa9-45db-915a-5b2f8fb36beb';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='f7056d4f-2728-45f7-b8df-4ff9c4cc909e';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='5ebe9fca-936e-4e3f-b28d-49295b344b79';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='dca7d306-3f76-4c11-8c43-c0768c6f8157';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='59b58e83-1c65-43a5-89c5-7a19a8f2d014';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='cf82e7d1-9dc4-47ff-a9c6-4a02684a1601';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='c1a0e38d-03b3-4c64-8ecb-24a1f9619ba9';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='ec3a109d-8ef9-45c1-8bde-220fc6186797';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='099da0e9-8ff9-44d3-8ba2-79cb665855fd';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='6f83460a-ae68-47c1-a1b6-2381cecf32fe';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='608a89ce-bd3e-4732-b04f-88066ff4b425';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='664dc278-2f51-4fe9-9934-4370051aa986';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='0511d444-1a34-4f0f-9cc4-ebaffb715950';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='2bdb7412-ee58-41e4-bd30-8f2ead38670c';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='930624a2-f82f-467d-95ef-23622e06af16';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='65b8ce68-3778-42d8-b46c-e6f7cd93569c';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='144dd46e-d1bf-41f5-9010-799c3511171b';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='13e45aab-10dd-466c-b4b4-07d4055c5427';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='c73ac2c6-43ff-4597-ba3b-811eb77c9cd6';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='4e331012-ec2c-46fd-96d0-6bb489ec69f8';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='c2fbdd1b-34d9-4394-a9a3-a013a07a39e8';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='c038e8f1-75db-456a-ae96-69f954c95e25';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='63e5ef32-b9db-4dc3-9c5e-95229e24e0e6';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='e8ea88a6-55c5-4ace-b570-c97ce168ad79';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='639e7a36-971a-4f3a-83c6-bbb50b64e2fa';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='a0596468-3b34-483a-83d7-f25ba59e1849';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='65ebd111-6b53-4158-b6c3-acdef73ecb6b';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='8cb6a8ff-e285-4b46-a348-04f7becf23d9';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='02d10091-6d6c-42e4-b3a3-94d911a7518c';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='ef2bec61-5b24-4b42-b228-33761acb8a18';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='e8558a73-4dda-4bbd-a3ad-a4abe8d5f165';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='d8dff049-f4d3-42f9-9ec1-f5a4d592c060';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='63c19e58-4600-47c0-8985-cac8a54611f0';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='9de9a993-2e44-4c23-8d1e-838dcc526673';
UPDATE journal_entry_lines SET account_id='50001-leaf-clearing' WHERE id='5398af68-aa7e-484d-b817-f55ff739d76b';

-- Step 4: Annotate 91 parent JE notes
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='029b47ee-5306-4b19-92a9-856493c4f3fc';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='0405fe94-8ad9-483a-b22b-a8dcfb1d27a9';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='049dd89f-8f53-4d29-b850-cc3695fe8331';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='04e23b8f-29e8-4785-82ba-738ce5c66fda';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='12b52652-6fb0-4dc5-a427-0f7932d2d29b';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='14d556bd-fb05-4621-bbb2-c665277b3f5e';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='15cd5dc6-df97-4140-b8b5-4d2c3b8fba54';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='1643bb8c-50d5-4c2b-8c75-8e2a96e0d608';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='171ba5ea-7229-4f9b-b58b-8651bf49b769';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='1ae5fbc1-4ff1-4c50-807c-45ad203cc555';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='238cca53-c134-4147-a5d1-f19128830459';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='23b03819-5a8e-446b-9279-bc67ae0484e7';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='25f091a3-c624-4b8f-847d-0d7e72cf1ec4';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='27c6847d-221a-40b1-b5fe-fc0ea6ffa42f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='2e68a3cb-4dda-46e8-8b2d-472d9cb6cf54';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='31954112-b945-4047-9471-8073391fe66b';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='34833cad-4170-40df-89ad-ea63489cc995';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='39473b9b-0294-4feb-b4d6-2461f0c18142';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='39877d50-57de-47f1-8c01-38edca24414f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='3e33bf9f-040a-489b-b8fe-fbcf8d41874f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='3e8992e9-1e61-43ef-aa79-631b919c2df2';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='42d8c6b6-afe2-47c7-a8a4-a6407a19bcc1';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='47999c20-75db-4aaf-984c-f7d289dfc669';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='53daa564-d316-42bd-81e6-aff0b138cf7b';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='5791b449-3c27-45f3-a5c2-bdfd043ff13e';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='58e3264e-3435-46f3-bf4e-41602c47554d';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='5c4e529d-ea30-46ed-96a6-68db8af4769c';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='61069e90-0f3e-4e90-9efb-c1ac77e56bcf';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='66c41dca-66bc-400e-90aa-206b26229805';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='6965a70b-6662-40d3-8b77-c94f21f74458';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='69b4ec0f-5a42-48d3-8b04-107dd320c0ca';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='71288da5-fd15-4917-a500-b43e6af09637';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='724b186b-8e49-4db5-832c-33ddf4fac1fe';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='72892e41-1c36-4a77-bc69-515b86fbaed7';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='74836127-6c52-445f-a631-94124b48e4a8';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='76600736-3ea1-47b8-8a95-ec22d94e9bfb';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='7878ca48-408c-4f5a-8b94-81381aaef6bc';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='7da43461-23b9-441e-8d54-acd616749f88';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='7e41b62f-c8e7-4214-9bc8-0d8055019d50';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='80815291-97e1-45ea-a7d4-731e30e597e1';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='80bd834b-f0e4-4682-ad32-6133b8b10129';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='81dc8dc8-b5bc-49c0-b360-6db22f9d016f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='81e53c79-24fe-4fc3-8d15-1da0e550f153';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='83c49255-686d-463c-a6cb-b8e8c6f60c81';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='87238486-bacf-43a4-bd5d-e5b41a5b4d87';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='894c8702-5de6-4fd3-a391-5118f457f79d';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='8a55a019-88ab-471f-b0c5-fcacae37dfa1';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='8badff2c-5d39-4df7-a7e1-67cb87ae732c';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='8bdfdc9c-51d1-4136-b657-7a4b7c43da3f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='8e824e37-5b98-4b76-a8a0-505b881d003d';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='909137a5-3b03-49cf-8a7e-ab8357c7830d';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='93b17a48-8fa3-4c3e-9201-8ae6e35ba2fe';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='9d43f0a9-d1ef-4092-98bf-720eb260e143';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='a3c20390-9a07-490b-a47b-7fbb69a6890b';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='a5813bfb-3717-4f5c-8ffe-9cc8cf5d027a';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='a589dcff-faa3-4451-8c57-516fdeaf31dd';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='a6bea353-b41b-4e93-a335-54a4b05fab8b';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='a898fde6-54c0-4786-82c5-349acdefef44';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='ab16bb85-1e8c-4e73-a080-57f1ed3e4492';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='ac76ed91-67f3-46bd-9a53-d39fdfd4dc8d';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='ae8fd1b8-1d2c-415d-9824-882fd9f060ef';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='aef6d179-4e18-4093-9cb4-708f682cbfc1';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='b40674d3-934f-42f8-850f-0103c1302877';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='b969bf8a-1730-4ce5-a351-3818908489b0';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='be8f2f90-f734-4039-8779-e6d4c17bdece';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='c3c342cd-6e5a-47f5-bb46-01acf9eac6e1';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='c43db14e-c902-4fb2-ba09-48c16b55861f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='c61a5772-506c-4568-bad4-fddf62651be6';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='cb9e444d-15e5-43c8-833a-dd2ac52825a2';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='cda1b088-f31f-4d89-9070-0f3dd7aa1b13';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='d19f1ec0-1863-480c-b6c8-1a8ee0a2caf4';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='d240cc8f-6c97-45a0-96ec-9c89b730e854';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='d9d4573c-25ed-4fd6-891e-c9b55db2f74c';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='da523d1b-4b28-483a-85ed-290bcc4287d6';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='db25e5b9-a823-4d4d-a524-43ab33245c4f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='dd19747e-c8c2-43c7-be64-963704936235';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='e0b03591-dfa9-4767-8bc0-7576e36012a7';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='e393f68c-8235-469f-bbce-647976672b03';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='e3bd27e9-35a0-4e44-a471-28eaf8994e8c';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='e70c17d3-cd3b-4cb9-aab9-70e6bca42e1f';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='ed652355-f50e-44c6-8b70-cc16dc27e354';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='efa3c79b-0023-425c-b5cc-1fa432a4eb68';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='f139392c-ce12-4865-87b7-501a53f67a92';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='f41bd9d3-8e0c-44fe-b5eb-104ddbab775d';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='f42f2dd1-1555-4619-89dc-79655e423e0a';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='f5d2431a-bae7-4683-8e23-ecdf843a4f19';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='f72f20d7-8dc9-476e-9a84-ce1fc6c34659';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='f769e675-2160-4acc-a0b2-81a8474abc35';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='fa552d9a-77e2-4720-92df-cfec6ee5d399';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='fc9af0b4-cc1d-4940-a461-a83d3d7f60c6';
UPDATE journal_entries SET notes=COALESCE(notes,'') || ' | Phase 30 Pattern B 2026-05-20: DR side repointed from expense/liability to clearing account; accrual side posted by reconstruction worker.' WHERE id='fcfc874d-d9f5-4ff5-8a1e-738f27a30b2d';

-- Step 5: Re-lock closed_periods
UPDATE closed_periods
   SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
 WHERE unlock_reason LIKE 'Phase 30 Pattern B%';
