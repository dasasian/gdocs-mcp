import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { resolveSegmentId, listSegments, type SegmentKind, type SegmentPage } from './structure.js';

// Write-side segment plumbing (#23). Reads can only look at what exists; a write
// may have to create the header/footer first — that's the letterhead case, where
// a fresh doc has no header at all and the logo has to go somewhere.

export interface SegmentTarget {
  /** undefined = the body. */
  segmentId?: string;
  /** true when this call created the header/footer. */
  created: boolean;
  /** re-fetched document — after a create, indices and maps have moved. */
  doc: docs_v1.Schema$Document;
  error?: string;
}

export async function resolveSegmentTarget(
  clients: GoogleClients,
  documentId: string,
  doc: docs_v1.Schema$Document,
  opts: { segment?: SegmentKind; page?: SegmentPage; create?: boolean; tabId?: string } = {},
): Promise<SegmentTarget> {
  const kind = opts.segment ?? 'body';
  if (kind === 'body') return { segmentId: undefined, created: false, doc };

  const existing = resolveSegmentId(doc, kind, opts.page, opts.tabId);
  if (existing) return { segmentId: existing, created: false, doc };
  if (!opts.create) {
    const have = listSegments(doc, opts.tabId).map((s) => `${s.page}-page ${s.kind}`).join(', ') || 'none';
    return { created: false, doc, error: `This doc has no ${kind}. Segments present: ${have}. Pass create:true to add one.` };
  }
  // Only the DEFAULT header/footer can be created through the API — a
  // first-page/even-page one has to be turned on in the editor first.
  if (opts.page && opts.page !== 'default') {
    return {
      created: false,
      doc,
      error: `The Docs API can only create the default ${kind} (no ${opts.page}-page ${kind}). Enable it in the editor, or omit page.`,
    };
  }
  const req: docs_v1.Schema$Request = kind === 'header' ? { createHeader: { type: 'DEFAULT' } } : { createFooter: { type: 'DEFAULT' } };
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [req] } });
  const fresh = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const segmentId = resolveSegmentId(fresh, kind, 'default', opts.tabId);
  if (!segmentId) return { created: false, doc: fresh, error: `Created a ${kind} but could not resolve its id.` };
  return { segmentId, created: true, doc: fresh };
}
