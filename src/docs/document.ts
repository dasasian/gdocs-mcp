import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, findTab, flattenTabs, tableInsertedAt, writeControlFor, TAB_METADATA_FIELDS, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { parseSuggestions } from './suggestions.js';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { markdownToRequests } from './write.js';
import { findProjectConfig } from '../auth/accounts.js';
import { uploadImageForInsert, resolveImageSource } from '../drive/images.js';
import { resolveIndex, fillCellRequests, columnAlignRequests } from './objects.js';

// Insert a markdown image at `index`. Remote URLs embed directly; a local path is
// resolved against baseDir, uploaded, embedded, and the temp upload deleted.
// Returns a warning string if it couldn't be resolved (never throws mid-render).
async function insertImagePlacement(
  clients: GoogleClients,
  documentId: string,
  index: number,
  src: string,
  baseDir: string | undefined,
  tabId?: string,
  segmentId?: string,
  size?: { width?: number; height?: number },
): Promise<{ objectId?: string; warning?: string }> {
  // Docs preserves aspect ratio, so it may adjust whichever dimension it must.
  const objectSize =
    size?.width || size?.height
      ? {
          width: size.width ? { magnitude: size.width, unit: 'PT' } : undefined,
          height: size.height ? { magnitude: size.height, unit: 'PT' } : undefined,
        }
      : undefined;
  const embed = async (uri: string): Promise<string | undefined> => {
    const r = await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertInlineImage: { location: { index, tabId, segmentId }, uri, objectSize } }] },
    });
    const reply = r.data.replies?.[0] as { insertInlineImage?: { objectId?: string } } | undefined;
    return reply?.insertInlineImage?.objectId ?? undefined;
  };

  const source = resolveImageSource(src, baseDir);
  if ('error' in source) return { warning: `${source.error}; skipped` };
  if (source.kind === 'url') return { objectId: await embed(source.uri) };

  const { uri, cleanup } = await uploadImageForInsert(clients, source.path);
  try {
    return { objectId: await embed(uri) };
  } finally {
    await cleanup();
  }
}

// Insert a table at `index` and fill its cells (descending so inserts don't shift
// later cells). Cell text is plain in this narrow first cut.

async function insertTableAt(
  clients: GoogleClients,
  documentId: string,
  index: number,
  rows: string[][],
  aligns: ('left' | 'center' | 'right' | null)[],
  tabId?: string,
  segmentId?: string,
): Promise<void> {
  const R = rows.length;
  const C = Math.max(...rows.map((r) => r.length));
  if (R === 0 || C === 0) return;
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertTable: { location: { index, tabId, segmentId }, rows: R, columns: C } }] },
  });
  const after = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tableEl = tableInsertedAt(after, index, tabId, segmentId);
  if (!tableEl?.table?.tableRows) return;

  const requests = fillCellRequests(tableEl, rows, { tabId, segmentId });
  if (requests.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests } });

  // Column alignment needs the post-fill indices, so re-fetch first.
  if (aligns.some((a) => a && a !== 'left')) {
    const aligned = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
    const alignReqs = columnAlignRequests(tableInsertedAt(aligned, index, tabId, segmentId), aligns, { tabId, segmentId });
    if (alignReqs.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: alignReqs } });
  }
}

// Render markdown into a doc/tab: insert the text (with table placeholders), then
// insert each table at its placeholder position (descending so indices stay valid).
async function renderMarkdownInto(
  clients: GoogleClients,
  documentId: string,
  markdown: string,
  opts: { tabId?: string; segmentId?: string; preRequests?: docs_v1.Schema$Request[]; requiredRevisionId?: string; baseDir?: string; startIndex?: number } = {},
): Promise<{ warnings: string[]; images: { src: string; objectId: string }[] }> {
  const { requests, tables, images } = markdownToRequests(markdown, opts.startIndex ?? 1, opts.tabId, opts.segmentId);
  const all = [...(opts.preRequests ?? []), ...requests];
  if (all.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: all, writeControl: writeControlFor(opts.requiredRevisionId) },
    });
  }
  // Structural inserts (tables + images) descending by index so earlier indices stay valid.
  const warnings: string[] = [];
  const imageMap: { src: string; objectId: string }[] = [];
  const placements: { index: number; run: () => Promise<void> }[] = [
    ...tables.map((t) => ({ index: t.index, run: () => insertTableAt(clients, documentId, t.index, t.rows, t.aligns, opts.tabId, opts.segmentId) })),
    ...images.map((im) => ({
      index: im.index,
      run: async () => {
        const res = await insertImagePlacement(clients, documentId, im.index, im.src, opts.baseDir, opts.tabId, opts.segmentId, { width: im.width, height: im.height });
        if (res.warning) warnings.push(res.warning);
        if (res.objectId) imageMap.push({ src: im.src, objectId: res.objectId });
      },
    })),
  ].sort((a, b) => b.index - a.index);
  for (const p of placements) await p.run();
  return { warnings, images: imageMap };
}

// Insert new markdown-rendered content at a STRUCTURAL position (#20), rather
// than by replacing anchor text the way edit_doc does. This is the only path to
// "add a paragraph after the table that ends the doc": a table's last cell can't
// anchor an insert outside the table (the Docs API forbids ranges crossing a cell
// boundary), and Docs' mandatory trailing empty paragraph has no text to match on.
// `at`: 'end' (default) · 'top' · a unique text anchor to insert right after.
export async function insertContent(
  clients: GoogleClients,
  documentId: string,
  content: string,
  opts: { at?: string; tab?: string; baseDir?: string; segment?: SegmentKind; page?: SegmentPage; createSegment?: boolean } = {},
): Promise<{
  status: 'ok' | 'not_found' | 'ambiguous' | 'no_segment';
  message?: string;
  matches?: { context: string }[];
  index?: number;
  characters?: number;
  warnings?: string[];
  images?: { src: string; objectId: string }[];
  createdSegment?: string;
}> {
  const first = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(first.data, opts.tab);
  // Same position vocabulary inside a header/footer — e.g. a letterhead address
  // line under the logo (#23).
  const seg = await resolveSegmentTarget(clients, documentId, first.data, {
    segment: opts.segment,
    page: opts.page,
    create: opts.createSegment,
    tabId,
  });
  if (seg.error) return { status: 'no_segment', message: seg.error };
  const resolved = resolveIndex(seg.doc, tabId, opts.at ?? 'end', seg.segmentId);
  if ('error' in resolved) {
    const { status, message, matches } = resolved.error;
    return { status: status as 'not_found' | 'ambiguous', message, matches };
  }
  const { warnings, images } = await renderMarkdownInto(clients, documentId, content, {
    tabId,
    segmentId: seg.segmentId,
    baseDir: opts.baseDir,
    startIndex: resolved.index,
  });
  return {
    status: 'ok',
    index: resolved.index,
    ...(seg.created ? { createdSegment: `${opts.segment}` } : {}),
    characters: content.length,
    ...(warnings.length ? { warnings } : {}),
    ...(images.length ? { images } : {}),
  };
}

// Extract a Drive file/folder id from a URL (…/folders/ID, …/d/ID) or a raw id.
export function parseDriveId(input: string): string {
  const m = /\/(?:folders|d)\/([a-zA-Z0-9_-]+)/.exec(input);
  if (m) return m[1];
  return input.trim().replace(/[?#].*$/, '');
}

// Resolve the document body from either an inline `content` string or a
// `contentFile` path read server-side. contentFile lets the caller pass a long
// document through mechanically instead of retyping it inline — a step that can
// silently drop/fuse text (#14). Exactly one of the two may be given. When
// contentFile is used and baseDir is unset, baseDir defaults to the file's own
// folder, so relative image paths inside that markdown still resolve.
export async function resolveContentSource(args: {
  content?: string;
  contentFile?: string;
  baseDir?: string;
}): Promise<{ content: string | undefined; baseDir: string | undefined }> {
  if (args.contentFile === undefined) return { content: args.content, baseDir: args.baseDir };
  if (args.content !== undefined) throw new Error('Provide content or contentFile, not both.');
  const abs = nodePath.isAbsolute(args.contentFile)
    ? args.contentFile
    : nodePath.resolve(args.baseDir ?? process.cwd(), args.contentFile);
  const content = await readFile(abs, 'utf8');
  return { content, baseDir: args.baseDir ?? nodePath.dirname(abs) };
}

export async function createDoc(
  clients: GoogleClients,
  title: string,
  content?: string,
  opts: { folder?: string; baseDir?: string } = {},
): Promise<{ documentId: string; title: string; folderId?: string; warnings?: string[]; images?: { src: string; objectId: string }[] }> {
  let documentId: string;
  let folderId: string | undefined;

  // Explicit folder arg wins; else fall back to the project's default folder.
  const folder = opts.folder ?? findProjectConfig().folder;

  if (folder) {
    // Create the doc directly in the folder via the Drive API.
    folderId = parseDriveId(folder);
    const created = await clients.drive.files.create({
      requestBody: { name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] },
      fields: 'id',
      supportsAllDrives: true,
    });
    documentId = created.data.id!;
  } else {
    const created = await clients.docs.documents.create({ requestBody: { title } });
    documentId = created.data.documentId!;
  }

  let warnings: string[] = [];
  let images: { src: string; objectId: string }[] = [];
  if (content) ({ warnings, images } = await renderMarkdownInto(clients, documentId, content, { baseDir: opts.baseDir }));
  return {
    documentId,
    title,
    ...(folderId ? { folderId } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(images.length ? { images } : {}),
  };
}

// Duplicate a doc via Drive files.copy (#24) — the "Make a copy" verb. Kept
// separate from update_doc even though it shares name/folder params: it creates
// a file rather than mutating one, so it belongs with the create verbs.
// Copying preserves everything create_doc can't reconstruct from markdown —
// headers/footers, image sizing, exact formatting.
export async function copyDoc(
  clients: GoogleClients,
  documentId: string,
  opts: { name?: string; folder?: string } = {},
): Promise<{ documentId: string; name: string; folderId?: string; parents: string[]; url: string }> {
  const folderId = opts.folder ? parseDriveId(opts.folder) : undefined;
  const res = await clients.drive.files.copy({
    fileId: documentId,
    requestBody: {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(folderId ? { parents: [folderId] } : {}),
    },
    fields: 'id,name,parents',
    supportsAllDrives: true,
  });
  const id = res.data.id ?? '';
  return {
    documentId: id,
    name: res.data.name ?? '',
    ...(folderId ? { folderId } : {}),
    parents: res.data.parents ?? [],
    url: `https://docs.google.com/document/d/${id}/edit`,
  };
}

// Move an existing doc into a folder (by folder URL or id).
export async function moveDoc(
  clients: GoogleClients,
  documentId: string,
  folder: string,
  opts: { expectTitle?: string; name?: string } = {},
): Promise<{ status: 'ok' | 'mismatch'; documentId: string; folderId?: string; parents?: string[]; name?: string; renamedTo?: string; message?: string }> {
  const folderId = parseDriveId(folder);
  const meta = await clients.drive.files.get({ fileId: documentId, fields: 'parents,name', supportsAllDrives: true });
  const name = meta.data.name ?? '';
  if (opts.expectTitle !== undefined && opts.expectTitle !== name) {
    return { status: 'mismatch', documentId, name, message: `expectTitle "${opts.expectTitle}" != live doc title "${name}". Refusing to move a different doc than intended.` };
  }
  // A rename requested alongside the move rides on this same call — Drive's
  // files.update sets the name and reparents in one request.
  const res = await clients.drive.files.update({
    fileId: documentId,
    ...(opts.name !== undefined ? { requestBody: { name: opts.name } } : {}),
    addParents: folderId,
    removeParents: (meta.data.parents ?? []).join(','),
    fields: 'id,parents,name',
    supportsAllDrives: true,
  });
  return { status: 'ok', documentId, folderId, parents: res.data.parents ?? [], name, renamedTo: opts.name === undefined ? undefined : res.data.name ?? opts.name };
}

// Rename = change the Drive file name (which is the doc title).
export async function renameDoc(
  clients: GoogleClients,
  documentId: string,
  name: string,
): Promise<{ documentId: string; name: string }> {
  const res = await clients.drive.files.update({
    fileId: documentId,
    requestBody: { name },
    fields: 'id,name',
  });
  return { documentId, name: res.data.name ?? name };
}

// The `update_doc` tool: rename and/or move. Both together is a single Drive
// write; a move whose expectTitle doesn't match refuses the rename too, so a
// wrong documentId can never be half-applied.
export async function updateDoc(
  clients: GoogleClients,
  documentId: string,
  opts: { name?: string; folder?: string; expectTitle?: string },
): Promise<Record<string, unknown>> {
  const { name, folder, expectTitle } = opts;
  if (name === undefined && folder === undefined) throw new Error('Provide name and/or folder to update.');
  if (folder === undefined) return { rename: await renameDoc(clients, documentId, name as string) };

  const moved = await moveDoc(clients, documentId, folder, { expectTitle, name });
  const result: Record<string, unknown> = { move: moved };
  if (moved.status === 'ok' && name !== undefined) {
    result.rename = { documentId, name: moved.renamedTo ?? name };
  }
  return result;
}

// Wholesale replace of a doc body (or one tab) with rendered markdown — GUARDED.
// Refuses if comments/suggestions are present (a full replace would orphan/wipe
// them) unless force=true.
export async function overwriteDoc(
  clients: GoogleClients,
  documentId: string,
  content: string,
  opts: { force?: boolean; tab?: string; baseDir?: string; expectTitle?: string } = {},
): Promise<{ status: 'ok' | 'blocked' | 'mismatch'; message?: string; warnings?: string[]; images?: { src: string; objectId: string }[] }> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tabId = resolveTabId(doc, opts.tab);

  // Name the doc being wholesale-replaced (#10): verify the caller-echoed title.
  if (opts.expectTitle !== undefined && opts.expectTitle !== (doc.title ?? '')) {
    return { status: 'mismatch', message: `expectTitle "${opts.expectTitle}" != live doc title "${doc.title ?? ''}". Refusing to overwrite a different doc than intended.` };
  }

  if (!opts.force) {
    const suggestions = parseSuggestions(doc, tabId).length;
    const comments = (
      await clients.drive.comments.list({ fileId: documentId, fields: 'comments(id)', pageSize: 1 })
    ).data.comments?.length
      ? 'present'
      : 'none';
    if (suggestions > 0 || comments === 'present') {
      return {
        status: 'blocked',
        message: `Doc has ${suggestions} suggestion(s) and comments=${comments}; a full overwrite would orphan/wipe them. Re-run with force=true to proceed.`,
      };
    }
  }

  const tabContent = contentOf(doc, tabId);
  const end = tabContent[tabContent.length - 1]?.endIndex ?? 2;
  const preRequests: docs_v1.Schema$Request[] =
    end > 2 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } }] : [];

  const { warnings, images } = await renderMarkdownInto(clients, documentId, content, {
    tabId,
    preRequests,
    requiredRevisionId: doc.revisionId ?? undefined,
    baseDir: opts.baseDir,
  });
  return { status: 'ok', ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
}

// Tab CRUD. The live Docs API supports these (verified), but googleapis@144's
// generated types lag — addDocumentTab/updateDocumentTabProperties/deleteTab are
// not yet on Schema$Request — so we construct the request shapes and cast.
// A future googleapis bump should remove the casts.
type RawRequest = docs_v1.Schema$Request;

export async function addTab(
  clients: GoogleClients,
  documentId: string,
  title: string,
  opts: { index?: number; parentTabId?: string } = {},
): Promise<{ tabId: string; title: string }> {
  const req = {
    addDocumentTab: {
      tabProperties: { title, index: opts.index, parentTabId: opts.parentTabId },
    },
  } as unknown as RawRequest;
  const res = await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [req] } });
  const reply = res.data.replies?.[0] as { addDocumentTab?: { tabProperties?: { tabId?: string } } } | undefined;
  return { tabId: reply?.addDocumentTab?.tabProperties?.tabId ?? '', title };
}

export async function renameTab(
  clients: GoogleClients,
  documentId: string,
  tabId: string,
  title: string,
): Promise<{ tabId: string; title: string }> {
  const req = {
    updateDocumentTabProperties: { tabProperties: { tabId, title }, fields: 'title' },
  } as unknown as RawRequest;
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [req] } });
  return { tabId, title };
}

export async function deleteTab(
  clients: GoogleClients,
  documentId: string,
  tabId: string,
  opts: { expectTitle?: string } = {},
): Promise<{ status: 'ok' | 'not_found' | 'mismatch'; deleted?: string; title?: string; message?: string }> {
  // Verify the tab's live title before deleting — tabId is opaque, so a stale/wrong
  // id would otherwise silently delete the wrong tab (#10). Tab metadata only:
  // this never looks at body content.
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true, fields: TAB_METADATA_FIELDS })).data;
  const tab = findTab(doc, tabId);
  if (!tab) return { status: 'not_found', message: `tab "${tabId}" not found` };
  const title = tab.tabProperties?.title ?? '';
  if (opts.expectTitle !== undefined && opts.expectTitle !== title) {
    return {
      status: 'mismatch',
      title,
      message: `expectTitle "${opts.expectTitle}" != live tab title "${title}". Re-check list_tabs — refusing to delete a different tab than intended.`,
    };
  }
  const req = { deleteTab: { tabId } } as unknown as RawRequest;
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [req] } });
  return { status: 'ok', deleted: tabId, title };
}

export interface TabInfo {
  tabId: string;
  title: string;
  index: number;
  nestingLevel: number;
  parentTabId: string | null;
}

// Read tab structure (flattened, depth-first). Tabs are read-only via the API.
export async function listTabs(clients: GoogleClients, documentId: string): Promise<TabInfo[]> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true, fields: TAB_METADATA_FIELDS })).data;
  return flattenTabs(doc).flatMap((t) => {
    const p = t.tabProperties;
    if (!p?.tabId) return [];
    return [{
      tabId: p.tabId,
      title: p.title ?? '',
      index: p.index ?? 0,
      nestingLevel: p.nestingLevel ?? 0,
      parentTabId: p.parentTabId ?? null,
    }];
  });
}
