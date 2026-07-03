import { useCallback, useState } from 'react';
import { base64ToBlob, downloadBlob } from '@/lib/download';
import { supabase } from '@/lib/supabase';
import type { LodgementRow } from '@/hooks/useLodgements';

interface BasLodgementPackResponse {
  ok?: boolean;
  pdf_base64?: string;
  filename?: string;
  error?: string;
}

function fallbackFilename(lodgement: LodgementRow): string {
  const safePeriod =
    lodgement.period_label
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'period';
  return `bas-lodgement-pack-${safePeriod}-${lodgement.id.slice(0, 8)}.pdf`;
}

export function useBasLodgementPack() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadPack = useCallback(async (lodgement: LodgementRow): Promise<boolean> => {
    if (lodgement.lodgement_type !== 'bas') {
      setError('Only BAS lodgements have a generated review pack right now.');
      return false;
    }

    setBusyId(lodgement.id);
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<BasLodgementPackResponse>(
        'bas-lodgement-pack',
        {
          body: { lodgement_id: lodgement.id },
        },
      );

      if (fnErr) throw new Error(fnErr.message);
      if (!data?.pdf_base64) {
        throw new Error(data?.error ?? 'BAS lodgement pack did not return a PDF.');
      }

      downloadBlob(
        base64ToBlob(data.pdf_base64, 'application/pdf'),
        data.filename ?? fallbackFilename(lodgement),
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return false;
    } finally {
      setBusyId(null);
    }
  }, []);

  return { busyId, error, downloadPack };
}
