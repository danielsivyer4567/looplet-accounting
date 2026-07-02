import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { getBillFileUrl } from '@/hooks/useBill';
import { SkeletonCard } from '@/components/Skeleton';

export interface PreviewableBill {
  id: string;
  storage_key?: string | null;
  mime_type?: string | null;
  original_filename?: string | null;
  supplier_name_raw?: string | null;
}

interface State {
  loading: boolean;
  imageUrl: string | null; // direct image (png/jpg) signed URL
  pdfPages: string[]; // PDF rendered to JPEG data URLs, one per page
  noDoc: boolean; // bank-imported / no real file
  error: string | null;
}

const INIT: State = { loading: true, imageUrl: null, pdfPages: [], noDoc: false, error: null };

interface PdfViewport {
  width: number;
  height: number;
}

interface PdfPage {
  getViewport: (args: { scale: number }) => PdfViewport;
  render: (args: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => {
    promise: Promise<void>;
  };
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
}

interface PdfjsModule {
  version: string;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (args: { data: Uint8Array }) => { promise: Promise<PdfDocument> };
}

let pdfjsCache: PdfjsModule | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsCache) return pdfjsCache;
  const pdfjs = (await import('pdfjs-dist')) as unknown as PdfjsModule;
  // Worker must match the installed pdfjs version; served from CDN (same
  // approach as BankStatementImport) and loaded only when previewing a PDF.
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  pdfjsCache = pdfjs;
  return pdfjs;
}

export function DocumentPreviewModal({
  bill,
  onClose,
}: {
  bill: PreviewableBill | null;
  onClose: () => void;
}) {
  const [s, setS] = useState<State>(INIT);

  useEffect(() => {
    if (!bill) return;
    let cancelled = false;
    setS(INIT);

    (async () => {
      // Bills imported from a bank statement have a placeholder storage_key and
      // no uploaded file — there's nothing to preview.
      if (!bill.storage_key || bill.storage_key === 'bank-import') {
        if (!cancelled) setS({ ...INIT, loading: false, noDoc: true });
        return;
      }

      const url = await getBillFileUrl(bill.storage_key);
      if (cancelled) return;
      if (!url) {
        setS({ ...INIT, loading: false, error: 'Could not load this document.' });
        return;
      }

      const isPdf =
        (bill.mime_type ?? '').toLowerCase().includes('pdf') ||
        (bill.original_filename ?? '').toLowerCase().endsWith('.pdf');

      if (!isPdf) {
        setS({ ...INIT, loading: false, imageUrl: url });
        return;
      }

      // PDF → render each page to a JPEG so it always displays (no reliance on
      // the browser's built-in PDF viewer).
      try {
        const pdfjs = await loadPdfjs();
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        const pages: string[] = [];
        for (let p = 1; p <= doc.numPages; p += 1) {
          if (cancelled) return;
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          pages.push(canvas.toDataURL('image/jpeg', 0.85));
        }
        if (!cancelled) setS({ ...INIT, loading: false, pdfPages: pages });
      } catch {
        if (!cancelled) setS({ ...INIT, loading: false, error: 'Could not render this PDF.' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bill]);

  return (
    <Modal
      open={!!bill}
      onClose={onClose}
      wide
      title={bill?.supplier_name_raw || bill?.original_filename || 'Document'}
    >
      {s.loading && (
        <div aria-busy="true" aria-label="Loading document preview">
          <SkeletonCard />
        </div>
      )}
      {s.noDoc && (
        <p style={{ color: '#888', lineHeight: 1.5 }}>
          No source document for this transaction — it was imported from a CommBank statement, not
          an uploaded file.
        </p>
      )}
      {s.error && <p style={{ color: 'salmon' }}>{s.error}</p>}
      {s.imageUrl && (
        <img
          src={s.imageUrl}
          alt="Bill document"
          style={{ maxWidth: '100%', borderRadius: 4, display: 'block' }}
        />
      )}
      {s.pdfPages.map((src, i) => (
        <img
          key={i}
          src={src}
          alt={`Page ${i + 1}`}
          style={{ maxWidth: '100%', borderRadius: 4, display: 'block', marginBottom: 8 }}
        />
      ))}
    </Modal>
  );
}
