-- migrations/055_heartbeat_orphans.sql
-- Session 15a (May 14, 2026): delete un-prefixed orphan heartbeat rows.
--
-- Migration 050 seeded BOTH naming conventions (cfo_* prefixed AND un-prefixed)
-- as a "transitional shim." But every actual cron writes the cfo_* version
-- (verified via grep in workers/router.js trackedRun calls). The un-prefixed
-- versions are pure orphans — seeded but never updated, permanently "unknown."
--
-- Trust score's data_freshness component reads the un-prefixed names; after
-- this migration + the finance-health.js reader update (15a), data_freshness
-- reads the cfo_* names which actually get written.
--
-- IMPORTANT: This deletes ONLY 5 rows. The first audit pass (Session 18)
-- incorrectly listed 11 candidates — 6 of those (cfo_daily_pulse,
-- cfo_daily_recon, cfo_issue_surfacer, cfo_monthly_close, cfo_weekly_directive,
-- square_sync) are ACTIVELY written by crons but show NEVER because those
-- crons fail or haven't run recently. KEEP those rows; they'll go green when
-- their underlying crons start succeeding.

DELETE FROM system_heartbeats WHERE component IN (
  'daily_close',
  'mercury_sync',
  'tier1_audit',
  'tier2_audit',
  'tier5_acceptance'
);
