-- Migration 011: Seed initial catering leads for battle-test
-- Real SLC corporate/event prospects for catering outreach
-- These are well-known companies with large teams in SLC that hold corporate events

INSERT OR IGNORE INTO catering_leads (
  id, name, contact_name, contact_title, contact_email, contact_phone,
  company_size, headcount, industry, city, website,
  source, status, created_at, updated_at
) VALUES
  ('cat_001', 'Adobe Systems - Lehi', NULL, 'Office Manager', NULL, NULL,
   'enterprise', 3000, 'technology', 'Lehi', 'adobe.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_002', 'Overstock.com', NULL, 'Events Coordinator', NULL, NULL,
   'enterprise', 1500, 'ecommerce', 'Salt Lake City', 'overstock.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_003', 'Domo Inc', NULL, 'People Operations', NULL, NULL,
   'mid-market', 600, 'technology', 'American Fork', 'domo.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_004', 'Pluralsight', NULL, 'HR Director', NULL, NULL,
   'enterprise', 1800, 'technology', 'Draper', 'pluralsight.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_005', 'Qualtrics', NULL, 'Events Manager', NULL, NULL,
   'enterprise', 5000, 'technology', 'Provo', 'qualtrics.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_006', 'Merit Medical Systems', NULL, 'Office Manager', NULL, NULL,
   'enterprise', 6000, 'healthcare', 'South Jordan', 'merit.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_007', 'SalesForce - Lehi', NULL, 'EA / Events', NULL, NULL,
   'enterprise', 800, 'technology', 'Lehi', 'salesforce.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_008', 'Instructure (Canvas)', NULL, 'Culture & Events', NULL, NULL,
   'mid-market', 900, 'edtech', 'Salt Lake City', 'instructure.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_009', 'Ancestry.com (Salt Lake)', NULL, 'Office Manager', NULL, NULL,
   'enterprise', 1200, 'technology', 'Lehi', 'ancestry.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_010', 'CHG Healthcare', NULL, 'People & Culture', NULL, NULL,
   'enterprise', 3500, 'healthcare', 'Salt Lake City', 'chghealthcare.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_011', 'Zions Bancorporation', NULL, 'Corporate Events', NULL, NULL,
   'enterprise', 10000, 'finance', 'Salt Lake City', 'zionsbancorporation.com',
   'manual', 'prospect', datetime('now'), datetime('now')),

  ('cat_012', 'Extra Space Storage', NULL, 'HR Events', NULL, NULL,
   'enterprise', 5000, 'real_estate', 'Salt Lake City', 'extraspace.com',
   'manual', 'prospect', datetime('now'), datetime('now'));

-- Catering corporate pitch angle in business_brain
INSERT OR IGNORE INTO business_brain (id, scope, category, instruction, source)
VALUES
  ('catering_corp_angle', 'catering', 'voice',
   'Corporate catering pitch: We supply pretzel warmers to Delta Center and Sandy Amphitheater. For corporate events (lunch & learns, all-hands, team builds) we set up a fresh pretzel station — no kitchen, no staff needed. CTA: offer to drop samples or do a trial at their next event. Keep emails under 120 words. Social proof: Levy Group (Delta Center), Sandy Amphitheater.',
   'direct');
