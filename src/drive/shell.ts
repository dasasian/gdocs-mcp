import type { GoogleClients } from '../google/clients.js';
import { updateTab } from '../docs/document.js';
import {
  listFolder,
  listOrphans,
  listSharedWithMe,
  listSharedDrives,
  withTabCounts,
  searchDrive,
  createFolder,
  type DriveEntry,
} from './files.js';
import {
  resolvePath,
  resolveEntry,
  listTabs,
  resolveRoot,
  looksLikePath,
  splitPath,
  LOST_FOUND,
  SHARED_ROOT,
  SHARED_WITH_ME,
  type Resolved,
  type TabRef,
} from './paths.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
}

function parseArgs(
  args: string[],
  opts: { valueFlags?: string[]; unknownDashIsOperand?: boolean } = {},
): ParsedArgs {
  const valueFlags = new Set(opts.valueFlags ?? []);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (valueFlags.has(a)) {
      values.set(a, args[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (opts.unknownDashIsOperand) positional.push(a);
      else flags.add(a);
      continue;
    }
    positional.push(a);
  }
  return { flags, values, positional };
}

export type ShellCommand = 'ls' | 'find' | 'mkdir' | 'cp' | 'mv';

export interface ShellOptions {
  expectName?: string;
  acceptOwnershipTransfer?: boolean;
  index?: number;
}

export type ShellResult = Record<string, unknown>;

function fail(message: string, extra: Record<string, unknown> = {}): ShellResult {
  return { status: 'error', message, ...extra };
}

async function resolveTarget(clients: GoogleClients, target: string): Promise<{ entry: Resolved } | { error: ShellResult }> {
  const r = await resolveEntry(clients, target);
  if (r.ok) return { entry: r.entry };
  return { error: fail(r.message, r.status === 'ambiguous' ? { status: 'ambiguous', candidates: r.candidates } : { status: 'not_found' }) };
}

function dirname(path: string): string {
  const segs = splitPath(path);
  const prefix = path.startsWith('~') ? '~' : '';
  return segs.length <= 1 ? `${prefix}/` : `${prefix}/${segs.slice(0, -1).join('/')}`;
}

function basename(path: string): string {
  const segs = splitPath(path);
  return segs[segs.length - 1] ?? '';
}

async function ls(clients: GoogleClients, args: string[]): Promise<ShellResult> {
  const path = parseArgs(args).positional[0] ?? '/';
  const segs = splitPath(path.startsWith('~') ? path.slice(1) : path);
  const head = segs.length ? `/${segs[0]}` : '/';

  if (head === LOST_FOUND && segs.length === 1) {
    const { orphaned, scanned, complete, message } = await listOrphans(clients);
    return { path: LOST_FOUND, entries: orphaned, scanned, complete, message };
  }
  if (head === SHARED_WITH_ME && segs.length === 1) return { path: SHARED_WITH_ME, entries: await listSharedWithMe(clients) };
  if (head === SHARED_ROOT && segs.length === 1) return { path: SHARED_ROOT, entries: await listSharedDrives(clients) };

  const target = await resolveTarget(clients, path);
  if ('error' in target) return target.error;
  const { entry } = target;
  if (entry.isDoc || entry.tab) {
    const tabs = await listTabs(clients, entry.id, entry.tab?.documentPath ?? entry.path);
    const parentTabId = entry.tab?.tabId ?? null;
    const entries = tabs
      .filter((t) => t.parentTabId === parentTabId)
      .map((t) => ({ type: 'tab', tabId: t.tabId, name: t.title, index: t.index, path: t.path, childTabs: t.childCount }));
    return { path, id: entry.id, entries };
  }
  if (!entry.isFolder) {
    return fail(`"${entry.name}" is a file, not a folder. Read a doc with read_doc.`, { status: 'not_a_folder', id: entry.id });
  }
  return { path, id: entry.id, entries: await withTabCounts(clients, await listFolder(clients, entry.id)) };
}

async function find(clients: GoogleClients, args: string[]): Promise<ShellResult> {
  const { values, positional } = parseArgs(args, { valueFlags: ['-type', '-name'], unknownDashIsOperand: true });
  let type: 'folder' | 'document' | 'any' = 'any';
  const t = values.get('-type');
  if (t !== undefined) {
    if (t === 'd') type = 'folder';
    else if (t === 'f') type = 'document';
    else return fail(`find -type takes d (folders) or f (documents), not "${t}".`);
  }
  const named = values.get('-name');
  const query = [...(named ? [named] : []), ...positional].join(' ').trim();
  if (!query) return fail('find needs something to look for: find "quarterly report" [-type d|f]');
  return { query, type, entries: await searchDrive(clients, query, type) };
}

async function mkdir(clients: GoogleClients, args: string[]): Promise<ShellResult> {
  const parsed = parseArgs(args);
  const parents = parsed.flags.has('-p');
  const path = parsed.positional[0];
  if (!path) return fail('mkdir needs a path: mkdir [-p] /Work/2026/Reports');
  if (!looksLikePath(path)) return fail(`mkdir takes a path, not an id ("${path}"). A path starts with / or ~.`);

  const rooted = await resolveRoot(clients, path);
  if ('error' in rooted) return fail(rooted.error);
  const segs = rooted.segments;
  if (!segs.length) return fail('mkdir needs a folder name, not just a root.');

  const prefix = path.startsWith('~') ? '~' : '';
  const rootPrefix = path.replace(/^~/, '').startsWith(SHARED_ROOT) ? `${SHARED_ROOT}/${splitPath(path)[1]}` : '';
  let parentId: string | undefined;
  let existingDepth = 0;
  for (let i = segs.length; i >= 0; i--) {
    const candidate = `${prefix}${rootPrefix}/${segs.slice(0, i).join('/')}`;
    const r = await resolvePath(clients, candidate);
    if (r.ok && r.entry.isFolder) {
      parentId = r.entry.id;
      existingDepth = i;
      break;
    }
    if (!r.ok && r.status === 'ambiguous') return fail(r.message, { status: 'ambiguous', candidates: r.candidates });
  }
  if (parentId === undefined) return fail(`Could not resolve any part of "${path}".`);
  if (existingDepth === segs.length) return { status: 'exists', path, id: parentId, message: `"${path}" already exists.` };

  const missing = segs.slice(existingDepth);
  if (missing.length > 1 && !parents) {
    return fail(`"/${segs.slice(0, existingDepth + 1).join('/')}" does not exist. Pass -p to create intermediate folders.`);
  }

  const created: { id: string; name: string }[] = [];
  for (const name of missing) {
    const f = await createFolder(clients, name, parentId);
    created.push({ id: f.id, name: f.name });
    parentId = f.id;
  }
  return { status: 'ok', path, id: parentId, created };
}

async function resolveDestination(
  clients: GoogleClients,
  dst: string,
): Promise<{ parentId: string; name?: string } | { error: ShellResult }> {
  const direct = looksLikePath(dst) ? await resolvePath(clients, dst) : null;
  if (direct?.ok && direct.entry.isFolder) return { parentId: direct.entry.id };
  if (direct && !direct.ok && direct.status === 'ambiguous') {
    return { error: fail(direct.message, { status: 'ambiguous', candidates: direct.candidates }) };
  }
  if (direct?.ok && !direct.entry.isFolder) {
    return { error: fail(`"${dst}" already exists and is a file. Refusing to overwrite it.`, { status: 'exists', id: direct.entry.id }) };
  }
  if (!looksLikePath(dst)) {
    const target = await resolveTarget(clients, dst);
    if ('error' in target) return { error: target.error };
    if (!target.entry.isFolder) return { error: fail(`Destination id "${dst}" is a file, not a folder.`) };
    return { parentId: target.entry.id };
  }
  const parent = await resolvePath(clients, dirname(dst));
  if (!parent.ok) {
    return { error: fail(`Destination folder "${dirname(dst)}" does not exist.`, { status: 'not_found' }) };
  }
  if (!parent.entry.isFolder) return { error: fail(`"${dirname(dst)}" is a file, not a folder.`) };
  return { parentId: parent.entry.id, name: basename(dst) };
}

async function collidingEntry(
  clients: GoogleClients,
  parentId: string,
  name: string,
  exceptId?: string,
): Promise<{ id: string; name: string } | undefined> {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await clients.drive.files.list({
    q: `'${parentId}' in parents and name = '${escaped}' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const hit = (res.data.files ?? []).find((f) => f.id !== exceptId);
  return hit ? { id: hit.id ?? '', name: hit.name ?? '' } : undefined;
}

async function cp(clients: GoogleClients, args: string[]): Promise<ShellResult> {
  const { flags, positional } = parseArgs(args);
  const recursive = flags.has('-r') || flags.has('-R');
  const [src, dst] = positional;
  if (!src || !dst) return fail('cp needs a source and a destination: cp /Work/Contract /Archive');

  const source = await resolveTarget(clients, src);
  if ('error' in source) return source.error;

  if (source.entry.tab) {
    return fail(
      'Drive cannot copy a tab — files.copy copies whole docs. Read the tab and write_doc it to the new path.',
      { status: 'unsupported', id: source.entry.id },
    );
  }

  if (source.entry.isFolder) {
    return fail(
      `Drive cannot copy a folder${recursive ? ', and -r does not change that' : ''} — files.copy refuses. Copy the files individually, or duplicate the folder in the Drive UI.`,
      { status: 'unsupported', id: source.entry.id },
    );
  }

  const destination = await resolveDestination(clients, dst);
  if ('error' in destination) return destination.error;

  const name = destination.name ?? source.entry.name;
  const clash = await collidingEntry(clients, destination.parentId, name);
  if (clash) {
    return fail(
      `"${dst}" already contains "${clash.name}". Drive would keep both under one name, which no filesystem does and which makes the path ambiguous afterwards. Copy to a different name instead.`,
      { status: 'exists', id: clash.id },
    );
  }

  const res = await clients.drive.files.copy({
    fileId: source.entry.id,
    requestBody: { name, parents: [destination.parentId] },
    fields: 'id,name,parents,mimeType',
    supportsAllDrives: true,
  });
  return {
    status: 'ok',
    id: res.data.id ?? '',
    name: res.data.name ?? '',
    parents: res.data.parents ?? [],
    ...(res.data.mimeType === 'application/vnd.google-apps.document'
      ? { url: `https://docs.google.com/document/d/${res.data.id}/edit` }
      : {}),
  };
}

function isSelfOrDescendant(tabs: TabRef[], tabId: string, candidateId: string | null): boolean {
  for (let id = candidateId; id; id = tabs.find((t) => t.tabId === id)?.parentTabId ?? null) {
    if (id === tabId) return true;
  }
  return false;
}

async function mvTab(clients: GoogleClients, tab: TabRef, dst: string, index: number | undefined): Promise<ShellResult> {
  const destination = await resolveEntry(clients, dst);
  let parent: Resolved;
  let title = tab.title;
  if (destination.ok) {
    parent = destination.entry;
  } else if (destination.status === 'not_found' && destination.missing) {
    parent = destination.missing.parent;
    title = destination.missing.name;
  } else {
    return fail(destination.message, destination.status === 'ambiguous' ? { status: 'ambiguous', candidates: destination.candidates } : { status: 'not_found' });
  }
  if (parent.isFolder || parent.id !== tab.documentId) {
    return fail(
      `A tab cannot leave its doc: "${dst}" is not in "${tab.documentTitle}". Read the tab and write_doc it into the other doc.`,
      { status: 'unsupported', id: tab.documentId },
    );
  }
  const tabs = await listTabs(clients, tab.documentId, tab.documentPath);
  const stayingPut = destination.ok && destination.entry.tab?.tabId === tab.tabId;
  const parentTabId = stayingPut ? tab.parentTabId : (parent.tab?.tabId ?? null);
  if (!stayingPut && isSelfOrDescendant(tabs, tab.tabId, parentTabId)) {
    return fail(`A tab cannot be moved under itself or its own descendant: "${dst}".`, { status: 'unsupported', tabId: tab.tabId });
  }

  const clash = tabs.find((t) => t.parentTabId === parentTabId && t.tabId !== tab.tabId && t.title.toLowerCase() === title.toLowerCase());
  if (clash) {
    return fail(
      `"${parent.path}" already has a tab named "${clash.title}". Two tabs with one name make the path ambiguous afterwards; move to a different name instead.`,
      { status: 'exists', id: clash.tabId },
    );
  }

  const change = {
    ...(title !== tab.title ? { title } : {}),
    ...(parentTabId !== tab.parentTabId ? { parentTabId: parentTabId ?? '' } : {}),
    ...(index !== undefined ? { index } : {}),
  };
  if (!Object.keys(change).length) {
    return { status: 'ok', tabId: tab.tabId, name: tab.title, unchanged: true, message: 'Nothing to change: the tab is already there. Pass index to reorder it.' };
  }
  try {
    await updateTab(clients, tab.documentId, tab.tabId, change);
  } catch (e) {
    return fail(`The Docs API refused the move: ${e instanceof Error ? e.message : String(e)}`, { status: 'error', tabId: tab.tabId });
  }
  const after = (await listTabs(clients, tab.documentId, tab.documentPath)).find((t) => t.tabId === tab.tabId);
  return {
    status: 'ok',
    tabId: tab.tabId,
    name: after?.title ?? title,
    path: after?.path,
    index: after?.index,
    ...(title !== tab.title ? { renamedFrom: tab.title } : {}),
  };
}

async function mv(clients: GoogleClients, args: string[], opts: ShellOptions): Promise<ShellResult> {
  const { positional } = parseArgs(args);
  const [src, dst] = positional;
  if (!src || !dst) return fail('mv needs a source and a destination: mv /Work/Roof /Archive');

  const source = await resolveTarget(clients, src);
  if ('error' in source) return source.error;

  if (opts.expectName !== undefined && opts.expectName !== source.entry.name) {
    return fail(
      `expectName "${opts.expectName}" != the resolved name "${source.entry.name}". Refusing to move something other than what was intended.`,
      { status: 'mismatch', id: source.entry.id, name: source.entry.name },
    );
  }

  if (source.entry.tab) return mvTab(clients, source.entry.tab, dst, opts.index);

  const destination = await resolveDestination(clients, dst);
  if ('error' in destination) return destination.error;

  const srcRoot = looksLikePath(src) ? await resolveRoot(clients, src) : { root: { kind: 'my-drive' as const, id: '' }, segments: [] };
  const dstRoot = looksLikePath(dst) ? await resolveRoot(clients, dst) : { root: { kind: 'my-drive' as const, id: '' }, segments: [] };
  const intoShared = !('error' in dstRoot) && dstRoot.root.kind === 'shared-drive';
  const fromShared = !('error' in srcRoot) && srcRoot.root.kind === 'shared-drive';
  if (intoShared && !fromShared && !opts.acceptOwnershipTransfer) {
    const name = !('error' in dstRoot) && dstRoot.root.kind === 'shared-drive' ? dstRoot.root.name : '';
    return fail(
      `Moving into the shared drive "${name}" transfers ownership of "${source.entry.name}" to the organization that owns it, and you cannot move it back out. This is not what mv does on a filesystem. Pass acceptOwnershipTransfer: true if that is intended.`,
      { status: 'ownership_transfer', id: source.entry.id },
    );
  }

  const finalName = destination.name ?? source.entry.name;
  const clash = await collidingEntry(clients, destination.parentId, finalName, source.entry.id);
  if (clash) {
    return fail(
      `"${dst}" already contains "${clash.name}". Drive would keep both under one name, which no filesystem does and which makes the path ambiguous afterwards. Move to a different name instead.`,
      { status: 'exists', id: clash.id },
    );
  }

  const meta = await clients.drive.files.get({ fileId: source.entry.id, fields: 'parents', supportsAllDrives: true });
  const res = await clients.drive.files.update({
    fileId: source.entry.id,
    ...(destination.name ? { requestBody: { name: destination.name } } : {}),
    addParents: destination.parentId,
    removeParents: (meta.data.parents ?? []).join(','),
    fields: 'id,name,parents',
    supportsAllDrives: true,
  });
  return {
    status: 'ok',
    id: res.data.id ?? source.entry.id,
    name: res.data.name ?? source.entry.name,
    parents: res.data.parents ?? [],
    ...(destination.name && destination.name !== source.entry.name ? { renamedFrom: source.entry.name } : {}),
    ...(intoShared ? { ownershipTransferred: true } : {}),
  };
}

export async function driveShell(
  clients: GoogleClients,
  cmd: ShellCommand,
  args: string[] = [],
  opts: ShellOptions = {},
): Promise<ShellResult> {
  switch (cmd) {
    case 'ls':
      return await ls(clients, args);
    case 'find':
      return await find(clients, args);
    case 'mkdir':
      return await mkdir(clients, args);
    case 'cp':
      return await cp(clients, args);
    case 'mv':
      return await mv(clients, args, opts);
    default:
      return fail(`Unknown command "${cmd as string}". Available: ls, find, mkdir, cp, mv.`);
  }
}

export type { DriveEntry };
