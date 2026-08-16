import type { GoogleClients } from '../google/clients.js';
import { parseDriveId } from '../docs/document.js';

// Drive navigation: list a folder's contents and search by name.

export type EntryType = 'folder' | 'document' | 'file';

export interface DriveEntry {
  id: string;
  name: string;
  type: EntryType;
  modifiedTime: string | null;
  /** the folders this entry sits in (#26) — id plus resolved name, so a result can be traced upward. */
  parents?: { id: string; name: string }[];
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

function typeOf(mimeType: string | null | undefined): EntryType {
  if (mimeType === FOLDER_MIME) return 'folder';
  if (mimeType === DOC_MIME) return 'document';
  return 'file';
}

interface RawFile {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  modifiedTime?: string | null;
  parents?: string[] | null;
}

function toEntry(f: RawFile): DriveEntry {
  return { id: f.id ?? '', name: f.name ?? '', type: typeOf(f.mimeType), modifiedTime: f.modifiedTime ?? null };
}

const LIST_FIELDS = 'files(id,name,mimeType,modifiedTime,parents)';

// A parent id alone can't be acted on, so resolve the distinct parents of a
// result set to names in one pass (#26). Bounded, and failures degrade to the
// bare id rather than failing the listing.
const MAX_PARENT_LOOKUPS = 25;

async function withParents(clients: GoogleClients, files: RawFile[]): Promise<DriveEntry[]> {
  const ids = [...new Set(files.flatMap((f) => f.parents ?? []))].slice(0, MAX_PARENT_LOOKUPS);
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const r = await clients.drive.files.get({ fileId: id, fields: 'name', supportsAllDrives: true });
        names.set(id, r.data.name ?? '');
      } catch {
        names.set(id, '');
      }
    }),
  );
  return files.map((f) => {
    const entry = toEntry(f);
    const parents = f.parents ?? [];
    if (parents.length) entry.parents = parents.map((id) => ({ id, name: names.get(id) ?? '' }));
    return entry;
  });
}

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
  return withParents(clients, res.data.files ?? []);
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
  return withParents(clients, res.data.files ?? []);
}

// Create a Drive folder (#25). A distinct create-verb rather than an op on
// list_folder: it makes a new file, and its params (name + parent) don't
// overlap the listing tools' vocabulary.
export async function createFolder(
  clients: GoogleClients,
  name: string,
  folder?: string,
): Promise<{ id: string; name: string; parents: string[] }> {
  const parentId = folder ? parseDriveId(folder) : undefined;
  const res = await clients.drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id,name,parents',
    supportsAllDrives: true,
  });
  return { id: res.data.id ?? '', name: res.data.name ?? name, parents: res.data.parents ?? [] };
}
