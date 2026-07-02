import type { GoogleClients } from '../google/clients.js';
import { parseDriveId } from '../docs/document.js';

// Drive navigation: list a folder's contents and search by name.

export type EntryType = 'folder' | 'document' | 'file';

export interface DriveEntry {
  id: string;
  name: string;
  type: EntryType;
  modifiedTime: string | null;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

function typeOf(mimeType: string | null | undefined): EntryType {
  if (mimeType === FOLDER_MIME) return 'folder';
  if (mimeType === DOC_MIME) return 'document';
  return 'file';
}

function toEntry(f: { id?: string | null; name?: string | null; mimeType?: string | null; modifiedTime?: string | null }): DriveEntry {
  return { id: f.id ?? '', name: f.name ?? '', type: typeOf(f.mimeType), modifiedTime: f.modifiedTime ?? null };
}

const LIST_FIELDS = 'files(id,name,mimeType,modifiedTime)';

// List the entries directly inside a folder (default: My Drive root).
export async function listFolder(clients: GoogleClients, folder?: string): Promise<DriveEntry[]> {
  const folderId = folder ? parseDriveId(folder) : 'root';
  const res = await clients.drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: LIST_FIELDS,
    pageSize: 200,
    orderBy: 'folder,name',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files ?? []).map(toEntry);
}

// Search Drive by name, optionally restricting to folders or docs.
export async function searchDrive(
  clients: GoogleClients,
  query: string,
  type: 'folder' | 'document' | 'any' = 'any',
): Promise<DriveEntry[]> {
  const escaped = query.replace(/'/g, "\\'");
  let q = `name contains '${escaped}' and trashed = false`;
  if (type === 'folder') q += ` and mimeType = '${FOLDER_MIME}'`;
  else if (type === 'document') q += ` and mimeType = '${DOC_MIME}'`;
  const res = await clients.drive.files.list({
    q,
    fields: LIST_FIELDS,
    pageSize: 50,
    orderBy: 'modifiedTime desc',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files ?? []).map(toEntry);
}
