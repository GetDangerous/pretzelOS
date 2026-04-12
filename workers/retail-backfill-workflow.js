/**
 * Dangerous Pretzel Co — Retail Backfill Workflow
 * Cloudflare Workflow (durable, long-running, auto-retry)
 *
 * Reads 18 months of historical Toast POS data from R2,
 * builds customer profiles in D1, rolls up menu analytics,
 * merges guestbook records, and runs initial churn scoring.
 *
 * Triggered via POST /retail/backfill/start
 * Progress visible via GET /retail/backfill/status/:id
 *
 * R2 bucket structure (uploaded from github.com/dangpretz/pos-data):
 *   incoming/toast-orders/orders-YYYY-MM.json  (18 files)
 *   customers.csv                               (1,036 records)
 *   normalized/menu/items.json                  (314 items)
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';

// ── PHONE NORMALIZATION ─────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // Strip leading 1 for US numbers
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null; // Invalid
}

function hashPhone(normalizedPhone) {
  return `rc_${normalizedPhone}`;
}

// ── DELIVERY RELAY BLOCKLIST ────────────────────────────────────
const DELIVERY_RELAY_PHONES = new Set([
  '8552228111',   // DoorDash relay
  '2678912738',   // Uber Eats relay
  '8332753287',   // Uber Eats relay
  '8775851085',   // Grubhub relay
]);
function isDeliveryRelay(phone) {
  return phone && DELIVERY_RELAY_PHONES.has(phone);
}

// ── PARSE TOAST MONEY STRING ────────────────────────────────────
function parseMoney(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[$,]/g, '')) || 0;
}

// ── EXTRACT CUSTOMER NAME FROM TAB ──────────────────────────────
function extractNameFromTab(tabName) {
  if (!tabName) return null;
  // tabName format: "3/1/26, 7:06 PM\n        Server\n                Server\n                                                CustomerName"
  const parts = tabName.split(/\n/).map(s => s.trim()).filter(Boolean);
  // Last non-empty part is often the customer name
  const last = parts[parts.length - 1];
  // Skip if it's a server name pattern or date
  if (!last || last.includes('Server') || last.includes('Kiosk') || /^\d/.test(last)) return null;
  // Skip DoorDash/UberEats order IDs
  if (last.startsWith('DD ') || last.startsWith('UE ') || last.startsWith('GH ')) {
    // Extract name after order ID: "DD ba229fe8 Eliza W"
    const match = last.match(/^(?:DD|UE|GH)\s+\S+\s+(.+)/);
    return match ? match[1].trim() : null;
  }
  return last;
}

// ── MAP TOAST ITEM NAMES TO SKU CODES ───────────────────────────
const ITEM_TO_SKU = {
  'spicy bee': 'SPICY-BEE',
  'spicy': 'SPICY-BEE',
  'bbk': 'BBK',
  'brush before kissing': 'BBK',
  'bbk - brush before kissing': 'BBK',
  'saint': 'SAINT',
  'salty': 'SALTY',
  'for the kids': 'KIDS',
  'kids': 'KIDS',
  'salty bombs': 'BOMBS',
  'bombs': 'BOMBS',
  'pretzel bombs': 'BOMBS',
};

function mapItemToSku(itemName) {
  if (!itemName) return null;
  const lower = itemName.toLowerCase().trim();
  // Direct match
  if (ITEM_TO_SKU[lower]) return ITEM_TO_SKU[lower];
  // Partial match
  for (const [key, sku] of Object.entries(ITEM_TO_SKU)) {
    if (lower.includes(key)) return sku;
  }
  return null; // Modifier, sauce, merch, etc.
}

// ── PARSE TOAST DATE STRING ─────────────────────────────────────
function parseToastDate(dateStr) {
  if (!dateStr) return null;
  // Format: "3/1/26, 7:06 PM" → ISO
  try {
    const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2}),?\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    let [, month, day, year, hour, min, ampm] = match;
    year = parseInt(year) + 2000;
    hour = parseInt(hour);
    if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return new Date(year, parseInt(month) - 1, parseInt(day), hour, parseInt(min)).toISOString();
  } catch {
    return null;
  }
}

// ── GET WEEK START (Monday) ─────────────────────────────────────
function getWeekStart(isoDate) {
  const d = new Date(isoDate);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setUTCDate(diff);
  return monday.toISOString().split('T')[0];
}

// ── GET QUARTER ─────────────────────────────────────────────────
function getQuarter(isoDate) {
  const month = new Date(isoDate).getUTCMonth();
  return `Q${Math.floor(month / 3) + 1}`;
}

// ── WORKFLOW ─────────────────────────────────────────────────────
export class RetailBackfillWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const db = this.env.DB;

    // ── Step 1: List all order files in R2 ───────────────────
    const fileKeys = await step.do('list-r2-files', async () => {
      const list = await this.env.POS_DATA_BUCKET.list({ prefix: 'incoming/toast-orders/' });
      return list.objects.map(o => o.key).sort();
    });

    console.log(`[Backfill] Found ${fileKeys.length} order files`);

    // ── Step 2: Process each month file ──────────────────────
    // Accumulate per-customer stats across all files
    const allCustomers = {}; // normalized_phone → profile
    const allOrders = [];    // for menu analytics
    let totalOrders = 0;

    for (const key of fileKeys) {
      const result = await step.do(`process-${key}`, async () => {
        const obj = await this.env.POS_DATA_BUCKET.get(key);
        if (!obj) return { processed: 0, customers: {}, orders: [] };

        const rawOrders = await obj.json();
        const customers = {};
        const orders = [];
        let processed = 0;

        for (const order of rawOrders) {
          for (const check of (order.checks || [])) {
            if (check.status === 'Voided') continue;

            const phone = normalizePhone(check.phone);
            const name = extractNameFromTab(check.tabName);
            const orderDate = parseToastDate(check.timeOpened);
            const total = parseMoney(check.total);
            const items = (check.items || []).filter(i => !i.voided);

            // Build SKU breakdown
            const skuBreakdown = {};
            let itemCount = 0;
            for (const item of items) {
              const sku = mapItemToSku(item.name);
              if (sku) {
                skuBreakdown[sku] = (skuBreakdown[sku] || 0) + (item.qty || 1);
                itemCount += (item.qty || 1);
              }
            }

            // Track order for menu analytics
            if (orderDate) {
              orders.push({
                date: orderDate,
                total,
                items: skuBreakdown,
                itemCount,
                phone,
                dayOfWeek: new Date(orderDate).getUTCDay(),
                hour: new Date(orderDate).getUTCHours(),
              });
            }

            // Skip delivery relay phones (DoorDash, UberEats, Grubhub)
            if (isDeliveryRelay(phone)) { processed++; continue; }

            // Skip catering-scale orders from retail profiles (>$500 or >30 items)
            if (total >= 500 || itemCount >= 30) { processed++; continue; }

            // Build/update customer profile (keyed by phone or name hash)
            const customerKey = phone || (name ? `name_${name.toLowerCase().replace(/\s+/g, '_')}` : null);
            if (!customerKey) { processed++; continue; }

            if (!customers[customerKey]) {
              customers[customerKey] = {
                phone,
                name,
                visitCount: 0,
                totalSpend: 0,
                orders: [],
                skuCounts: {},
                dayOfWeekCounts: {},
                quarterCounts: {},
                hourCounts: {},
                firstVisit: orderDate,
                lastVisit: orderDate,
              };
            }

            const c = customers[customerKey];
            c.visitCount++;
            c.totalSpend += total;
            if (orderDate) {
              if (!c.firstVisit || orderDate < c.firstVisit) c.firstVisit = orderDate;
              if (!c.lastVisit || orderDate > c.lastVisit) c.lastVisit = orderDate;
              c.dayOfWeekCounts[new Date(orderDate).getUTCDay()] = (c.dayOfWeekCounts[new Date(orderDate).getUTCDay()] || 0) + 1;
              c.quarterCounts[getQuarter(orderDate)] = (c.quarterCounts[getQuarter(orderDate)] || 0) + 1;
              c.hourCounts[new Date(orderDate).getUTCHours()] = (c.hourCounts[new Date(orderDate).getUTCHours()] || 0) + 1;
            }
            for (const [sku, qty] of Object.entries(skuBreakdown)) {
              c.skuCounts[sku] = (c.skuCounts[sku] || 0) + qty;
            }
            c.orders.push({ date: orderDate, total, skus: skuBreakdown, itemCount });
            if (!c.name && name) c.name = name;
            processed++;
          }
        }

        return { processed, customers, orders };
      });

      // Merge into global accumulators
      totalOrders += result.processed;
      for (const [key, profile] of Object.entries(result.customers)) {
        if (!allCustomers[key]) {
          allCustomers[key] = profile;
        } else {
          const existing = allCustomers[key];
          existing.visitCount += profile.visitCount;
          existing.totalSpend += profile.totalSpend;
          if (profile.firstVisit && (!existing.firstVisit || profile.firstVisit < existing.firstVisit)) {
            existing.firstVisit = profile.firstVisit;
          }
          if (profile.lastVisit && (!existing.lastVisit || profile.lastVisit > existing.lastVisit)) {
            existing.lastVisit = profile.lastVisit;
          }
          for (const [sku, qty] of Object.entries(profile.skuCounts)) {
            existing.skuCounts[sku] = (existing.skuCounts[sku] || 0) + qty;
          }
          for (const [dow, count] of Object.entries(profile.dayOfWeekCounts)) {
            existing.dayOfWeekCounts[dow] = (existing.dayOfWeekCounts[dow] || 0) + count;
          }
          for (const [q, count] of Object.entries(profile.quarterCounts)) {
            existing.quarterCounts[q] = (existing.quarterCounts[q] || 0) + count;
          }
          for (const [h, count] of Object.entries(profile.hourCounts)) {
            existing.hourCounts[h] = (existing.hourCounts[h] || 0) + count;
          }
          existing.orders.push(...profile.orders);
          if (!existing.name && profile.name) existing.name = profile.name;
          if (!existing.phone && profile.phone) existing.phone = profile.phone;
        }
      }
      allOrders.push(...result.orders);
    }

    console.log(`[Backfill] Processed ${totalOrders} orders, ${Object.keys(allCustomers).length} unique customers`);

    // ── Step 3: Merge customers.csv (phone enrichment) ───────
    await step.do('merge-customers-csv', async () => {
      const csvObj = await this.env.POS_DATA_BUCKET.get('customers.csv');
      if (!csvObj) { console.log('[Backfill] No customers.csv found'); return; }

      const text = await csvObj.text();
      const lines = text.split('\n').slice(1); // skip header
      let merged = 0;

      for (const line of lines) {
        const [name, phoneRaw] = line.split(',').map(s => s?.trim());
        if (!name || !phoneRaw) continue;
        const phone = normalizePhone(phoneRaw);
        if (!phone) continue;

        const key = phone;
        if (allCustomers[key]) {
          // Enrich existing — prefer CSV name if we only have a partial name
          if (!allCustomers[key].name || allCustomers[key].name.length < name.length) {
            allCustomers[key].name = name;
          }
          merged++;
        }
        // Also check name-keyed entries and merge by phone
        const nameKey = `name_${name.toLowerCase().replace(/\s+/g, '_')}`;
        if (allCustomers[nameKey] && !allCustomers[nameKey].phone) {
          allCustomers[nameKey].phone = phone;
          // Move to phone-keyed entry
          if (!allCustomers[key]) {
            allCustomers[key] = allCustomers[nameKey];
            delete allCustomers[nameKey];
          } else {
            // Merge into phone-keyed
            allCustomers[key].visitCount += allCustomers[nameKey].visitCount;
            allCustomers[key].totalSpend += allCustomers[nameKey].totalSpend;
            allCustomers[key].orders.push(...allCustomers[nameKey].orders);
            delete allCustomers[nameKey];
          }
          merged++;
        }
      }

      console.log(`[Backfill] Merged ${merged} customers from CSV`);
    });

    // ── Step 4: Write customer profiles to D1 ────────────────
    await step.do('write-customer-profiles', async () => {
      const entries = Object.entries(allCustomers);
      let written = 0;

      for (let i = 0; i < entries.length; i += 100) {
        const batch = entries.slice(i, i + 100);
        const stmts = [];

        for (const [key, profile] of batch) {
          const phone = profile.phone;
          const normalizedPhone = phone || null;
          const customerId = phone ? hashPhone(phone) : `rc_name_${key.replace(/^name_/, '')}`;

          // Calculate derived fields
          const avgOrderValue = profile.visitCount > 0 ? profile.totalSpend / profile.visitCount : 0;
          const favoriteSku = Object.entries(profile.skuCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
          const skuDiversity = Object.keys(profile.skuCounts).length;

          // Order frequency (avg days between visits)
          const sortedDates = profile.orders
            .map(o => o.date)
            .filter(Boolean)
            .sort();
          let frequencyDays = null;
          if (sortedDates.length >= 2) {
            const gaps = [];
            for (let j = 1; j < sortedDates.length; j++) {
              const gap = (new Date(sortedDates[j]) - new Date(sortedDates[j - 1])) / 86400000;
              if (gap > 0) gaps.push(gap);
            }
            if (gaps.length > 0) {
              frequencyDays = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10;
            }
          }

          // Last 3 orders' SKUs
          const lastOrderSkus = profile.orders
            .filter(o => o.date)
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 3)
            .map(o => ({ skus: o.skus, value: o.total }));

          // Largest single order
          const largestOrder = Math.max(...profile.orders.map(o => o.itemCount || 0), 0);
          const isGroupBuyer = largestOrder >= 5 ? 1 : 0;

          // Segment
          const daysSinceLastVisit = profile.lastVisit
            ? Math.floor((Date.now() - new Date(profile.lastVisit)) / 86400000)
            : 999;
          let segment;
          if (daysSinceLastVisit >= 60) segment = 'churned';
          else if (daysSinceLastVisit >= 14) segment = 'lapsed';
          else if (profile.visitCount >= 6) segment = 'vip';
          else if (profile.visitCount >= 2) segment = 'regular';
          else segment = 'new';

          // Peak send hour
          const peakHour = Object.entries(profile.hourCounts)
            .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

          // SMS eligibility
          const smsEligible = phone ? 1 : 0;

          stmts.push(
            db.prepare(`
              INSERT INTO retail_customers (
                id, phone, normalized_phone, first_name,
                visit_count, total_lifetime_value, avg_order_value,
                avg_items_per_order, largest_single_order,
                favorite_sku, sku_diversity_score,
                first_visit_date, last_visit_date,
                segment, is_group_buyer,
                order_frequency_days, last_order_skus,
                day_of_week_pattern, visits_by_quarter,
                peak_send_hour, sms_eligible, sms_consent,
                acquisition_source,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', datetime('now'), datetime('now'))
              ON CONFLICT(id) DO UPDATE SET
                visit_count = MAX(retail_customers.visit_count, excluded.visit_count),
                total_lifetime_value = MAX(retail_customers.total_lifetime_value, excluded.total_lifetime_value),
                avg_order_value = excluded.avg_order_value,
                favorite_sku = COALESCE(excluded.favorite_sku, retail_customers.favorite_sku),
                sku_diversity_score = MAX(retail_customers.sku_diversity_score, excluded.sku_diversity_score),
                first_visit_date = MIN(COALESCE(retail_customers.first_visit_date, excluded.first_visit_date), COALESCE(excluded.first_visit_date, retail_customers.first_visit_date)),
                last_visit_date = MAX(COALESCE(retail_customers.last_visit_date, excluded.last_visit_date), COALESCE(excluded.last_visit_date, retail_customers.last_visit_date)),
                order_frequency_days = COALESCE(excluded.order_frequency_days, retail_customers.order_frequency_days),
                last_order_skus = excluded.last_order_skus,
                day_of_week_pattern = excluded.day_of_week_pattern,
                visits_by_quarter = excluded.visits_by_quarter,
                peak_send_hour = excluded.peak_send_hour,
                normalized_phone = COALESCE(excluded.normalized_phone, retail_customers.normalized_phone),
                sms_eligible = MAX(retail_customers.sms_eligible, excluded.sms_eligible),
                updated_at = datetime('now')
            `).bind(
              customerId,
              phone || null,
              normalizedPhone,
              profile.name || null,
              profile.visitCount,
              Math.round(profile.totalSpend * 100) / 100,
              Math.round(avgOrderValue * 100) / 100,
              profile.orders.length > 0
                ? Math.round(profile.orders.reduce((s, o) => s + (o.itemCount || 0), 0) / profile.orders.length * 10) / 10
                : 0,
              largestOrder,
              favoriteSku,
              Math.min(skuDiversity, 10),
              profile.firstVisit || null,
              profile.lastVisit || null,
              segment,
              isGroupBuyer,
              frequencyDays,
              JSON.stringify(lastOrderSkus),
              JSON.stringify(profile.dayOfWeekCounts),
              JSON.stringify(profile.quarterCounts),
              peakHour ? parseInt(peakHour) : null,
              smsEligible,
              smsEligible, // sms_consent = same as sms_eligible for backfill
            )
          );
        }

        await db.batch(stmts);
        written += batch.length;
      }

      console.log(`[Backfill] Wrote ${written} customer profiles to D1`);
    });

    // ── Step 5: Merge guestbook records ──────────────────────
    await step.do('merge-guestbook', async () => {
      const guestbookRows = await db.prepare(`
        SELECT phone, first_name, last_name, last_visit, order_count
        FROM guestbook
        WHERE phone IS NOT NULL AND phone != ''
      `).all();

      const records = guestbookRows.results || [];
      let merged = 0;
      const stmts = [];

      for (const row of records) {
        const phone = normalizePhone(row.phone);
        if (!phone) continue;

        const customerId = hashPhone(phone);
        const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;

        stmts.push(
          db.prepare(`
            INSERT INTO retail_customers (
              id, phone, normalized_phone, first_name,
              visit_count, total_lifetime_value,
              last_visit_date, segment, sms_eligible, sms_consent,
              acquisition_source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, 'new', 1, 1, 'guestbook', datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              first_name = COALESCE(retail_customers.first_name, excluded.first_name),
              normalized_phone = COALESCE(excluded.normalized_phone, retail_customers.normalized_phone),
              sms_eligible = MAX(retail_customers.sms_eligible, 1),
              sms_consent = MAX(retail_customers.sms_consent, 1),
              updated_at = datetime('now')
          `).bind(
            customerId,
            phone,
            phone,
            name,
            row.order_count || 1,
            row.last_visit || null,
          )
        );
        merged++;

        // Batch execute every 100
        if (stmts.length >= 100) {
          await db.batch(stmts.splice(0));
        }
      }

      if (stmts.length > 0) await db.batch(stmts);
      console.log(`[Backfill] Merged ${merged} guestbook records`);
    });

    // ── Step 6: Build historical menu analytics ──────────────
    await step.do('build-menu-analytics', async () => {
      // Group orders by week + SKU
      const weeklySkuData = {};

      for (const order of allOrders) {
        if (!order.date) continue;
        const weekStart = getWeekStart(order.date);

        for (const [sku, qty] of Object.entries(order.items)) {
          const key = `${weekStart}|${sku}`;
          if (!weeklySkuData[key]) {
            weeklySkuData[key] = {
              weekStart,
              sku,
              unitsSold: 0,
              revenue: 0,
              buyers: new Set(),
              hours: [],
              days: [],
            };
          }
          const entry = weeklySkuData[key];
          entry.unitsSold += qty;
          // Approximate revenue per SKU based on total / items ratio
          if (order.itemCount > 0) {
            entry.revenue += (order.total / order.itemCount) * qty;
          }
          if (order.phone) entry.buyers.add(order.phone);
          entry.hours.push(order.hour);
          entry.days.push(order.dayOfWeek);
        }
      }

      // Calculate combos (most paired SKU per week)
      const weeklyOrders = {};
      for (const order of allOrders) {
        if (!order.date) continue;
        const weekStart = getWeekStart(order.date);
        if (!weeklyOrders[weekStart]) weeklyOrders[weekStart] = [];
        weeklyOrders[weekStart].push(Object.keys(order.items));
      }

      const comboCounts = {};
      for (const [week, orders] of Object.entries(weeklyOrders)) {
        for (const skus of orders) {
          if (skus.length < 2) continue;
          for (let i = 0; i < skus.length; i++) {
            for (let j = i + 1; j < skus.length; j++) {
              const pair = [skus[i], skus[j]].sort().join('|');
              const key = `${week}|${pair}`;
              comboCounts[key] = (comboCounts[key] || 0) + 1;
            }
          }
        }
      }

      // Write to D1
      const stmts = [];
      const entries = Object.values(weeklySkuData);

      for (const entry of entries) {
        const peakHour = mode(entry.hours);
        const peakDay = mode(entry.days);
        const morningPct = entry.hours.filter(h => h < 12).length / (entry.hours.length || 1);
        const weekendPct = entry.days.filter(d => d === 0 || d === 5 || d === 6).length / (entry.days.length || 1);

        // Find most paired SKU for this week+sku
        let mostPairedSku = null;
        let pairFrequency = 0;
        for (const [key, count] of Object.entries(comboCounts)) {
          if (!key.startsWith(`${entry.weekStart}|`)) continue;
          const pair = key.split('|').slice(1);
          if (pair.includes(entry.sku) && count > pairFrequency) {
            mostPairedSku = pair.find(s => s !== entry.sku);
            pairFrequency = count;
          }
        }

        stmts.push(
          db.prepare(`
            INSERT OR REPLACE INTO retail_menu_analytics (
              id, week_start, sku, units_sold, revenue, unique_buyers,
              most_paired_sku, pair_frequency,
              peak_hour, peak_day_of_week, morning_pct, weekend_pct,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).bind(
            `rma_${entry.weekStart}_${entry.sku}`,
            entry.weekStart,
            entry.sku,
            entry.unitsSold,
            Math.round(entry.revenue * 100) / 100,
            entry.buyers.size,
            mostPairedSku,
            pairFrequency,
            peakHour,
            peakDay,
            Math.round(morningPct * 100) / 100,
            Math.round(weekendPct * 100) / 100,
          )
        );

        if (stmts.length >= 100) {
          await db.batch(stmts.splice(0));
        }
      }

      if (stmts.length > 0) await db.batch(stmts);

      // Calculate WoW trends
      const weeks = [...new Set(entries.map(e => e.weekStart))].sort();
      for (let i = 1; i < weeks.length; i++) {
        const prevWeek = weeks[i - 1];
        const currWeek = weeks[i];
        await db.prepare(`
          UPDATE retail_menu_analytics
          SET units_trend_pct = CASE
            WHEN (SELECT units_sold FROM retail_menu_analytics AS prev
                  WHERE prev.week_start = ? AND prev.sku = retail_menu_analytics.sku) > 0
            THEN ROUND(
              (retail_menu_analytics.units_sold * 1.0 /
               (SELECT units_sold FROM retail_menu_analytics AS prev
                WHERE prev.week_start = ? AND prev.sku = retail_menu_analytics.sku) - 1) * 100, 1)
            ELSE 0
          END
          WHERE week_start = ?
        `).bind(prevWeek, prevWeek, currWeek).run();
      }

      console.log(`[Backfill] Built ${entries.length} menu analytics rows across ${weeks.length} weeks`);
    });

    // ── Step 7: Initial churn scoring ────────────────────────
    await step.do('initial-churn-scoring', async () => {
      // Score all customers with enough data
      const customers = await db.prepare(`
        SELECT id, visit_count, last_visit_date, order_frequency_days,
               last_order_skus, visits_by_quarter
        FROM retail_customers
        WHERE visit_count >= 1
      `).all();

      const records = customers.results || [];
      const stmts = [];
      const now = Date.now();

      for (const c of records) {
        const score = calculateChurnScore(c, now);
        const clv = calculateCLV(c);

        stmts.push(
          db.prepare(`
            UPDATE retail_customers
            SET churn_risk_score = ?, predicted_clv = ?, updated_at = datetime('now')
            WHERE id = ?
          `).bind(score, clv, c.id)
        );

        if (stmts.length >= 100) {
          await db.batch(stmts.splice(0));
        }
      }

      if (stmts.length > 0) await db.batch(stmts);
      console.log(`[Backfill] Scored ${records.length} customers for churn risk`);
    });

    return {
      success: true,
      totalOrders,
      uniqueCustomers: Object.keys(allCustomers).length,
      completedAt: new Date().toISOString(),
    };
  }
}

// ── CHURN SCORE (shared with retail-agent.js) ────────────────────
function calculateChurnScore(customer, nowMs = Date.now()) {
  if (!customer.order_frequency_days || customer.visit_count < 2) {
    return 30;
  }

  const daysSinceLastVisit = customer.last_visit_date
    ? Math.floor((nowMs - new Date(customer.last_visit_date)) / 86400000)
    : 999;

  const overdueFactor = daysSinceLastVisit / customer.order_frequency_days;
  const baseScore = Math.min(overdueFactor * 50, 50);

  // Value decay from last_order_skus
  let valueDecay = 0;
  try {
    const recentOrders = JSON.parse(customer.last_order_skus || '[]');
    if (recentOrders.length >= 3) {
      const values = recentOrders.map(o => o.value || 0);
      const trend = (values[0] - values[values.length - 1]) / (values[values.length - 1] || 1);
      if (trend < -0.1) valueDecay = Math.min(Math.abs(trend) * 100, 20);
    }
  } catch {}

  const rawScore = baseScore + valueDecay;

  // Hard rules
  if (daysSinceLastVisit > 90) return Math.max(rawScore, 90);
  if (daysSinceLastVisit > 60) return Math.max(rawScore, 70);

  // Seasonal check — don't penalize seasonal customers in off-season
  try {
    const quarters = JSON.parse(customer.visits_by_quarter || '{}');
    const currentQuarter = `Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
    const totalVisits = Object.values(quarters).reduce((a, b) => a + b, 0);
    const quarterVisits = quarters[currentQuarter] || 0;
    if (totalVisits > 0 && quarterVisits === 0 && customer.visit_count >= 3) {
      // They never visit this quarter — seasonal, cap score at 40
      return Math.min(Math.round(rawScore), 40);
    }
  } catch {}

  return Math.round(Math.min(rawScore, 100));
}

// ── CLV PREDICTION (seasonal-aware) ──────────────────────────────
function calculateCLV(customer) {
  if (!customer.visit_count || customer.visit_count < 1) return 0;

  const avgOrderValue = customer.total_lifetime_value
    ? customer.total_lifetime_value / customer.visit_count
    : 0;

  let predictedVisits90d;
  try {
    const quarters = JSON.parse(customer.visits_by_quarter || '{}');
    const currentQuarter = `Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
    const historicalQuarterVisits = quarters[currentQuarter] || 0;

    const avgVisitsPer90d = customer.order_frequency_days && customer.order_frequency_days > 0
      ? 90 / customer.order_frequency_days
      : customer.visit_count / 6; // rough estimate over 18 months

    predictedVisits90d = (historicalQuarterVisits * 0.5) + (avgVisitsPer90d * 0.5);
  } catch {
    predictedVisits90d = customer.order_frequency_days && customer.order_frequency_days > 0
      ? 90 / customer.order_frequency_days
      : 1;
  }

  const churnMultiplier = 1 - ((customer.churn_risk_score || 0) / 150);
  return Math.round(avgOrderValue * predictedVisits90d * churnMultiplier * 100) / 100;
}

// ── HELPERS ──────────────────────────────────────────────────────
function mode(arr) {
  if (!arr || arr.length === 0) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}
