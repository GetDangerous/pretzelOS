// workers/finance-canonical-truth.js
// DIF-2 — Canonical-truth registry.
//
// Purpose: a single, documented map from "metric" → "the ONE function that
// computes it." Every consumer of cash/revenue/runway/burn MUST import these
// helpers via this registry — not directly off finance-shared.
//
// Why a registry, not just re-exports:
//   1. Discoverability — one place new contributors look to learn what's
//      canonical vs ad-hoc.
//   2. Cross-consumer Tier 1 check (below) iterates the registry, so adding
//      a new metric automatically extends the consistency invariant.
//   3. DIF-4 (deprecation test) greps for "non-registry SUM" patterns; the
//      registry membership IS the allow-list.
//
// To add a new canonical metric:
//   1. Implement the helper in finance-shared.js (or a domain-specific file)
//   2. Add an entry to CANONICAL below with: id, label, helper fn, expected
//      output shape, value selector (how to pull the comparable scalar)
//   3. Add a consumer to CROSS_CONSUMER_PROBES so the Tier 1 check verifies
//      a second computation path agrees within tolerance
//   4. Add an acceptance test for the new endpoint
//
// Tier 1 invariant: `cash_consumers_agree` + `revenue_consumers_agree_30d`
// fail if two registered consumers disagree by > tolerance. ANY fail trips
// FINANCE_READ_ONLY because the system is displaying inconsistent numbers.

import {
  getCanonicalCashOnHand,
  getCanonicalRunway,
  getCanonicalWeeklyBurn,
  getCanonicalWeeklyRevenue,
} from './finance-shared.js';
import { getScorecard } from './finance-scorecard.js';
import { getArAging } from './finance-ar-aging.js';

// ── Registry of canonical metrics ────────────────────────────────────────
// Every dollar value displayed anywhere on the dashboard or in an email
// MUST be sourced from one of these helpers. Direct SUM(...) against
// mercury_transactions or journal_entry_lines for these metrics is a
// deprecation violation that will fail DIF-4 grep enforcement.
export const CANONICAL = {
  cash: {
    id: 'cash',
    label: 'Cash on hand',
    helper: getCanonicalCashOnHand,
    selector: (v) => v?.total,
    units: 'usd',
    notes: 'Sum of mercury_accounts.current_balance for is_active=1 rows. 5-min TTL with inline refresh.',
  },
  weekly_burn: {
    id: 'weekly_burn',
    label: 'Weekly burn',
    helper: getCanonicalWeeklyBurn,
    selector: (v) => v?.weekly_burn,
    units: 'usd_per_week',
    notes: 'Max of GL burn 30d and Mercury outflows × 0.7, ÷ 4.3.',
  },
  runway: {
    id: 'runway',
    label: 'Runway',
    helper: getCanonicalRunway,
    selector: (v) => v?.weeks,
    units: 'weeks',
    notes: 'cash / weekly_burn. Display string handles infinity/critical/etc.',
  },
  weekly_revenue: {
    id: 'weekly_revenue',
    label: 'Weekly revenue (last 7d)',
    helper: (env) => getCanonicalWeeklyRevenue(env, 7),
    selector: (v) => v?.total,
    units: 'usd_per_week',
    notes: 'Sum of paid orders.gross_revenue across retail + wholesale + catering channels.',
  },
  monthly_revenue: {
    id: 'monthly_revenue',
    label: 'Monthly revenue (last 30d)',
    helper: (env) => getCanonicalWeeklyRevenue(env, 30),
    selector: (v) => v?.total,
    units: 'usd_per_month',
    notes: 'Sum of paid orders.gross_revenue across retail + wholesale + catering, 30d window.',
  },
};

// ── Cross-consumer probes ─────────────────────────────────────────────────
// For each canonical metric, list ≥1 additional computation path that should
// agree with the helper. The Tier 1 check below compares the canonical value
// to each probe and fails if any disagree by more than `tolerance`.
//
// Tolerance rules:
//   - cash: must agree to the penny ($0.01) — same DB column, no rounding diff
//   - burn: 1% — both are rolling 30d but small lag is OK
//   - runway: 1 week — derived from cash + burn
//   - revenue: 1% — orders + paid-state filter must agree across paths
const CROSS_CONSUMER_PROBES = {
  cash: [
    {
      id: 'scorecard_cash',
      label: 'getScorecard().cash.current.total',
      probe: async (env) => {
        const sc = await getScorecard(env);
        return sc?.cash?.current?.total ?? sc?.cash?.total ?? null;
      },
      tolerance: 0.01,
      tolerance_kind: 'absolute',
    },
  ],
  weekly_burn: [
    {
      id: 'scorecard_burn',
      label: 'getScorecard().cash.runway.weekly_burn',
      probe: async (env) => {
        const sc = await getScorecard(env);
        return sc?.cash?.runway?.weekly_burn ?? null;
      },
      tolerance: 0.01,
      tolerance_kind: 'relative',
    },
  ],
  monthly_revenue: [
    // Smoke test only — 4× weekly is a coarse multiplier (weeks have heavy
    // week-to-week noise: catering payouts cluster, marketplace bills lag).
    // We catch gross drift (e.g., revenue suddenly 10×, or zero) not
    // precision drift. The Tier 1 check is also a WARN not FAIL for revenue
    // so a precision-only disagreement won't trip read-only.
    {
      id: 'sum_4x_weekly',
      label: '4× getCanonicalWeeklyRevenue(7d) ≈ getCanonicalWeeklyRevenue(30d)',
      probe: async (env) => {
        const wk = await getCanonicalWeeklyRevenue(env, 7);
        // 30d / 7 = 4.286. Multiplier is rough; tolerance is wide.
        return (wk?.total || 0) * 30 / 7;
      },
      tolerance: 0.60,           // 60% — smoke test only, not precision
      tolerance_kind: 'relative',
    },
  ],
  // DIF-6 (May 13 2026 Session 11): additional cross-consumer probes
  runway: [
    {
      id: 'scorecard_runway_weeks',
      label: 'getScorecard().cash.runway.weeks',
      probe: async (env) => {
        const sc = await getScorecard(env);
        return sc?.cash?.runway?.weeks ?? null;
      },
      tolerance: 0.5,            // half a week of slack
      tolerance_kind: 'absolute',
    },
  ],
};

// AR overdue cross-consumer check (probes only — no canonical helper because
// AR aging IS the canonical source. We verify that scorecard's overdue total
// agrees with the AR aging endpoint's overdue total.)
async function checkArOverdueAgreement(env) {
  try {
    const [scorecard, aging] = await Promise.all([
      getScorecard(env),
      getArAging(env),
    ]);
    const scOverdue = scorecard?.ar_30d?.buckets?.overdue?.total ?? null;
    const buckets = aging?.buckets || {};
    const arOverdue = Math.round(
      ((buckets.days_1_30?.total || 0)
        + (buckets.days_31_60?.total || 0)
        + (buckets.days_61_90?.total || 0)
        + (buckets.days_91_plus?.total || 0)) * 100
    ) / 100;
    if (scOverdue == null) return { ok: true, skipped: true, note: 'scorecard ar_30d.buckets.overdue not present' };
    const diff = Math.abs(scOverdue - arOverdue);
    const denom = Math.max(Math.abs(scOverdue), Math.abs(arOverdue), 1);
    const relPct = Math.round((diff / denom) * 10000) / 100;
    return {
      ok: diff < 50 || relPct < 5,    // either $50 absolute or 5% relative tolerance
      scorecard_overdue: scOverdue,
      ar_aging_overdue: arOverdue,
      diff,
      rel_diff_pct: relPct,
    };
  } catch (e) {
    return { ok: false, error: e.message?.slice(0, 200) };
  }
}
export { checkArOverdueAgreement };

// ── Helper for Tier 1 check ──────────────────────────────────────────────
// Returns an array of {metric, canonical_value, probe_id, probe_value,
// diff, within_tolerance}. Tier 1 wraps this with the runCheck adapter.
export async function checkCrossConsumerAgreement(env) {
  const results = [];
  for (const metric of Object.values(CANONICAL)) {
    const probes = CROSS_CONSUMER_PROBES[metric.id];
    if (!probes || probes.length === 0) continue;

    let canonicalValue;
    try {
      const helperOut = await metric.helper(env);
      canonicalValue = metric.selector(helperOut);
    } catch (err) {
      results.push({
        metric: metric.id,
        canonical_value: null,
        probe_id: 'self',
        probe_value: null,
        diff: null,
        within_tolerance: false,
        error: `helper threw: ${err.message?.slice(0, 100)}`,
      });
      continue;
    }

    for (const probe of probes) {
      let probeValue = null;
      let error = null;
      try {
        probeValue = await probe.probe(env);
      } catch (err) {
        error = `probe threw: ${err.message?.slice(0, 100)}`;
      }

      if (canonicalValue == null || probeValue == null) {
        results.push({
          metric: metric.id,
          canonical_value: canonicalValue,
          probe_id: probe.id,
          probe_value: probeValue,
          diff: null,
          within_tolerance: false,
          error: error || 'null value',
        });
        continue;
      }

      const diff = Math.abs(canonicalValue - probeValue);
      const denom = Math.max(Math.abs(canonicalValue), Math.abs(probeValue), 1);
      const relDiff = diff / denom;
      const within = probe.tolerance_kind === 'absolute'
        ? diff <= probe.tolerance
        : relDiff <= probe.tolerance;

      results.push({
        metric: metric.id,
        canonical_value: Math.round(canonicalValue * 100) / 100,
        probe_id: probe.id,
        probe_label: probe.label,
        probe_value: Math.round(probeValue * 100) / 100,
        diff: Math.round(diff * 100) / 100,
        rel_diff_pct: Math.round(relDiff * 10000) / 100,
        tolerance: probe.tolerance,
        tolerance_kind: probe.tolerance_kind,
        within_tolerance: within,
      });
    }
  }
  return results;
}

// ── Public summary endpoint helper ──
// Returns the full canonical truth state — what's registered, what consumers
// agree, and what's drifting. Used by /finance/canonical-truth.
export async function getCanonicalTruthState(env) {
  const metrics = {};
  for (const m of Object.values(CANONICAL)) {
    try {
      const value = await m.helper(env);
      metrics[m.id] = {
        label: m.label,
        units: m.units,
        notes: m.notes,
        value: m.selector(value),
        full: value,
      };
    } catch (err) {
      metrics[m.id] = {
        label: m.label,
        units: m.units,
        notes: m.notes,
        error: err.message?.slice(0, 200),
      };
    }
  }
  const consistency = await checkCrossConsumerAgreement(env);
  const disagreements = consistency.filter(r => !r.within_tolerance);

  return {
    metrics,
    cross_consumer_check: {
      total_probes: consistency.length,
      passing: consistency.length - disagreements.length,
      failing: disagreements.length,
      details: consistency,
    },
    disagreements,
    as_of: new Date().toISOString(),
  };
}
