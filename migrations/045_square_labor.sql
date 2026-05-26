-- migrations/045_square_labor.sql
-- Square Labor / Shifts — used for payroll % trend + labor cost forecasting.

CREATE TABLE IF NOT EXISTS square_team_members (
  id              TEXT PRIMARY KEY,
  square_member_id TEXT UNIQUE,
  name            TEXT,
  email           TEXT,
  status          TEXT,                       -- 'ACTIVE' | 'INACTIVE'
  hourly_wage     REAL,
  is_owner        INTEGER DEFAULT 0,
  last_synced_at  TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_team_members_status ON square_team_members(status);

CREATE TABLE IF NOT EXISTS square_shifts (
  id              TEXT PRIMARY KEY,
  square_shift_id TEXT UNIQUE,
  team_member_id  TEXT REFERENCES square_team_members(id),
  team_member_name TEXT,                       -- denormalized
  shift_date      TEXT,
  start_at        TEXT,
  end_at          TEXT,
  hours           REAL,
  hourly_wage     REAL,
  cost            REAL,                        -- hours × wage
  status          TEXT,                        -- 'CLOSED' | 'OPEN' | 'DRAFT'
  is_forecast     INTEGER DEFAULT 0,           -- 1 = scheduled (not yet worked)
  raw_payload     TEXT,
  last_synced_at  TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON square_shifts(shift_date DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_forecast ON square_shifts(is_forecast, shift_date);
