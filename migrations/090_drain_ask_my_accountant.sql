-- migrations/090_drain_ask_my_accountant.sql
-- Phase 31-A2: Drain Ask My Accountant by reclassing $40K of Chase Ink Mercury IO charges
-- to proper expense + liability accounts based on Drew-confirmed vendor mapping.
--
-- Approach: UPDATE journal_entry_lines.account_id directly (preserves date + JE structure).
-- Each line's account_id changes from Ask My Accountant to the proper category.

UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='31-A2', unlocked_by='phase_31_a2' WHERE unlocked_at IS NULL;

UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='65d95c8b-2ba1-4660-bdb4-77f2554c5976';  -- Mercury IO charge · Statefoodsafetycom · ••0475 $25.99 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='2b7a54e4-5bfd-42b7-913b-f6cb392e4f6e';  -- Mercury IO charge · Statefoodsafetycom · ••3877 $134 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='664b7ab2-6613-4705-833a-1563a08641e2';  -- Mercury IO charge · Statefoodsafetycom · ••3877 $402 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='2cf0a517-e0cb-45e4-9ca5-65afccc0417a';  -- Mercury IO charge · Digital Room · ••3877 $731.4 -> Office expenses
UPDATE journal_entry_lines SET account_id='6fe11a6a-eae8-4aa5-b65e-5b9f0dc6c289' WHERE id='c4ad97f4-e5f1-4556-a5e7-d4627b306f4b';  -- Mercury IO charge · State Wine Store · ••3877 $42.01 -> Cost of goods sold:Liquor Purchases
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='fd6667f0-38fe-4d0e-a208-261f08d0d7a3';  -- Mercury IO charge · Statefoodsafetycom · ••3877 $25.99 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='ea5377fa-9c33-48d0-b12a-8cef88b3c295';  -- Mercury IO charge · Statefoodsafetycom · ••3877 $25.99 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='2baa2e34-6dee-4ff6-a159-516875ce2b8f';  -- Mercury IO charge · Statefoodsafetycom · ••3877 $24 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='00e39376-235f-4310-aa62-d87f7f8d8814' WHERE id='8eac1dee-8b46-47bc-b164-43ec8132dabf';  -- Mercury IO charge · Level Crossing Brewing Company · ••3877 $75.46 -> Cost of goods sold:Beer Purchases
UPDATE journal_entry_lines SET account_id='00e39376-235f-4310-aa62-d87f7f8d8814' WHERE id='6f2aae44-a063-4ab1-ab16-22b0d0edd793';  -- Mercury IO charge · Helper City Library · ••3877 $432 -> Cost of goods sold:Beer Purchases
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='38d20213-78f1-445c-b64e-fa081c0f82e8';  -- Mercury IO charge · OpenAI · ••3877 $21.45 -> Software & apps
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='c047af23-5a33-49a6-8bcb-73a084e6b4db';  -- Mercury IO charge · PayPal · ••3877 $3099.24 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='801acc1b-af62-497d-b38f-dd476f6360ac';  -- Mercury IO charge · Digital Room · ••3877 $53.39 -> Office expenses
UPDATE journal_entry_lines SET account_id='6fe11a6a-eae8-4aa5-b65e-5b9f0dc6c289' WHERE id='912af66f-44dc-42e7-9f6c-94475fd11819';  -- Mercury IO charge · State Wine Store · ••3877 $77.92 -> Cost of goods sold:Liquor Purchases
UPDATE journal_entry_lines SET account_id='219b6726-780e-406f-aefb-e4605b1117e1' WHERE id='5eb3f0b6-9bc1-4a78-aede-d1f993c570f3';  -- Mercury IO charge · Square · ••3877 $19.72 -> Merchant account fees
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='ede0da5b-d628-4a4b-af55-93a85a34a626';  -- Mercury IO charge · OpenAI · ••3877 $21.45 -> Software & apps
UPDATE journal_entry_lines SET account_id='b9aa9dc6-be2d-4447-9787-b2e5be83c388' WHERE id='0038be16-ef5e-44f4-9c3b-e46fa82e7a9d';  -- Mercury IO charge · Utah DMV · ••3877 $1427.62 -> Sales tax to pay
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='209d99d6-29b8-4832-91b3-4e0e44e3b101';  -- Mercury IO charge · PayPal · ••3877 $3467.4 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='e1b2c3af-cb80-4ac2-9e1c-96487e41409f';  -- Mercury IO charge · Salt Lake County Asses · ••3877 $98.59 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='00e39376-235f-4310-aa62-d87f7f8d8814' WHERE id='b1902b53-70af-4ff3-bd11-f4bf3b59a2a8';  -- Mercury IO charge · Level Crossing Brewing Company · ••3877 $62.7 -> Cost of goods sold:Beer Purchases
UPDATE journal_entry_lines SET account_id='219b6726-780e-406f-aefb-e4605b1117e1' WHERE id='a4235238-7e3e-44ac-8ccb-50f257f1f25b';  -- Mercury IO charge · Square · ••3877 $19.72 -> Merchant account fees
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='2a31c254-b4f4-4df2-ae02-ce427c054dfc';  -- Mercury IO charge · OpenAI · ••3877 $21.45 -> Software & apps
UPDATE journal_entry_lines SET account_id='b9aa9dc6-be2d-4447-9787-b2e5be83c388' WHERE id='93e3031a-e8a1-4fd0-b011-f423f1943066';  -- Mercury IO charge · Utah DMV · ••3877 $13015.67 -> Sales tax to pay
UPDATE journal_entry_lines SET account_id='6fe11a6a-eae8-4aa5-b65e-5b9f0dc6c289' WHERE id='37918688-f164-4c6d-8769-cb6f95022dd0';  -- Mercury IO charge · State Wine Store · ••3877 $212.16 -> Cost of goods sold:Liquor Purchases
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='bf799749-1914-474c-b751-87afb63435a3';  -- Mercury IO charge · Anthropic · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='5eee13d2-ba34-45d6-a0b2-1711a2333760';  -- Mercury IO charge · Digital Room · ••3877 $63.45 -> Office expenses
UPDATE journal_entry_lines SET account_id='fb1e3700-e9fa-4f7c-bc22-b1996d83375d' WHERE id='fb6b1d47-bd80-4796-a5d5-51e6334bda10';  -- Mercury IO charge · Ledger Collective · ••3877 $850 -> Legal & accounting services:Accounting fees
UPDATE journal_entry_lines SET account_id='6fe11a6a-eae8-4aa5-b65e-5b9f0dc6c289' WHERE id='e471c444-6a9a-479c-96a2-d5f987be2931';  -- Mercury IO charge · State Wine Store · ••3877 $42 -> Cost of goods sold:Liquor Purchases
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='df61c35a-d3a4-4723-9080-2aab57a4f442';  -- Mercury IO charge · Slcohd - Food · ••0475 $120 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='4ebb74e2-e4ea-4ae1-88d7-90d8bfe071cc';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='7601f1f9-776f-4ecd-bc1e-44a122d3fbd3';  -- Mercury IO charge · Digital Room · ••3877 $201.79 -> Office expenses
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='2f63346a-b605-4c2d-a27a-6a8846d7e5a2';  -- Mercury IO charge · Digital Room · ••3877 $455.76 -> Office expenses
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='62feef0a-740e-47ad-8f6d-44330a7229d0';  -- Mercury IO charge · Slcohd - Food · ••0475 $90 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='c67bc28e-3df6-4225-bb6e-cd716ea9aff0';  -- Mercury IO charge · Anthropic · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='7f3df799-b351-4b80-b8ee-85dee7cc2d91';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='0cd4aaf7-7dfa-4c10-95ba-bb9f27013418';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='fb1e3700-e9fa-4f7c-bc22-b1996d83375d' WHERE id='ccc87478-6c43-4ccf-aba2-c4c0c241da26';  -- Mercury IO charge · Ledger Collective · ••3877 $850 -> Legal & accounting services:Accounting fees
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='d68f2221-3a8f-4b1e-b8ea-2d35404505ca';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='5c87d937-edb7-46c1-bbef-42a7d09ee7e5';  -- Mercury IO charge · Anthropic · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='3e927f9d-0882-41d7-bb0e-368bf251fec6';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='fb1e3700-e9fa-4f7c-bc22-b1996d83375d' WHERE id='d9261ffb-7849-4f26-b79e-7ef4808628a6';  -- Mercury IO charge · Ledger Collective · ••3877 $850 -> Legal & accounting services:Accounting fees
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='7376f085-cde8-41a7-aa3e-7af17c1fa0ea';  -- Mercury IO charge · PayPal · ••3877 $3094 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='50b47857-09e8-4a86-bab8-6984f4070c41';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='97d04ade-52aa-4a09-8894-96984b6f7fa0';  -- Mercury IO charge · Anthropic · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='972e9857-7f38-4f9e-95c4-7ca476e36e3a';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='fb1e3700-e9fa-4f7c-bc22-b1996d83375d' WHERE id='f86da0b6-a301-4c30-b95b-7c237f02c49f';  -- Mercury IO charge · Ledger Collective · ••3877 $850 -> Legal & accounting services:Accounting fees
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='7a4320c6-160d-4774-aff5-ed233a56f3fe';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='bdc14be3-e542-41ba-b0c3-f4f1863b09ea';  -- Mercury IO charge · Anthropic · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='936eff9f-bcfe-45ac-811c-0ec095c73f46' WHERE id='aae64a62-c270-4e67-9f2b-f58020e44d19';  -- Mercury IO charge · Salt & Seek LLC · ••3877 $350 -> Advertising & marketing
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='dcb3b7dc-c6db-4885-903f-e69844122f44';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='1cabb1c3-7c49-4832-9254-09a58e3c25dc';  -- Mercury IO charge · PayPal · ••3877 $950 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='607bca2a-d0cd-4886-9742-26197047648d';  -- Mercury IO charge · Anthropic · ••3877 $105.23 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='13b09234-5619-47c2-ae39-233c670bc81c';  -- Mercury IO charge · Xero · ••3877 $8.25 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='38fcb638-09e3-49d0-b0e1-8777f7d2b5ef';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='00e39376-235f-4310-aa62-d87f7f8d8814' WHERE id='5e089fba-2e13-4411-9b31-5d6270420ddf';  -- Mercury IO charge · Level Crossing Brewing Company · ••3877 $57.18 -> Cost of goods sold:Beer Purchases
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='8547cdf1-e6cc-4bd0-aa9a-9531cfe15c74';  -- Mercury IO charge · Make · ••3877 $11.48 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='2f52d78f-f191-4d35-b015-8214bbce3d7c';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='81154a68-2525-4b85-8c3c-95423bc62fbb';  -- Mercury IO charge · Anthropic · ••3877 $10.85 -> Software & apps
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='c3f58282-8d5d-4791-85f4-1e7e4dc8ee6e';  -- Mercury IO charge · PayPal · ••3877 $176.59 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='dd3030b4-9ab8-43b5-8515-831d946082fc';  -- Mercury IO charge · Apify* Subscription · ••3877 $31.16 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='05a2d2ec-126d-4cb0-a0e6-35159ab32920';  -- Mercury IO charge · Anthropic · ••3877 $5.37 -> Software & apps
UPDATE journal_entry_lines SET account_id='8103988a-ad3e-470a-83ac-63b0306199cb' WHERE id='f6f316e3-a9c3-447d-a1dd-47ebe1ef4cba';  -- Mercury IO charge · Urban Food Con · ••3877 $50 -> Meals
UPDATE journal_entry_lines SET account_id='8103988a-ad3e-470a-83ac-63b0306199cb' WHERE id='5b73fce3-ad74-4294-a5f9-33a370b9f643';  -- Mercury IO charge · Santo Taco · ••3877 $37.98 -> Meals
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='2db3bc82-7119-4ac4-93db-26b9c248e713';  -- Mercury IO charge · Cloudflare · ••3877 $5 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='49067ad0-351a-4350-990a-c3582ea24edb';  -- Mercury IO charge · Apollo · ••3877 $63.38 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='314489c5-987c-4a6c-85fa-f55a71ab9e6b';  -- Mercury IO charge · Anthropic · ••3877 $107.45 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='87dc7266-3398-4a9a-9c1e-0bbb1971e214';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='00e39376-235f-4310-aa62-d87f7f8d8814' WHERE id='b161d82f-a639-41ab-a4f4-f210f9ce6e3c';  -- Mercury IO charge · Level Crossing Brewing Company · ••3877 $18.64 -> Cost of goods sold:Beer Purchases
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='b0d776c9-477c-49ce-989b-5dc4e871fa62';  -- Mercury IO charge · Digital Room · ••3877 $212.27 -> Office expenses
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='9ba307d4-1a2f-458e-b2ac-35ed525e8da2';  -- Mercury IO charge · Make · ••3877 $11.48 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='645177d4-d8ce-4e67-a8b4-fa1907344e51';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='9677c683-f100-4026-8db6-1967f902dced';  -- Mercury IO charge · Anthropic · ••3877 $97.61 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='ee9394a9-6d1e-4136-bc59-56fa7b7f1c6e';  -- Mercury IO charge · Anthropic · ••3877 $27.11 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='bb853af6-d5c2-4196-b572-5084f418dbd2';  -- Mercury IO charge · Anthropic · ••3877 $27.11 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='1d13375e-5b9d-4790-b001-193c7588da00';  -- Mercury IO charge · Apify* Inv#20260404072 · ••3877 $31.16 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='28a29c43-5453-4024-bc68-44c0d2608048';  -- Mercury IO charge · Anthropic · ••3877 $176.21 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='04b1ab4f-5616-4e20-b673-ae50ddd71a7d';  -- Mercury IO charge · Anthropic · ••3877 $27.11 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='d004d6fa-c1c4-419f-9ffd-efd24ef62792';  -- Mercury IO charge · Anthropic · ••3877 $27.11 -> Software & apps
UPDATE journal_entry_lines SET account_id='0c1ff2ad-45a7-4cbb-948a-4b04b053ba35' WHERE id='c7e1590f-c773-49fe-83a5-64f321559de1';  -- Mercury IO charge · Touchstone Commerical · ••3877 $519.71 -> Repairs & maintenance
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='b56c146d-93fa-4978-8957-9ef6a7acf5e5';  -- Mercury IO charge · Cloudflare · ••3877 $5.52 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='263744eb-973a-4dd2-92a6-6cc125785589';  -- Mercury IO charge · Apollo · ••3877 $63.39 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='9b417a91-8275-4e62-9db0-c89e43262286';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='bb416151-1f3c-4270-8ad5-59c1ab1292e4';  -- Mercury IO charge · Make · ••3877 $11.48 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='a7eae0b8-3d70-4d73-ad8f-4ab0df0373ae';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='fb1e3700-e9fa-4f7c-bc22-b1996d83375d' WHERE id='62f5e3bf-292e-4407-8243-b2d2a706d8dd';  -- Mercury IO charge · Ledger Collective · ••3877 $850 -> Legal & accounting services:Accounting fees
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='0cdcc9db-7716-4d3f-a700-766c60ca3416';  -- Mercury IO charge · PayPal · ••3877 $3210.69 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='2e0809ac-7d87-4c81-9694-6c7064a2e614';  -- Mercury IO charge · Anthropic · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='42093edd-6fad-471c-ae5b-56e1cb57d861';  -- Mercury IO charge · Salt Lake County Health Department - Foo $302.5 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='68c1980c-2c75-4333-80fe-92f57ae8a613';  -- Mercury IO charge · Ut Business License · ••0475 $18 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='e8cf242e-30fb-4c1c-b357-ed1acc6729e3';  -- Mercury IO charge · Digital Room · ••0475 $356.54 -> Office expenses
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='21b5dda2-f6f6-4bf4-822e-1848d4c1de36';  -- Mercury IO charge · PayPal · ••3877 $840 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='c39612b4-aed1-4959-8356-3cef82c25ec5';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='d7640996-6bdd-4dfa-9575-ad0da60acd2d';  -- Mercury IO charge · Anthropic · ••3877 $96.98 -> Software & apps
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='df50d18f-62fa-491b-bba7-fc2d91c95327';  -- Mercury IO charge · Utah Department of Alcoholic Beverage Se $750 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='0ffb6cb2-0d47-48b4-9a47-4bb32fc8f9e7';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='b9aa9dc6-be2d-4447-9787-b2e5be83c388' WHERE id='83e9a472-7a6a-40b6-ad42-f2604af1c6b6';  -- Mercury IO charge · Utah DMV · ••3877 $1585.42 -> Sales tax to pay
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='bc5e7f6d-82fe-4d3d-8778-d439554feecb';  -- Mercury IO charge · Digital Room · ••3877 $21.86 -> Office expenses
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='7b0d0ecb-d4ca-4b43-8531-f8d03ab50762';  -- Mercury IO charge · Digital Room · ••3877 $139.26 -> Office expenses
UPDATE journal_entry_lines SET account_id='fb1e3700-e9fa-4f7c-bc22-b1996d83375d' WHERE id='6d14df96-b836-438b-aa5d-9c48fc295ef1';  -- Mercury IO charge · Ledger Collective · ••3877 $850 -> Legal & accounting services:Accounting fees
UPDATE journal_entry_lines SET account_id='ffb54885-616b-42fd-816e-83a7257cffd1' WHERE id='7fe23d2a-1017-4cfd-821d-1172142af5c7';  -- Mercury IO charge · Digital Room · ••3877 $22.69 -> Office expenses
UPDATE journal_entry_lines SET account_id='f56e93c9-e07a-4591-8c81-0d66edf63a37' WHERE id='1feabb2a-b7fd-47b3-92aa-bb77b09087f2';  -- Mercury IO charge · Salt Lake County Health Department - Foo $210 -> Business licenses & Permits
UPDATE journal_entry_lines SET account_id='c5962c07-1b37-47bb-bedf-324e5fea7d12' WHERE id='b600f8a3-169f-4a09-9104-50452e31b4d1';  -- Mercury IO charge · PayPal · ••3877 $840 -> Cost of goods sold:Paper Packaging Products
UPDATE journal_entry_lines SET account_id='219b6726-780e-406f-aefb-e4605b1117e1' WHERE id='9d3d349c-4067-4e1d-b4af-419e041fd24e';  -- Mercury IO charge · Square · ••3877 $30.2 -> Merchant account fees
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='9b86aa4e-a5a5-4c25-854a-7205d27d7c48';  -- Mercury IO charge · OpenAI · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='3de8ee2c-878d-4289-b3e4-a5fd552a3ca9';  -- Mercury IO charge · Anthropic · ••3877 $21.49 -> Software & apps
UPDATE journal_entry_lines SET account_id='40e89e24-12cd-4af2-8e00-294994e88dde' WHERE id='a174c793-ceca-42ef-b94d-c54e19e2873f';  -- Mercury IO charge · OpenAI · ••0475 $21.49 -> Software & apps

-- Mapped: 106 lines, total $44,913.03
-- Unmapped: 1 lines (will remain in Ask My Accountant)
--   UNMAPPED: Mercury IO charge · Love's Travel Stops & Country Stores · ••3877 $63.73


-- Handle Love's Travel Stops separately (apostrophe escaping issue in batch loop)
UPDATE journal_entry_lines SET account_id='8ea0ce68-d7da-4269-b688-2c75dda40eed' WHERE id='b414fc38-b7f3-41e4-b68a-b5a81225303d';

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason='31-A2';
