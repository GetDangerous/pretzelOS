-- Migration 008: Summer venue contact enrichment (batch 2)
-- Sources: venue websites directly (April 4, 2026)
-- Run: npx wrangler d1 execute pretzel-os --remote --file=migrations/008_summer_venue_contacts.sql

-- ══════════════════════════════════════════════════════════════════════════
-- UTAH STATE FAIRGROUNDS
-- Source: utahstatefair.com/p/about/about-us/staff1 (public staff directory)
-- Fred Acebo = F&B Manager — primary. Kelli McCaffery = Commercial Vendor Manager — secondary.
-- Both emails confirmed from their own website.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_name   = 'Fred Acebo',
  contact_email  = 'fred@utahstatefair.com',
  contact_title  = 'Food & Beverage Manager',
  notes          = COALESCE(notes || ' | ', '') || 'Secondary: Kelli McCaffery (Event Coordinator & Commercial Vendor Manager) kelli@utahstatefair.com. Bobby Villarreal (Operations Director) bobby@utahstatefair.com. Annual fair in Sept + year-round event rentals. Very high volume potential.',
  updated_at     = datetime('now')
WHERE name = 'Utah State Fairgrounds';

-- ══════════════════════════════════════════════════════════════════════════
-- RED BUTTE GARDEN CONCERTS
-- Source: redbuttegarden.org/contact-us/ (public contact page)
-- Tristin Tabish = Events & Guest Services Director — perfect contact.
-- University of Utah nonprofit. 4000-cap outdoor amphitheater. Upscale crowd.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_name   = 'Tristin Tabish',
  contact_email  = 'tristin.tabish@redbutte.utah.edu',
  contact_title  = 'Events & Guest Services Director',
  notes          = COALESCE(notes || ' | ', '') || 'Events & Guest Services Director owns the concert vendor relationships. University of Utah affiliation — nonprofit purchasing may have extra steps. Rentals contact: rentals@redbutte.utah.edu (Amie Cox, Isabella Rutledge).',
  updated_at     = datetime('now')
WHERE name = 'Red Butte Garden Concerts';

-- ══════════════════════════════════════════════════════════════════════════
-- OGDEN AMPHITHEATER (Ogden Twilight series)
-- Website unreachable, city contact pages returning 404.
-- Instagram @ogdentwilight confirmed on ogdentwilight.com — Drew DM approach.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_instagram  = '@ogdentwilight',
  contact_method_note = 'City-operated. Website unreachable. DM @ogdentwilight on Instagram — they''re active there. For email: try Ogden City Special Events at ogdencity.com.',
  notes              = COALESCE(notes || ' | ', '') || 'Instagram @ogdentwilight is active. Series is city-operated — city procurement may be involved. Ogden Twilight runs June-August. DM Drew route preferred until city contact found.',
  updated_at         = datetime('now')
WHERE name = 'Ogden Amphitheater';

-- ══════════════════════════════════════════════════════════════════════════
-- GALLIVAN CENTER
-- SLC city-operated. Main site SSL issues. No staff email found online.
-- Instagram @gallivancenter — Drew DM approach.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_instagram  = '@gallivancenter',
  contact_method_note = 'City-operated (SLC Parks). Instagram @gallivancenter is likely active. For direct email try: gallivan@slcgov.com or contact slc.gov city directory. Programming managed by SLC Arts.',
  notes              = COALESCE(notes || ' | ', '') || 'SLC city property. Summer concert series runs June-August downtown. High foot traffic, mixed crowd. Instagram DM until direct city staff contact found.',
  updated_at         = datetime('now')
WHERE name = 'Gallivan Center';

-- ══════════════════════════════════════════════════════════════════════════
-- THIS IS THE PLACE HERITAGE PARK
-- Only generic CustomerService email found — still usable, agent can personalize.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_email  = 'CustomerService@ThisIsThePlace.org',
  contact_title  = 'General Inquiry',
  notes          = COALESCE(notes || ' | ', '') || 'Generic email only — ask for Operations Manager or Events Director in first line. State-operated heritage site with seasonal festivals. Summer programming May-September.',
  updated_at     = datetime('now')
WHERE name = 'This Is The Place Heritage Park';

-- ══════════════════════════════════════════════════════════════════════════
-- PROVO ROOFTOP CONCERT SERIES
-- Website unreachable. Instagram approach.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_instagram  = '@provoprooftop',
  contact_method_note = 'Organizer website down. Instagram @provoprooftop is primary channel — DM approach. Utah County audience.',
  notes              = COALESCE(notes || ' | ', '') || 'Rooftop outdoor series in downtown Provo. Organizer-run (not city). Instagram is primary channel. Series runs May-August. Utah County crowd — different vibe than SLC venues.',
  updated_at         = datetime('now')
WHERE name = 'Provo Rooftop Concert Series';

-- ══════════════════════════════════════════════════════════════════════════
-- WEBER COUNTY FAIRGROUNDS
-- County government site unreachable. No contact found.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_method_note = 'Weber County government. Try: webercountyutah.gov/fair or call Weber County main line. Look for Parks & Recreation or Special Events department.',
  notes              = COALESCE(notes || ' | ', '') || 'County fair runs August. Year-round event rentals. Weber County government procurement — may need to route through county purchasing for new vendor approval. High volume if county fair adds pretzels.',
  updated_at         = datetime('now')
WHERE name = 'Weber County Fairgrounds';

-- ══════════════════════════════════════════════════════════════════════════
-- SNOWBIRD SUMMER CONCERTS
-- Resort website CSS-only (no staff data). Alta/Powder Mountain warm intro is key.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE venues
SET
  contact_method_note = 'Resort F&B Director. Snowbird.com contact form or call 801-933-2222 (resort main). Alta connection is warm intro — ask at Alta if they know Snowbird F&B team.',
  notes              = COALESCE(notes || ' | ', '') || 'Summer Oktoberfest + summer concert series. Alta ski connection could warm-intro to Snowbird F&B Director. No direct email online — resort phone 801-933-2222 or contact form. Drew should leverage Alta relationship first.',
  updated_at         = datetime('now')
WHERE name = 'Snowbird Summer Concerts';
