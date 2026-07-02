import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GoogleClients } from '../google/clients.js';
import { inlineObjectsOf, resolveTabId } from '../docs/structure.js';

// The Docs API can only embed an image from a fetchable URL, not local bytes.
// So to insert a local image we upload it to Drive, make it link-readable, hand
// Docs the URL (Docs fetches + embeds its own copy), then delete the temp upload.

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export function mimeForImage(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

export interface UploadedImage {
  uri: string;
  cleanup: () => Promise<void>;
}

// Upload a local image to Drive and return a fetchable URL + a cleanup fn to
// delete the temp file (call cleanup after the image has been embedded).
export async function uploadImageForInsert(clients: GoogleClients, absPath: string): Promise<UploadedImage> {
  const up = await clients.drive.files.create({
    requestBody: { name: path.basename(absPath) },
    media: { mimeType: mimeForImage(absPath), body: createReadStream(absPath) },
    fields: 'id',
    supportsAllDrives: true,
  });
  const fileId = up.data.id!;
  await clients.drive.permissions.create({ fileId, requestBody: { type: 'anyone', role: 'reader' } });
  return {
    uri: `https://drive.google.com/uc?export=view&id=${fileId}`,
    cleanup: async () => {
      await clients.drive.files.delete({ fileId }).catch(() => {});
    },
  };
}

function extFromBytes(buf: Buffer): string {
  const hex = buf.subarray(0, 4).toString('hex');
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (hex.startsWith('47494638')) return 'gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF') return 'webp';
  return 'png';
}

export interface DownloadedImage {
  objectId: string;
  filename: string;
  path: string;
  bytes: number;
}

// Download every embedded image in a doc to `destDir`. Uses the image's ephemeral
// contentUri (valid for the moment; fetched with the user's token). Returns the
// objectId->file mapping so the caller can rewrite read_doc's image markers.
export async function downloadImages(
  clients: GoogleClients,
  documentId: string,
  destDir: string,
  tab?: string,
): Promise<DownloadedImage[]> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tabId = resolveTabId(doc, tab);
  const objects = inlineObjectsOf(doc, tabId);
  const token = (await clients.auth.getAccessToken()).token;
  mkdirSync(destDir, { recursive: true });

  const out: DownloadedImage[] = [];
  let n = 0;
  for (const [objectId, obj] of Object.entries(objects)) {
    const contentUri = obj.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
    if (!contentUri) continue;
    const res = await fetch(contentUri, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    n += 1;
    const filename = `image-${n}.${extFromBytes(buf)}`;
    const filePath = path.join(destDir, filename);
    writeFileSync(filePath, buf);
    out.push({ objectId, filename, path: filePath, bytes: buf.length });
  }
  return out;
}
