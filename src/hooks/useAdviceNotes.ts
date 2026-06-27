import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type AdviceNoteKind =
  | 'structuring'
  | 'year_end'
  | 'cgt'
  | 'fbt'
  | 'profit_extraction'
  | 'forecast';

export type AdviceNoteStatus = 'draft' | 'issued' | 'acted' | 'dismissed';

export interface AdviceNote {
  id: string;
  organization_id: string;
  kind: AdviceNoteKind;
  title: string;
  summary: string;
  inputs: Record<string, unknown>;
  numbers: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  citations: unknown[];
  disclaimer: string;
  registered_agent_signoff_by: string | null;
  registered_agent_signoff_at: string | null;
  status: AdviceNoteStatus;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

export interface CreateAdviceNoteInput {
  kind: AdviceNoteKind;
  title: string;
  summary: string;
  inputs?: Record<string, unknown>;
  numbers?: Record<string, unknown>;
  assumptions?: Record<string, unknown>;
  citations?: unknown[];
  disclaimer?: string | null;
}

export interface AdviceNoteMutationResult {
  ok: boolean;
  advice_note_id: string;
  organization_id: string;
  kind?: AdviceNoteKind;
  status: AdviceNoteStatus;
}

export interface UseAdviceNotesOptions {
  kind?: AdviceNoteKind | null;
  status?: AdviceNoteStatus | null;
}

/**
 * RLS-scoped read/action hook for Phase 6 advisory artifacts. The SQL RPCs own
 * shape defaults and status transitions; the hook keeps UI code on that narrow
 * surface instead of writing advice_notes directly.
 */
export function useAdviceNotes(options: UseAdviceNotesOptions = {}) {
  const { currentOrg } = useOrg();
  const kind = options.kind ?? null;
  const status = options.status ?? null;
  const [notes, setNotes] = useState<AdviceNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setNotes([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('list_advice_notes', {
      p_org: currentOrg.id,
      p_kind: kind,
      p_status: status,
    });

    if (rpcErr) {
      setNotes([]);
      setError(rpcErr.message);
    } else {
      setNotes((data ?? []) as AdviceNote[]);
    }
    setLoading(false);
  }, [currentOrg, kind, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createNote = useCallback(
    async (input: CreateAdviceNoteInput): Promise<AdviceNoteMutationResult> => {
      if (!currentOrg) throw new Error('Select an organization first.');
      setActionBusy(true);
      setError(null);
      try {
        const { data, error: rpcErr } = await supabase.rpc('create_advice_note', {
          p_org: currentOrg.id,
          p_kind: input.kind,
          p_title: input.title,
          p_summary: input.summary,
          p_inputs: input.inputs ?? {},
          p_numbers: input.numbers ?? {},
          p_assumptions: input.assumptions ?? {},
          p_citations: input.citations ?? [],
          p_disclaimer: input.disclaimer ?? null,
        });
        if (rpcErr) throw new Error(rpcErr.message);
        await refresh();
        return data as AdviceNoteMutationResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create advice note.';
        setError(message);
        throw err;
      } finally {
        setActionBusy(false);
      }
    },
    [currentOrg, refresh],
  );

  const signOff = useCallback(
    async (id: string): Promise<AdviceNoteMutationResult> => {
      setActionBusy(true);
      setError(null);
      try {
        const { data, error: rpcErr } = await supabase.rpc('sign_off_advice_note', { p_id: id });
        if (rpcErr) throw new Error(rpcErr.message);
        await refresh();
        return data as AdviceNoteMutationResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to sign off advice note.';
        setError(message);
        throw err;
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  const dismiss = useCallback(
    async (id: string): Promise<AdviceNoteMutationResult> => {
      setActionBusy(true);
      setError(null);
      try {
        const { data, error: rpcErr } = await supabase.rpc('dismiss_advice_note', { p_id: id });
        if (rpcErr) throw new Error(rpcErr.message);
        await refresh();
        return data as AdviceNoteMutationResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to dismiss advice note.';
        setError(message);
        throw err;
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  return {
    notes,
    loading,
    actionBusy,
    error,
    refresh,
    createNote,
    signOff,
    dismiss,
  };
}
