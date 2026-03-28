-- Seed active accounts from handoff doc Section 11
-- Run after schema.sql migration

INSERT INTO venues (id, name, category, status, city, state, activated_at, created_at, updated_at)
VALUES
  ('v_delta_center',    'Delta Center',                'stadium',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_slc_bees',        'SLC Bees Stadium',            'stadium',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_powder_mtn',      'Powder Mountain Ski Resort',  'ski_resort',   'active', 'Eden',           'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_alta_gmd',        'Alta Ski - Goldminers Daughter', 'ski_resort','active', 'Alta',           'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_union_event',     'The Union Event Center',      'event_venue',  'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_pioneer_theater', 'Pioneer Theater Company',     'theater',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_tf_brewery',      'TF Brewery',                  'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_hopkins',         'Hopkins Brewery',             'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_roha',            'ROHA Brewing',                'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_hk_brewing',      'HK Brewing',                  'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now'));

INSERT INTO active_accounts (id, venue_id, fulfilled_by, health_status, churn_risk, created_at, updated_at)
VALUES
  ('aa_delta_center',    'v_delta_center',    'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_slc_bees',        'v_slc_bees',        'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_powder_mtn',      'v_powder_mtn',      'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_alta_gmd',        'v_alta_gmd',        'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_union_event',     'v_union_event',     'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_pioneer_theater', 'v_pioneer_theater', 'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_tf_brewery',      'v_tf_brewery',      'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_hopkins',         'v_hopkins',         'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_roha',            'v_roha',            'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_hk_brewing',      'v_hk_brewing',      'self', 'green', 0, datetime('now'), datetime('now'));
