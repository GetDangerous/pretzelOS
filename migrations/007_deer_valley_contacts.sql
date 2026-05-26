-- Migration 007: Deer Valley Concert Series contact enrichment
-- Apollo-verified contacts from background search (April 4, 2026)
--
-- Jason Dominguez — Catering & Conference Sales Manager
--   Previously at C3 Presents (major concert promoter) — highest relevance for pretzel trial pitch
--   Verified via Apollo: j.dominguez@deervalley.com
--
-- Barbara Valpreda — Food and Beverage Manager
--   Direct F&B oversight — good secondary target
--   Verified via Apollo: bvalpreda@deervalley.com
--
-- Strategy: Jason as primary (C3 background = knows concessions), Barbara as backup

UPDATE venues
SET
  contact_name  = 'Jason Dominguez',
  contact_email = 'j.dominguez@deervalley.com',
  contact_title = 'Catering & Conference Sales Manager',
  notes         = COALESCE(notes || ' | ', '') || 'Secondary: Barbara Valpreda (F&B Manager) bvalpreda@deervalley.com — Jason has C3 Presents background, strong concert concessions angle.',
  updated_at    = datetime('now')
WHERE name = 'Deer Valley Concert Series';
