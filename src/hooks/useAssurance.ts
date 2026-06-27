import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { base64ToBlob, downloadBlob } from '@/lib/download';
import { useOrg } from '@/hooks/useOrg';

export type AtoCorrespondenceStatus = 'received' | 'in_review' | 'drafted' | 'responded' | 'closed';

export type AtoDraftStatus = 'draft' | 'ready_for_review' | 'approved' | 'sent' | 'superseded';

export interface AtoCorrespondenceRow {
  id: string;
  organization_id: string;
  notice_type: string;
  subject: string | null;
  ato_reference: string | null;
  received_at: string;
  due_date: string | null;
  source_doc_ref: Record<string, unknown>;
  status: AtoCorrespondenceStatus;
  details: Record<string, unknown>;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface EvidenceLink {
  type?: string;
  label?: string;
  href?: string | null;
  storage_key?: string | null;
  source_id?: string | null;
  resolved?: boolean;
}

export interface AtoCorrespondenceDraftRow {
  id: string;
  organization_id: string;
  correspondence_id: string;
  draft_type: string;
  subject: string;
  body: string;
  evidence: EvidenceLink[];
  status: AtoDraftStatus;
  approval_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface WorkingPapersSourceFile {
  storage_key: string;
  source: string;
  source_id: string | null;
  original_filename: string | null;
  resolved: boolean;
  signed_url: string | null;
  expires_in_seconds: number;
  error: string | null;
}

export interface WorkingPapersBundle {
  organization_id: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  manifest: Record<string, unknown>;
  source_files: WorkingPapersSourceFile[];
  checks: {
    manifest_ok: boolean;
    source_files_resolved: boolean;
    unresolved_source_file_count: number;
  };
  complete: boolean;
}

export interface WorkingPapersResult {
  ok: boolean;
  bundle?: WorkingPapersBundle;
  pdf_base64?: string;
  unresolved_source_files?: WorkingPapersSourceFile[];
  error?: string;
}

interface AtoCorrespondenceDraftResponse {
  ok?: boolean;
  draft?: AtoCorrespondenceDraftRow;
  evidence?: EvidenceLink[];
  error?: string;
}

interface AtoSendResponse {
  ok?: boolean;
  approved?: boolean;
  approval_id?: string | null;
  error?: string;
}

interface ParsedFunctionError {
  message: string;
  approvalId?: string | null;
  approved?: boolean;
}

const CORRESPONDENCE_COLUMNS =
  'id, organization_id, notice_type, subject, ato_reference, received_at, due_date, ' +
  'source_doc_ref, status, details, notes, created_at, updated_at, created_by';

const DRAFT_COLUMNS =
  'id, organization_id, correspondence_id, draft_type, subject, body, evidence, status, ' +
  'approval_id, sent_at, created_at, updated_at, created_by';

async function readFunctionError(err: unknown): Promise<ParsedFunctionError> {
  const e = err as { message?: string; context?: { json?: () => Promise<unknown> } };
  let message = e.message ?? 'Request failed';
  let approvalId: string | null | undefined;
  let approved: boolean | undefined;

  try {
    if (e.context?.json) {
      const body = (await e.context.json()) as {
        error?: unknown;
        approval_id?: unknown;
        approved?: unknown;
      };
      if (typeof body?.error === 'string' && body.error.trim()) message = body.error;
      if (typeof body?.approval_id === 'string' || body?.approval_id === null) {
        approvalId = body.approval_id;
      }
      if (typeof body?.approved === 'boolean') approved = body.approved;
    }
  } catch {
    // Non-JSON or already-consumed function body; keep the Supabase error message.
  }

  const parsed: ParsedFunctionError = { message };
  if (approvalId !== undefined) parsed.approvalId = approvalId;
  if (approved !== undefined) parsed.approved = approved;
  return parsed;
}

export function useAssurance(limit = 50) {
  const { currentOrg } = useOrg();
  const [correspondence, setCorrespondence] = useState<AtoCorrespondenceRow[]>([]);
  const [drafts, setDrafts] = useState<AtoCorrespondenceDraftRow[]>([]);
  const [workingPapers, setWorkingPapers] = useState<WorkingPapersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setCorrespondence([]);
      setDrafts([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const [correspondenceRes, draftsRes] = await Promise.all([
      supabase
        .from('ato_correspondence')
        .select(CORRESPONDENCE_COLUMNS)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('received_at', { ascending: false })
        .limit(limit),
      supabase
        .from('ato_correspondence_drafts')
        .select(DRAFT_COLUMNS)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(limit),
    ]);

    if (correspondenceRes.error || draftsRes.error) {
      setError(
        correspondenceRes.error?.message ??
          draftsRes.error?.message ??
          'Could not load assurance workspace.',
      );
      setCorrespondence([]);
      setDrafts([]);
    } else {
      setCorrespondence((correspondenceRes.data ?? []) as unknown as AtoCorrespondenceRow[]);
      setDrafts((draftsRes.data ?? []) as unknown as AtoCorrespondenceDraftRow[]);
    }
    setLoading(false);
  }, [currentOrg, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const compileWorkingPapers = useCallback(
    async (periodStart: string, periodEnd: string): Promise<boolean> => {
      if (!currentOrg) return false;
      setActionBusy('working-papers');
      setActionMessage(null);
      setError(null);

      const { data, error: fnErr } = await supabase.functions.invoke<WorkingPapersResult>(
        'working-papers',
        {
          body: {
            organization_id: currentOrg.id,
            period_start: periodStart,
            period_end: periodEnd,
          },
        },
      );

      setActionBusy(null);
      if (fnErr) {
        const parsed = await readFunctionError(fnErr);
        setError(parsed.message);
        return false;
      }

      const result = data ?? null;
      setWorkingPapers(result);
      if (!result?.ok) {
        setActionMessage(result?.error ?? 'Working-papers bundle returned incomplete checks.');
        return false;
      }

      setActionMessage('Working-papers bundle compiled.');
      return true;
    },
    [currentOrg],
  );

  const draftCorrespondence = useCallback(
    async (
      correspondenceId: string,
      requestedOutcome: string,
      periodStart?: string,
      periodEnd?: string,
    ): Promise<boolean> => {
      if (!currentOrg) return false;
      setActionBusy(`draft:${correspondenceId}`);
      setActionMessage(null);
      setError(null);

      const { data, error: fnErr } =
        await supabase.functions.invoke<AtoCorrespondenceDraftResponse>('ato-correspondence', {
          body: {
            action: 'draft',
            organization_id: currentOrg.id,
            correspondence_id: correspondenceId,
            requested_outcome: requestedOutcome,
            period_start: periodStart || undefined,
            period_end: periodEnd || undefined,
          },
        });

      setActionBusy(null);
      if (fnErr) {
        const parsed = await readFunctionError(fnErr);
        setError(parsed.message);
        return false;
      }
      if (!data?.ok) {
        setError(data?.error ?? 'Could not draft ATO correspondence.');
        return false;
      }

      setActionMessage('Draft response created for review.');
      await refresh();
      return true;
    },
    [currentOrg, refresh],
  );

  const requestSendApproval = useCallback(
    async (draftId: string): Promise<boolean> => {
      if (!currentOrg) return false;
      setActionBusy(`send:${draftId}`);
      setActionMessage(null);
      setError(null);

      const { data, error: fnErr } = await supabase.functions.invoke<AtoSendResponse>(
        'ato-correspondence',
        {
          body: {
            action: 'send',
            organization_id: currentOrg.id,
            draft_id: draftId,
          },
        },
      );

      setActionBusy(null);
      if (fnErr) {
        const parsed = await readFunctionError(fnErr);
        if (parsed.approvalId) {
          setActionMessage(`Tier-2 approval requested: ${parsed.approvalId}.`);
          await refresh();
          return true;
        }
        if (parsed.approved) {
          setActionMessage(
            'Draft is approved. ATO send/transport remains disabled until the lodgement gateway ships.',
          );
          return true;
        }
        setError(parsed.message);
        return false;
      }

      if (data?.approval_id) {
        setActionMessage(`Tier-2 approval requested: ${data.approval_id}.`);
        await refresh();
        return true;
      }

      setActionMessage(
        data?.error ??
          'Approval check completed. ATO send/transport remains disabled until the lodgement gateway ships.',
      );
      return data?.ok === true;
    },
    [currentOrg, refresh],
  );

  const downloadWorkingPapersPdf = useCallback((): boolean => {
    const pdfBase64 = workingPapers?.pdf_base64;
    const bundle = workingPapers?.bundle;
    if (!pdfBase64 || !bundle) {
      setError('Compile a working-papers bundle before downloading the index PDF.');
      return false;
    }
    downloadBlob(
      base64ToBlob(pdfBase64, 'application/pdf'),
      `working-papers-${bundle.period_start}-${bundle.period_end}.pdf`,
    );
    return true;
  }, [workingPapers]);

  return {
    correspondence,
    drafts,
    workingPapers,
    loading,
    error,
    actionBusy,
    actionMessage,
    refresh,
    compileWorkingPapers,
    draftCorrespondence,
    requestSendApproval,
    downloadWorkingPapersPdf,
  };
}
