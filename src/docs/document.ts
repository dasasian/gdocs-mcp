import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId } from './structure.js';
import { parseSuggestions } from './suggestions.js';
import { markdownToRequests } from './write.js';
import { findProjectConfig } from '../auth/accounts.js';

// Insert a table at `index` and fill its cells (descending so inserts don't shift
// later cells). Cell text is plain in this narrow first cut.
async function insertTableAt(
  clients: GoogleClients,
  documentId: string,
  index: number,
  rows: string[][],
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
  const inserts: { index: number; text: string }[] = [];
  tableEl.table.tableRows.forEach((row, r) =>
    row.tableCells?.forEach((cell, c) => {
      const txt = rows[r]?.[c];
      const idx = cell.content?.[0]?.startIndex;
      if (txt && idx != null) inserts.push({ index: idx, text: txt });
    }),
  );
  inserts.sort((a, b) => b.index - a.index);
  if (inserts.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: inserts.map((i) => ({ insertText: { location: { index: i.index, tabId }, text: i.text } })) },
    });
  }
}

// Render markdown into a doc/tab: insert the text (with table placeholders), then
// insert each table at its placeholder position (descending so indices stay valid).
async function renderMarkdownInto(
  clients: GoogleClients,
  documentId: string,
  markdown: string,
  opts: { tabId?: string; preRequests?: docs_v1.Schema$Request[]; requiredRevisionId?: string } = {},
): Promise<void> {
  const { requests, tables } = markdownToRequests(markdown, 1, opts.tabId);
  const all = [...(opts.preRequests ?? []), ...requests];
  if (all.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: all, writeControl: opts.requiredRevisionId ? { requiredRevisionId: opts.requiredRevisionId } : undefined },
    });
  }
  for (const t of [...tables].sort((a, b) => b.index - a.index)) {
    await insertTableAt(clients, documentId, t.index, t.rows, opts.tabId);
  }
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
  opts: { folder?: string } = {},
): Promise<{ documentId: string; title: string; folderId?: string }> {
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

  if (content) await renderMarkdownInto(clients, documentId, content);
  return { documentId, title, ...(folderId ? { folderId } : {}) };
}

// Move an existing doc into a folder (by folder URL or id).
export async function moveDoc(
  clients: GoogleClients,
  documentId: string,
  folder: string,
): Promise<{ documentId: string; folderId: string; parents: string[] }> {
  const folderId = parseDriveId(folder);
  const meta = await clients.drive.files.get({ fileId: documentId, fields: 'parents', supportsAllDrives: true });
  const res = await clients.drive.files.update({
    fileId: documentId,
    addParents: folderId,
    removeParents: (meta.data.parents ?? []).join(','),
    fields: 'id,parents',
    supportsAllDrives: true,
  });
  return { documentId, folderId, parents: res.data.parents ?? [] };
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
  opts: { force?: boolean; tab?: string } = {},
): Promise<{ status: 'ok' | 'blocked'; message?: string }> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tabId = resolveTabId(doc, opts.tab);

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

  await renderMarkdownInto(clients, documentId, content, {
    tabId,
    preRequests,
    requiredRevisionId: doc.revisionId ?? undefined,
  });
  return { status: 'ok' };
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
): Promise<{ deleted: string }> {
  const req = { deleteTab: { tabId } } as unknown as RawRequest;
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [req] } });
  return { deleted: tabId };
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
