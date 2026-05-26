// workers/http-utils.js
// Shared HTTP utilities — retry wrapper for external APIs that rate-limit.
//
// Tier 4d motivation: Anthropic/QBO/Square/Twilio all return 429 under load.
// Previously, a single 429 on e.g. generateWeeklyInsight would bubble up as a
// 500 from the caller endpoint. This helper retries on known-transient codes
// with exponential backoff + Retry-After awareness, so a brief rate limit
// becomes a 2-second delay instead of a user-visible failure.
//
// Usage:
//   import { fetchWithBackoff } from './http-utils.js';
//   const r = await fetchWithBackoff('https://api.anthropic.com/...', {
//     method: 'POST', headers, body: JSON.stringify(payload),
//   }, { retries: 3, baseDelayMs: 1000, caller: 'generateWeeklyInsight' });

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;  // 1s, then 2s, then 4s
const DEFAULT_TIMEOUT_MS = 30000;    // 30s per attempt

export async function fetchWithBackoff(url, init = {}, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const caller = opts.caller || 'unknown';

  let lastErr = null;
  let lastStatus = null;
  let lastText = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Per-attempt timeout so a hung API doesn't eat the whole Worker CPU budget.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) return response;
      lastStatus = response.status;
      if (!RETRYABLE_STATUS.has(response.status)) {
        // Non-retryable error — return the response so caller can inspect it.
        return response;
      }
      // Retryable — capture body snippet for logging then compute wait.
      try { lastText = (await response.clone().text()).slice(0, 200); } catch {}
      if (attempt === retries) {
        console.error(`[fetchWithBackoff] ${caller} exhausted retries on ${response.status}: ${lastText}`);
        return response;
      }
      // Respect Retry-After when present (in seconds).
      const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : baseDelay * Math.pow(2, attempt);
      console.warn(`[fetchWithBackoff] ${caller} got ${response.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
      if (attempt === retries) throw err;
      const wait = baseDelay * Math.pow(2, attempt);
      console.warn(`[fetchWithBackoff] ${caller} network error: ${err.message}, retrying in ${wait}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
    }
  }
  // Unreachable — either returned or threw above.
  throw lastErr || new Error(`fetchWithBackoff exhausted: ${lastStatus} ${lastText}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
