import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, findTab } from './structure.js';
import { parseSuggestions } from './suggestions.js';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';
import { markdownToRequests } from './write.js';
import { parseInline, segmentTextStyle } from './inline.js';
import { findProjectConfig } from '../auth/accounts.js';
import { uploadImageForInsert } from '../drive/images.js';

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
): Promise<{ objectId?: string; warning?: string }> {
  const embed = async (uri: string): Promise<string | undefined> => {
    const r = await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertInlineImage: { location: { index, tabId }, uri } }] },
    });
    const reply = r.data.replies?.[0] as { insertInlineImage?: { objectId?: string } } | undefined;
    return reply?.insertInlineImage?.objectId ?? undefined;
  };

  if (/^https?:\/\//i.test(src)) {
    return { objectId: await embed(src) };
  }
  const decoded = decodeURIComponent(src);
  const absPath = nodePath.isAbsolute(decoded) ? decoded : baseDir ? nodePath.resolve(baseDir, decoded) : null;
  if (!absPath) return { warning: `image "${src}" is a local path but no baseDir was provided; skipped` };
  if (!existsSync(absPath)) return { warning: `image not found: ${absPath}; skipped` };
  const { uri, cleanup } = await uploadImageForInsert(clients, absPath);
  try {
    return { objectId: await embed(uri) };
  } finally {
    await cleanup();
  }
}

// Insert a table at `index` and fill its cells (descending so inserts don't shift
// later cells). Cell text is plain in this narrow first cut.
const PARA_ALIGN: Record<'center' | 'right', string> = { center: 'CENTER', right: 'END' };

async function insertTableAt(
  clients: GoogleClients,
  documentId: string,
  index: number,
  rows: string[][],
  aligns: ('left' | 'center' | 'right' | null)[],
  tabId?: string,
): Promise<void> {
  const R = rows.length;
  const C = Math.max(...rows.map((r) => r.length));
  if (R === 0 || C === 0) return;
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertTable: { location: { index, tabId }, rows: R, columns: C } }] },
  });
  const after = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tableEl = contentOf(after, tabId)
    .filter((e) => e.table && (e.startIndex ?? 0) >= index)
    .sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0))[0];
  if (!tableEl?.table?.tableRows) return;
  // Collect cell (index, markdown) descending so inserts don't shift later cells.
  const cells: { index: number; md: string }[] = [];
  tableEl.table.tableRows.forEach((row, r) =>
    row.tableCells?.forEach((cell, c) => {
      const md = rows[r]?.[c];
      const idx = cell.content?.[0]?.startIndex;
      if (md && idx != null) cells.push({ index: idx, md });
    }),
  );
  cells.sort((a, b) => b.index - a.index);

  // Render each cell's inline markdown (bold/italic/code/links) into the cell.
  const requests: docs_v1.Schema$Request[] = [];
  for (const cell of cells) {
    const segs = parseInline(cell.md);
    const plain = segs.map((s) => s.text).join('');
    if (!plain) continue;
    requests.push({ insertText: { location: { index: cell.index, tabId }, text: plain } });
    let off = 0;
    for (const seg of segs) {
      const { textStyle, fields } = segmentTextStyle(seg);
      if (fields.length) {
        requests.push({
          updateTextStyle: { range: { startIndex: cell.index + off, endIndex: cell.index + off + seg.text.length, tabId }, textStyle, fields: fields.join(',') },
        });
      }
      off += seg.text.length;
    }
  }
  if (requests.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests } });

  // Apply column alignment (center/right) to every cell's paragraph. Re-fetch so
  // indices are current; paragraph-style ops don't change length.
  if (aligns.some((a) => a === 'center' || a === 'right')) {
    const aligned = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
    const tableEl2 = contentOf(aligned, tabId)
      .filter((e) => e.table && (e.startIndex ?? 0) >= index)
      .sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0))[0];
    const alignReqs: docs_v1.Schema$Request[] = [];
    tableEl2?.table?.tableRows?.forEach((row) =>
      row.tableCells?.forEach((cell, c) => {
        const a = aligns[c];
        const para = cell.content?.[0];
        if ((a === 'center' || a === 'right') && para?.startIndex != null) {
          alignReqs.push({
            updateParagraphStyle: {
              range: { startIndex: para.startIndex, endIndex: para.endIndex ?? para.startIndex + 1, tabId },
              paragraphStyle: { alignment: PARA_ALIGN[a] },
              fields: 'alignment',
            },
          });
        }
      }),
    );
    if (alignReqs.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: alignReqs } });
  }
}

// Render markdown into a doc/tab: insert the text (with table placeholders), then
// insert each table at its placeholder position (descending so indices stay valid).
async function renderMarkdownInto(
  clients: GoogleClients,
  documentId: string,
  markdown: string,
  opts: { tabId?: string; preRequests?: docs_v1.Schema$Request[]; requiredRevisionId?: string; baseDir?: string } = {},
): Promise<{ warnings: string[]; images: { src: string; objectId: string }[] }> {
  const { requests, tables, images } = markdownToRequests(markdown, 1, opts.tabId);
  const all = [...(opts.preRequests ?? []), ...requests];
  if (all.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: all, writeControl: opts.requiredRevisionId ? { requiredRevisionId: opts.requiredRevisionId } : undefined },
    });
  }
  // Structural inserts (tables + images) descending by index so earlier indices stay valid.
  const warnings: string[] = [];
  const imageMap: { src: string; objectId: string }[] = [];
  const placements: { index: number; run: () => Promise<void> }[] = [
    ...tables.map((t) => ({ index: t.index, run: () => insertTableAt(clients, documentId, t.index, t.rows, t.aligns, opts.tabId) })),
    ...images.map((im) => ({
      index: im.index,
      run: async () => {
        const res = await insertImagePlacement(clients, documentId, im.index, im.src, opts.baseDir, opts.tabId);
        if (res.warning) warnings.push(res.warning);
        if (res.objectId) imageMap.push({ src: im.src, objectId: res.objectId });
      },
    })),
  ].sort((a, b) => b.index - a.index);
  for (const p of placements) await p.run();
  return { warnings, images: imageMap };
}

// Extract a Drive file/folder id from a URL (…/folders/ID, …/d/ID) or a raw id.
export function parseDriveId(input: string): string {
  const m = /\/(?:folders|d)\/([a-zA-Z0-9_-]+)/.exec(input);
  if (m) return m[1];
  return input.trim().replace(/[?#].*$/, '');
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

// Move an existing doc into a folder (by folder URL or id).
export async function moveDoc(
  clients: GoogleClients,
  documentId: string,
  folder: string,
  opts: { expectTitle?: string } = {},
): Promise<{ status: 'ok' | 'mismatch'; documentId: string; folderId?: string; parents?: string[]; name?: string; message?: string }> {
  const folderId = parseDriveId(folder);
  const meta = await clients.drive.files.get({ fileId: documentId, fields: 'parents,name', supportsAllDrives: true });
  const name = meta.data.name ?? '';
  if (opts.expectTitle !== undefined && opts.expectTitle !== name) {
    return { status: 'mismatch', documentId, name, message: `expectTitle "${opts.expectTitle}" != live doc title "${name}". Refusing to move a different doc than intended.` };
  }
  const res = await clients.drive.files.update({
    fileId: documentId,
    addParents: folderId,
    removeParents: (meta.data.parents ?? []).join(','),
    fields: 'id,parents',
    supportsAllDrives: true,
  });
  return { status: 'ok', documentId, folderId, parents: res.data.parents ?? [], name };
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
  // id would otherwise silently delete the wrong tab (#10).
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
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
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const out: TabInfo[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined): void => {
    for (const t of tabs ?? []) {
      const p = t.tabProperties;
      if (p?.tabId) {
        out.push({
          tabId: p.tabId,
          title: p.title ?? '',
          index: p.index ?? 0,
          nestingLevel: p.nestingLevel ?? 0,
          parentTabId: p.parentTabId ?? null,
        });
      }
      walk(t.childTabs ?? undefined);
    }
  };
  walk(doc.tabs ?? undefined);
  return out;
}
