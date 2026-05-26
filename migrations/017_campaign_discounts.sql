-- Campaign discount codes linked to Square Catalog API
CREATE TABLE IF NOT EXISTS retail_campaign_discounts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  square_catalog_id TEXT,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'FIXED_AMOUNT',  -- 'FIXED_AMOUNT' or 'FIXED_PERCENTAGE'
  amount INTEGER NOT NULL DEFAULT 500,                  -- cents for fixed, whole number for percentage
  max_redemptions INTEGER,
  times_redeemed INTEGER DEFAULT 0,
  valid_until TEXT,
  status TEXT DEFAULT 'active',  -- active, expired, disabled
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaign_discounts_campaign ON retail_campaign_discounts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_discounts_square ON retail_campaign_discounts(square_catalog_id);
CREATE INDEX IF NOT EXISTS idx_campaign_discounts_code ON retail_campaign_discounts(code);
