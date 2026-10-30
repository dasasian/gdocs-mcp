import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { flattenTabs, INLINE_READ } from './structure.js';
import { project, type Projection } from './transformer.js';
import { contextAround } from './context.js';

export interface Post {
  postId?: string;
  content?: string;
  createTime?: string;
  commentAction?: string;
  author?: { displayName?: string; me?: boolean };
}

export interface CommentThread {
  commentId: string;
  anchorId?: string;
  plainTextQuote?: string;
  status?: string;
  headPost?: Post;
  replies?: Post[];
}

export interface SuggestionThread {
  suggestionId: string;
  status?: string;
  summaryText?: string;
  headPost?: Post;
}

interface AnchorRange {
  startIndex?: number;
  endIndex?: number;
  tabId?: string;
  segmentId?: string;
}

interface TabWithAnchors {
  commentAnchors?: Record<string, { ranges?: AnchorRange[] }>;
}

/** A Docs document as `documents.get` returns it with comments and suggestions included, which the generated typings do not yet know. */
export type ReviewedDocument = docs_v1.Schema$Document & { comments?: CommentThread[]; suggestions?: SuggestionThread[] };

export const REVIEW_READ = {
  ...INLINE_READ,
  commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
} as const;

export async function getDocForReview(clients: GoogleClients, documentId: string): Promise<ReviewedDocument> {
  const res = await clients.docs.documents.get({ documentId, ...REVIEW_READ });
  return res.data;
}

export interface CommentRange {
  startIndex: number;
  endIndex: number;
  tabId?: string;
  segmentId?: string;
}

export interface AnchoredThread {
  thread: CommentThread;
  range?: CommentRange;
}

function tabsWithAnchors(doc: ReviewedDocument): { tabId: string | undefined; content: TabWithAnchors }[] {
  const tabs = flattenTabs(doc);
  if (tabs.length === 0) return [{ tabId: undefined, content: doc as TabWithAnchors }];
  return tabs.map((tab) => ({ tabId: tab.tabProperties?.tabId ?? undefined, content: (tab.documentTab ?? {}) as TabWithAnchors }));
}

function rangesByAnchorId(doc: ReviewedDocument): Map<string, CommentRange> {
  const ranges = new Map<string, CommentRange>();
  for (const { tabId, content } of tabsWithAnchors(doc)) {
    for (const [anchorId, anchor] of Object.entries(content.commentAnchors ?? {})) {
      const [first] = anchor.ranges ?? [];
      if (first) ranges.set(anchorId, { startIndex: first.startIndex ?? 0, endIndex: first.endIndex ?? 0, tabId: first.tabId ?? tabId, segmentId: first.segmentId || undefined });
    }
  }
  return ranges;
}

/** Every comment thread in the doc, with the range it sits on when Docs gives it one. A comment made in Drive has none. */
export function anchoredThreads(doc: ReviewedDocument): AnchoredThread[] {
  const ranges = rangesByAnchorId(doc);
  return (doc.comments ?? []).map((thread) => ({ thread, range: thread.anchorId ? ranges.get(thread.anchorId) : undefined }));
}

const firstTabId = (doc: ReviewedDocument): string | undefined => flattenTabs(doc)[0]?.tabProperties?.tabId ?? undefined;

export type RangedThread = { thread: CommentThread; range: CommentRange };

/** The comments on a range in this tab's body, or in one of its headers or footers (`segmentId`). */
export function threadsOnRangesIn(doc: ReviewedDocument, tabId: string | undefined, segmentId?: string): RangedThread[] {
  const wantedTab = tabId ?? firstTabId(doc);
  return anchoredThreads(doc).flatMap(({ thread, range }) => (range && range.tabId === wantedTab && range.segmentId === segmentId ? [{ thread, range }] : []));
}

/** The comments Docs gives no range: the ones made in Drive, which carry only their quote. */
export function threadsWithoutRange(doc: ReviewedDocument): CommentThread[] {
  return anchoredThreads(doc).flatMap(({ thread, range }) => (range ? [] : [thread]));
}

export function commentCounts(doc: ReviewedDocument, tabId: string | undefined, segmentId?: string): { withRange: number; withoutRange: number } {
  return { withRange: threadsOnRangesIn(doc, tabId, segmentId).length, withoutRange: threadsWithoutRange(doc).length };
}

export interface ListedReply {
  id: string | null;
  author: string | null;
  time: string | null;
  content: string;
  action: 'resolve' | 'reopen' | null;
}

export interface ListedComment {
  id: string;
  quotedText: string;
  context: string;
  author: string | null;
  time: string | null;
  status: 'open' | 'resolved';
  content: string;
  replies: ListedReply[];
  range?: CommentRange;
}

const ACTIONS: Record<string, ListedReply['action']> = { RESOLVE: 'resolve', REOPEN: 'reopen' };

function replyOf(post: Post): ListedReply {
  return { id: post.postId ?? null, author: post.author?.displayName ?? null, time: post.createTime ?? null, content: post.content ?? '', action: ACTIONS[post.commentAction ?? ''] ?? null };
}

function plainSpanOf(projection: Projection, range: CommentRange): { from: number; to: number } | undefined {
  const from = projection.map.findIndex((index) => index >= range.startIndex);
  if (from < 0) return undefined;
  let to = from;
  while (to < projection.map.length && projection.map[to] < range.endIndex) to++;
  return { from, to };
}

/** Every comment in the doc, in the order Docs lists them, each with the sentence its range sits in. */
export function readComments(doc: ReviewedDocument): ListedComment[] {
  const projections = new Map<string, Projection>();
  const projectionOf = (range: CommentRange): Projection => {
    const key = `${range.tabId}|${range.segmentId}`;
    if (!projections.has(key)) projections.set(key, project(doc, range.tabId, range.segmentId));
    return projections.get(key) as Projection;
  };
  return anchoredThreads(doc).map(({ thread, range }) => {
    const quotedText = thread.plainTextQuote ?? '';
    const span = range && plainSpanOf(projectionOf(range), range);
    return {
      id: thread.commentId,
      quotedText,
      context: range && span ? contextAround(projectionOf(range).text, span.from, span.to) : quotedText,
      author: thread.headPost?.author?.displayName ?? null,
      time: thread.headPost?.createTime ?? null,
      status: thread.status === 'RESOLVED' ? 'resolved' : 'open',
      content: thread.headPost?.content ?? '',
      replies: (thread.replies ?? []).map(replyOf),
      ...(range ? { range } : {}),
    };
  });
}

export async function listComments(clients: GoogleClients, documentId: string): Promise<ListedComment[]> {
  return readComments(await getDocForReview(clients, documentId));
}

export const asRequest = (request: object): docs_v1.Schema$Request => request as docs_v1.Schema$Request;

interface AddCommentReply {
  replies?: { addCommentReply?: { post?: Post } }[];
}

export async function replyToComment(clients: GoogleClients, documentId: string, commentId: string, content: string): Promise<{ id: string }> {
  const res = await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [asRequest({ addCommentReply: { commentId, post: { content } } })] } });
  return { id: (res.data as AddCommentReply).replies?.[0]?.addCommentReply?.post?.postId ?? '' };
}

export type ResolveResult = { status: 'ok'; id: string; commentStatus: 'open' | 'resolved' } | { status: 'mismatch'; message: string };

/**
 * Resolves or reopens a comment, after checking that `expectQuotedText` is the text the comment is on, as `list_comments` gave it.
 * The id is opaque, so a stale one would otherwise act on whatever comment it names.
 */
export async function resolveComment(
  clients: GoogleClients,
  documentId: string,
  commentId: string,
  opts: { expectQuotedText: string; reopen?: boolean },
): Promise<ResolveResult> {
  const thread = (await getDocForReview(clients, documentId)).comments?.find((candidate) => candidate.commentId === commentId);
  if (!thread) return { status: 'mismatch', message: `There is no comment with id "${commentId}" in this doc. Run list_comments again.` };
  const quotedText = thread.plainTextQuote ?? '';
  if (quotedText !== opts.expectQuotedText) {
    return { status: 'mismatch', message: `expectQuotedText "${opts.expectQuotedText}" is not the text this comment is on ("${quotedText}"). Run list_comments again: this id may be a different comment.` };
  }
  const commentAction = opts.reopen ? 'REOPEN' : 'RESOLVE';
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [asRequest({ addCommentReply: { commentId, post: { commentAction } } })] } });
  return { status: 'ok', id: commentId, commentStatus: opts.reopen ? 'open' : 'resolved' };
}
