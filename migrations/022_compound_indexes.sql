-- Compound indexes for hot queries identified by tech audit.
-- /queue/today runs 4 scans of catering_leads by status + updated_at.
-- Weekly digest joins outreach_logs on (venue_id, direction, sequence_step) + filters replied_at/sent_at.
-- As outreach_logs grows past 10K rows and catering_leads past a few hundred, these
-- start to matter.

-- Covers: /queue/today flagged/no_contact/stuck scans + catering Kanban feed ordering
CREATE INDEX IF NOT EXISTS idx_catering_leads_status_updated
  ON catering_leads(status, updated_at DESC);

-- Covers: follow-up candidate query (direction='out' + sequence_step + replied_at IS NULL ordering)
CREATE INDEX IF NOT EXISTS idx_outreach_followup
  ON outreach_logs(venue_id, direction, sequence_step, replied_at);

-- Covers: approval queue query (approval_status='pending' ordered by created_at)
CREATE INDEX IF NOT EXISTS idx_outreach_pending
  ON outreach_logs(approval_status, direction, created_at);

-- Covers: venues /queue/today stuck scan (status + updated_at)
CREATE INDEX IF NOT EXISTS idx_venues_status_updated
  ON venues(status, updated_at DESC);
