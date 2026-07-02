import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId } from './structure.js';
import { parseSuggestions } from './suggestions.js';
import { markdownToRequests } from './write.js';

export async function createDoc(
  clients: GoogleClients,
  title: string,
  content?: string,
): Promise<{ documentId: string; title: string }> {
  const created = await clients.docs.documents.create({ requestBody: { title } });
  const documentId = created.data.documentId!;
  if (content) {
    const { requests } = markdownToRequests(content, 1);
    if (requests.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  }
  return { documentId, title: created.data.title ?? title };
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
  const requests: docs_v1.Schema$Request[] = [];
  if (end > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } });
  requests.push(...markdownToRequests(content, 1, tabId).requests);

  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: { requests, writeControl: doc.revisionId ? { requiredRevisionId: doc.revisionId } : undefined },
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
