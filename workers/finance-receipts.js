// workers/finance-receipts.js
// Receipt processing — Drew snaps a photo, agent extracts + matches + categorizes.
//
// Flow:
//   1. POST /finance/receipts/process with {image_base64, mime_type}
//   2. Haiku vision extracts vendor + date + amount + items
//   3. Searches mercury_transactions + chase_cc_transactions for matches
//      (amount within $0.50 + date within 5 days + vendor fuzzy)
//   4. Looks up suggested categorization via vendor KB + cfo_facts
//   5. Returns + saves to receipts table as 'pending'
//   6. Drew approves → updates matched txn's proposed_account_id + posts
//
// Endpoints:
//   POST /finance/receipts/process  -d {image_base64, mime_type, note}
//   GET  /finance/receipts/pending
//   POST /finance/receipts/:id/approve
//   POST /finance/receipts/:id/reject

import { callAI } from './ai-budget.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Extract receipt data via Haiku vision ─────────────────────────────────
async function extractReceiptData(env, imageBase64, mimeType) {
  const result = await callAI(env, {
    use_case: 'receipt_extraction',
    model: 'haiku',                  // vision-capable, cheap
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 },
        },
        {
          type: 'text',
          text: `Extract the structured data from this receipt. Return STRICT JSON (no markdown):

{
  "vendor": "<merchant name>",
  "date": "<YYYY-MM-DD>",
  "total_amount": <dollars as number, no $ sign>,
  "items": [{"description": "<item name>", "qty": <number>, "price": <dollars>}],
  "payment_method": "<card/cash/etc or null>",
  "confidence": <0.0-1.0 how confident in the extraction>
}

If you cannot determine a field, use null. Don't make things up.`,
        },
      ],
    }],
    caller: 'finance-receipts.js:extractReceiptData',
    allow_haiku_downgrade: false,    // already haiku
  });

  if (!result.ok) return { error: result.error || result.blocked_reason || 'AI extraction failed' };

  const text = result.content || '';
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return { ...parsed, cost_usd: result.cost_usd, raw: text };
  } catch (err) {
    return { error: 'failed to parse extraction', raw: text };
  }
}

// ── Find matching Mercury / Chase txn ─────────────────────────────────────
async function findMatchingTxn(env, extracted) {
  if (!extracted.total_amount || !extracted.date) return null;

  const amount = Math.abs(extracted.total_amount);
  const targetDate = extracted.date;
  const tolerance = 0.50;

  // Search Mercury first (most outflows go through Mercury)
  const { results: mercMatches } = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name, description, is_reconciled, user_overridden,
      ABS(ABS(amount) - ?) as amount_diff,
      ABS(julianday(txn_date) - julianday(?)) as days_diff
    FROM mercury_transactions
    WHERE amount < 0
      AND ABS(ABS(amount) - ?) <= ?
      AND ABS(julianday(txn_date) - julianday(?)) <= 7
      AND is_reconciled = 0
    ORDER BY amount_diff, days_diff LIMIT 5
  `).bind(amount, targetDate, amount, tolerance, targetDate).all();

  // Search Chase CC
  const { results: chaseMatches } = await env.DB.prepare(`
    SELECT id, txn_date, amount, merchant, description, is_reconciled, pending,
      ABS(ABS(amount) - ?) as amount_diff,
      ABS(julianday(txn_date) - julianday(?)) as days_diff
    FROM chase_cc_transactions
    WHERE amount > 0
      AND ABS(ABS(amount) - ?) <= ?
      AND ABS(julianday(txn_date) - julianday(?)) <= 7
      AND is_reconciled = 0
    ORDER BY amount_diff, days_diff LIMIT 5
  `).bind(amount, targetDate, amount, tolerance, targetDate).all();

  // Score candidates: exact amount + vendor match > exact amount + close date > approximate
  const allCandidates = [
    ...(mercMatches || []).map(m => ({
      type: 'mercury',
      id: m.id,
      date: m.txn_date.slice(0, 10),
      amount: m.amount,
      vendor: m.counterparty_name,
      description: m.description,
      amount_diff: m.amount_diff,
      days_diff: m.days_diff,
    })),
    ...(chaseMatches || []).map(c => ({
      type: 'chase_cc',
      id: c.id,
      date: c.txn_date.slice(0, 10),
      amount: c.amount,
      vendor: c.merchant,
      description: c.description,
      amount_diff: c.amount_diff,
      days_diff: c.days_diff,
    })),
  ];

  if (!allCandidates.length) return { matches: [], best: null };

  // Score: 100 - 50*amount_diff - 5*days_diff - vendor_match_bonus
  const extractedVendorNorm = (extracted.vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const c of allCandidates) {
    const candVendorNorm = (c.vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const vendorMatch = extractedVendorNorm && candVendorNorm &&
      (extractedVendorNorm.includes(candVendorNorm) || candVendorNorm.includes(extractedVendorNorm));
    c.score = r2(100 - 50 * c.amount_diff - 5 * c.days_diff + (vendorMatch ? 20 : 0));
    c.vendor_match = vendorMatch;
  }
  allCandidates.sort((a, b) => b.score - a.score);
  const best = allCandidates[0];

  let method = 'amount_date';
  if (best.vendor_match) method = 'amount_date_vendor';
  if (best.amount_diff > 0.01) method = 'amount_approximate_date';

  const confidence = best.amount_diff < 0.01 && best.vendor_match ? 0.98
                   : best.amount_diff < 0.01 ? 0.85
                   : best.amount_diff < 0.10 ? 0.70
                   : 0.50;

  return {
    matches: allCandidates.slice(0, 3),
    best: { ...best, match_method: method, confidence },
  };
}

// ── Suggest categorization for the matched txn ────────────────────────────
async function suggestCategorization(env, extracted, matchedVendor) {
  const vendor = extracted.vendor || matchedVendor;
  if (!vendor) return null;
  try {
    const { lookupVendor } = await import('./finance-vendor-kb.js');
    const kb = await lookupVendor(env, vendor);
    if (kb.found) {
      return {
        account_id: kb.account_id,
        account_name: kb.account_name,
        confidence: kb.confidence,
        via: kb.source,
        reasoning: kb.reasoning,
      };
    }
  } catch {}
  return null;
}

// ── Public: process a receipt ─────────────────────────────────────────────
export async function processReceipt(env, { image_base64, mime_type, note }) {
  if (!image_base64) return { error: 'image_base64 required' };

  const id = crypto.randomUUID();
  const imageSize = Math.floor(image_base64.length * 0.75);  // base64 → bytes approx

  // 1. Extract via vision
  const extracted = await extractReceiptData(env, image_base64, mime_type);
  if (extracted.error) {
    // Save the failed attempt for audit
    await env.DB.prepare(`
      INSERT INTO receipts (id, image_size_bytes, mime_type, status, drew_note)
      VALUES (?, ?, ?, 'extraction_failed', ?)
    `).bind(id, imageSize, mime_type || 'image/jpeg', extracted.error.slice(0, 500)).run().catch(() => {});
    return { ok: false, error: extracted.error, receipt_id: id };
  }

  // 2. Find matching txn
  const matchResult = await findMatchingTxn(env, extracted);
  const best = matchResult?.best;

  // 3. Suggest categorization
  const suggestion = await suggestCategorization(env, extracted, best?.vendor);

  // 4. Save the receipt
  await env.DB.prepare(`
    INSERT INTO receipts (id, image_size_bytes, mime_type, vendor_extracted, date_extracted,
      amount_extracted, items_extracted, raw_extraction, extraction_confidence, extraction_cost_usd,
      matched_txn_type, matched_txn_id, match_confidence, match_method,
      suggested_account_id, suggested_account_name, suggested_via,
      status, drew_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, imageSize, mime_type || 'image/jpeg',
    extracted.vendor || null,
    extracted.date || null,
    extracted.total_amount || null,
    JSON.stringify(extracted.items || []),
    extracted.raw || '',
    extracted.confidence || null,
    extracted.cost_usd || 0,
    best?.type || null,
    best?.id || null,
    best?.confidence || null,
    best?.match_method || (best ? 'unknown' : 'no_match'),
    suggestion?.account_id || null,
    suggestion?.account_name || null,
    suggestion?.via || null,
    best ? 'pending' : 'no_match',
    note || null,
  ).run().catch(() => {});

  return {
    ok: true,
    receipt_id: id,
    extracted: {
      vendor: extracted.vendor,
      date: extracted.date,
      amount: extracted.total_amount,
      items: extracted.items,
      confidence: extracted.confidence,
      cost_usd: extracted.cost_usd,
    },
    match: best ? {
      type: best.type,
      txn_id: best.id,
      txn_date: best.date,
      txn_amount: best.amount,
      txn_vendor: best.vendor,
      vendor_match: best.vendor_match,
      confidence: best.confidence,
      method: best.match_method,
    } : null,
    suggested_categorization: suggestion,
    other_candidates: matchResult?.matches?.slice(1, 3) || [],
    status: best ? 'pending' : 'no_match',
    next_step: best
      ? `POST /finance/receipts/${id}/approve to apply the matched txn + categorization, or /reject to cancel`
      : 'No matching transaction found yet — the txn may post later. Receipt saved for reprocessing.',
  };
}

// ── List pending receipts for inbox ───────────────────────────────────────
export async function listPendingReceipts(env, opts = {}) {
  const { results } = await env.DB.prepare(`
    SELECT id, uploaded_at, vendor_extracted, date_extracted, amount_extracted,
           matched_txn_type, matched_txn_id, match_confidence, match_method,
           suggested_account_name, suggested_via, status
    FROM receipts WHERE status IN ('pending','no_match')
    ORDER BY uploaded_at DESC LIMIT ?
  `).bind(opts.limit || 50).all();
  return { count: (results || []).length, receipts: results || [] };
}

// ── Approve: update the matched txn ───────────────────────────────────────
export async function approveReceipt(env, receiptId) {
  const r = await env.DB.prepare(`SELECT * FROM receipts WHERE id = ?`).bind(receiptId).first();
  if (!r) return { error: 'receipt not found' };
  if (r.status !== 'pending') return { error: `cannot approve status=${r.status}` };
  if (!r.matched_txn_id) return { error: 'no matched txn to apply to' };

  // Apply suggested categorization to the matched txn
  if (r.suggested_account_id && r.matched_txn_type === 'mercury') {
    await env.DB.prepare(`
      UPDATE mercury_transactions
      SET proposed_account_id = ?, proposed_confidence = 0.99,
          proposed_reasoning = ?, user_overridden = 1
      WHERE id = ?
    `).bind(
      r.suggested_account_id,
      `Receipt match: ${r.vendor_extracted || ''} $${r.amount_extracted} on ${r.date_extracted}. Categorized via ${r.suggested_via || 'manual'}.`,
      r.matched_txn_id,
    ).run();
  } else if (r.suggested_account_id && r.matched_txn_type === 'chase_cc') {
    await env.DB.prepare(`
      UPDATE chase_cc_transactions
      SET proposed_account_id = ?, proposed_confidence = 0.99,
          proposed_reasoning = ?, user_overridden = 1
      WHERE id = ?
    `).bind(
      r.suggested_account_id,
      `Receipt match: ${r.vendor_extracted || ''} $${r.amount_extracted} on ${r.date_extracted}.`,
      r.matched_txn_id,
    ).run();
  }

  await env.DB.prepare(`
    UPDATE receipts SET status = 'approved', drew_action_at = datetime('now') WHERE id = ?
  `).bind(receiptId).run();

  return { ok: true, receipt_id: receiptId, applied_to: { txn_type: r.matched_txn_type, txn_id: r.matched_txn_id } };
}

export async function rejectReceipt(env, receiptId, note) {
  await env.DB.prepare(`
    UPDATE receipts SET status = 'rejected', drew_action_at = datetime('now'), drew_note = ?
    WHERE id = ?
  `).bind((note || '').slice(0, 500), receiptId).run();
  return { ok: true, receipt_id: receiptId };
}
