import type { GoogleClients } from '../google/clients.js';
import { renderMarkdown } from './transformer.js';
import { resolveTabId, listSegments, resolveSegmentId, type SegmentInfo, type SegmentKind, type SegmentPage } from './structure.js';

export type ReadMode = 'clean' | 'tracked' | 'accepted' | 'rejected';

// Map read mode -> Docs suggestionsViewMode. Using an explicit mode avoids the
// "32" corruption (a naive view concatenates pending suggestion text).
const VIEW_MODE: Record<ReadMode, string> = {
  clean: 'PREVIEW_WITHOUT_SUGGESTIONS',
  rejected: 'PREVIEW_WITHOUT_SUGGESTIONS',
  accepted: 'PREVIEW_SUGGESTIONS_ACCEPTED',
  tracked: 'SUGGESTIONS_INLINE',
};

function label(s: SegmentInfo): string {
  const page = s.page === 'default' ? '' : `${s.page}-page `;
  return `${page}${s.kind}`;
}

export interface ReadResult {
  title: string;
  markdown: string;
  /** header/footer segments this doc defines — always reported, even when reading the body (#23). */
  segments?: SegmentInfo[];
  note?: string;
}

export async function readDoc(
  clients: GoogleClients,
  documentId: string,
  mode: ReadMode = 'clean',
  tab?: string,
  opts: { segment?: SegmentKind | 'all'; page?: SegmentPage } = {},
): Promise<ReadResult> {
  const res = await clients.docs.documents.get({
    documentId,
    includeTabsContent: true,
    suggestionsViewMode: VIEW_MODE[mode],
  });
  const tabId = resolveTabId(res.data, tab);
  const tracked = mode === 'tracked';
  const segments = listSegments(res.data, tabId);
  const title = res.data.title ?? '';
  const segment = opts.segment ?? 'body';

  if (segment === 'all') {
    const parts = [`<!-- segment: body -->\n${renderMarkdown(res.data, { tracked, tabId })}`];
    for (const s of segments) {
      parts.push(`<!-- segment: ${label(s)} -->\n${renderMarkdown(res.data, { tracked, tabId, segmentId: s.segmentId })}`);
    }
    return { title, markdown: parts.join('\n\n'), segments };
  }

  if (segment === 'header' || segment === 'footer') {
    const segmentId = resolveSegmentId(res.data, segment, opts.page, tabId);
    if (!segmentId) {
      const have = segments.map(label).join(', ') || 'none';
      return {
        title,
        markdown: '',
        segments,
        note: `This doc has no ${opts.page ? `${opts.page}-page ` : ''}${segment}. Segments present: ${have}.`,
      };
    }
    return { title, markdown: renderMarkdown(res.data, { tracked, tabId, segmentId }), segments };
  }

  // Body read. A header/footer's content is NOT part of the body tree, so a
  // letterhead logo would otherwise make the doc look like it has no image at
  // all — say what exists rather than reading as silently empty (#23).
  const note = segments.length
    ? `Not shown: ${segments.map((s) => `${label(s)} (${s.paragraphs} para, ${s.images} image${s.images === 1 ? '' : 's'})`).join('; ')}. Read with segment:"header"/"footer", or segment:"all".`
    : undefined;
  return {
    title,
    markdown: renderMarkdown(res.data, { tracked, tabId }),
    ...(segments.length ? { segments } : {}),
    ...(note ? { note } : {}),
  };
}
