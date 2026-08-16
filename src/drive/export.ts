import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GoogleClients } from '../google/clients.js';
import { parseDriveId } from '../docs/document.js';

// Export a Doc to a real file format (#22). Google renders it server-side via
// Drive files.export — pagination, page setup and layout are applied by the same
// engine the editor uses, so there is no client-side rendering to get wrong.

export type ExportFormat = 'pdf' | 'docx' | 'odt' | 'rtf' | 'txt' | 'html' | 'epub' | 'md';

const MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
  html: 'text/html',
  epub: 'application/epub+zip',
  md: 'text/markdown',
};

export const EXPORT_FORMATS = Object.keys(MIME) as ExportFormat[];

// Keep the doc's own title as the filename, minus what a filesystem can't take.
function safeName(name: string): string {
  return (name.replace(/[/\\:*?"<>|\n\r]+/g, '-').trim() || 'document').slice(0, 120);
}

export interface ExportResult {
  path: string;
  format: ExportFormat;
  mimeType: string;
  bytes: number;
  title: string;
}

export async function exportDoc(
  clients: GoogleClients,
  documentId: string,
  dir: string,
  opts: { format?: ExportFormat; filename?: string } = {},
): Promise<ExportResult> {
  const fileId = parseDriveId(documentId);
  const format = opts.format ?? 'pdf';
  const mimeType = MIME[format];
  if (!mimeType) throw new Error(`Unsupported export format "${format}". Use one of: ${EXPORT_FORMATS.join(', ')}.`);

  const meta = await clients.drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
  const title = meta.data.name ?? 'document';

  // arraybuffer, not the default JSON parse — the response is raw bytes.
  const res = await clients.drive.files.export({ fileId, mimeType }, { responseType: 'arraybuffer' });
  const buf = Buffer.from(res.data as ArrayBuffer);

  mkdirSync(dir, { recursive: true });
  const filename = opts.filename ?? `${safeName(title)}.${format}`;
  const outPath = path.join(dir, filename);
  writeFileSync(outPath, buf);

  return { path: outPath, format, mimeType, bytes: buf.length, title };
}
