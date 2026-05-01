import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/heic',
  'image/webp',
]);

export interface UploadResult {
  bill_id: string;
  routing?: {
    outcome: 'auto_attached' | 'suggested' | 'queued';
    matched_job_number?: string;
    match_score?: number;
  };
  method?: 'cache' | 'text' | 'vision';
  error?: string;
}

export interface UploadStage {
  step: 'idle' | 'validating' | 'uploading' | 'creating_row' | 'extracting' | 'done' | 'error';
  message: string;
  progress: number; // 0-100
  result?: UploadResult;
}

export function useBillUpload() {
  const { currentOrg } = useOrg();
  const [stage, setStage] = useState<UploadStage>({
    step: 'idle',
    message: '',
    progress: 0,
  });

  const reset = () => setStage({ step: 'idle', message: '', progress: 0 });

  async function upload(file: File): Promise<UploadResult> {
    if (!currentOrg) {
      const err = 'No organisation selected';
      setStage({ step: 'error', message: err, progress: 0 });
      return { bill_id: '', error: err };
    }

    // Validate
    setStage({ step: 'validating', message: 'Checking file…', progress: 5 });
    if (file.size > MAX_BYTES) {
      const err = `File too large (max ${MAX_BYTES / 1024 / 1024} MB)`;
      setStage({ step: 'error', message: err, progress: 0 });
      return { bill_id: '', error: err };
    }
    if (!ALLOWED_MIME.has(file.type)) {
      const err = `Unsupported file type: ${file.type}. Use PDF, PNG, JPG, HEIC, or WEBP.`;
      setStage({ step: 'error', message: err, progress: 0 });
      return { bill_id: '', error: err };
    }

    // Build storage path: org-{uuid}/{YYYY-MM-DD}/{rand}-{filename}
    const today = new Date().toISOString().slice(0, 10);
    const rand = crypto.randomUUID().slice(0, 8);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const storagePath = `org-${currentOrg.id}/${today}/${rand}-${safeName}`;

    // Upload to storage
    setStage({ step: 'uploading', message: `Uploading ${file.name}…`, progress: 15 });
    const { error: uploadErr } = await supabase.storage
      .from('bills')
      .upload(storagePath, file, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: false,
      });
    if (uploadErr) {
      const err = `Upload failed: ${uploadErr.message}`;
      setStage({ step: 'error', message: err, progress: 0 });
      return { bill_id: '', error: err };
    }

    // Create bill row
    setStage({ step: 'creating_row', message: 'Recording bill…', progress: 40 });
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: bill, error: insertErr } = await supabase
      .from('bills')
      .insert({
        organization_id: currentOrg.id,
        source: 'manual_upload',
        status: 'received',
        storage_key: storagePath,
        original_filename: file.name,
        mime_type: file.type,
        file_size_bytes: file.size,
        currency_code: 'AUD',
        created_by: user?.id ?? null,
      })
      .select('id')
      .single();
    if (insertErr || !bill) {
      const err = `DB insert failed: ${insertErr?.message ?? 'unknown'}`;
      setStage({ step: 'error', message: err, progress: 0 });
      return { bill_id: '', error: err };
    }

    // Invoke bills-extract
    setStage({
      step: 'extracting',
      message: 'Extracting fields (this can take a few seconds)…',
      progress: 60,
    });
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      const err = 'Not signed in';
      setStage({ step: 'error', message: err, progress: 0 });
      return { bill_id: bill.id as string, error: err };
    }

    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bills-extract`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ bill_id: bill.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        const errMsg = body.error ?? `Extract failed (${res.status})`;
        // The bill row exists, just extraction failed — let user navigate to detail and retry
        setStage({
          step: 'error',
          message: errMsg,
          progress: 0,
          result: { bill_id: bill.id as string, error: errMsg },
        });
        return { bill_id: bill.id as string, error: errMsg };
      }

      const result: UploadResult = {
        bill_id: bill.id as string,
        method: body.method,
        routing: body.routing,
      };
      setStage({ step: 'done', message: 'Done', progress: 100, result });
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setStage({
        step: 'error',
        message: errMsg,
        progress: 0,
        result: { bill_id: bill.id as string, error: errMsg },
      });
      return { bill_id: bill.id as string, error: errMsg };
    }
  }

  return { stage, upload, reset };
}
