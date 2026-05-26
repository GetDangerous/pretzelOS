-- Free Pretzel Welcome campaign overhaul
-- 1. Add missing columns for drip expiry + win-back flagging
-- 2. Rewire the campaign row to trigger on (first order + sms_consent) with a real 3-step drip

-- ── Schema: expiry_days on campaigns ───────────────────────────────
ALTER TABLE retail_campaigns ADD COLUMN expiry_days INTEGER DEFAULT 14;

-- ── Schema: discount code + expiry on each send ───────────────────
ALTER TABLE retail_campaign_sends ADD COLUMN discount_code TEXT;
ALTER TABLE retail_campaign_sends ADD COLUMN expires_at TEXT;

-- ── Schema: welcome tracking on customers ─────────────────────────
ALTER TABLE retail_customers ADD COLUMN welcomed_not_redeemed INTEGER DEFAULT 0;
ALTER TABLE retail_customers ADD COLUMN welcomed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_retail_welcomed
  ON retail_customers(welcomed_not_redeemed)
  WHERE welcomed_not_redeemed = 1;

-- ── Index: fast lookup for existing enrollments in a campaign ─────
CREATE INDEX IF NOT EXISTS idx_sends_campaign_customer
  ON retail_campaign_sends(campaign_id, customer_id);

-- ── Rewire the Free Pretzel Welcome row ──────────────────────────
UPDATE retail_campaigns SET
  trigger_type = 'event',
  -- Trigger: fires on order.completed, only if first order + sms_consent + from Square
  trigger_config = json('{
    "event": "order.completed",
    "conditions": {
      "visit_count_eq": 1,
      "sms_consent_eq": 1,
      "acquisition_source_eq": "square"
    },
    "delay_seconds": 7200,
    "re_enrollment_days": 365
  }'),
  -- 3-step drip: Day 0 welcome → Day 7 reminder → Day 13 urgent
  drip_schedule = json('[
    {"day": 0,  "variant": "welcome"},
    {"day": 7,  "variant": "reminder"},
    {"day": 13, "variant": "urgent"}
  ]'),
  -- Copy variants — {first_name}, {code}, {expires_short} are interpolated at send time
  message_variants = json('{
    "welcome":  "Hey {first_name}! Welcome to Dangerous Pretzel Co. Grab a free pretzel on us — code {code} for $8 off at dangerouspretzel.com. Good thru {expires_short}. Reply STOP to opt out",
    "reminder": "Hi {first_name} — friendly nudge: your $8-off code {code} is still good thru {expires_short}. Come grab your free pretzel.",
    "urgent":   "Last day, {first_name} — code {code} ($8 off) expires tomorrow. Dont miss out: dangerouspretzel.com"
  }'),
  expiry_days = 14,
  send_strategy = 'drip',
  campaign_mode = 'continuous',
  status = 'active',
  updated_at = datetime('now')
WHERE id = '9143a900-ba1c-48b5-9a15-06db2e7bd095';
