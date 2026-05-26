-- migrations/054_monthly_revenue_canonical.sql
-- RTR-7 (Session 14, May 13 2026): canonical monthly revenue table.
--
-- One row per (period, version). Computed from orders (sale-event timing,
-- post-RTR-2). Holds the AUTHORITATIVE revenue number for each month so
-- display + reports + analysis don't have to recompute from scratch.
--
-- The cfo_briefs monthly_close snapshot still exists for the full P&L
-- (with COGS + expense + BS + CF). THIS table is just revenue, computed
-- from orders only, refreshable per period without unlocking the close.

CREATE TABLE IF NOT EXISTS monthly_revenue_canonical (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL UNIQUE,            -- 'YYYY-MM'
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Orders-based (canonical)
  revenue_orders REAL NOT NULL,
  retail REAL DEFAULT 0,
  wholesale REAL DEFAULT 0,
  catering REAL DEFAULT 0,
  marketplace REAL DEFAULT 0,

  -- GL cross-check (for transparency, NOT for display)
  revenue_gl REAL,
  gl_orders_drift REAL,
  gl_orders_drift_pct REAL,

  -- Metadata
  orders_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'getOrdersRevenueForPeriod',
  is_closed INTEGER DEFAULT 0,            -- 1 if the period has a locked monthly close
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_mrc_period ON monthly_revenue_canonical (period DESC);
