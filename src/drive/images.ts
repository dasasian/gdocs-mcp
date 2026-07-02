import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { GoogleClients } from '../google/clients.js';

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
