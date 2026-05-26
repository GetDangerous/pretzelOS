// workers/finance-ar-aging.js
// AR Aging Report — current / 1-30 / 31-60 / 61-90 / 90+ buckets per customer,
// plus a "send Gmail reminder" hook that drafts (doesn't send) a polite
// follow-up email tailored to each invoice's overdue bucket.
//
// Endpoints:
//   GET  /finance/ar-aging                          — full aging report
//   GET  /finance/ar-aging/customer/:name           — single customer detail
//   POST /finance/ar-aging/draft-reminder?id=...    — draft Gmail reminder
//
// Data source: `orders` table for source IN ('qbo_wholesale','qbo_invoice')
// with balance > 0. Each row's raw_payload has due_date + balance + customer.

function r2(n) { return Math.round((n || 0) * 100) / 100; }

function ageBucket(daysOverdue) {
  if (daysOverdue < 0) return 'current';
  if (daysOverdue <= 30) return 'days_1_30';
  if (daysOverdue <= 60) return 'days_31_60';
  if (daysOverdue <= 90) return 'days_61_90';
  return 'days_90_plus';
}

// ── Get full aging report ─────────────────────────────────────────────────
export async function getArAging(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, customer_name, gross_revenue, order_date,
           json_extract(raw_payload, '$.invoice_id') as invoice_id,
           json_extract(raw_payload, '$.doc_number') as doc_number,
           json_extract(raw_payload, '$.due_date') as due_date,
           json_extract(raw_payload, '$.balance') as balance,
           json_extract(raw_payload, '$.txn_date') as txn_date
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice')
      AND status NOT IN ('voided','paid','estimate')
      AND CAST(json_extract(raw_payload, '$.balance') AS REAL) > 0
    ORDER BY json_extract(raw_payload, '$.due_date')
  `).all();

  const today = new Date();
  const buckets = {
    current: { invoices: 0, total: 0, oldest_days: 0 },
    days_1_30: { invoices: 0, total: 0, oldest_days: 0 },
    days_31_60: { invoices: 0, total: 0, oldest_days: 0 },
    days_61_90: { invoices: 0, total: 0, oldest_days: 0 },
    days_90_plus: { invoices: 0, total: 0, oldest_days: 0 },
  };

  const byCustomer = new Map();
  const invoices = [];

  for (const inv of (results || [])) {
    const balance = parseFloat(inv.balance) || 0;
    if (balance <= 0) continue;
    const due = inv.due_date ? new Date(inv.due_date) : null;
    if (!due) continue;
    const daysOverdue = Math.floor((today - due) / 86400000);
    const bucket = ageBucket(daysOverdue);

    buckets[bucket].invoices += 1;
    buckets[bucket].total = r2(buckets[bucket].total + balance);
    if (daysOverdue > buckets[bucket].oldest_days) buckets[bucket].oldest_days = daysOverdue;

    const customer = inv.customer_name || '(no name)';
    if (!byCustomer.has(customer)) {
      byCustomer.set(customer, { customer, total: 0, invoices: 0, oldest_days: -Infinity, invoice_list: [] });
    }
    const c = byCustomer.get(customer);
    c.total = r2(c.total + balance);
    c.invoices += 1;
    if (daysOverdue > c.oldest_days) c.oldest_days = daysOverdue;
    c.invoice_list.push({
      id: inv.id,
      doc_number: inv.doc_number,
      txn_date: inv.txn_date,
      due_date: inv.due_date,
      balance: r2(balance),
      days_overdue: daysOverdue,
      bucket,
    });
    invoices.push({
      id: inv.id,
      customer,
      doc_number: inv.doc_number,
      txn_date: inv.txn_date,
      due_date: inv.due_date,
      balance: r2(balance),
      days_overdue: daysOverdue,
      bucket,
    });
  }

  const customers = Array.from(byCustomer.values())
    .map(c => ({ ...c, oldest_days: c.oldest_days === -Infinity ? 0 : c.oldest_days }))
    .sort((a, b) => b.total - a.total);

  const grandTotal = r2(Object.values(buckets).reduce((s, b) => s + b.total, 0));
  const overdueTotal = r2(grandTotal - buckets.current.total);

  return {
    generated_at: new Date().toISOString(),
    grand_total: grandTotal,
    current_total: buckets.current.total,
    overdue_total: overdueTotal,
    buckets,
    customers,
    invoices: invoices.sort((a, b) => b.days_overdue - a.days_overdue),
  };
}

// ── Single customer detail ────────────────────────────────────────────────
export async function getArCustomer(env, customerName) {
  const aging = await getArAging(env);
  return aging.customers.find(c =>
    c.customer.toLowerCase() === (customerName || '').toLowerCase()
  ) || { error: 'customer not found', customer: customerName };
}

// ── Draft a Gmail reminder for a specific invoice ─────────────────────────
// Returns the draft message ID + email content for Drew to review.
// Tone scales with overdue severity: gentle at <30d, firmer at 31-60d, etc.
export async function buildReminderDraft(env, invoiceId) {
  const inv = await env.DB.prepare(`
    SELECT customer_name, gross_revenue,
           json_extract(raw_payload, '$.doc_number') as doc_number,
           json_extract(raw_payload, '$.due_date') as due_date,
           json_extract(raw_payload, '$.balance') as balance,
           json_extract(raw_payload, '$.txn_date') as txn_date,
           json_extract(raw_payload, '$.email') as customer_email
    FROM orders WHERE id = ?
  `).bind(invoiceId).first();

  if (!inv) return { error: 'invoice not found' };
  if (!inv.customer_email) return { error: 'no customer email on file', invoice: inv };

  const balance = parseFloat(inv.balance) || 0;
  const today = new Date();
  const due = new Date(inv.due_date);
  const daysOverdue = Math.floor((today - due) / 86400000);

  let tone;
  if (daysOverdue < 0) tone = 'soft_upcoming';
  else if (daysOverdue <= 7) tone = 'gentle_recent';
  else if (daysOverdue <= 30) tone = 'polite_followup';
  else if (daysOverdue <= 60) tone = 'firm_followup';
  else tone = 'escalation';

  const docRef = inv.doc_number ? `Invoice #${inv.doc_number}` : 'your invoice';
  const amount = `$${balance.toFixed(2)}`;

  const drafts = {
    soft_upcoming: {
      subject: `Heads up: ${docRef} ${amount} due ${inv.due_date}`,
      body: `Hi,\n\nJust a friendly heads-up — ${docRef} for ${amount} is coming due ${inv.due_date}. Let me know if you have any questions or if there's anything I can help with.\n\nThanks!\nDrew\nDangerous Pretzel Co.`,
    },
    gentle_recent: {
      subject: `Quick check on ${docRef} (${amount})`,
      body: `Hi,\n\nHope you're well. Just checking in on ${docRef} for ${amount} (due ${inv.due_date}). Wanted to make sure it didn't get caught in a spam filter or lost in the shuffle.\n\nIf payment is on the way, no need to respond. If anything looks off or you need the invoice resent, just let me know.\n\nThanks!\nDrew`,
    },
    polite_followup: {
      subject: `Following up: ${docRef} (${amount}, ${daysOverdue} days past due)`,
      body: `Hi,\n\nFollowing up on ${docRef} for ${amount}, which was due ${inv.due_date}. It's now about ${daysOverdue} days past due.\n\nCould you let me know the status? Happy to resend the invoice or walk through any questions. If there's an issue on our end with the bill, I want to make it right.\n\nThanks!\nDrew`,
    },
    firm_followup: {
      subject: `${docRef} now ${daysOverdue} days past due — ${amount}`,
      body: `Hi,\n\nWanted to follow up again on ${docRef} for ${amount}, which is now ${daysOverdue} days past due (originally due ${inv.due_date}). I haven't heard back on my prior note, so I want to make sure we're on the same page.\n\nCan you let me know when we should expect payment? If there's a concern with the invoice or a process issue on your end, I'd appreciate the chance to address it directly.\n\nThanks,\nDrew\nDangerous Pretzel Co.`,
    },
    escalation: {
      subject: `${docRef}: ${amount} now ${daysOverdue} days past due`,
      body: `Hi,\n\n${docRef} for ${amount} (originally due ${inv.due_date}) is now ${daysOverdue} days past due, and I haven't been able to get a response.\n\nCan we get on a quick call this week to walk through what's needed to get this resolved? I want to make sure we're not missing something. My direct line is (801) [phone] — or just reply here with a time that works.\n\nThanks,\nDrew\nDangerous Pretzel Co.`,
    },
  };

  const draft = drafts[tone];
  return {
    ok: true,
    invoice_id: invoiceId,
    customer: inv.customer_name,
    customer_email: inv.customer_email,
    balance: r2(balance),
    days_overdue: daysOverdue,
    tone,
    draft,
    note: 'This is the email body Drew should review. To create as Gmail draft, call create_draft tool with these fields.',
  };
}
