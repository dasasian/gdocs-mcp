import type { GoogleClients } from '../google/clients.js';
import { renderMarkdown } from './transformer.js';
import { resolveTabId } from './structure.js';

export type ReadMode = 'clean' | 'tracked' | 'accepted' | 'rejected';

// Map read mode -> Docs suggestionsViewMode. Using an explicit mode avoids the
// "32" corruption (a naive view concatenates pending suggestion text).
const VIEW_MODE: Record<ReadMode, string> = {
  clean: 'PREVIEW_WITHOUT_SUGGESTIONS',
  rejected: 'PREVIEW_WITHOUT_SUGGESTIONS',
  accepted: 'PREVIEW_SUGGESTIONS_ACCEPTED',
  tracked: 'SUGGESTIONS_INLINE',
};

export async function readDoc(
  clients: GoogleClients,
  documentId: string,
  mode: ReadMode = 'clean',
  tab?: string,
): Promise<{ title: string; markdown: string }> {
  const res = await clients.docs.documents.get({
    documentId,
    includeTabsContent: true,
    suggestionsViewMode: VIEW_MODE[mode],
  });
  const tabId = resolveTabId(res.data, tab);
  return {
    title: res.data.title ?? '',
    markdown: renderMarkdown(res.data, { tracked: mode === 'tracked', tabId }),
  };
}
