-- Keep the debt enum aligned with the debt UI options.
-- This is separate from the trigger migration so newly added enum values are
-- committed before the next migration uses them.
ALTER TYPE public.debt_kind ADD VALUE IF NOT EXISTS 'business_loan' AFTER 'personal_loan';
ALTER TYPE public.debt_kind ADD VALUE IF NOT EXISTS 'overdraft' AFTER 'line_of_credit';
ALTER TYPE public.debt_kind ADD VALUE IF NOT EXISTS 'tax_debt' AFTER 'overdraft';
