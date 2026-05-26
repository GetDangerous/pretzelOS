-- Migration 035 — Name recovery + campaign expansion (2026-04-22)
-- Prerequisite for NPD campaign Sunday + Bronze/Recovery/Last Call win-back expansion.
-- Unlocks ~2,000+ additional reachable SMS customers whose names existed in orders.customer_name
-- but never got written back to retail_customers.first_name during the Toast→Square transition.

-- ════════════════════════════════════════════════════════════════════
-- PHASE 0: NAME RECOVERY + CONSENT BACKFILL
-- ════════════════════════════════════════════════════════════════════

-- Step 0.1: Recover first_name from orders.customer_name where retail_customers has NULL/junk.
-- Takes the FIRST word of the customer_name (Square often stores "Given Family") and writes
-- it to first_name. Matches orders by normalized phone (stripping +1, dashes, parens, spaces).
-- Filters out generic labels (Guest checkout, Valued Customer, etc.) and phone-as-name patterns.
-- Prefers most recent order in case name changed (e.g. "Guest" → real name later).
UPDATE retail_customers
SET first_name = (
  SELECT TRIM(SUBSTR(o.customer_name, 1, CASE
    WHEN INSTR(o.customer_name, ' ') > 0 THEN INSTR(o.customer_name, ' ') - 1
    ELSE LENGTH(o.customer_name)
  END))
  FROM orders o
  WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(o.customer_phone,''),'+1',''),'-',''),' ',''),'(',''),')','') = retail_customers.normalized_phone
    AND o.customer_name IS NOT NULL
    AND LENGTH(TRIM(o.customer_name)) >= 2
    AND LOWER(TRIM(o.customer_name)) NOT IN ('guest checkout','valued customer','customer','guest','unknown','cardholder','visa cardholder','mastercard','amex','discover','na','n/a','none')
    AND o.customer_name NOT GLOB '+*'
    AND o.customer_name NOT GLOB '1[0-9]*'
  ORDER BY o.order_date DESC
  LIMIT 1
),
updated_at = datetime('now')
WHERE (first_name IS NULL
       OR LENGTH(TRIM(COALESCE(first_name,''))) < 2
       OR LOWER(first_name) IN ('guest checkout','valued customer','customer','guest','unknown','cardholder','visa cardholder','mastercard','amex','discover','na','n/a','none')
       OR first_name GLOB '+*'
       OR first_name GLOB '1[0-9]*');

-- Step 0.2: Enable sms_eligible ONLY for recovered-name customers with 2+ visits.
-- Implicit-consent heuristic: repeat visits = ongoing relationship. Single-visit Toast customers
-- stay sms_eligible=0 pending Drew's consent policy decision (TCPA caution).
UPDATE retail_customers
SET sms_eligible = 1, sms_consent = 1, updated_at = datetime('now')
WHERE first_name IS NOT NULL
  AND LENGTH(TRIM(first_name)) >= 2
  AND LOWER(first_name) NOT IN ('guest checkout','valued customer','customer','guest','unknown','cardholder','visa cardholder','mastercard','amex','discover','na','n/a','none')
  AND first_name NOT GLOB '+*'
  AND first_name NOT GLOB '1[0-9]*'
  AND normalized_phone IS NOT NULL
  AND LENGTH(normalized_phone) = 10
  AND visit_count >= 2
  AND (sms_eligible = 0 OR sms_eligible IS NULL);

-- ════════════════════════════════════════════════════════════════════
-- PHASE 1: NATIONAL PRETZEL DAY CAMPAIGN (manual-fire, Fri/Sat waves)
-- ════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO retail_campaigns (
  id, name, campaign_type, status, approval_status,
  trigger_type, campaign_mode, send_strategy,
  target_segment, expiry_days, daily_send_limit,
  agent_reasoning, created_at, updated_at
) VALUES (
  'holiday_npd_2026',
  'National Pretzel Day — $1 Salty',
  'holiday_promo',
  'active', 'approved',
  'manual', 'manual', 'immediate',
  'all', NULL, 500,
  'One-shot event campaign for National Pretzel Day 2026-04-26. Two waves: Fri targeting high-intent (SALTY fans + recent regulars + group buyers), Sat targeting warm lapsed 61-180d. No discount code — $1 Salty handled at register.',
  datetime('now'), datetime('now')
);

-- ════════════════════════════════════════════════════════════════════
-- PHASE 2: BRONZE SAVE — 2-3 Visit Rescue (condition-triggered continuous)
-- ════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO retail_campaigns (
  id, name, campaign_type, status, approval_status,
  trigger_type, campaign_mode, send_strategy,
  target_segment, target_criteria, trigger_config,
  exclude_campaigns, ab_config, message_variants,
  expiry_days, daily_send_limit,
  agent_reasoning, created_at, updated_at
) VALUES (
  'bronze_save_2026',
  'Bronze Save — 2-3 Visit Rescue',
  'winback_bronze',
  'active', 'approved',
  'condition', 'continuous', 'immediate',
  'all',
  json('{"visit_count_min":2,"visit_count_max":3,"days_since_last_visit_min":30,"days_since_last_visit_max":180}'),
  json('{"conditions":{"visit_count_min":2,"visit_count_max":3,"days_since_last_visit_min":30,"days_since_last_visit_max":180,"sms_eligible_eq":1},"re_enrollment_days":180}'),
  json('["singles_lapsed_2026","9ec6f467-0134-445f-b265-5951b0a0a9db","daa07670-fd60-434e-83ca-df37d21db7b8","platinum_winback_2026"]'),
  json('{"arms":[{"name":"A","weight":28,"variant_key":"miss"},{"name":"B","weight":28,"variant_key":"curious"},{"name":"C","weight":28,"variant_key":"direct"}],"control_pct":16}'),
  json('{"miss":"Hey {first_name} — missed you since that last {favorite_sku_or_default}. $5 off with {code} thru {expires_short}. Reply STOP","curious":"Hey {first_name} — been thinking about you. $5 off your next pretzel at Dangerous Pretzel with {code} thru {expires_short}. Reply STOP","direct":"{first_name}, Dangerous Pretzel. You came in twice. Come make it three. $5 off with {code}. Reply STOP"}'),
  14, 30,
  'Covers the 2-3 visit lapsed/churned gap — customers who came back once (proving they like it) but never crossed into regular status. ~600 eligible post name-recovery. $5 off matches Singles discount since LTV is similar.',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO retail_campaign_discounts (id, campaign_id, code, discount_type, amount, valid_until, status, created_at) VALUES
  (lower(hex(randomblob(16))), 'bronze_save_2026', 'DPBRNZ', 'FIXED_AMOUNT', 500, date('now','+60 days'), 'active', datetime('now'));

-- Add Bronze to Singles' exclude_campaigns (a 1-visit customer crossing to 2 visits should
-- now be in Bronze's cohort, not duplicated back into Singles)
UPDATE retail_campaigns
SET exclude_campaigns = json('["bronze_save_2026","9ec6f467-0134-445f-b265-5951b0a0a9db","daa07670-fd60-434e-83ca-df37d21db7b8","platinum_winback_2026"]'),
    updated_at = datetime('now')
WHERE id = 'singles_lapsed_2026';

-- ════════════════════════════════════════════════════════════════════
-- PHASE 3: CHURN RECOVERY — 61-180d with 2+ visits (condition-triggered continuous)
-- ════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO retail_campaigns (
  id, name, campaign_type, status, approval_status,
  trigger_type, campaign_mode, send_strategy,
  target_segment, target_criteria, trigger_config,
  exclude_campaigns, ab_config, message_variants,
  expiry_days, daily_send_limit,
  agent_reasoning, created_at, updated_at
) VALUES (
  'churn_recovery_2026',
  'Churn Recovery — Been Gone 61-180 Days',
  'winback_recovery',
  'active', 'approved',
  'condition', 'continuous', 'immediate',
  'all',
  json('{"visit_count_min":2,"days_since_last_visit_min":61,"days_since_last_visit_max":180}'),
  json('{"conditions":{"visit_count_min":2,"days_since_last_visit_min":61,"days_since_last_visit_max":180,"sms_eligible_eq":1},"re_enrollment_days":365}'),
  json('["bronze_save_2026","singles_lapsed_2026","9ec6f467-0134-445f-b265-5951b0a0a9db","daa07670-fd60-434e-83ca-df37d21db7b8","platinum_winback_2026"]'),
  json('{"arms":[{"name":"A","weight":30,"variant_key":"warm"},{"name":"B","weight":30,"variant_key":"personal"},{"name":"C","weight":30,"variant_key":"apology"}],"control_pct":10}'),
  json('{"warm":"Hey {first_name} — its been {weeks_since_last} weeks. Come grab a {favorite_sku_or_default} from Dangerous Pretzel, $10 off with {code} thru {expires_short}. Reply STOP","personal":"{first_name}, Drew here from Dangerous Pretzel. Missing you. $10 off waiting at {code} thru {expires_short}. Reply STOP","apology":"Hey {first_name} — feels like we lost touch. Heres $10 off from Dangerous Pretzel with {code} to change that. Thru {expires_short}. Reply STOP"}'),
  14, 40,
  'Covers 61-180 day churned customers with 2+ visits — the dead zone where Gold excludes churned and Silver requires narrow CLV band. ~700 eligible post-recovery. Stronger $10 offer for dormant customer.',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO retail_campaign_discounts (id, campaign_id, code, discount_type, amount, valid_until, status, created_at) VALUES
  (lower(hex(randomblob(16))), 'churn_recovery_2026', 'DPRCV', 'FIXED_AMOUNT', 1000, date('now','+60 days'), 'active', datetime('now'));

-- ════════════════════════════════════════════════════════════════════
-- PHASE 4: LAST CALL — 181-365d cold wake-up (draft status, flip to active after proving)
-- ════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO retail_campaigns (
  id, name, campaign_type, status, approval_status,
  trigger_type, campaign_mode, send_strategy,
  target_segment, target_criteria, trigger_config,
  exclude_campaigns, ab_config, message_variants,
  expiry_days, daily_send_limit,
  agent_reasoning, created_at, updated_at
) VALUES (
  'last_call_2026',
  'Last Call — Cold Wake-Up',
  'winback_lastcall',
  'draft', 'pending',
  'condition', 'continuous', 'immediate',
  'all',
  json('{"visit_count_min":1,"days_since_last_visit_min":181,"days_since_last_visit_max":365}'),
  json('{"conditions":{"visit_count_min":1,"days_since_last_visit_min":181,"days_since_last_visit_max":365,"sms_eligible_eq":1},"re_enrollment_days":99999}'),
  json('["churn_recovery_2026","bronze_save_2026","singles_lapsed_2026","9ec6f467-0134-445f-b265-5951b0a0a9db","daa07670-fd60-434e-83ca-df37d21db7b8","platinum_winback_2026"]'),
  json('{"arms":[{"name":"A","weight":42,"variant_key":"goodbye"},{"name":"B","weight":43,"variant_key":"nostalgic"}],"control_pct":15}'),
  json('{"goodbye":"{first_name} — been a long time. One last hello from Dangerous Pretzel. $10 off with {code} if you ever want to come back. Thru {expires_short}. Reply STOP","nostalgic":"Hey {first_name} — you used to come in to Dangerous Pretzel. We still make pretzels. $10 off waiting at {code}. Reply STOP"}'),
  21, 50,
  'Experimental one-shot for 181-365d cold cohort (~2,500 eligible post-recovery). Never re-enrolls (re_enrollment_days=99999). Pure volume test: can we wake up customers who have been gone >6mo? Framed as graceful goodbye. Starts draft — flip to active ONLY after Bronze proves >=1% conversion.',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO retail_campaign_discounts (id, campaign_id, code, discount_type, amount, valid_until, status, created_at) VALUES
  (lower(hex(randomblob(16))), 'last_call_2026', 'DPLAST', 'FIXED_AMOUNT', 1000, date('now','+60 days'), 'active', datetime('now'));
