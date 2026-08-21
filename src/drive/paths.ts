import type { GoogleClients } from '../google/clients.js';

// Resolving a Drive path (#44).
//
// The filesystem vocabulary is borrowed because the model already knows it. The
// borrowing is honest only where Drive actually behaves like a filesystem, and
// there are three places it does not:
//
//   1. Two files may share a name in one parent. No filesystem the model learned
//      from allows this, so it will not defensively check — it will assume the
//      path resolved. A wrong prior is worse than none, so a collision refuses
//      and lists the candidates rather than guessing.
//   2. Matching folds case. Linux is case-sensitive and macOS is not, so
//      whichever the model recalls is wrong here; `Reports` and `reports` in one
//      folder are two files that both answer either query. Collision detection
//      therefore folds case too.
//   3. Drive names may contain `/`. A file called "Q1/Q2" cannot be addressed by
//      path at all — see docs/limitations.md. Ids always work.
//
// Paths also see less than `find` does: a file with no parent is reachable by
// search and by id, but by no path (#46). That is a property to state, not a bug
// — `/lost+found` is the one place those surface.

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const SHARED_ROOT = '/shared';
export const SHARED_WITH_ME = '/shared-with-me';
export const LOST_FOUND = '/lost+found';

/** Where a path is rooted, and the id to start walking the parent graph from. */
export type Root =
  | { kind: 'my-drive'; id: string }
  | { kind: 'shared-drive'; id: string; name: string }
  | { kind: 'shared-with-me' }
  | { kind: 'lost+found' };

export interface Resolved {
  id: string;
  name: string;
  isFolder: boolean;
}

export type Resolution =
  | { ok: true; entry: Resolved }
  | { ok: false; status: 'not_found'; message: string }
  | { ok: false; status: 'ambiguous'; message: string; candidates: { id: string; name: string; isFolder: boolean }[] };

// A path is anything that starts with / or ~; everything else is treated as a
// Drive id or URL, because that is what every other tool in this server returns
// and callers paste them back.
export function looksLikePath(s: string): boolean {
  return s.startsWith('/') || s === '~' || s.startsWith('~/');
}

export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function quote(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function fold(s: string): string {
  return s.toLowerCase();
}

// `files.get('root')` is one call per account and the answer never changes.
const rootIdCache = new Map<GoogleClients, string>();

export async function myDriveRootId(clients: GoogleClients): Promise<string> {
  const hit = rootIdCache.get(clients);
  if (hit) return hit;
  const res = await clients.drive.files.get({ fileId: 'root', fields: 'id' });
  const id = res.data.id ?? 'root';
  rootIdCache.set(clients, id);
  return id;
}

// Peel the rooting prefix off a path and say where the remaining segments start.
export async function resolveRoot(
  clients: GoogleClients,
  path: string,
): Promise<{ root: Root; segments: string[] } | { error: string }> {
  const normalized = path.startsWith('~') ? `/${path.slice(1)}` : path;
  const segments = splitPath(normalized);

  if (segments.length && `/${segments[0]}` === LOST_FOUND) {
    return { root: { kind: 'lost+found' }, segments: segments.slice(1) };
  }
  if (segments.length && `/${segments[0]}` === SHARED_WITH_ME) {
    return { root: { kind: 'shared-with-me' }, segments: segments.slice(1) };
  }
  if (segments.length && `/${segments[0]}` === SHARED_ROOT) {
    const driveName = segments[1];
    if (driveName === undefined) return { error: `"${SHARED_ROOT}" is not a folder — it holds the shared drives. Name one: ${SHARED_ROOT}/<drive name>/…` };
    const res = await clients.drive.drives.list({ pageSize: 100, fields: 'drives(id,name)' });
    const drives = res.data.drives ?? [];
    const matches = drives.filter((d) => fold(d.name ?? '') === fold(driveName));
    if (!matches.length) {
      const names = drives.map((d) => d.name ?? '').filter(Boolean);
      return { error: `No shared drive named "${driveName}". Available: ${names.length ? names.join(', ') : '(none)'}` };
    }
    if (matches.length > 1) return { error: `More than one shared drive is named "${driveName}"; address its contents by id instead.` };
    return { root: { kind: 'shared-drive', id: matches[0].id ?? '', name: matches[0].name ?? driveName }, segments: segments.slice(2) };
  }

  return { root: { kind: 'my-drive', id: await myDriveRootId(clients) }, segments };
}

interface Candidate {
  id: string;
  name: string;
  isFolder: boolean;
  parents: string[];
}

// Ask for every segment name in ONE query, then walk the parent graph locally.
// The naive walk is a round trip per segment; this is a round trip per path, and
// in the common case fewer than today, since finding a doc by name already costs
// a search before the operation.
async function candidatesFor(clients: GoogleClients, names: string[], driveId?: string): Promise<Candidate[]> {
  const distinct = [...new Set(names.map(fold))];
  const clause = distinct.map((n) => `name = '${quote(n)}'`).join(' or ');
  const res = await clients.drive.files.list({
    q: `(${clause}) and trashed = false`,
    fields: 'files(id,name,mimeType,parents)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(driveId ? { driveId, corpora: 'drive' } : {}),
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? '',
    name: f.name ?? '',
    isFolder: f.mimeType === FOLDER_MIME,
    parents: f.parents ?? [],
  }));
}

/**
 * Resolve a path to a single Drive entry. Refuses rather than guessing when a
 * segment matches more than one thing. Bare ids/URLs are handled by the caller
 * (see resolveTarget in shell.ts) — this is the path half only.
 */
export async function resolvePath(clients: GoogleClients, path: string): Promise<Resolution> {
  const rooted = await resolveRoot(clients, path);
  if ('error' in rooted) return { ok: false, status: 'not_found', message: rooted.error };
  const { root, segments } = rooted;

  if (root.kind === 'lost+found' || root.kind === 'shared-with-me') {
    if (segments.length) {
      const where = root.kind === 'lost+found' ? LOST_FOUND : SHARED_WITH_ME;
      return { ok: false, status: 'not_found', message: `${where} is a flat collection, not a tree — list it with \`ls ${where}\` and address an entry by id.` };
    }
    return { ok: false, status: 'not_found', message: `${root.kind === 'lost+found' ? LOST_FOUND : SHARED_WITH_ME} is a collection, not a folder; it cannot be a target.` };
  }

  const startId = root.id;
  const startName = root.kind === 'shared-drive' ? root.name : 'My Drive';
  if (!segments.length) return { ok: true, entry: { id: startId, name: startName, isFolder: true } };

  const driveId = root.kind === 'shared-drive' ? root.id : undefined;
  const pool = await candidatesFor(clients, segments, driveId);

  let current: Resolved = { id: startId, name: startName, isFolder: true };
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    const here = pool.filter(
      (c) => fold(c.name) === fold(segment) && c.parents.includes(current.id) && (last || c.isFolder),
    );
    const walked = segments.slice(0, i + 1).join('/');
    if (!here.length) {
      return { ok: false, status: 'not_found', message: `No ${last ? 'entry' : 'folder'} named "${segment}" in /${segments.slice(0, i).join('/')} (resolving /${walked}).` };
    }
    if (here.length > 1) {
      return {
        ok: false,
        status: 'ambiguous',
        message: `"${segment}" matches ${here.length} entries in the same folder (resolving /${walked}). Drive allows duplicate names and folds case, so this path is not unique — address the one you mean by id.`,
        candidates: here.map((c) => ({ id: c.id, name: c.name, isFolder: c.isFolder })),
      };
    }
    current = { id: here[0].id, name: here[0].name, isFolder: here[0].isFolder };
  }
  return { ok: true, entry: current };
}
