-- migrations/089k_reverse_23_leaf_split.sql
-- Phase 30 Pattern B step 8: reverse 16 obsolete `23-leaf-split-*` JEs.
--
-- These Phase 23-LEAF JEs used approximate 25/75 interest/principal split for
-- FY2026 LEAF Mercury outflows. Now obsolete because:
--   - 089h posted proper mercury_txn JEs (DR LEAF Clearing / CR Mercury)
--   - leaf_amortization_reconstruction posted exact amortization JEs
-- Keeping `23-leaf-split-*` would double-count the cash leg.

UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='089k', unlocked_by='089k' WHERE unlocked_at IS NULL;

UPDATE journal_entries
   SET status='reversed',
       notes=COALESCE(notes,'') || ' | Phase 30 089k 2026-05-20: reversed — replaced by 089h mercury_txn + leaf_amortization_reconstruction exact-amortization JEs'
 WHERE id LIKE '23-leaf-split-%' AND status='posted';

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason='089k';
