-- 0014 (SEED): reference data for public.intake_categories.
--
-- intake_categories is a GLOBAL taxonomy table (PK = code, no org scoping). It is
-- consumed by the classifier (gmail-classify-ai, staged-entities-enrich-sonar),
-- src/hooks/useIntakeCategories.ts, and is FK-referenced by intake_known_senders,
-- intake_rules, bank_transactions, subscriptions and staged_entities. The table is
-- created (empty) in 0005; a fresh `supabase db reset` therefore had NO reference
-- data, which breaks intake routing. This file seeds the full live set (24 rows,
-- snapshot 2026-06-20 from project dxoikltymmknxqpkpyhi via read-only MCP).
--
-- Idempotent: ON CONFLICT (code) DO NOTHING. Safe to re-run and safe on the live DB
-- (existing rows are left untouched). See docs/MIGRATION_GAP_AUDIT.md (B.5).

INSERT INTO public.intake_categories
  (code, label, xero_account_code, xero_tax_type, description, is_business, side, sort_order)
VALUES
  ('materials', 'Materials', '500', 'INPUT', 'Reece, Bunnings, hardware, fencing supplies', true, 'expense', 10),
  ('subcontractor', 'Subcontractor labour', '478', 'INPUT', 'Day rates and ad-hoc trades you pay', true, 'expense', 20),
  ('employee_wages', 'Employee wages', '477', 'BASEXCLUDED', 'PAYG employee gross wages', true, 'expense', 30),
  ('motor_vehicle', 'Motor vehicle', '449', 'INPUT', 'Fuel, rego, repairs, insurance on fleet', true, 'expense', 40),
  ('fuel', 'Fuel (vehicle)', '449', 'INPUT', 'Petrol/diesel for fleet — sub-bucket of motor vehicle', true, 'expense', 41),
  ('plant_equipment', 'Plant & equipment', '710', 'INPUT', 'Tools, machinery, asset purchases', true, 'expense', 45),
  ('insurance', 'Insurance', '433', 'INPUT', 'Public liability, fleet, workers comp', true, 'expense', 50),
  ('telephone_internet', 'Telephone & internet', '489', 'INPUT', 'Phone bills, mobile, internet, NBN', true, 'expense', 60),
  ('subscriptions_saas', 'Subscriptions & SaaS', '485', 'INPUT', 'Xero, ServiceM8, Office365, design tools', true, 'expense', 70),
  ('office_supplies', 'Office expenses', '453', 'INPUT', 'Stationery, computer accessories, office consumables', true, 'expense', 80),
  ('travel', 'Travel', '493', 'INPUT', 'National travel: flights, accommodation, taxis', true, 'expense', 90),
  ('meals_entertainment', 'Meals & entertainment', '420', 'INPUT', 'Client lunches, team meals (FBT consideration)', true, 'expense', 100),
  ('professional_fees', 'Professional fees', '412', 'INPUT', 'Accounting, legal, consulting', true, 'expense', 110),
  ('rent', 'Rent', '469', 'INPUT', 'Office, yard, storage rent', true, 'expense', 120),
  ('utilities', 'Utilities', '445', 'INPUT', 'Power, water, gas', true, 'expense', 130),
  ('bank_fees', 'Bank fees & interest', '404', 'NONE', 'Bank fees, merchant fees, interest charges', true, 'expense', 140),
  ('marketing', 'Marketing & advertising', '400', 'INPUT', 'Google Ads, web hosting, signage, sponsorships', true, 'expense', 150),
  ('training', 'Training & licences', '454', 'INPUT', 'Trade tickets, white card, ongoing PD', true, 'expense', 160),
  ('uniform_ppe', 'Uniform & PPE', '463', 'INPUT', 'High-vis, boots, hats, branded gear', true, 'expense', 170),
  ('ato_bas_super', 'ATO / BAS / super', '820', 'BASEXCLUDED', 'GST owed, PAYG, super contributions — internal admin', true, 'liability', 200),
  ('refunds', 'Customer refunds', '260', 'OUTPUT', 'Refunds to customers — reduces revenue', true, 'income', 300),
  ('customer_payment', 'Customer payment', '200', 'OUTPUT', 'Inbound revenue — invoice paid by customer', true, 'income', 310),
  ('personal_expense', 'Personal', NULL, NULL, 'Tracked locally only, NEVER pushed to Xero', false, 'expense', 900),
  ('uncategorized', 'Needs review', NULL, NULL, 'Auto Setup could not classify — user must pick', false, 'expense', 999)
ON CONFLICT (code) DO NOTHING;
