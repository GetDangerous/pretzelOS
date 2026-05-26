-- Migration 012: Venue pipeline expansion — 35 new leads
-- Summer outdoor concerts, breweries, sports/entertainment, golf, events

-- ── SUMMER / OUTDOOR CONCERT VENUES ──────────────────────────────────────────

INSERT OR IGNORE INTO venues (
  id, name, category, tier, city, website, status, campaign, created_at, updated_at
) VALUES

-- Tier 1: Major outdoor amphitheaters & resort concerts
('venue_thanksgiving_pt_amp', 'Thanksgiving Point Amphitheater', 'summer_venue', 1,
 'Lehi', 'thanksgivingpoint.org', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_park_city_mtn_concerts', 'Park City Mountain Summer Concerts', 'summer_venue', 1,
 'Park City', 'parkcitymountain.com', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_usana_amphitheater', 'USANA Amphitheater', 'summer_venue', 1,
 'West Valley City', 'livenation.com', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_eccles_center_park_city', 'Eccles Center for the Performing Arts', 'summer_venue', 1,
 'Park City', 'ecclescenter.org', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_tuacahn_amphitheater', 'Tuacahn Amphitheatre', 'summer_venue', 1,
 'Ivins', 'tuacahn.org', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_utah_symphony_deer_valley', 'Utah Symphony at Deer Valley', 'summer_venue', 1,
 'Park City', 'utahsymphony.org', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_canyons_summer_concerts', 'Canyons Village Summer Concerts', 'summer_venue', 1,
 'Park City', 'canyonsvillage.com', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_twilight_concert_series', 'Twilight Concert Series (Pioneer Park)', 'summer_venue', 1,
 'Salt Lake City', 'twi-lite.org', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_murray_park_concerts', 'Murray Park Amphitheater Summer Series', 'summer_venue', 2,
 'Murray', 'murray.utah.gov', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_solitude_summer', 'Solitude Mountain Resort Summer Events', 'summer_venue', 2,
 'Big Cottonwood Canyon', 'solitudemountain.com', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_utah_olympic_park', 'Utah Olympic Park Events', 'summer_venue', 2,
 'Park City', 'utaholympiclegacy.org', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

('venue_brigham_city_peach_days', 'Brigham City Peach Days Festival', 'summer_venue', 3,
 'Brigham City', 'peachdays.org', 'prospect', 'summer_2026', datetime('now'), datetime('now')),

-- ── BREWERIES ────────────────────────────────────────────────────────────────

('venue_epic_brewing', 'Epic Brewing Company', 'brewery', 1,
 'Salt Lake City', 'epicbrewingcompany.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_squatters_downtown', 'Squatter''s Pub Brewery', 'brewery', 1,
 'Salt Lake City', 'squatters.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_kiitos_brewing', 'Kiitos Brewing', 'brewery', 1,
 'Salt Lake City', 'kiitosbrewing.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_fisher_brewing', 'Fisher Brewing Company', 'brewery', 1,
 'Salt Lake City', 'fisherbrewing.co', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_proper_brewing', 'Proper Brewing Co', 'brewery', 1,
 'Salt Lake City', 'properbrewingco.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_uinta_brewing_taproom', 'Uinta Brewing Taproom', 'brewery', 1,
 'Salt Lake City', 'uintabrewing.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_red_rock_brewing', 'Red Rock Brewing Co', 'brewery', 1,
 'Salt Lake City', 'redrockbrewing.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_roosters_ogden', 'Roosters Brewing Co', 'brewery', 2,
 'Ogden', 'roostersbrewing.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_bohemian_brewery', 'Bohemian Brewery', 'brewery', 2,
 'Midvale', 'bohemianbrewery.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_desert_edge_brewery', 'Desert Edge Brewery at the Pub', 'brewery', 1,
 'Salt Lake City', 'desertedgebrewery.com', 'prospect', NULL, datetime('now'), datetime('now')),

-- ── SPORTS & ENTERTAINMENT ───────────────────────────────────────────────────

('venue_utah_grizzlies_maverik', 'Utah Grizzlies — Maverik Center', 'stadium', 1,
 'West Valley City', 'utahgrizzlies.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_topgolf_slc', 'Topgolf Salt Lake City', 'entertainment', 1,
 'Midvale', 'topgolf.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_scheels_arena_ogden', 'Scheels Arena — Ogden', 'stadium', 2,
 'Ogden', 'utahgrizzlies.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_real_salt_lake_stadium', 'America First Field (Real Salt Lake)', 'stadium', 1,
 'Sandy', 'rsl.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_utah_warriors_rugby', 'Utah Warriors Rugby — America First Field', 'stadium', 2,
 'Sandy', 'utahwarriors.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_vivint_arena_events', 'Delta Center Non-Jazz Events', 'stadium', 1,
 'Salt Lake City', 'deltacenter.com', 'prospect', NULL, datetime('now'), datetime('now')),

-- ── GOLF COURSES WITH EVENTS ─────────────────────────────────────────────────

('venue_thanksgiving_pt_golf', 'Thanksgiving Point Golf Club', 'golf', 1,
 'Lehi', 'thanksgivingpoint.org', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_soldier_hollow_golf', 'Soldier Hollow Golf Course', 'golf', 2,
 'Midway', 'stateparks.utah.gov', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_alpine_country_club', 'Alpine Country Club', 'golf', 1,
 'Highland', 'alpinecc.com', 'prospect', NULL, datetime('now'), datetime('now')),

-- ── EVENT CENTERS ────────────────────────────────────────────────────────────

('venue_mountain_america_expo', 'Mountain America Exposition Center', 'event_center', 1,
 'Sandy', 'maexpocenter.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_salt_palace_convention', 'Salt Palace Convention Center', 'event_center', 1,
 'Salt Lake City', 'visitsaltlake.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_davis_conference_center', 'Davis Conference Center', 'event_center', 2,
 'Layton', 'davisconferencecenter.com', 'prospect', NULL, datetime('now'), datetime('now')),

('venue_provo_towne_centre_events', 'Provo City Center Events', 'event_center', 2,
 'Provo', 'provo.org', 'prospect', NULL, datetime('now'), datetime('now'));

-- Update notes for venues we already have Apollo contact intel on
UPDATE venues SET
  notes = 'Apollo found: Jacob (VP F&B), Barbara + Franco (F&B Managers), Carrie (Event Manager), Devan (Marketing/Events/Sponsorship Coordinator). All have emails on file in Apollo — enrich to unlock.'
WHERE id = '2438fd5b838b04485f953edf9e1783c6'; -- Deer Valley Concert Series

UPDATE venues SET
  notes = 'Apollo found: Case La*** (Exec Director), Allegra Ha*** (Event Manager), Marianne Du*** (Executive Ops Manager). All have emails on file in Apollo.'
WHERE id = '82eacf2efe33ecf791881b762cdf436e'; -- This Is The Place Heritage Park

UPDATE venues SET
  notes = 'Apollo found: Aimee Du*** (Executive Director, email on file), Amanda Ne*** (Assistant Director, email + phone).'
WHERE id = '1d165d20a0164a5ba3f4e2c35b6f7890'; -- Utah Arts Festival (approximate ID)
