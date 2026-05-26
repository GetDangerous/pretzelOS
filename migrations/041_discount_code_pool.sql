-- 041_discount_code_pool.sql
-- 3b-rotation mechanism: Drew pre-creates single-use Discount Codes in Square Dashboard
-- (these ARE customer-typeable in Square Online + Register, unlike Catalog DISCOUNT objects).
-- We mirror them in this pool table; the SMS send path draws from the pool, marks used,
-- alerts when low.
--
-- See plan: /Users/drew/.claude/plans/iterative-frolicking-hollerith.md (Phase B.1a)

CREATE TABLE IF NOT EXISTS discount_code_pool (
  id TEXT PRIMARY KEY,                -- uuid
  campaign_id TEXT NOT NULL,          -- which campaign this pool serves
  code TEXT NOT NULL UNIQUE,          -- the Square Dashboard code (e.g. 'WEL001')
  amount_cents INTEGER NOT NULL,      -- $ off in cents (e.g. 800 = $8)
  status TEXT NOT NULL DEFAULT 'available',
  -- Status values: available / assigned / redeemed / expired / voided
  -- 'available' = ready to draw
  -- 'assigned' = drawn for a customer but not yet redeemed
  -- 'redeemed' = customer redeemed it; webhook detected the catalog_object match
  -- 'expired' = auto-expired by cleanup cron (past valid_until)
  -- 'voided' = manually disabled (e.g. duplicate import)
  assigned_to_customer_id TEXT,       -- rc_* id when status='assigned'
  assigned_at TEXT,
  assigned_to_send_id TEXT,           -- retail_campaign_sends.id reference
  redeemed_at TEXT,
  valid_until TEXT,                   -- inherited from Square's expiration (we set 7d on import)
  created_at TEXT DEFAULT (datetime('now')),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_pool_campaign_status ON discount_code_pool (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_pool_code ON discount_code_pool (code);
CREATE INDEX IF NOT EXISTS idx_pool_customer ON discount_code_pool (assigned_to_customer_id) WHERE assigned_to_customer_id IS NOT NULL;
