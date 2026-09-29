import type { GoogleClients } from '../google/clients.js';
import { TAB_TREE_FIELDS } from '../docs/structure.js';
import type { docs_v1, drive_v3 } from 'googleapis';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const MAX_FOLDER_DEPTH = 32;

export const SHARED_ROOT = '/shared';
export const SHARED_WITH_ME = '/shared-with-me';
export const LOST_FOUND = '/lost+found';

/** Where a path is rooted, and the id to start walking the parent graph from. */
export type Root =
  | { kind: 'my-drive'; id: string }
  | { kind: 'shared-drive'; id: string; name: string }
  | { kind: 'shared-with-me' }
  | { kind: 'lost+found' };

export interface TabRef {
  documentId: string;
  documentTitle: string;
  documentPath: string;
  tabId: string;
  title: string;
  index: number;
  parentTabId: string | null;
  childCount: number;
  path: string;
}

/** For a tab, `id` is the id of the doc that holds it and `tab` says which one. */
export interface Resolved {
  id: string;
  name: string;
  isFolder: boolean;
  isDoc: boolean;
  path: string;
  tab?: TabRef;
}

export interface PathCandidate {
  id: string;
  name: string;
  isFolder: boolean;
  path?: string;
}

/**
 * `missing` is set only when every step but the last resolved: the parent to
 * create the last step under. `notAnId` is set when the input was not a path and
 * Drive has no file with its first step as an id.
 */
export type Resolution =
  | { ok: true; entry: Resolved }
  | { ok: false; status: 'not_found'; message: string; missing?: { parent: Resolved; name: string }; notAnId?: true }
  | { ok: false; status: 'ambiguous'; message: string; candidates: PathCandidate[] };

/** A path starts with / or ~; anything else is a Drive id or URL, which is what every other tool returns. */
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

const rootIdCache = new Map<GoogleClients, string>();

export async function myDriveRootId(clients: GoogleClients): Promise<string> {
  const hit = rootIdCache.get(clients);
  if (hit) return hit;
  const res = await clients.drive.files.get({ fileId: 'root', fields: 'id' });
  const id = res.data.id ?? 'root';
  rootIdCache.set(clients, id);
  return id;
}

/** Peel the rooting prefix off a path and say where the remaining segments start. */
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

interface PoolEntry {
  id: string;
  name: string;
  isFolder: boolean;
  isDoc: boolean;
  parents: string[];
}

async function candidatesFor(clients: GoogleClients, names: string[], driveId?: string): Promise<PoolEntry[]> {
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
    isDoc: f.mimeType === DOC_MIME,
    parents: f.parents ?? [],
  }));
}

function tabsOf(doc: docs_v1.Schema$Document, documentId: string, docPath: string): TabRef[] {
  const out: TabRef[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined | null, parentId: string | null, parentPath: string): void => {
    for (const t of tabs ?? []) {
      const p = t.tabProperties;
      if (!p?.tabId) continue;
      const path = `${parentPath}/${p.title ?? ''}`;
      out.push({
        documentId,
        documentTitle: doc.title ?? '',
        documentPath: docPath,
        tabId: p.tabId,
        title: p.title ?? '',
        index: p.index ?? 0,
        parentTabId: parentId,
        childCount: t.childTabs?.length ?? 0,
        path,
      });
      walk(t.childTabs, p.tabId, path);
    }
  };
  walk(doc.tabs, null, docPath);
  return out;
}

/** Every tab of a doc, depth-first, each with the full path a caller can pass back. */
export async function listTabs(clients: GoogleClients, documentId: string, docPath: string): Promise<TabRef[]> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true, fields: `title,${TAB_TREE_FIELDS}` });
  return tabsOf(res.data, documentId, docPath);
}

function tabEntry(tab: TabRef): Resolved {
  return { id: tab.documentId, name: tab.title, isFolder: false, isDoc: false, path: tab.path, tab };
}

async function descendIntoDoc(clients: GoogleClients, doc: Resolved, steps: string[]): Promise<Resolution> {
  if (!steps.length) return { ok: true, entry: doc };
  const tabs = await listTabs(clients, doc.id, doc.path);
  let current: Resolved = doc;
  let parentTabId: string | null = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const last = i === steps.length - 1;
    const level = tabs.filter((t) => t.parentTabId === parentTabId);
    let here = level.filter((t) => fold(t.title) === fold(step) || t.tabId === step);
    if (!here.length) here = tabs.filter((t) => t.tabId === step);
    if (!here.length) {
      return {
        ok: false,
        status: 'not_found',
        message: `No tab named "${step}" in ${current.path}.`,
        ...(last ? { missing: { parent: current, name: step } } : {}),
      };
    }
    if (here.length > 1) {
      return {
        ok: false,
        status: 'ambiguous',
        message: `"${step}" matches ${here.length} tabs in ${current.path}. Address the one you mean by its tabId.`,
        candidates: here.map((t) => ({ id: t.tabId, name: t.title, isFolder: false, path: t.path })),
      };
    }
    current = tabEntry(here[0]);
    parentTabId = here[0].tabId;
  }
  return { ok: true, entry: current };
}

/** A Drive id from a folder or doc URL, or the raw id. */
export function parseDriveId(input: string): string {
  const m = /\/(?:folders|d)\/([a-zA-Z0-9_-]+)/.exec(input);
  if (m) return m[1];
  return input.trim().replace(/[?#].*$/, '');
}

function splitIdAndSteps(input: string): { id: string; steps: string[] } {
  const trimmed = input.trim();
  const folderUrl = /^https?:\/\/[^/]+\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)((?:\/[^?#]*)?)/.exec(trimmed);
  if (folderUrl) return { id: folderUrl[1], steps: splitPath(decodeURIComponent(folderUrl[2])) };
  if (/^https?:\/\//.test(trimmed)) {
    const tab = /[?&]tab=([^&#]+)/.exec(trimmed)?.[1];
    return { id: parseDriveId(trimmed), steps: tab ? [decodeURIComponent(tab)] : [] };
  }
  const [id, ...steps] = splitPath(trimmed);
  return { id: parseDriveId(id ?? ''), steps };
}

async function walkFolders(clients: GoogleClients, start: Resolved, segments: string[], driveId?: string): Promise<Resolution> {
  if (!segments.length) return { ok: true, entry: start };
  const pool = await candidatesFor(clients, segments, driveId);
  const prefix = start.path === '/' ? '' : start.path;

  let current = start;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    const walked = `${prefix}/${segments.slice(0, i + 1).join('/')}`;
    const here = pool.filter(
      (c) => fold(c.name) === fold(segment) && c.parents.includes(current.id) && (last || c.isFolder || c.isDoc),
    );
    if (!here.length) {
      return {
        ok: false,
        status: 'not_found',
        message: `No ${last ? 'entry' : 'folder'} named "${segment}" in ${current.path} (resolving ${walked}).`,
        ...(last ? { missing: { parent: current, name: segment } } : {}),
      };
    }
    if (here.length > 1) {
      return {
        ok: false,
        status: 'ambiguous',
        message: `"${segment}" matches ${here.length} entries in the same folder (resolving ${walked}). Drive allows duplicate names and folds case, so this path is not unique — address the one you mean by id.`,
        candidates: here.map((c) => ({ id: c.id, name: c.name, isFolder: c.isFolder })),
      };
    }
    current = { id: here[0].id, name: here[0].name, isFolder: here[0].isFolder, isDoc: here[0].isDoc, path: walked };
    if (current.isDoc && !last) return descendIntoDoc(clients, current, segments.slice(i + 1));
  }
  return { ok: true, entry: current };
}

/**
 * The one path walker. Folders are walked against Drive; the first step that is
 * a Google Doc switches the walk to that doc's tabs, and a nested tab is one more
 * step. Refuses rather than guessing when a step matches more than one thing.
 */
export async function resolvePath(clients: GoogleClients, path: string): Promise<Resolution> {
  const rooted = await resolveRoot(clients, path);
  if ('error' in rooted) return { ok: false, status: 'not_found', message: rooted.error };
  const { root, segments } = rooted;

  if (root.kind === 'lost+found' || root.kind === 'shared-with-me') {
    const where = root.kind === 'lost+found' ? LOST_FOUND : SHARED_WITH_ME;
    if (segments.length) {
      return { ok: false, status: 'not_found', message: `${where} is a flat collection, not a tree — list it with \`ls ${where}\` and address an entry by id.` };
    }
    return { ok: false, status: 'not_found', message: `${where} is a collection, not a folder; it cannot be a target.` };
  }

  const start: Resolved = {
    id: root.id,
    name: root.kind === 'shared-drive' ? root.name : 'My Drive',
    isFolder: true,
    isDoc: false,
    path: root.kind === 'shared-drive' ? `${SHARED_ROOT}/${root.name}` : '/',
  };
  return walkFolders(clients, start, segments, root.kind === 'shared-drive' ? root.id : undefined);
}

/** A path, or a Drive id or URL optionally followed by more steps (`<folderId>/Doc/Ch.4`, `<docId>/Ch.4`, or a URL with `?tab=`); the id decides whether the walk starts in a folder or in a doc's tabs. */
export async function resolveEntry(clients: GoogleClients, input: string): Promise<Resolution> {
  if (looksLikePath(input)) return resolvePath(clients, input);
  const { id, steps } = splitIdAndSteps(input);
  let meta: { name?: string | null; mimeType?: string | null };
  try {
    meta = (await clients.drive.files.get({ fileId: id, fields: 'id,name,mimeType', supportsAllDrives: true })).data;
  } catch {
    return { ok: false, status: 'not_found', notAnId: true, message: `No Drive file with id "${id}". A path must start with / or ~; anything else is read as an id.` };
  }
  const entry: Resolved = {
    id,
    name: meta.name ?? '',
    isFolder: meta.mimeType === FOLDER_MIME,
    isDoc: meta.mimeType === DOC_MIME,
    path: id,
  };
  if (!steps.length) return { ok: true, entry };
  if (entry.isFolder) return walkFolders(clients, entry, steps);
  if (!entry.isDoc) return { ok: false, status: 'not_found', message: `"${entry.name}" is neither a folder nor a Google Doc, so there is nothing to walk into.` };
  return descendIntoDoc(clients, entry, steps);
}

export function refusal(resolution: Exclude<Resolution, { ok: true }>): Error {
  if (resolution.status !== 'ambiguous') return new Error(resolution.message);
  const listed = resolution.candidates.map((c) => `  ${c.id}  ${c.path ?? c.name}`).join('\n');
  return new Error(`${resolution.message}\n${listed}`);
}

/**
 * The tab a doc tool acts on, from an entry already resolved. A doc with one tab
 * means that tab; a doc with several and no tab step is refused, listing every
 * tab's full path.
 */
export async function tabOfEntry(clients: GoogleClients, entry: Resolved, input: string): Promise<TabRef> {
  if (entry.tab) return entry.tab;
  if (!entry.isDoc) throw new Error(`"${input}" is ${entry.isFolder ? 'a folder' : 'not a Google Doc'}. Name a doc or one of its tabs.`);
  const tabs = await listTabs(clients, entry.id, entry.path);
  if (tabs.length === 1) return tabs[0];
  if (!tabs.length) throw new Error(`"${entry.name}" has no tabs.`);
  throw new Error(`"${entry.name}" has ${tabs.length} tabs; name one:\n${tabs.map((t) => `  ${t.path}`).join('\n')}`);
}

export async function resolveTab(clients: GoogleClients, input: string): Promise<TabRef> {
  const resolution = await resolveEntry(clients, input);
  if (!resolution.ok) throw refusal(resolution);
  return tabOfEntry(clients, resolution.entry, input);
}

/** The doc a file-level tool (comments, sharing, export) acts on; a tab path names its doc, and `tab` says which tab was named. */
export async function resolveDocument(clients: GoogleClients, input: string): Promise<{ documentId: string; title: string; tab?: TabRef }> {
  const resolution = await resolveEntry(clients, input);
  if (!resolution.ok) throw refusal(resolution);
  const { entry } = resolution;
  if (entry.tab) return { documentId: entry.tab.documentId, title: entry.tab.documentTitle, tab: entry.tab };
  if (!entry.isDoc) throw new Error(`"${input}" is ${entry.isFolder ? 'a folder' : 'not a Google Doc'}. Name a doc.`);
  return { documentId: entry.id, title: entry.name };
}

/** The path that reaches a folder given by id or URL, or undefined when no path does (an orphan, or a folder only shared with you). */
export async function folderPathOf(clients: GoogleClients, folder: string): Promise<string | undefined> {
  const rootId = await myDriveRootId(clients);
  const names: string[] = [];
  let id = parseDriveId(folder);
  for (let hop = 0; hop < MAX_FOLDER_DEPTH; hop++) {
    if (id === rootId) return `/${names.reverse().join('/')}`;
    let meta: drive_v3.Schema$File;
    try {
      meta = (await clients.drive.files.get({ fileId: id, fields: 'name,mimeType,parents,driveId', supportsAllDrives: true })).data;
    } catch {
      return undefined;
    }
    if (hop === 0 && meta.mimeType !== FOLDER_MIME) return undefined;
    names.push(meta.name ?? '');
    const parent = meta.parents?.[0];
    if (parent) {
      id = parent;
    } else if (meta.driveId === id) {
      const driveName = names.pop() ?? '';
      return `${SHARED_ROOT}/${driveName}${names.length ? `/${names.reverse().join('/')}` : ''}`;
    } else {
      return undefined;
    }
  }
  return undefined;
}
