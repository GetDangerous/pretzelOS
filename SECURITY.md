# Dangerous Pretzel Company LLC — Information Security Policy

**Effective date**: May 13, 2026
**Owner**: Drew Falkman, Owner/CEO (drew@dangerouspretzel.com)
**Review cadence**: Annually + on material system changes
**Last reviewed**: May 13, 2026

This document is the master Information Security Policy ("ISP") for Pretzel OS,
the internal financial operations platform of Dangerous Pretzel Company LLC.
It is referenced by third-party data providers (Plaid, etc.) during their
underwriting and serves as the operating runbook for the system's security
posture.

---

## 1. Purpose & Scope

This policy describes the information security controls Dangerous Pretzel
Company LLC ("the Company") operates to protect customer financial data,
business records, and integrations with third-party financial services
(Mercury, Plaid, QuickBooks Online, Square, Toast Payroll, Anthropic, Gmail).

**Scope**: all data processed by the Company's internal financial operations
platform ("Pretzel OS"), hosted on Cloudflare's infrastructure.

## 2. Data Classification

- **Restricted**: third-party API access tokens (Plaid, Mercury, Square, QBO,
  Anthropic, Gmail OAuth refresh tokens), customer payment data
- **Confidential**: financial transaction records, vendor lists, internal
  ledger, employee payroll
- **Internal**: business reports, dashboards
- **Public**: marketing site content (dangerouspretzel.com)

## 3. Storage & Encryption

- All persistent data is stored in Cloudflare D1 (SQLite at edge) and
  Cloudflare KV. Both are encrypted at rest using AES-256 with
  Cloudflare-managed keys.
- All API traffic is transported over TLS 1.2+ (Cloudflare default; HTTP
  is redirected).
- Third-party API access tokens are stored as Cloudflare Workers secrets,
  encrypted at rest, accessible only by the deployed Workers runtime.
- Plaid `access_token` values specifically are stored encrypted in D1
  using a dedicated encryption key (`PLAID_ENCRYPTION_KEY`) rotated annually.
- The KV store contains short-lived OAuth refresh tokens and operational
  flags only; no PII or financial data is cached there.

## 4. Access Controls

- The Pretzel OS platform is a single-operator system; only the Owner
  (Drew Falkman) has administrative access.
- The internal financial dashboard is gated by **Cloudflare Access** with
  Google SSO authentication (Google Workspace with MFA enforced at the
  identity provider).
- API endpoints additionally require bearer-token authentication
  (`X-Pretzel-Auth` header against `DASHBOARD_AUTH_TOKEN` secret) for all
  non-webhook paths.
- Webhook endpoints (Square, QBO, Plaid) verify provider HMAC signatures
  before processing payloads.
- Multi-factor authentication is enforced on all third-party SaaS providers
  the Company uses (Cloudflare, Anthropic, Mercury, Square, QBO, Gmail/
  Google Workspace, Plaid Dashboard).
- Production secrets are managed via `wrangler secret put` (Cloudflare's
  managed secret store) and never committed to source control or shared
  in plaintext.
- Principle of least privilege is observed: every API token is scoped to
  the minimum permissions required.

## 5. Logging & Monitoring

- Every financial-state-changing operation writes to the `finance_audit_log`
  table with actor, action type, entity, and before/after JSON payload.
- Every Anthropic API call is logged to the `ai_calls` table with token
  usage and cost; total monthly spend is capped at $50 with automatic
  feature degradation at soft caps.
- Every cron job records start, completion, and error state to the
  `cron_runs` table with status and duration.
- A daily reconciliation job verifies internal ledger balances against live
  Mercury account balances; variance exceeding $50 for 2 consecutive days
  automatically places the system in read-only mode.
- A continuously-computed "Trust Score" surfaces system health across six
  dimensions: data freshness, ledger integrity, categorization accuracy,
  sync health, AI cost vs budget, and autonomous decision quality.
- Every autonomous agent decision is logged to `agent_decisions` with
  reasoning, source (rule / knowledge base / human-clarified fact / AI
  fallback), and confidence score.

## 6. Vulnerability & Patch Management

- The platform runs on Cloudflare Workers (serverless), patched
  continuously by Cloudflare.
- Application dependencies are reviewed before integration; the platform
  uses minimal third-party JS libraries (`@anthropic-ai/sdk` only).
- Database schema changes are version-controlled and applied via reviewed
  migrations (50+ migrations to date, append-only).
- All deploys pass an acceptance test suite (`tests/acceptance.test.sh`)
  exercising every critical API endpoint before being released to
  production.

## 7. Incident Response

In the event of a suspected data incident:

1. The Owner immediately rotates affected credentials (Cloudflare secrets,
   OAuth tokens via `wrangler secret put`).
2. Forensic data is preserved from `finance_audit_log`, `ai_calls`,
   `cron_runs`, and `agent_decisions` for 90 days.
3. Affected third-party providers are notified per their incident-reporting
   requirements (Plaid: within 24 hours per Plaid Developer Policy).
4. Customers whose data was affected are notified per applicable Utah and
   federal law.

## 8. Risk Assessment

The Owner conducts an annual review of:

- Active third-party integrations and their access scopes
- Stored credentials and rotation status
- Logged anomalies (financial flags, audit log warnings)
- Trust score components and remediation of any sustained-low signals
- Plaid Item connection status (re-auth flow exercised quarterly)

## 9. Employee Access

The Company has no employees with platform access at this time. Should
that change, role-based access will be implemented before granting access,
with the principle of least privilege. All employee access will require
MFA enforced at the identity provider.

## 10. Vendor Management

Critical service providers have been evaluated for their own security
posture:

- **Cloudflare** (hosting, D1, KV, secrets) — SOC 2 Type II, ISO 27001
- **Anthropic** (AI processing) — SOC 2 Type II
- **Mercury Bank** (banking) — FDIC member, SOC 2 Type II equivalent
- **Plaid** (banking aggregation) — SOC 2 Type II
- **Intuit / QuickBooks Online** (accounting historical) — SOC 2 Type II
- **Square / Block** (POS + payroll) — PCI DSS Level 1, SOC 2 Type II
- **Google Workspace** (email, identity) — SOC 2 Type II, ISO 27001

## 11. Customer Data Handling

Pretzel OS is an internal operations platform; the only end-user data
ingested is:

- Customer names, emails, and phone numbers from Square POS transactions
  (used for AR aging, follow-up reminders)
- Customer-provided email addresses from catering inquiry forms
  (used for invoice + reminder communication)
- Aggregated transaction data from Mercury Bank API and Chase Business
  Credit Card via Plaid (used for financial reporting)

The Company does not sell, share, or otherwise disclose customer data
to third parties beyond the SOC 2-audited service providers listed in
Section 10 required to deliver the service.

## 12. Disposal

When data is no longer needed, it is purged from D1 tables via
documented migrations or scheduled retention policies. Account tokens
of disconnected services are deleted within 30 days of disconnection.

---

## Appendix A — Plaid-specific commitments

Per Plaid's Developer Policy, the Company specifically commits to:

- Never storing the user's bank credentials (username/password)
- Never displaying or transmitting `access_token` values in URLs
- Encrypting `access_token` storage with a dedicated key
- Disconnecting any Plaid Item upon user request within 30 days
- Notifying Plaid of any security incident within 24 hours
- Annual review of Plaid integration scope and access patterns

---

**Signed**: Drew Falkman, Owner — May 13, 2026

*This document is version-controlled at `SECURITY.md` in the Pretzel OS repository.*
