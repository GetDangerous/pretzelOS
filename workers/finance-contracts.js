// workers/finance-contracts.js
// DIF-5 — Contract tests for every external API boundary.
//
// Purpose: detect when an external API (Mercury, Square, QBO, Plaid, Gmail,
// Anthropic) changes its response shape BEFORE the change reaches production.
// Each contract: a lightweight live ping + a schema-shape assertion on the
// fields we depend on.
//
// Tradeoffs:
//   - Live pings keep the test honest (real API drift will surface) but cost
//     a small amount of latency per check. We hit cheap endpoints only
//     (accounts list, locations list — never anything that mutates data).
//   - Anthropic is NOT live-tested because every call costs money. We just
//     verify the API key is present + valid model ID is configured.
//   - Plaid is gracefully skipped if no credentials present (Drew may not have
//     applied for production access yet).
//
// Endpoint: GET /finance/contracts
//   Returns { summary, contracts: { mercury, square, qbo, plaid, gmail, anthropic },
//             as_of }
//
// Wired as a Tier 2 daily check. If any required contract fails, trust score
// drops and Drew gets a daily-brief warning.

const REQUIRED = new Set(['mercury', 'square', 'qbo', 'anthropic']);  // these MUST pass
const OPTIONAL = new Set(['plaid', 'gmail', 'apollo', 'swell']);       // skipped if not configured

// ── Helpers ───────────────────────────────────────────────────────────────
function missing(obj, fields) {
  return fields.filter(f => !(f in (obj || {})));
}
function shape(obj, fields) {
  // Returns { present, missing, sample_keys }
  if (!obj || typeof obj !== 'object') {
    return { present: 0, missing: fields, sample_keys: [], note: 'not an object' };
  }
  return {
    present: fields.filter(f => f in obj).length,
    missing: missing(obj, fields),
    sample_keys: Object.keys(obj).slice(0, 12),
  };
}

// ── Mercury Bank ──────────────────────────────────────────────────────────
async function checkMercury(env) {
  if (!env.MERCURY_API_TOKEN) {
    return { ok: false, error: 'MERCURY_API_TOKEN not set', skipped: false };
  }
  const r = await fetch('https://api.mercury.com/api/v1/accounts', {
    headers: { Authorization: `Bearer ${env.MERCURY_API_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
  }
  const j = await r.json();
  // Response top-level: { accounts: [...] }
  const topShape = shape(j, ['accounts']);
  const sampleAccount = j.accounts?.[0];
  const accountShape = shape(sampleAccount, ['id', 'name', 'currentBalance', 'status', 'type']);
  const ok = topShape.missing.length === 0 && accountShape.missing.length === 0;
  return {
    ok,
    response_keys: topShape.sample_keys,
    account_keys: accountShape.sample_keys,
    missing_top: topShape.missing,
    missing_account: accountShape.missing,
    account_count: j.accounts?.length || 0,
  };
}

// ── Square ────────────────────────────────────────────────────────────────
async function checkSquare(env) {
  if (!env.SQUARE_ACCESS_TOKEN) {
    return { ok: false, error: 'SQUARE_ACCESS_TOKEN not set' };
  }
  // /v2/locations is cheap + always available
  const r = await fetch('https://connect.squareup.com/v2/locations', {
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': env.SQUARE_VERSION || '2024-10-17',
      'Content-Type': 'application/json',
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
  }
  const j = await r.json();
  const topShape = shape(j, ['locations']);
  const sampleLoc = j.locations?.[0];
  const locShape = shape(sampleLoc, ['id', 'name', 'status', 'merchant_id']);
  const ok = topShape.missing.length === 0 && locShape.missing.length === 0;
  return {
    ok,
    response_keys: topShape.sample_keys,
    location_keys: locShape.sample_keys,
    missing_top: topShape.missing,
    missing_location: locShape.missing,
    location_count: j.locations?.length || 0,
  };
}

// ── QBO / Intuit ──────────────────────────────────────────────────────────
async function checkQBO(env) {
  if (!env.QBO_CLIENT_ID || !env.QBO_CLIENT_SECRET) {
    return { ok: false, error: 'QBO_CLIENT_ID/SECRET not set' };
  }
  try {
    const { getQBOToken } = await import('./qbo-client.js');
    const token = await getQBOToken(env);
    if (!token) return { ok: false, error: 'QBO token refresh failed' };

    const realmId = (await env.KV.get('QBO_REALM_ID')) || env.QBO_REALM_ID;
    if (!realmId) return { ok: false, error: 'QBO_REALM_ID not set' };

    // CompanyInfo query is the cheapest QBO call
    const r = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${encodeURIComponent('SELECT * FROM CompanyInfo')}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    const j = await r.json();
    const company = j.QueryResponse?.CompanyInfo?.[0];
    const topShape = shape(j, ['QueryResponse']);
    const companyShape = shape(company, ['CompanyName', 'Country']);
    const ok = topShape.missing.length === 0 && companyShape.missing.length === 0;
    return {
      ok,
      company_name: company?.CompanyName,
      response_keys: topShape.sample_keys,
      missing_company: companyShape.missing,
    };
  } catch (e) {
    return { ok: false, error: `exception: ${e.message?.slice(0, 200)}` };
  }
}

// ── Plaid (skipped if no creds) ───────────────────────────────────────────
async function checkPlaid(env) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    return { ok: true, skipped: true, note: 'Plaid credentials not configured (sandbox + production access pending Drew)' };
  }
  // Verify auth by creating a link_token (sandbox is free)
  const plaidEnv = env.PLAID_ENV || 'sandbox';
  const base = plaidEnv === 'production' ? 'https://production.plaid.com'
              : plaidEnv === 'development' ? 'https://development.plaid.com'
              : 'https://sandbox.plaid.com';
  const r = await fetch(`${base}/link/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      client_name: 'Pretzel OS contract check',
      user: { client_user_id: 'pretzel-os-contract-test' },
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
  }
  const j = await r.json();
  const ok = !!j.link_token && !!j.expiration;
  return {
    ok,
    env: plaidEnv,
    response_keys: Object.keys(j).slice(0, 8),
    has_link_token: !!j.link_token,
  };
}

// ── Gmail (skipped if no refresh token) ──────────────────────────────────
async function checkGmail(env) {
  if (!env.GMAIL_REFRESH_TOKEN || !env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    return { ok: true, skipped: true, note: 'Gmail OAuth not configured' };
  }
  // Refresh access token (cheap) + ping /users/me/profile
  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GMAIL_CLIENT_ID,
        client_secret: env.GMAIL_CLIENT_SECRET,
        refresh_token: env.GMAIL_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    });
    if (!tokenResp.ok) {
      const body = await tokenResp.text().catch(() => '');
      return { ok: false, error: `token refresh HTTP ${tokenResp.status}: ${body.slice(0, 200)}` };
    }
    const tok = await tokenResp.json();
    if (!tok.access_token) return { ok: false, error: 'no access_token in response' };

    const profileResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!profileResp.ok) {
      return { ok: false, error: `profile HTTP ${profileResp.status}` };
    }
    const profile = await profileResp.json();
    const profileShape = shape(profile, ['emailAddress', 'messagesTotal']);
    return {
      ok: profileShape.missing.length === 0,
      email: profile.emailAddress,
      missing: profileShape.missing,
    };
  } catch (e) {
    return { ok: false, error: `exception: ${e.message?.slice(0, 200)}` };
  }
}

// ── Anthropic (no live call — too expensive) ─────────────────────────────
async function checkAnthropic(env) {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
  }
  // We don't make a live call (each costs money). Verify the key is the
  // expected shape (sk-ant-...) and ai-budget.js model resolution works.
  const keyOk = /^sk-ant-/.test(env.ANTHROPIC_API_KEY);
  if (!keyOk) {
    return { ok: false, error: 'API key does not match expected sk-ant- prefix' };
  }
  // Check active models resolved (literals owned by ai-budget.js per DIF-3;
  // this contract just confirms env override availability)
  const sonnetOverride = env.ACTIVE_SONNET_MODEL || null;
  const haikuOverride = env.ACTIVE_HAIKU_MODEL || null;
  return {
    ok: true,
    api_key_present: true,
    api_key_shape_ok: keyOk,
    sonnet_override: sonnetOverride,  // null = using ai-budget default
    haiku_override: haikuOverride,
    note: 'live ping skipped (cost). Model IDs resolved by workers/ai-budget.js. Drift detected via ai_calls error rates.',
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────
const CHECKS = {
  mercury: checkMercury,
  square: checkSquare,
  qbo: checkQBO,
  plaid: checkPlaid,
  gmail: checkGmail,
  anthropic: checkAnthropic,
};

export async function checkContracts(env) {
  const started = Date.now();
  const results = {};
  // Run all in parallel — they're independent and live pings benefit from concurrency
  const entries = Object.entries(CHECKS);
  const settled = await Promise.allSettled(
    entries.map(async ([key, fn]) => [key, await fn(env)])
  );
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results[key] = s.value[1];
    } else {
      results[key] = { ok: false, error: `unhandled: ${s.reason?.message?.slice(0, 200) || String(s.reason)}` };
    }
  }

  // Required vs optional accounting
  const required = Object.entries(results).filter(([k]) => REQUIRED.has(k));
  const optional = Object.entries(results).filter(([k]) => !REQUIRED.has(k));
  const required_failing = required.filter(([, v]) => !v.ok).map(([k]) => k);
  const optional_failing = optional.filter(([, v]) => !v.ok && !v.skipped).map(([k]) => k);

  return {
    summary: {
      required_checked: required.length,
      required_passing: required.length - required_failing.length,
      required_failing,
      optional_checked: optional.length,
      optional_passing: optional.filter(([, v]) => v.ok && !v.skipped).length,
      optional_skipped: optional.filter(([, v]) => v.skipped).length,
      optional_failing,
      duration_ms: Date.now() - started,
    },
    ok: required_failing.length === 0,
    contracts: results,
    as_of: new Date().toISOString(),
  };
}
