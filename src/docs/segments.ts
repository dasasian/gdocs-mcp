import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { resolveSegmentId, listSegments, type SegmentKind, type SegmentPage } from './structure.js';

export interface SegmentTarget {
  /** undefined = the body. */
  segmentId?: string;
  doc: docs_v1.Schema$Document;
  error?: string;
}

export function resolveSegmentTarget(
  doc: docs_v1.Schema$Document,
  opts: { segment?: SegmentKind; page?: SegmentPage; tabId?: string } = {},
): SegmentTarget {
  const kind = opts.segment ?? 'body';
  if (kind === 'body') return { segmentId: undefined, doc };

  const existing = resolveSegmentId(doc, kind, opts.page, opts.tabId);
  if (existing) return { segmentId: existing, doc };
  const have = listSegments(doc, opts.tabId).map((s) => `${s.page}-page ${s.kind}`).join(', ') || 'none';
  return { doc, error: `This doc has no ${kind}. Segments present: ${have}. write_doc with segment: "${kind}" creates the default one.` };
}

export const DIFFERENT_FIRST_PAGE_REFUSAL = 'Turn on Different first page in Docs (Format → Headers & footers), then retry.';

/**
 * The segment id for a write_doc to a header or footer, creating the default one
 * when the doc has none. A first-page or even-page one cannot be created by the
 * API, so asking for one that is missing returns the refusal to show the user.
 */
export async function segmentForWrite(
  clients: GoogleClients,
  documentId: string,
  doc: docs_v1.Schema$Document,
  opts: { segment: 'header' | 'footer'; page?: SegmentPage; tabId?: string },
): Promise<{ segmentId: string; doc: docs_v1.Schema$Document } | { refusal: string }> {
  const existing = resolveSegmentId(doc, opts.segment, opts.page, opts.tabId);
  if (existing) return { segmentId: existing, doc };
  if (opts.page && opts.page !== 'default') return { refusal: DIFFERENT_FIRST_PAGE_REFUSAL };
  const request: docs_v1.Schema$Request =
    opts.segment === 'header'
      ? { createHeader: { type: 'DEFAULT' } }
      : { createFooter: { type: 'DEFAULT' } };
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [request] } });
  const fresh = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const segmentId = resolveSegmentId(fresh, opts.segment, 'default', opts.tabId);
  if (!segmentId) throw new Error(`Created a ${opts.segment} but could not resolve its id.`);
  return { segmentId, doc: fresh };
}
