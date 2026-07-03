/**
 * Minimal CSV export helper.
 * Derives columns from rows[0] keys. Cells containing commas, double-quotes,
 * or newlines are wrapped in double-quotes with internal quotes escaped as "".
 * Triggers a browser download via a temporary <a download> element.
 */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  const first = rows[0];
  if (!first) return;

  const columns = Object.keys(first);

  function escapeCell(value: unknown): string {
    const str = value == null ? '' : String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const header = columns.map(escapeCell).join(',');
  const body = rows.map((row) => columns.map((col) => escapeCell(row[col])).join(',')).join('\n');
  const csv = `${header}\n${body}`;

  // Prepend a UTF-8 BOM so Excel on Windows decodes the file as UTF-8 rather than the
  // locale ANSI codepage — without it, accented names and em dashes become mojibake.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
