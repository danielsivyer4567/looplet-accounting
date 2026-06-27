// Trigger a browser download of an in-memory Blob (e.g. a generated PDF/CSV) under a
// given filename, cleaning up the object URL afterwards. Presentation-only.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Decode a base64 string (e.g. a `pdf_base64` field from an edge function) into a Blob of
// the given MIME type, ready for downloadBlob. (EOFY.tsx has a local copy predating this;
// it can migrate here later — see the deferred download-lib consolidation.)
export function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
