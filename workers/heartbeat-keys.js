// workers/heartbeat-keys.js
// Session 15b (May 14, 2026): single source of truth for heartbeat cadence.
//
// Every cron that writes a heartbeat via trackedRun() has its expected cadence
// declared here. This drives:
//   1. expected_max_lag_minutes in the system_heartbeats row (writer sets it).
//   2. The status computation in finance-health.js (lag > 2× cadence = red).
//   3. The critical/secondary trust panel split.
//
// Why this exists: before today, heartbeat() inserted with hardcoded
// `expected_max_lag_minutes = 60`. Any cron that runs less frequently than
// hourly (every-6h, daily, weekly) would appear permanently red within its
// normal cadence window. Real bug, hit `cfo_pipeline_stalled_check` (6h cron)
// and `square_customer_sync` (6h cron) — both were showing red despite being
// healthy.

// ── Heartbeat registry ────────────────────────────────────────────────────
// Maps each agent name to its expected cadence in minutes.
// CRITICAL is just a flag for the trust panel display split.
export const HEARTBEATS = {
  // ── Critical: failure means books can't be trusted (data_freshness) ──
  cfo_daily_close:       { cadence_min: 1440, critical: true },   // daily 7am MT
  cfo_audit_tier1:       { cadence_min: 60,   critical: true },   // hourly
  chase_sync_plaid:      { cadence_min: 240,  critical: true },   // every 4h (Plaid sync)

  // ── Secondary: informational; failure surfaces in sync_health ──
  // Finance crons
  cfo_pulse:                  { cadence_min: 60 },                 // hourly
  cfo_daily_pulse:            { cadence_min: 1440 },               // daily
  cfo_daily_recon:            { cadence_min: 1440 },               // daily
  cfo_monthly_close:          { cadence_min: 43200 },              // monthly (~30d)
  cfo_weekly_directive:       { cadence_min: 10080 },              // weekly
  cfo_pipeline_stalled_check: { cadence_min: 360 },                // every 6h
  cfo_issue_surfacer:         { cadence_min: 1440 },               // daily
  cfo_audit_tier2:            { cadence_min: 1440 },               // daily
  page_narrative_refresh:     { cadence_min: 1440 },               // daily, alongside daily close

  // Sync crons
  qbo_sync:                { cadence_min: 60 },                    // hourly
  square_sync:             { cadence_min: 1440 },                  // daily 0 10 * * *
  square_customer_sync:    { cadence_min: 360 },                   // every 6h
  square_labor_sync:       { cadence_min: 1440 },                  // daily

  // Engagement crons
  reply_scanner:           { cadence_min: 60 },                    // hourly
  retail_suggestions:      { cadence_min: 60 },                    // hourly
  retail_verdict:          { cadence_min: 1440 },                  // daily
  email_cohort_b:          { cadence_min: 1440 },                  // daily
  weekly_digest:           { cadence_min: 10080 },                 // weekly
  code_expiration_cleaner: { cadence_min: 1440 },                  // daily

  // Lead-gen agents (rarely critical to ops)
  cfo:               { cadence_min: 1440 },
  optimizer:         { cadence_min: 1440 },
  scout:             { cadence_min: 1440 },
  qualifier:         { cadence_min: 1440 },
  outreach:          { cadence_min: 1440 },
  catering:          { cadence_min: 1440 },
  catering_crossover:{ cadence_min: 1440 },
  catering_scout:    { cadence_min: 1440 },
  account:           { cadence_min: 1440 },
  account_sync:      { cadence_min: 1440 },
  pilot:             { cadence_min: 1440 },
  reviews:           { cadence_min: 1440 },
  retail:            { cadence_min: 1440 },
  signal_scanner:    { cadence_min: 1440 },  // daily 30 12 * * *

  // Forward automation (Session 24 May 16 — Drew "no manual reruns" directive)
  monthly_depreciation:  { cadence_min: 43200 },  // monthly 1st of month
  tier5_monthly:         { cadence_min: 43200 },  // monthly 1st of month
  mercury_io_reminder:   { cadence_min: 43200 },  // monthly 28th
};

// Returns the cadence_min for a given agent, defaulting to 60 if unregistered.
// Unregistered names are intentionally hostile-defaulted so new crons announce
// themselves loudly (they'll appear red until added to HEARTBEATS).
export function cadenceForAgent(name) {
  return HEARTBEATS[name]?.cadence_min || 60;
}

export function isCritical(name) {
  return !!HEARTBEATS[name]?.critical;
}

// Subsets for the trust panel header rendering
export const CRITICAL_HEARTBEAT_NAMES = Object.keys(HEARTBEATS).filter(n => HEARTBEATS[n].critical);
export const ALL_HEARTBEAT_NAMES = Object.keys(HEARTBEATS);
