import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, flattenTabs, tableInsertedAt, writeControlFor, TAB_TREE_FIELDS, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { getDocInline } from './suggestions.js';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { markdownToRequests, parseBlocks } from './write.js';
import { resolveEntry, tabOfEntry, refusal, folderPathOf, parseDriveId, type Resolved, type TabRef } from '../drive/paths.js';
import { measureLoss, confirmLossToken, lossSummary, lossDetails, countComments, type Loss } from './loss.js';
import { uploadImageForInsert, resolveImageSource } from '../drive/images.js';
import { resolveIndex, fillCellRequests, columnAlignRequests } from './objects.js';

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

  if (aligns.some((a) => a && a !== 'left')) {
    const aligned = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
    const alignReqs = columnAlignRequests(tableInsertedAt(aligned, index, tabId, segmentId), aligns, { tabId, segmentId });
    if (alignReqs.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: alignReqs } });
  }
}

async function renderMarkdownInto(
  clients: GoogleClients,
  documentId: string,
  markdown: string,
  opts: { tabId?: string; segmentId?: string; preRequests?: docs_v1.Schema$Request[]; requiredRevisionId?: string; baseDir?: string; startIndex?: number; resetParagraphStyles?: boolean } = {},
): Promise<{ warnings: string[]; images: { src: string; objectId: string }[] }> {
  const { requests, tables, images } = markdownToRequests(markdown, opts.startIndex ?? 1, opts.tabId, opts.segmentId, { resetParagraphStyles: opts.resetParagraphStyles });
  const all = [...(opts.preRequests ?? []), ...requests];
  if (all.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: all, writeControl: writeControlFor(opts.requiredRevisionId) },
    });
  }
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

/**
 * Insert new markdown at a structural position instead of replacing anchor text.
 * `at`: 'end' (default) · 'top' · a unique text anchor to insert right after.
 * The only way to add a paragraph after a table that ends the doc.
 */
export async function insertContent(
  clients: GoogleClients,
  documentId: string,
  content: string,
  opts: { at?: string; tabId?: string; baseDir?: string; segment?: SegmentKind; page?: SegmentPage; createSegment?: boolean } = {},
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
  const tabId = resolveTabId(first.data, opts.tabId);
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

/**
 * Body from either `content` or a `contentFile` read server-side (so a long
 * document passes through mechanically, #14). With contentFile and no baseDir,
 * baseDir is the file's own folder, so relative image paths still resolve.
 */
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

export async function updateTab(
  clients: GoogleClients,
  documentId: string,
  tabId: string,
  change: { title?: string; index?: number; parentTabId?: string },
): Promise<void> {
  const fields = (['title', 'index', 'parentTabId'] as const).filter((f) => change[f] !== undefined).join(',');
  const req = { updateDocumentTabProperties: { tabProperties: { tabId, ...change }, fields } } as unknown as RawRequest;
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [req] } });
}


export type WriteDocResult =
  | { status: 'created'; kind: 'doc' | 'tab'; path: string; documentId: string; tabId?: string; url: string; warnings?: string[]; images?: { src: string; objectId: string }[] }
  | { status: 'replaced'; path: string; documentId: string; tabId: string; warnings?: string[]; images?: { src: string; objectId: string }[] }
  | { status: 'confirm_required'; message: string; lost: Loss; details: string[]; confirmLoss: string }
  | { status: 'not_created'; message: string; suggestedPath?: string };

function childPath(parent: Resolved, name: string): string {
  return `${parent.path === '/' ? '' : parent.path}/${name}`;
}

function docUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

async function createAt(
  clients: GoogleClients,
  parent: Resolved,
  name: string,
  content: string,
  baseDir: string | undefined,
): Promise<WriteDocResult> {
  if (parent.isFolder) {
    const created = await clients.drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.document', parents: [parent.id] },
      fields: 'id',
      supportsAllDrives: true,
    });
    const documentId = created.data.id ?? '';
    const { warnings, images } = await renderMarkdownInto(clients, documentId, content, { baseDir });
    return { status: 'created', kind: 'doc', path: childPath(parent, name), documentId, url: docUrl(documentId), ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
  }
  const { tabId } = await addTab(clients, parent.id, name, { parentTabId: parent.tab?.tabId });
  const { warnings, images } = await renderMarkdownInto(clients, parent.id, content, { tabId, baseDir });
  return { status: 'created', kind: 'tab', path: childPath(parent, name), documentId: parent.id, tabId, url: docUrl(parent.id), ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
}

async function replaceTab(
  clients: GoogleClients,
  tab: TabRef,
  content: string,
  opts: { confirmLoss?: string; baseDir?: string },
  asNamed: string,
): Promise<WriteDocResult> {
  const doc = await getDocInline(clients, tab.documentId);
  const tabId = resolveTabId(doc, tab.tabId);
  const loss = measureLoss(doc, tabId, await countComments(clients, tab.documentId));
  const confirmLoss = confirmLossToken(loss, doc.revisionId);
  if (opts.confirmLoss !== confirmLoss) {
    const changed = opts.confirmLoss !== undefined;
    return {
      status: 'confirm_required',
      message: `Ask the user before doing anything else: nothing has been changed, and the user has not agreed to this yet. ${changed ? 'The doc changed since the earlier summary, or the summary was not passed back as given, so this is a fresh one. ' : ''}Replacing "${asNamed}" removes ${lossSummary(loss)}. Show the user that list and wait for a yes. Only after a yes, call write_doc again with the same content and confirmLoss set to the string below, exactly.`,
      lost: loss,
      details: lossDetails(loss, flattenTabs(doc).length > 1),
      confirmLoss,
    };
  }
  const tabContent = contentOf(doc, tabId);
  const end = tabContent[tabContent.length - 1]?.endIndex ?? 2;
  const preRequests: docs_v1.Schema$Request[] =
    end > 2 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } }] : [];
  const { warnings, images } = await renderMarkdownInto(clients, tab.documentId, content, {
    tabId,
    preRequests,
    requiredRevisionId: doc.revisionId ?? undefined,
    baseDir: opts.baseDir,
    resetParagraphStyles: true,
  });
  return { status: 'replaced', path: tab.path, documentId: tab.documentId, tabId: tab.tabId, ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
}

function topOfMyDriveKey(clients: GoogleClients, name: string): string {
  return `${clients.account}:${name.toLowerCase()}`;
}

async function defaultFolderIn(clients: GoogleClients, defaultFolder: string): Promise<string> {
  return (await folderPathOf(clients, defaultFolder)) ?? parseDriveId(defaultFolder);
}

function inFolder(folder: string, name: string): string {
  return `${folder === '/' ? '' : folder}/${name}`;
}

async function refuseBareName(
  clients: GoogleClients,
  name: string,
  opts: { defaultFolder?: string; rootCreates: Set<string> },
): Promise<WriteDocResult> {
  if (!opts.defaultFolder) return { status: 'not_created', message: `Not created: no folder was given. Name a folder, e.g. ~/${name}.` };
  const folder = await defaultFolderIn(clients, opts.defaultFolder);
  const suggestedPath = inFolder(folder, name);
  opts.rootCreates.add(topOfMyDriveKey(clients, name));
  return {
    status: 'not_created',
    suggestedPath,
    message: `Not created: no folder was given. This project's default folder for new docs is ${folder}. Tell the user, then call write_doc(${JSON.stringify(suggestedPath)}, …) — or, if the user wants it at the top of My Drive, call write_doc(${JSON.stringify(`/${name}`)}, …).`,
  };
}

async function refuseTopOfMyDrive(
  clients: GoogleClients,
  name: string,
  opts: { defaultFolder: string; rootCreates: Set<string> },
): Promise<WriteDocResult> {
  const folder = await defaultFolderIn(clients, opts.defaultFolder);
  const suggestedPath = inFolder(folder, name);
  opts.rootCreates.add(topOfMyDriveKey(clients, name));
  return {
    status: 'not_created',
    suggestedPath,
    message: `Not created: this project's default folder for new docs is ${folder}. Tell the user, then call write_doc(${JSON.stringify(suggestedPath)}, …) — or, if the user wants it at the top of My Drive, repeat this same call.`,
  };
}

function isTopOfMyDrive(parent: Resolved): boolean {
  return parent.isFolder && parent.path === '/';
}

/**
 * Write like the local Write tool: a path that names nothing is created (a doc in
 * a folder, a tab in a doc, a child tab under a tab) and never asks; a path that
 * names something is refused with a loss summary until the caller passes it back
 * as `confirmLoss`. A bare name (not a path, URL or Drive id) is never created: it
 * is refused with the path to call, built from `defaultFolder` (an id or URL) when
 * there is one. With a `defaultFolder`, a new doc at the top of My Drive is refused
 * once too; `rootCreates` remembers what was refused, so the same call repeated
 * (the caller owns the set, for the life of a session) goes through. Throws for a path that is ambiguous, a folder, or a multi-tab doc
 * with no tab step.
 */
export async function writeDoc(
  clients: GoogleClients,
  path: string,
  content: string,
  opts: { confirmLoss?: string; baseDir?: string; defaultFolder?: string; rootCreates?: Set<string> } = {},
): Promise<WriteDocResult> {
  parseBlocks(content);
  const rootCreates = opts.rootCreates ?? new Set<string>();
  const resolution = await resolveEntry(clients, path);
  if (resolution.ok) return replaceTab(clients, await tabOfEntry(clients, resolution.entry, path), content, opts, path);
  if (resolution.status === 'not_found' && resolution.missing) {
    const { parent, name } = resolution.missing;
    if (opts.defaultFolder && isTopOfMyDrive(parent) && !rootCreates.has(topOfMyDriveKey(clients, name))) {
      return refuseTopOfMyDrive(clients, name, { defaultFolder: opts.defaultFolder, rootCreates });
    }
    return createAt(clients, resolution.missing.parent, resolution.missing.name, content, opts.baseDir);
  }
  if (resolution.status === 'not_found' && resolution.notAnId) return refuseBareName(clients, path, { defaultFolder: opts.defaultFolder, rootCreates });
  throw refusal(resolution);
}
