import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import type { TableLayout } from './table-layout.js';
import { parseBlocks } from './write.js';

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
  const widths = (layout: TableLayout): (number | undefined)[] => layout.columns.map((column) => column.width);
  const anyWidth = [...widths(before), ...widths(after)].some((width) => width !== undefined);
  const differs = JSON.stringify(widths(before)) !== JSON.stringify(widths(after));
  if (changesColumns ? anyWidth : differs) throw cannotSuggest(COLUMN_WIDTH.what, COLUMN_WIDTH.request);
}

interface SuggestionResponses {
  suggestionResponses?: { createdSuggestionIds?: string[] }[];
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
  const suggestingDocuments = Object.create(documents, { batchUpdate: { value: batchUpdate } });
  const suggestingDocs = Object.create(clients.docs, { documents: { value: suggestingDocuments } });
  return { ...clients, docs: suggestingDocs };
}
