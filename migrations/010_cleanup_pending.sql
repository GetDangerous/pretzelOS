-- Migration 010: Clean up duplicate pending emails + fix Snowbird notes
-- Run: npx wrangler d1 execute pretzel-os --remote --file=migrations/010_cleanup_pending.sql

-- Fix Snowbird notes — remove Oktoberfest reference (fall event, not summer)
UPDATE venues
SET notes = 'Alyssa Schoenfeld is the F&B Manager at Snowbird. Verified email: aschoenfeld@snowbird.com. Snowbird runs summer outdoor concerts May-September with large crowds. Free summer concerts series every Friday night. Perfect warmer program fit — outdoor guests, alcohol sales, long lines. | Alta ski connection (Goldminer''s Daughter) could warm-intro. Use summer concert angle only — Oktoberfest is a fall event and out of scope for this campaign.',
    updated_at = datetime('now')
WHERE id = '450d4464828fef5937a99be8deb39a22';

-- Auto-reject duplicate pending emails — keep highest self_score per venue
-- For venues with multiple pending emails, reject all but the best one
UPDATE outreach_logs
SET approval_status = 'rejected', notes = COALESCE(notes || ' | ', '') || 'Auto-rejected: duplicate draft (lower score than kept version)'
WHERE direction = 'out'
  AND approval_status = 'pending'
  AND id NOT IN (
    -- Keep the best-scored pending email per venue
    SELECT id FROM outreach_logs o1
    WHERE direction = 'out'
      AND approval_status = 'pending'
      AND self_score = (
        SELECT MAX(o2.self_score)
        FROM outreach_logs o2
        WHERE o2.venue_id = o1.venue_id
          AND o2.approval_status = 'pending'
          AND o2.direction = 'out'
      )
      AND created_at = (
        -- If tied score, keep most recent
        SELECT MAX(o3.created_at)
        FROM outreach_logs o3
        WHERE o3.venue_id = o1.venue_id
          AND o3.approval_status = 'pending'
          AND o3.direction = 'out'
          AND o3.self_score = o1.self_score
      )
  );
