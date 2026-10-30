import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import type { TableLayout } from './table-layout.js';
import { parseBlocks } from './write.js';
import { getDocForReview, REVIEW_READ, type ReviewedDocument } from './comments.js';
import { suggestionFootprints } from './suggestions.js';

const UNSUGGESTABLE_REQUESTS: Record<string, string> = {
  addDocumentTab: 'a new tab',
  updateDocumentTabProperties: 'renaming, moving or nesting a tab',
  deleteHeader: 'deleting a header',
  deleteFooter: 'deleting a footer',
  createNamedRange: 'a named range',
  deleteNamedRange: 'a named range',
  updateTableColumnProperties: 'a table column width',
};

export class SuggestRefusal extends Error {}

const cannotSuggest = (what: string, request: string): SuggestRefusal =>
  new SuggestRefusal(`Nothing was changed: Docs cannot suggest ${what} (${request}), so this edit cannot be a suggestion. Leave that part out, or make the edit without suggest.`);

export const noSuggestedSegment = (segment: 'header' | 'footer'): SuggestRefusal =>
  new SuggestRefusal(`Nothing was changed: this doc has no ${segment} yet, and a ${segment} cannot be created as a suggestion. Create it with write_doc, without suggest, then suggest changes to it.`);

const requestName = (request: docs_v1.Schema$Request): string => Object.keys(request)[0] ?? '';

export function refuseUnsuggestable(requests: docs_v1.Schema$Request[]): void {
  for (const request of requests) {
    const what = UNSUGGESTABLE_REQUESTS[requestName(request)];
    if (what) throw cannotSuggest(what, requestName(request));
  }
}

const COLUMN_WIDTH = { what: UNSUGGESTABLE_REQUESTS.updateTableColumnProperties, request: 'updateTableColumnProperties' };

/** Refuses markdown that holds a table with a column width, which Docs cannot suggest, before the first request of the edit is sent. */
export function refuseColumnWidthsIn(markdown: string): void {
  const hasWidth = parseBlocks(markdown).some((block) => block.type === 'table' && block.layout?.columns.some((column) => column.width !== undefined));
  if (hasWidth) throw cannotSuggest(COLUMN_WIDTH.what, COLUMN_WIDTH.request);
}

/** Refuses a table edit that sets a column width: any width that differs, or any width at all when columns are added or removed. */
export function refuseColumnWidthChange(before: TableLayout, after: TableLayout, changesColumns: boolean): void {
  const count = Math.max(before.columns.length, after.columns.length);
  const widths = (layout: TableLayout): (number | undefined)[] => Array.from({ length: count }, (_, c) => layout.columns[c]?.width);
  const anyWidth = [...widths(before), ...widths(after)].some((width) => width !== undefined);
  const differs = widths(before).some((width, c) => width !== widths(after)[c]);
  if (changesColumns ? anyWidth : differs) throw cannotSuggest(COLUMN_WIDTH.what, COLUMN_WIDTH.request);
}

interface SuggestionResponses {
  suggestionResponses?: { createdSuggestionIds?: string[] }[];
}

type DocumentsApi = GoogleClients['docs']['documents'];

function withDocuments(clients: GoogleClients, replaced: Partial<Pick<DocumentsApi, 'get' | 'batchUpdate'>>): GoogleClients {
  const documents = Object.create(clients.docs.documents, Object.fromEntries(Object.entries(replaced).map(([name, value]) => [name, { value }])));
  const docs = Object.create(clients.docs, { documents: { value: documents } });
  return { ...clients, docs };
}

/**
 * The same clients, except that every `documents.batchUpdate` is sent with `writeMode: "SUGGEST"` and the ids of the
 * suggestions it makes are added to `made`. A request Docs cannot suggest is refused before that batch is sent.
 */
export function suggestingClients(clients: GoogleClients, made: string[]): GoogleClients {
  const documents = clients.docs.documents;
  const batchUpdate = async (params: docs_v1.Params$Resource$Documents$Batchupdate, ...rest: unknown[]) => {
    refuseUnsuggestable(params.requestBody?.requests ?? []);
    const writeControl = { ...params.requestBody?.writeControl, writeMode: 'SUGGEST' };
    const send = documents.batchUpdate.bind(documents) as (...args: unknown[]) => Promise<{ data: SuggestionResponses }>;
    const res = await send({ ...params, requestBody: { ...params.requestBody, writeControl } }, ...rest);
    made.push(...(res.data.suggestionResponses ?? []).flatMap((response) => response.createdSuggestionIds ?? []));
    return res;
  };
  return withDocuments(clients, { batchUpdate: batchUpdate as DocumentsApi['batchUpdate'] });
}

export interface SuggestingSession {
  clients: GoogleClients;
  /** The ids of the suggestions that now hold the edited text, from one read after the write. Empty when no batch was sent. */
  suggestionsNow(documentId: string): Promise<string[]>;
}

/**
 * `suggestingClients`, plus a note of how the suggestions in the doc stood at the first read that had them inline.
 * Docs folds an edit that touches the caller's own pending suggestion into it and reports no created id, so the ids are
 * those the batches created, and those of the suggestions that differ after the write from before it.
 */
export function suggestingSession(clients: GoogleClients): SuggestingSession {
  const made: string[] = [];
  const suggesting = suggestingClients(clients, made);
  const documents = suggesting.docs.documents;
  let before: Map<string, string> | undefined;
  let sentABatch = false;
  const get = async (params: docs_v1.Params$Resource$Documents$Get, ...rest: unknown[]) => {
    const read = documents.get.bind(documents) as (...args: unknown[]) => Promise<{ data: ReviewedDocument }>;
    const res = await read(params, ...rest);
    if (!before && params.suggestionsViewMode === REVIEW_READ.suggestionsViewMode) before = suggestionFootprints(res.data);
    return res;
  };
  const batchUpdate = async (params: docs_v1.Params$Resource$Documents$Batchupdate, ...rest: unknown[]) => {
    sentABatch = true;
    const send = documents.batchUpdate.bind(documents) as (...args: unknown[]) => Promise<unknown>;
    return send(params, ...rest);
  };
  const watched = withDocuments(suggesting, { get: get as DocumentsApi['get'], batchUpdate: batchUpdate as DocumentsApi['batchUpdate'] });
  const suggestionsNow = async (documentId: string): Promise<string[]> => {
    if (!sentABatch) return [];
    const after = suggestionFootprints(await getDocForReview(suggesting, documentId));
    const changed = [...after].filter(([id, footprint]) => before?.get(id) !== footprint).map(([id]) => id);
    return [...new Set([...changed, ...made])];
  };
  return { clients: watched, suggestionsNow };
}
