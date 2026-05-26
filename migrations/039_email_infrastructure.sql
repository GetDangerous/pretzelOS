-- 039_email_infrastructure.sql
-- Email reach expansion via Resend. Three audiences: Toast-imported reactivation (A),
-- Square first-time win-back (B), real-time welcome trigger on first Square order (C).
--
-- See plan: /Users/drew/.claude/plans/iterative-frolicking-hollerith.md

-- ── Square customer mirror ─────────────────────────────────────────────
-- Distinct from retail_customers (which is the SMS-deliverable phone profile).
-- This table is the email-segmentation source of truth, populated from Square's
-- public Customers API. ~7,708 rows expected on initial backfill.
CREATE TABLE IF NOT EXISTS square_customers (
  square_customer_id    TEXT PRIMARY KEY,            -- Square's customer ID (gv2:... or legacy)
  email                 TEXT,                        -- email_address from Square
  phone                 TEXT,                        -- phone_number from Square
  given_name            TEXT,
  family_name           TEXT,
  creation_source       TEXT,                        -- IMPORT (Toast), POS, INSTANT_PROFILE, etc.
  email_unsubscribed    INTEGER DEFAULT 0,           -- 1 = customer clicked our unsubscribe link OR Square reports unsubscribed
  email_bounced         INTEGER DEFAULT 0,           -- 1 = hard bounce in Resend, never retry
  square_order_count    INTEGER DEFAULT 0,           -- denormalized count of orders.customer_id matches; refreshed on sync
  last_square_order_date TEXT,                       -- denormalized
  created_at            TEXT,                        -- as reported by Square
  updated_at            TEXT,                        -- as reported by Square
  synced_at             TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sqcust_email          ON square_customers (email)             WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sqcust_creation_src   ON square_customers (creation_source);
CREATE INDEX IF NOT EXISTS idx_sqcust_last_order     ON square_customers (last_square_order_date);
CREATE INDEX IF NOT EXISTS idx_sqcust_unsub          ON square_customers (email_unsubscribed, email_bounced);

-- ── Email sends ledger ─────────────────────────────────────────────────
-- One row per Resend send attempt. Resend webhooks update the timestamp columns
-- so we can compute open/click/bounce/unsub rates per campaign. idempotency_key
-- is unique to prevent accidental duplicate sends from retried code paths.
CREATE TABLE IF NOT EXISTS email_sends (
  id                    TEXT PRIMARY KEY,
  to_email              TEXT NOT NULL,
  subject               TEXT,
  campaign_id           TEXT,                        -- FK retail_campaigns.id (loose)
  cohort                TEXT,                        -- 'A' / 'B' / 'C'
  customer_id           TEXT,                        -- square_customer_id when known
  resend_id             TEXT,                        -- Resend's email id (for webhook matching)
  idempotency_key       TEXT UNIQUE,                 -- prevents duplicate sends
  sent_at               TEXT DEFAULT (datetime('now')),
  status                TEXT DEFAULT 'queued',       -- queued | sent | bounced | unsubscribed | error
  status_detail         TEXT,                        -- error message or bounce reason
  bounced_at            TEXT,
  opened_at             TEXT,
  clicked_at            TEXT,
  unsubscribed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_sends_resend_id    ON email_sends (resend_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign     ON email_sends (campaign_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_email_sends_customer     ON email_sends (customer_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_cohort       ON email_sends (cohort, sent_at);

-- ── Loyalty accounts mirror ────────────────────────────────────────────
-- Used for Cohort C exclusion (don't send the welcome email to anyone who
-- already joined Loyalty — they get loyalty rewards instead). Synced from
-- /v2/loyalty/accounts/search alongside customer sync.
CREATE TABLE IF NOT EXISTS loyalty_accounts (
  loyalty_account_id    TEXT PRIMARY KEY,
  square_customer_id    TEXT,
  program_id            TEXT,
  balance               INTEGER DEFAULT 0,           -- points
  enrolled_at           TEXT,
  synced_at             TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_accounts (square_customer_id);

-- ── retail_campaigns extension ─────────────────────────────────────────
-- lifetime_emailed counts Resend sends; complements existing lifetime_sent
-- which counts SMS sends. Together with lifetime_returned this gives a
-- channel-aware rate signal in the dashboard scoreboard.
ALTER TABLE retail_campaigns ADD COLUMN lifetime_emailed INTEGER DEFAULT 0;
