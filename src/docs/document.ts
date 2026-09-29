import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, tableInsertedAt, writeControlFor, TAB_TREE_FIELDS, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { parseSuggestions } from './suggestions.js';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { markdownToRequests, parseBlocks } from './write.js';
import { findProjectConfig } from '../auth/accounts.js';
import { parseDriveId } from '../drive/paths.js';
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

export async function createDoc(
  clients: GoogleClients,
  title: string,
  content?: string,
  opts: { folder?: string; baseDir?: string } = {},
): Promise<{ documentId: string; title: string; folderId?: string; warnings?: string[]; images?: { src: string; objectId: string }[] }> {
  if (content) parseBlocks(content);
  let documentId: string;
  let folderId: string | undefined;

  const folder = opts.folder ?? findProjectConfig().folder;

  if (folder) {
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

export async function overwriteDoc(
  clients: GoogleClients,
  documentId: string,
  content: string,
  opts: { force?: boolean; tab?: string; baseDir?: string; expectTitle?: string } = {},
): Promise<{ status: 'ok' | 'blocked' | 'mismatch'; message?: string; warnings?: string[]; images?: { src: string; objectId: string }[] }> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tabId = resolveTabId(doc, opts.tab);

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
    resetParagraphStyles: true,
  });
  return { status: 'ok', ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
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
