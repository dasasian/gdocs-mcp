import type { GoogleClients } from '../google/clients.js';
import { INLINE_READ, resolveTabId, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { project } from './transformer.js';
import { locate, rangeFor } from './edit.js';
import { contextAround } from './context.js';
import { asRequest, type CommentRange, type CommentThread } from './comments.js';

export type AddCommentResult =
  | { status: 'ok'; id: string; quotedText: string; range: CommentRange }
  | { status: 'not_found' | 'no_segment'; message: string }
  | { status: 'ambiguous'; message: string; matches: { context: string }[] };

interface InsertCommentReply {
  replies?: { insertComment?: { commentThread?: CommentThread } }[];
}

/**
 * A comment on the one place `quotedText` matches, found the way `edit_doc` finds `old_string`.
 * Docs has no comment without a range, so a quote that matches nowhere or twice is refused.
 */
export async function addComment(
  clients: GoogleClients,
  documentId: string,
  content: string,
  quotedText: string,
  opts: { tabId?: string; segment?: SegmentKind; page?: SegmentPage } = {},
): Promise<AddCommentResult> {
  const doc = (await clients.docs.documents.get({ documentId, ...INLINE_READ })).data;
  const tabId = resolveTabId(doc, opts.tabId);
  const target = resolveSegmentTarget(doc, { segment: opts.segment, page: opts.page, tabId });
  if (target.error) return { status: 'no_segment', message: target.error };
  const projection = project(doc, tabId, target.segmentId);
  const { needle, positions } = locate(projection.text, quotedText);
  if (positions.length === 0) return { status: 'not_found', message: `"${quotedText}" not found.` };
  if (positions.length > 1) {
    return {
      status: 'ambiguous',
      message: `${positions.length} matches — quote more text, so that one place matches.`,
      matches: positions.map((position) => ({ context: contextAround(projection.text, position, position + needle.length) })),
    };
  }
  const range: CommentRange = { ...rangeFor(projection, positions[0], positions[0] + needle.length), tabId, segmentId: target.segmentId };
  const res = await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [asRequest({ insertComment: { content, range } })] } });
  const thread = (res.data as InsertCommentReply).replies?.[0]?.insertComment?.commentThread;
  return { status: 'ok', id: thread?.commentId ?? '', quotedText: thread?.plainTextQuote ?? needle, range };
}
