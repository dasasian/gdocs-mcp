import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GoogleClients } from '../google/clients.js';
import { parseDriveId, listTabs, type TabRef } from './paths.js';

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

async function exportOneTab(clients: GoogleClients, documentId: string, tab: TabRef, format: ExportFormat): Promise<Buffer> {
  const { token } = await clients.auth.getAccessToken();
  const res = await fetch(`https://docs.google.com/document/d/${documentId}/export?format=${format}&tab=${tab.tabId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Exporting one tab uses an endpoint Google does not document, and it answered ${res.status}. Nothing was exported. To export the whole doc, every tab, pass the doc path "${tab.documentPath}".`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Drive's own export always renders every tab. With `tab` naming one tab of a
 * multi-tab doc, the export goes through the Docs UI's `export?tab=` endpoint
 * instead, which Google does not document and throttles; if it fails the call
 * throws rather than exporting the whole doc. A one-tab doc exports whole either way.
 */
export async function exportDoc(
  clients: GoogleClients,
  documentId: string,
  dir: string,
  opts: { format?: ExportFormat; filename?: string; tab?: TabRef } = {},
): Promise<ExportResult> {
  const fileId = parseDriveId(documentId);
  const format = opts.format ?? 'pdf';
  const mimeType = MIME[format];
  if (!mimeType) throw new Error(`Unsupported export format "${format}". Use one of: ${EXPORT_FORMATS.join(', ')}.`);

  const oneTab = opts.tab && (await listTabs(clients, fileId, opts.tab.documentPath)).length > 1 ? opts.tab : undefined;
  const [meta, bytes] = await Promise.all([
    clients.drive.files.get({ fileId, fields: 'name', supportsAllDrives: true }),
    oneTab
      ? exportOneTab(clients, fileId, oneTab, format)
      : clients.drive.files.export({ fileId, mimeType }, { responseType: 'arraybuffer' }).then((res) => Buffer.from(res.data as ArrayBuffer)),
  ]);
  const title = meta.data.name ?? 'document';

  mkdirSync(dir, { recursive: true });
  const filename = opts.filename ?? `${safeName(oneTab ? `${title} - ${oneTab.title}` : title)}.${format}`;
  const outPath = path.join(dir, filename);
  writeFileSync(outPath, bytes);

  return { path: outPath, format, mimeType, bytes: bytes.length, title };
}
