import { useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useBillUpload, type UploadResult } from '@/hooks/useBillUpload';
import { GmailConnect } from '@/components/settings/GmailConnect';
import { PageHeader } from '@/components/ui/PageHeader';

export function BillUploadPage() {
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const { stage, upload, reset } = useBillUpload();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!currentOrg) {
    return (
      <section>
        <h1>Upload bill</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation first.</p>
      </section>
    );
  }

  const handleFile = async (file: File) => {
    const result = await upload(file);
    if (!result.error && result.bill_id) {
      // Brief pause so the user sees the routing outcome before nav
      setTimeout(() => navigate(`/bills/${result.bill_id}`), 1200);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const busy = stage.step !== 'idle' && stage.step !== 'error' && stage.step !== 'done';

  return (
    <section>
      <Link to="/bills" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        ← back to bills
      </Link>
      <PageHeader title="Upload bill" style={{ marginTop: '0.5rem' }} />
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: '1.5rem' }}>
        PDF, PNG, JPG, HEIC, or WEBP. Max 25 MB. Born-digital PDFs extract in ~100ms with no OCR
        cost; photos and scans run vision OCR.
      </p>

      {stage.step === 'idle' || stage.step === 'error' ? (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent-success)' : 'var(--border-subtle)'}`,
              borderRadius: 8,
              padding: '4rem 2rem',
              textAlign: 'center',
              background: dragOver ? 'var(--bg-success-subtle)' : 'var(--bg-card)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: '0.5rem' }}>
              {dragOver ? 'Drop to upload' : 'Drop a bill here'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>or click to browse</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/heic,image/webp"
            onChange={onPick}
            style={{ display: 'none' }}
          />
          {stage.step === 'error' && (
            <div
              style={{
                marginTop: '1rem',
                padding: '0.75rem',
                background: 'var(--bg-danger-subtle)',
                color: 'var(--text-danger)',
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              {stage.message}
              {stage.result?.bill_id && (
                <>
                  {' · '}
                  <Link
                    to={`/bills/${stage.result.bill_id}`}
                    style={{ color: 'var(--text-danger)' }}
                  >
                    open the partial bill
                  </Link>
                </>
              )}
              <br />
              <button
                onClick={reset}
                style={{
                  marginTop: '0.5rem',
                  background: 'transparent',
                  color: 'var(--text-danger)',
                  border: '1px solid var(--accent-danger)',
                  borderRadius: 4,
                  padding: '0.25rem 0.75rem',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Try again
              </button>
            </div>
          )}
        </>
      ) : (
        <ProgressBox stage={stage} busy={busy} />
      )}

      <div
        style={{
          marginTop: '2rem',
          padding: '1.25rem',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          background: 'var(--bg-card)',
        }}
      >
        <GmailConnect
          title="Google document intake"
          description="Connect Gmail to pull supplier invoices, receipts, and bill attachments from Google. Looplet stores each PDF or image as a bill, then runs extraction automatically."
          connectLabel="+ Connect Google mailbox"
          reconnectLabel="Reconnect Google mailbox"
          showContainerSpacing={false}
        />
      </div>
    </section>
  );
}

function ProgressBox({
  stage,
  busy,
}: {
  stage: { step: string; message: string; progress: number; result?: UploadResult };
  busy: boolean;
}) {
  const isDone = stage.step === 'done';
  const r = stage.result;
  return (
    <div
      style={{
        padding: '2rem',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: '1rem' }}>
        {busy ? 'Working…' : stage.message}
      </div>
      <div
        style={{
          height: 6,
          background: 'var(--bg-panel)',
          borderRadius: 3,
          overflow: 'hidden',
          marginBottom: '1rem',
        }}
      >
        <div
          style={{
            width: `${stage.progress}%`,
            height: '100%',
            background: isDone ? 'var(--accent-success)' : 'var(--accent-info)',
            transition: 'width 0.3s',
          }}
        />
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{stage.message}</div>

      {isDone && r && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            background: 'var(--bg-success-subtle)',
            border: '1px solid var(--accent-success)',
            borderRadius: 4,
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--text-success)', fontWeight: 600 }}>
            {r.routing?.outcome === 'auto_attached'
              ? `Auto-attached to ${r.routing.matched_job_number}`
              : r.routing?.outcome === 'suggested'
                ? `Suggested ${r.routing.matched_job_number} (${Math.round((r.routing.match_score ?? 0) * 100)}%)`
                : 'Extracted — needs allocation'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-success)', marginTop: '0.25rem' }}>
            Extraction method: <strong>{r.method ?? '—'}</strong>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            Opening bill…
          </div>
        </div>
      )}
    </div>
  );
}
