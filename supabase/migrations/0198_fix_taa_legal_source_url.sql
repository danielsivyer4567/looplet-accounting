-- 0198: fix the registered FRL series for the Taxation Administration Act 1953.
--
-- 0110 seeded C2004A07377, whose /latest/text route now returns the FRL
-- "requested title could not be loaded" shell. The principal TAA 1953 series is
-- C1953A00001, which resolves to the current in-force compilation and chunkable
-- legal text.

UPDATE public.legal_sources
SET
  canonical_url = 'https://www.legislation.gov.au/C1953A00001',
  last_checked_at = CASE
    WHEN canonical_url <> 'https://www.legislation.gov.au/C1953A00001' THEN NULL
    ELSE last_checked_at
  END,
  last_version_ref = CASE
    WHEN canonical_url <> 'https://www.legislation.gov.au/C1953A00001' THEN NULL
    ELSE last_version_ref
  END,
  updated_at = now()
WHERE name = 'Taxation Administration Act 1953'
  AND deleted_at IS NULL
  AND canonical_url <> 'https://www.legislation.gov.au/C1953A00001';

NOTIFY pgrst, 'reload schema';
