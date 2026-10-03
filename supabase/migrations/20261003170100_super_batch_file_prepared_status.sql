-- LODGE-01: a super batch whose clearing-house file has been generated is "file_prepared", not "sent".
--
-- super-batch-send builds the SuperStream clearing-house file and marked the batch `sent`, although
-- nothing went to a fund or clearing house and nothing was paid: the employer still has to upload the
-- file and pay. `file_prepared` sits between `approved` and `sent`; `sent`/`confirmed` stay for a real
-- transport. ALTER TYPE ... ADD VALUE gets its own migration so the next one can use the new value.

ALTER TYPE public.super_batch_status ADD VALUE IF NOT EXISTS 'file_prepared' BEFORE 'sent';
