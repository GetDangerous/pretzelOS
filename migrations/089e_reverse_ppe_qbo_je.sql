-- migrations/089e_reverse_ppe_qbo_je.sql
-- Phase 30 Pattern B step 5: reverse 52 payroll qbo_je_ingest JEs (bookkeeper PPE).
--
-- The cash leg portion (-$57K CR Mercury embedded in these JEs) is now COVERED by
-- the 40 phase_30_dp_cash_leg JEs from 089d which include the Jan-May 2025 Dangerous
-- Pretze cash legs that PPE was capturing. Reversing PPE here:
--   - Un-DRs Salaries/Tax/etc.: ~-$218K FY2025 P&L expense (NI improves substantially)
--   - Un-CRs Mercury Checking: +$57K (offsets -$57K from 089d, Mercury GL preserved)
--   - Un-CRs Payroll Payable: ~-$107K (accrual removed; toast_payroll_reconstruction
--     will replace via Direct Deposit → Payroll Clearing in 089f)
--   - Un-CRs Payroll Tax Payable: -$46K
--   - Un-CRs Manual Checks: -$4K
--
-- Match payroll PPE JEs by description prefix (same as 088c original).

UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='Phase 30 089e', unlocked_by='phase_30_089e' WHERE unlocked_at IS NULL;

UPDATE journal_entries
   SET status='reversed',
       notes=COALESCE(notes,'') || ' | Phase 30 089e Pattern B 2026-05-20: reversed PPE — cash leg now in phase_30_dp_cash_leg (Dangerous Pretze) + Mercury TOAST PAYROLL (post-089b in Payroll Clearing); expense recognition will come from toast_payroll_reconstruction'
 WHERE source_type='qbo_je_ingest'
   AND status='posted'
   AND entry_date >= '2025-01-01'
   AND entry_date <= '2025-12-31'
   AND (
     description LIKE 'QBO JE PPE%'
     OR description LIKE 'QBO JE Payroll%'
     OR description LIKE 'QBO JE PR%'
   );

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason='Phase 30 089e';
