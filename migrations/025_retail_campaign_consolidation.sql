-- Retail campaign consolidation: 10 → 5 campaigns with A/B testing + control arms + graduated offers
-- Kills 6 dead campaigns, upgrades 3 to consolidated Platinum/Gold/Silver/Singles/Momentum tiers,
-- adds the schema needed for A/B testing and control-arm holdout.

-- ── Schema: A/B testing + control holdout on sends ───────────────
ALTER TABLE retail_campaign_sends ADD COLUMN ab_arm TEXT;
ALTER TABLE retail_campaign_sends ADD COLUMN control_holdout_until TEXT;

-- ── Schema: A/B config + cross-campaign exclusion on campaigns ──
ALTER TABLE retail_campaigns ADD COLUMN ab_config TEXT;
ALTER TABLE retail_campaigns ADD COLUMN exclude_campaigns TEXT;
ALTER TABLE retail_campaigns ADD COLUMN send_window TEXT;
CREATE INDEX IF NOT EXISTS idx_sends_ab_arm
  ON retail_campaign_sends(campaign_id, ab_arm, control_holdout_until);

-- ── Archive 6 dead/consolidated campaigns ──────────────────────
UPDATE retail_campaigns
SET status = 'archived', updated_at = datetime('now')
WHERE id IN (
  'f12a39d0-403d-4678-81be-f2b9789ff638', -- First-Timer Day 7 Nudge
  '4b0b1ab1-5a1b-430d-9cc5-f0f218461210', -- New Customer Onboarding
  'a2b6913e-0ee1-451b-b67f-4d491e584a0d', -- VIP Thank You
  '9b69eb2d-5cfe-4d62-8d05-d59ab9135da3', -- Magic Number Push
  'e2da6b50-f095-484a-a345-095f6e467bd6', -- Win-back: Spicy Bee Lapsed VIPs
  'd4d34513-8425-4288-a56d-43437d930b20'  -- Group Buyers: 4 to Reactivate
);

-- Disable their active discount codes too (avoid accidental redemption of stale offers)
UPDATE retail_campaign_discounts SET status = 'disabled'
WHERE campaign_id IN (
  'f12a39d0-403d-4678-81be-f2b9789ff638',
  '4b0b1ab1-5a1b-430d-9cc5-f0f218461210',
  'a2b6913e-0ee1-451b-b67f-4d491e584a0d',
  '9b69eb2d-5cfe-4d62-8d05-d59ab9135da3',
  'e2da6b50-f095-484a-a345-095f6e467bd6',
  'd4d34513-8425-4288-a56d-43437d930b20'
) AND status = 'active';

-- ── Repurpose "Save 11 High-Value" row as Silver ─────────────────
UPDATE retail_campaigns SET
  name = 'Silver Save — At-Risk',
  campaign_type = 'winback_silver',
  status = 'active',
  approval_status = 'approved',
  trigger_type = 'condition',
  campaign_mode = 'continuous',
  send_strategy = 'immediate',
  target_segment = 'all',
  target_criteria = json('{"churn_probability_min":0.7,"clv_min":50,"clv_max":100}'),
  trigger_config = json('{"conditions":{"churn_probability_min":0.7,"predicted_clv_min":50,"predicted_clv_max":100,"sms_eligible_eq":1},"re_enrollment_days":180}'),
  exclude_campaigns = json('["9ec6f467-0134-445f-b265-5951b0a0a9db","daa07670-fd60-434e-83ca-df37d21db7b8"]'),
  ab_config = json('{"arms":[{"name":"A","weight":37,"variant_key":"offer"},{"name":"B","weight":37,"variant_key":"save"}],"control_pct":26}'),
  message_variants = json('{"offer":"Hey {first_name}, $10 off your next pretzel — use {code} thru {expires_short}. dangerouspretzel.com. Reply STOP","save":"Hey {first_name} — saving your spot. $10 off this week only with {code}. dangerouspretzel.com. Reply STOP"}'),
  expiry_days = 7,
  daily_send_limit = 40,
  updated_at = datetime('now')
WHERE id = 'daa07670-fd60-434e-83ca-df37d21db7b8';

-- ── Repurpose "Win-back: 30 Lapsed VIPs" row as Gold ──────────────
UPDATE retail_campaigns SET
  name = 'Gold Win-Back — Lapsed Regulars',
  campaign_type = 'winback_gold',
  status = 'active',
  approval_status = 'approved',
  trigger_type = 'condition',
  campaign_mode = 'continuous',
  send_strategy = 'immediate',
  target_segment = 'all',
  target_criteria = json('{"visit_count_min":4,"visit_count_max":9,"days_since_last_visit_min":30}'),
  trigger_config = json('{"conditions":{"visit_count_min":4,"visit_count_max":9,"days_since_last_visit_min":30,"sms_eligible_eq":1},"re_enrollment_days":180}'),
  exclude_campaigns = json('["platinum_placeholder"]'),
  ab_config = json('{"arms":[{"name":"A","weight":28,"variant_key":"warm"},{"name":"B","weight":28,"variant_key":"urgency"},{"name":"C","weight":28,"variant_key":"sku"}],"control_pct":16}'),
  message_variants = json('{"warm":"Hey {first_name} — been missing you. Come grab your {favorite_sku_or_default} on us, $15 off with {code} thru {expires_short}. Reply STOP","urgency":"Hey {first_name}, its been {weeks_since_last} weeks! $15 off your next pretzel with {code} thru {expires_short}. Reply STOP","sku":"{first_name} — your {favorite_sku_or_default} is waiting. $15 off with {code} thru {expires_short}. dangerouspretzel.com. Reply STOP"}'),
  expiry_days = 14,
  daily_send_limit = 175,
  updated_at = datetime('now')
WHERE id = '9ec6f467-0134-445f-b265-5951b0a0a9db';

-- ── Repurpose existing VIP Momentum Protection row (keep config, add copy + offer) ──
UPDATE retail_campaigns SET
  name = 'Momentum Save — Catch Before Lapse',
  campaign_type = 'momentum_save',
  status = 'active',
  approval_status = 'approved',
  trigger_config = json('{"conditions":{"visit_count_min":4,"momentum_below":-30,"segment_not_in":["churned","lapsed"],"days_since_last_visit_min":7,"days_since_last_visit_max":29,"sms_eligible_eq":1},"re_enrollment_days":60}'),
  exclude_campaigns = json('["9ec6f467-0134-445f-b265-5951b0a0a9db","daa07670-fd60-434e-83ca-df37d21db7b8"]'),
  message_template = 'Hey {first_name} — havent seen you in a bit. Your {favorite_sku_or_default} is ready when you are. $10 off with {code} thru {expires_short}. Reply STOP',
  expiry_days = 14,
  daily_send_limit = 20,
  updated_at = datetime('now')
WHERE id = 'f20398ce-9192-4bc1-8438-0466dbdb95ae';

-- ── Insert new Platinum campaign row ───────────────────────────
INSERT INTO retail_campaigns (
  id, name, campaign_type, status, approval_status,
  trigger_type, campaign_mode, send_strategy,
  target_segment, target_criteria, trigger_config,
  message_template,
  expiry_days, daily_send_limit,
  agent_reasoning, created_at, updated_at
) VALUES (
  'platinum_winback_2026',
  'Platinum Win-Back — Lapsed VIPs',
  'winback_platinum',
  'active', 'approved',
  'manual', -- explicitly NOT condition/event — Drew fires each one individually via dossier UI
  'manual',
  'immediate',
  'all',
  json('{"visit_count_min":10,"days_since_last_visit_min":30}'),
  json('{"conditions":{"visit_count_min":10,"days_since_last_visit_min":30,"sms_eligible_eq":1},"re_enrollment_days":365}'),
  '[personal — Drew writes each one from the dossier]',
  60, 13,
  'n=13 lapsed VIPs with 10+ visits and avg $269 LTV. Too few to automate, too valuable to template. Drew reviews dossier per person, tweaks copy, fires individually.',
  datetime('now'), datetime('now')
);

-- ── Insert new Singles campaign row ────────────────────────────
INSERT INTO retail_campaigns (
  id, name, campaign_type, status, approval_status,
  trigger_type, campaign_mode, send_strategy,
  target_segment, target_criteria, trigger_config,
  ab_config, message_variants,
  expiry_days, daily_send_limit,
  agent_reasoning, created_at, updated_at
) VALUES (
  'singles_lapsed_2026',
  'Singles Lapsed — Long Tail',
  'winback_singles',
  'active', 'approved',
  'condition',
  'continuous',
  'immediate',
  'all',
  json('{"visit_count_eq":1,"days_since_last_visit_min":30,"days_since_last_visit_max":180}'),
  json('{"conditions":{"visit_count_eq":1,"days_since_last_visit_min":30,"days_since_last_visit_max":180,"sms_eligible_eq":1},"re_enrollment_days":180}'),
  json('{"arms":[{"name":"A","weight":30,"variant_key":"offer"},{"name":"B","weight":30,"variant_key":"curiosity"},{"name":"C","weight":30,"variant_key":"miss"}],"control_pct":10}'),
  json('{"offer":"Hey {first_name}, $5 off your next pretzel — {code} thru {expires_short}. dangerouspretzel.com. Reply STOP","curiosity":"Hey {first_name} — weve got something new since your last visit. $5 off with {code}. dangerouspretzel.com. Reply STOP","miss":"Hey {first_name} — havent seen you in a bit! $5 off your next pretzel with {code}. Reply STOP"}'),
  14, 150,
  'n=1,052 lapsed single-visit customers at avg $24 LTV. 3-arm copy test in Week 1 (500 sends), then scale winning variant to remainder if Week 1 redemption >=3%.',
  datetime('now'), datetime('now')
);

-- ── Discount codes: create rows for the 5 new codes ─────────────
-- NOTE: Drew must create matching discounts in Square Catalog; square_catalog_id populated later
INSERT INTO retail_campaign_discounts (id, campaign_id, code, discount_type, amount, valid_until, status, created_at) VALUES
  (lower(hex(randomblob(16))), 'platinum_winback_2026', 'DPPLAT', 'FIXED_AMOUNT', 2000, date('now', '+60 days'), 'active', datetime('now')),
  (lower(hex(randomblob(16))), '9ec6f467-0134-445f-b265-5951b0a0a9db', 'DPGOLD', 'FIXED_AMOUNT', 1500, date('now', '+60 days'), 'active', datetime('now')),
  (lower(hex(randomblob(16))), 'daa07670-fd60-434e-83ca-df37d21db7b8', 'DPSLVR', 'FIXED_AMOUNT', 1000, date('now', '+60 days'), 'active', datetime('now')),
  (lower(hex(randomblob(16))), 'singles_lapsed_2026', 'DPFIRST', 'FIXED_AMOUNT', 500, date('now', '+60 days'), 'active', datetime('now')),
  (lower(hex(randomblob(16))), 'f20398ce-9192-4bc1-8438-0466dbdb95ae', 'DPMOMX', 'FIXED_AMOUNT', 1000, date('now', '+60 days'), 'active', datetime('now'));

-- Fix Gold's exclude_campaigns self-reference to point at the real Platinum ID
UPDATE retail_campaigns SET exclude_campaigns = json('["platinum_winback_2026"]') WHERE id = '9ec6f467-0134-445f-b265-5951b0a0a9db';
