-- 20260702130000_invoice_zero_gst_treatment.sql
-- Preserve zero-rated invoice line GST treatment instead of collapsing it to
-- GST-free. This keeps invoice lines aligned with the UI option and allows
-- downstream reporting/adapters to distinguish the treatment.

alter type public.invoice_gst_treatment add value if not exists 'zero';
