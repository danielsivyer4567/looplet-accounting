-- 0230_advisor_work_proofs.sql
--
-- Durable finish-work proof packs for external advisors. The UI can preview
-- accountant activity and audit-log rows, but the internal save must be compiled
-- server-side so the stored snapshot is database-derived and hashable.

BEGIN;

CREATE TABLE IF NOT EXISTS public.advisor_work_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_email text,
  role_label text NOT NULL DEFAULT 'advisor',
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  note text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  emailed_at timestamptz,
  emailed_to text,
  delivery_status text NOT NULL DEFAULT 'saved'
    CHECK (delivery_status IN ('saved', 'emailed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS advisor_work_proofs_org_time_idx
  ON public.advisor_work_proofs (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS advisor_work_proofs_user_time_idx
  ON public.advisor_work_proofs (organization_id, user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS advisor_work_proofs_snapshot_hash_idx
  ON public.advisor_work_proofs (organization_id, snapshot_hash);

ALTER TABLE public.advisor_work_proofs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS advisor_work_proofs_select ON public.advisor_work_proofs;
CREATE POLICY advisor_work_proofs_select ON public.advisor_work_proofs
  FOR SELECT USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND (
      user_id = auth.uid()
      OR public.require_role(organization_id, 'admin'::public.org_role)
    )
  );

REVOKE ALL ON public.advisor_work_proofs FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.advisor_work_proofs FROM authenticated;
GRANT SELECT ON public.advisor_work_proofs TO authenticated;

DROP TRIGGER IF EXISTS advisor_work_proofs_audit ON public.advisor_work_proofs;
CREATE TRIGGER advisor_work_proofs_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.advisor_work_proofs
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

CREATE OR REPLACE FUNCTION public.finish_advisor_work_session(
  p_organization_id uuid,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT now(),
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_email text;
  v_role text;
  v_default_start timestamptz;
  v_period_start timestamptz;
  v_period_end timestamptz := COALESCE(p_period_end, now());
  v_sessions jsonb;
  v_activity jsonb;
  v_audit jsonb;
  v_resource_counts jsonb;
  v_path_counts jsonb;
  v_event_type_counts jsonb;
  v_risk_flags jsonb;
  v_summary jsonb;
  v_snapshot jsonb;
  v_snapshot_hash text;
  v_proof_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'finish_advisor_work_session: not signed in'
      USING ERRCODE = '28000';
  END IF;

  SELECT email INTO v_email
    FROM auth.users
   WHERE id = v_user_id;

  SELECT m.role_enum::text INTO v_role
    FROM public.organization_memberships m
   WHERE m.organization_id = p_organization_id
     AND m.user_id = v_user_id
     AND m.accepted_at IS NOT NULL
   LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'finish_advisor_work_session: organization is not accessible'
      USING ERRCODE = '42501';
  END IF;

  -- Looplet's current external-advisor access is the accountant role. Admin and
  -- owner are included so firms can test/recover proofs without weakening RLS.
  IF v_role NOT IN ('accountant', 'admin', 'owner') THEN
    RAISE EXCEPTION 'finish_advisor_work_session: accountant role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT started_at INTO v_default_start
    FROM public.accountant_sessions
   WHERE organization_id = p_organization_id
     AND user_id = v_user_id
     AND ended_at IS NULL
   ORDER BY started_at DESC
   LIMIT 1;

  v_period_start := COALESCE(p_period_start, v_default_start, now() - INTERVAL '8 hours');

  IF v_period_end < v_period_start THEN
    RAISE EXCEPTION 'finish_advisor_work_session: period_end must be after period_start';
  END IF;

  IF v_period_end - v_period_start > INTERVAL '31 days' THEN
    RAISE EXCEPTION 'finish_advisor_work_session: proof window cannot exceed 31 days';
  END IF;

  UPDATE public.accountant_sessions
     SET last_activity_at = GREATEST(last_activity_at, v_period_end),
         ended_at = v_period_end,
         end_reason = 'manual',
         total_seconds = EXTRACT(EPOCH FROM (v_period_end - started_at))::int
   WHERE organization_id = p_organization_id
     AND user_id = v_user_id
     AND ended_at IS NULL
     AND started_at >= v_period_start - INTERVAL '1 second';

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.started_at), '[]'::jsonb)
    INTO v_sessions
    FROM (
      SELECT id, started_at, last_activity_at, ended_at, end_reason,
             pageview_count, action_count, total_seconds, digest_sent_at
        FROM public.accountant_sessions
       WHERE organization_id = p_organization_id
         AND user_id = v_user_id
         AND started_at <= v_period_end
         AND COALESCE(ended_at, last_activity_at, started_at) >= v_period_start
       ORDER BY started_at
    ) s;

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.occurred_at), '[]'::jsonb)
    INTO v_activity
    FROM (
      SELECT id, occurred_at, event_type, path, description, resource_type,
             resource_id, duration_ms, metadata
        FROM public.accountant_activity_log
       WHERE organization_id = p_organization_id
         AND user_id = v_user_id
         AND occurred_at >= v_period_start
         AND occurred_at <= v_period_end
       ORDER BY occurred_at
    ) a;

  SELECT COALESCE(jsonb_agg(to_jsonb(al) ORDER BY al.occurred_at), '[]'::jsonb)
    INTO v_audit
    FROM (
      SELECT id, occurred_at, table_name, record_id, operation, actor_user_id,
             actor_email, action, resource_type, resource_id, changes, metadata
        FROM public.audit_log
       WHERE organization_id = p_organization_id
         AND occurred_at >= v_period_start
         AND occurred_at <= v_period_end
         AND (
           actor_user_id = v_user_id
           OR (actor_user_id IS NULL AND actor_email = v_email)
         )
       ORDER BY occurred_at
    ) al;

  SELECT COALESCE(jsonb_object_agg(resource_key, event_count), '{}'::jsonb)
    INTO v_resource_counts
    FROM (
      SELECT COALESCE(resource_type, table_name, 'unknown') AS resource_key,
             count(*) AS event_count
        FROM public.audit_log
       WHERE organization_id = p_organization_id
         AND occurred_at >= v_period_start
         AND occurred_at <= v_period_end
         AND (
           actor_user_id = v_user_id
           OR (actor_user_id IS NULL AND actor_email = v_email)
         )
       GROUP BY COALESCE(resource_type, table_name, 'unknown')
    ) counts;

  SELECT COALESCE(jsonb_object_agg(path_key, event_count), '{}'::jsonb)
    INTO v_path_counts
    FROM (
      SELECT COALESCE(path, '(no path)') AS path_key, count(*) AS event_count
        FROM public.accountant_activity_log
       WHERE organization_id = p_organization_id
         AND user_id = v_user_id
         AND occurred_at >= v_period_start
         AND occurred_at <= v_period_end
       GROUP BY COALESCE(path, '(no path)')
    ) counts;

  SELECT COALESCE(jsonb_object_agg(event_type, event_count), '{}'::jsonb)
    INTO v_event_type_counts
    FROM (
      SELECT event_type, count(*) AS event_count
        FROM public.accountant_activity_log
       WHERE organization_id = p_organization_id
         AND user_id = v_user_id
         AND occurred_at >= v_period_start
         AND occurred_at <= v_period_end
       GROUP BY event_type
    ) counts;

  SELECT COALESCE(jsonb_agg(flag), '[]'::jsonb)
    INTO v_risk_flags
    FROM (
      SELECT 'no_activity_rows' AS flag
       WHERE jsonb_array_length(v_activity) = 0
      UNION ALL
      SELECT 'no_write_audit_events' AS flag
       WHERE jsonb_array_length(v_audit) = 0
      UNION ALL
      SELECT 'delete_or_void_events_present' AS flag
       WHERE EXISTS (
         SELECT 1
           FROM jsonb_to_recordset(v_audit) AS a(action text, operation text)
          WHERE COALESCE(a.action, a.operation) IN ('DELETE', 'VOID')
       )
    ) flags;

  v_summary := jsonb_build_object(
    'session_count', jsonb_array_length(v_sessions),
    'activity_count', jsonb_array_length(v_activity),
    'audit_event_count', jsonb_array_length(v_audit),
    'pageview_count', (
      SELECT count(*)
        FROM public.accountant_activity_log
       WHERE organization_id = p_organization_id
         AND user_id = v_user_id
         AND event_type = 'pageview'
         AND occurred_at >= v_period_start
         AND occurred_at <= v_period_end
    ),
    'action_count', (
      SELECT count(*)
        FROM public.accountant_activity_log
       WHERE organization_id = p_organization_id
         AND user_id = v_user_id
         AND event_type IN ('action', 'comment', 'export')
         AND occurred_at >= v_period_start
        AND occurred_at <= v_period_end
    ),
    'resource_counts', v_resource_counts,
    'path_counts', v_path_counts,
    'event_type_counts', v_event_type_counts,
    'risk_flags', v_risk_flags,
    'invoice_seed', jsonb_build_object(
      'evidence_kind', 'advisor_work_proof',
      'period_start', v_period_start,
      'period_end', v_period_end,
      'description',
        'Advisor work proof ' || to_char(v_period_start, 'YYYY-MM-DD') || ' to ' ||
        to_char(v_period_end, 'YYYY-MM-DD') || ': ' ||
        jsonb_array_length(v_activity)::text || ' activity events, ' ||
        jsonb_array_length(v_audit)::text || ' audited write events',
      'activity_count', jsonb_array_length(v_activity),
      'audit_event_count', jsonb_array_length(v_audit),
      'suggested_reference', 'advisor-work-proof'
    )
  );

  v_snapshot := jsonb_build_object(
    'schema_version', 1,
    'kind', 'advisor_work_proof',
    'organization_id', p_organization_id,
    'user_id', v_user_id,
    'user_email', v_email,
    'role', v_role,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'note', NULLIF(BTRIM(COALESCE(p_note, '')), ''),
    'summary', v_summary,
    'sessions', v_sessions,
    'activity', v_activity,
    'audit_log', v_audit
  );

  v_snapshot_hash := encode(digest(v_snapshot::text, 'sha256'), 'hex');

  INSERT INTO public.advisor_work_proofs (
    organization_id, user_id, user_email, role_label, period_start, period_end,
    note, summary, snapshot, snapshot_hash
  ) VALUES (
    p_organization_id, v_user_id, v_email, v_role, v_period_start, v_period_end,
    NULLIF(BTRIM(COALESCE(p_note, '')), ''), v_summary, v_snapshot, v_snapshot_hash
  )
  ON CONFLICT (organization_id, snapshot_hash)
    DO UPDATE SET delivery_status = public.advisor_work_proofs.delivery_status
  RETURNING id INTO v_proof_id;

  RETURN jsonb_build_object(
    'ok', true,
    'proof_id', v_proof_id,
    'snapshot_hash', v_snapshot_hash,
    'summary', v_summary,
    'snapshot', v_snapshot
  );
END;
$$;

COMMENT ON TABLE public.advisor_work_proofs IS
  'Server-compiled, hashable work-session proof snapshots for accountants/advisors.';

COMMENT ON FUNCTION public.finish_advisor_work_session(uuid, timestamptz, timestamptz, text) IS
  'Closes the caller advisor session manually and persists a DB-derived proof snapshot from accountant activity and audit_log rows.';

REVOKE ALL ON FUNCTION public.finish_advisor_work_session(uuid, timestamptz, timestamptz, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_advisor_work_session(uuid, timestamptz, timestamptz, text)
  TO authenticated;

COMMIT;
