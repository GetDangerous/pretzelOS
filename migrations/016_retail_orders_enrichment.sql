-- 016: Retail Orders Enrichment
-- Adds columns to orders table for richer Toast/Square data
-- Adds momentum + behavior columns to retail_customers for AI analytics

-- ── Orders table enrichment ─────────────────────────────────────
ALTER TABLE orders ADD COLUMN tip_amount REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN dining_option TEXT;
ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN customer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_revenue ON orders(gross_revenue);

-- ── Retail customers: AI analytics columns ──────────────────────
ALTER TABLE retail_customers ADD COLUMN momentum_score INTEGER DEFAULT 0;       -- -100 to +100
ALTER TABLE retail_customers ADD COLUMN behavior_type TEXT;                      -- explorer | loyalist | social | opportunist | emerging
ALTER TABLE retail_customers ADD COLUMN churn_probability_7d REAL DEFAULT 0;    -- 0.0 to 1.0

CREATE INDEX IF NOT EXISTS idx_retail_customers_momentum ON retail_customers(momentum_score);
CREATE INDEX IF NOT EXISTS idx_retail_customers_behavior ON retail_customers(behavior_type);

-- ── Campaign sends: win-back tracking ───────────────────────────
ALTER TABLE retail_campaign_sends ADD COLUMN rechurn_at TEXT;                   -- date if customer churned again after win-back
