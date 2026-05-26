-- Migration 013: Add confirmed contacts to existing + new venues

-- ── Existing summer venues (from migration 006) ───────────────────────────
UPDATE venues SET
  contact_name = 'Catherine Bradley',
  contact_title = 'Catering Sales Director',
  contact_email = 'cbradley@deervalley.com',
  notes = 'Confirmed contact: Catherine Bradley (Catering Sales Director). Also: banquets@deervalley.com. Concert series = Deer Valley Music Festival at Snow Park Outdoor Amphitheater.'
WHERE name LIKE '%Deer Valley%' AND category = 'summer_venue';

-- Snowbird — clear any holds so agent can re-evaluate with new voice template
DELETE FROM outreach_holds WHERE venue_id IN (SELECT id FROM venues WHERE name LIKE '%Snowbird%');
-- Also clear any rejected outreach logs so it's treated as fresh
UPDATE outreach_logs SET approval_status = 'superseded'
  WHERE venue_id IN (SELECT id FROM venues WHERE name LIKE '%Snowbird%')
  AND approval_status = 'rejected';

UPDATE venues SET
  notes = 'F&B Manager: Alyssa Schoenfeld (aschoenfeld@snowbird.com). Summer concerts May-Sept, Friday night free concert series (Plazapalooza). Alta/Goldminer warm intro possible. Strong fit.'
WHERE name LIKE '%Snowbird%' AND contact_email = 'aschoenfeld@snowbird.com';

-- ── New venues — add contacts ──────────────────────────────────────────────

-- Twilight Concert Series
UPDATE venues SET
  contact_name = 'Jeff Mudgett',
  contact_title = 'Event Coordinator',
  contact_email = 'jeff@snspresents.com',
  notes = 'S&S Presents runs Twilight. Jeff Mudgett (Event Coord) = best first contact. Backup: Elaine Sayer (Production, elaine@snspresents.com), Nic Smith CEO (nic@snspresents.com). Pioneer Park. High volume summer crowds.'
WHERE id = 'venue_twilight_concert_series';

-- Epic Brewing
UPDATE venues SET
  contact_name = 'Ryan',
  contact_title = 'Wholesale/Distribution Contact',
  contact_email = 'ryan@epicbrewing.com',
  notes = 'Ryan handles wholesale/distribution. Large indoor taproom + patio. High foot traffic. Already have TF, Hopkins, ROHA, HK as social proof for breweries.'
WHERE id = 'venue_epic_brewing';

-- Squatters
UPDATE venues SET
  contact_email = 'info@squatterspubs.com',
  notes = 'General contact. GM possibly Jon Keddington (jkeddington@saltlakebrewingco.com - unverified). Downtown SLC, high foot traffic. Part of Salt Lake Brewing Co family.'
WHERE id = 'venue_squatters_downtown';

-- Tuacahn
UPDATE venues SET
  contact_name = 'Lindsay',
  contact_title = 'Facility Rentals',
  contact_email = 'facilityrentals@tuacahn.org',
  notes = 'Lindsay handles facility rentals/events. 1900-seat outdoor canyon amphitheater in St George. Shakespeare + Broadway productions May-Oct. High tourist + local crowd. Different market (St George) — use for expansion round.'
WHERE id = 'venue_tuacahn_amphitheater';

-- USANA Amphitheater
UPDATE venues SET
  contact_name = 'Live Nation Special Events',
  contact_title = 'Special Events',
  contact_email = 'specialevents@livenation.com',
  notes = 'Live Nation venue (20k cap). National special events team. Biggest outdoor venue in Utah. Long shot but high value. Phone: 801-456-2803.'
WHERE id = 'venue_usana_amphitheater';

-- Thanksgiving Point
UPDATE venues SET
  contact_name = 'Tucker Lougee',
  contact_title = 'Senior Director of Campus Events',
  contact_email = 'tlougee@thanksgivingpoint.org',
  notes = 'Tucker Lougee, Sr Dir Campus Events. Ashley Taylor also handles private events (ataylor@thanksgivingpoint.org). Huge family campus in Lehi — amphitheater, events center, gardens. 1.5M visitors/year.'
WHERE id = 'venue_thanksgiving_pt_amp';

-- Utah Arts Festival
UPDATE venues SET
  contact_name = 'Aimee Dunsmore',
  contact_title = 'Executive Director',
  contact_email = 'adunsmore@uaf.org',
  notes = 'Aimee Dunsmore, Exec Director. Amanda Neff (Program Manager) also available. Annual 4-day festival downtown SLC. 80k+ attendees. Food vendor opportunity. Bob Ra*** listed as Culinary Arts Coordinator — reach Aimee first.'
WHERE id = 'venue_utah_arts_festival'
   OR (name LIKE '%Utah Arts Festival%' AND contact_email IS NULL);

-- Eccles / Park City Performing Arts
UPDATE venues SET
  contact_name = 'Ember Conley',
  contact_title = 'Executive Director',
  contact_email = 'boxoffice@parkcityinstitute.org',
  notes = 'Ember Conley, Exec Director (since Aug 2024). Rebranded to Park City Performing Arts / Park City Institute. 1800 E Kearns Blvd, Park City. Phone: 435-655-3114.'
WHERE id = 'venue_eccles_center_park_city';

-- Red Rock Brewing
UPDATE venues SET
  contact_email = 'info@redrockbrewing.com',
  notes = 'Downtown SLC brewery + restaurant. High lunch/dinner traffic. Good brewery social proof from TF, Hopkins, ROHA, HK.'
WHERE id = 'venue_red_rock_brewing';

-- Desert Edge Brewery (from Apollo: Tiffany Lee, Restaurant Manager)
UPDATE venues SET
  contact_name = 'Tiffany Lee',
  contact_title = 'Restaurant Manager',
  notes = 'Tiffany Lee is Restaurant Manager (from Apollo). Trolley Square location. High foot traffic, bar setting. Email not in Apollo — try calling: look up Trolley Square directory.'
WHERE id = 'venue_desert_edge_brewery';

-- Gallivan Center — add city contact
UPDATE venues SET
  contact_email = 'gallivancenter@slcgov.com',
  notes = 'City of SLC operated. Summer concert series + outdoor events year-round. gallivancenter@slcgov.com or call 801-535-6110. Target events coordinator.'
WHERE id = '60a1ef6f7dee86ce32afa5e87b24714d';

-- Ogden Amphitheater — add city contact
UPDATE venues SET
  contact_email = 'events@ogdencity.com',
  notes = 'City of Ogden operated. Ogden Twilight concert series. events@ogdencity.com. Also try Ogden City Recreation. Strong summer programming.'
WHERE id = '06d794dc1969afa97f8b9e64b0e9b741';

-- This Is The Place — add customer service email
UPDATE venues SET
  contact_email = 'customerservice@thisistheplace.org',
  notes = 'State-operated. CustomerService@ThisIsThePlace.org is only public email. Call 801-804-5611 to get to events/ops team. Apollo shows Case La*** (Exec Dir), Allegra Ha*** (Event Manager) are on file.'
WHERE id = '82eacf2efe33ecf791881b762cdf436e';
