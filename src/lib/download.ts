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
