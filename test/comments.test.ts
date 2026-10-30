import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { createServer } from '../src/server.js';
import { addComment } from '../src/docs/add-comment.js';
import { commentCounts, listComments, readComments, replyToComment, resolveComment, REVIEW_READ, type ReviewedDocument } from '../src/docs/comments.js';

const PARAGRAPH = 'Pay within 30 days of invoice.';
const HEADER = 'Acme letterhead';

function paragraph(startIndex: number, text: string): docs_v1.Schema$StructuralElement {
  return { startIndex, endIndex: startIndex + text.length + 1, paragraph: { elements: [{ startIndex, endIndex: startIndex + text.length + 1, textRun: { content: `${text}\n` } }] } };
}

const thread = (commentId: string, extra: Partial<ReviewedDocument['comments'] extends (infer T)[] | undefined ? T : never> = {}) => ({
  commentId,
  status: 'OPEN',
  plainTextQuote: 'quote',
  headPost: { content: `body of ${commentId}`, createTime: '2026-10-29T10:00:00Z', author: { displayName: 'Sam Lee', me: false } },
  ...extra,
});

function reviewedDoc(extra: Partial<ReviewedDocument> = {}): ReviewedDocument {
  return {
    title: 'Contract',
    revisionId: 'r1',
    documentStyle: { defaultHeaderId: 'h1' },
    headers: { h1: { headerId: 'h1', content: [paragraph(0, HEADER)] } },
    body: { content: [paragraph(1, PARAGRAPH)] },
    ...extra,
  } as ReviewedDocument;
}

function clientsFor(doc: ReviewedDocument, reply: unknown = { replies: [{}] }) {
  const get = vi.fn().mockResolvedValue({ data: doc });
  const batchUpdate = vi.fn().mockResolvedValue({ data: reply });
  const clients = { account: 'a', auth: {} as GoogleClients['auth'], docs: { documents: { get, batchUpdate } } as unknown as GoogleClients['docs'], drive: {} as GoogleClients['drive'] } as GoogleClients;
  return { clients, get, batchUpdate };
}

const requestsSent = (batchUpdate: ReturnType<typeof vi.fn>): docs_v1.Schema$Request[] => batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);

describe('list_comments reads the doc', () => {
  const doc = reviewedDoc({
    comments: [
      thread('c1', { anchorId: 'a1', plainTextQuote: '30', replies: [{ postId: 'p1', content: 'agreed', author: { displayName: 'Ann' }, createTime: '2026-10-29T11:00:00Z', commentAction: 'RESOLVE' }], status: 'RESOLVED' }),
      thread('c2', { plainTextQuote: 'the old fee schedule' }),
      thread('c3', { anchorId: 'a3', plainTextQuote: 'Acme' }),
    ],
    commentAnchors: {
      a1: { anchorId: 'a1', ranges: [{ startIndex: 12, endIndex: 14 }] },
      a3: { anchorId: 'a3', ranges: [{ startIndex: 0, endIndex: 4, segmentId: 'h1' }] },
    },
  } as ReviewedDocument);

  it('asks for comments, with the suggestions inline that the comment ranges are valid against', async () => {
    const { clients, get } = clientsFor(doc);
    await listComments(clients, 'd');
    expect(get).toHaveBeenCalledWith({ documentId: 'd', ...REVIEW_READ });
    expect(REVIEW_READ).toMatchObject({ includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE', commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED' });
  });

  const [onBody, madeInDrive, onHeader] = readComments(doc);

  it('a comment with a range carries it, its quoted text and the sentence it sits in', () => {
    expect(onBody).toMatchObject({ id: 'c1', quotedText: '30', status: 'resolved', range: { startIndex: 12, endIndex: 14 }, author: 'Sam Lee', time: '2026-10-29T10:00:00Z', content: 'body of c1' });
    expect(onBody.context).toBe('…Pay within ⟦30⟧ days of invoice.⏎…');
  });

  it('its replies carry author, time and the resolve action', () => {
    expect(onBody.replies).toEqual([{ id: 'p1', author: 'Ann', time: '2026-10-29T11:00:00Z', content: 'agreed', action: 'resolve' }]);
  });

  it('a comment made in Drive has no range, and its quote is its context', () => {
    expect(madeInDrive.range).toBeUndefined();
    expect(madeInDrive.context).toBe('the old fee schedule');
    expect(madeInDrive.status).toBe('open');
  });

  it('a comment in a header carries the segment, and its context is read from the header', () => {
    expect(onHeader.range).toMatchObject({ segmentId: 'h1' });
    expect(onHeader.context).toBe('…⟦Acme⟧ letterhead⏎…');
  });

  it('the counts are by range: the body, a header, and the comments with no range', () => {
    expect(commentCounts(doc, undefined)).toEqual({ withRange: 1, withoutRange: 1 });
    expect(commentCounts(doc, undefined, 'h1')).toEqual({ withRange: 1, withoutRange: 1 });
  });

  it('on a doc with tabs, a comment is counted in the tab whose anchors hold its range', () => {
    const tabbed = {
      comments: [thread('c1', { anchorId: 'a1' }), thread('c2', { anchorId: 'a2' })],
      tabs: [
        { tabProperties: { tabId: 't.1' }, documentTab: { body: { content: [paragraph(1, PARAGRAPH)] }, commentAnchors: { a1: { ranges: [{ startIndex: 1, endIndex: 4 }] } } } },
        { tabProperties: { tabId: 't.2' }, documentTab: { body: { content: [paragraph(1, PARAGRAPH)] }, commentAnchors: { a2: { ranges: [{ startIndex: 1, endIndex: 4 }] } } } },
      ],
    } as ReviewedDocument;
    expect(commentCounts(tabbed, 't.1').withRange).toBe(1);
    expect(commentCounts(tabbed, 't.2').withRange).toBe(1);
    expect(commentCounts(tabbed, undefined).withRange).toBe(1);
    expect(readComments(tabbed).map((c) => c.range?.tabId)).toEqual(['t.1', 't.2']);
  });
});

describe('add_comment puts a comment on the text it matches', () => {
  const insertedComment = { replies: [{ insertComment: { commentThread: { commentId: 'new1', plainTextQuote: '30 days' } } }] };

  it('a single match is an insertComment on exactly that range', async () => {
    const { clients, batchUpdate } = clientsFor(reviewedDoc(), insertedComment);
    const result = await addComment(clients, 'd', 'is this firm?', '30 days');
    expect(result).toMatchObject({ status: 'ok', id: 'new1', quotedText: '30 days', range: { startIndex: 12, endIndex: 19 } });
    expect(requestsSent(batchUpdate)).toEqual([{ insertComment: { content: 'is this firm?', range: { startIndex: 12, endIndex: 19, tabId: undefined, segmentId: undefined } } }]);
  });

  it('is matched the way edit_doc matches, so markup in the quote is tolerated', async () => {
    const { clients } = clientsFor(reviewedDoc(), insertedComment);
    expect(await addComment(clients, 'd', 'x', '**30 days**')).toMatchObject({ status: 'ok', range: { startIndex: 12, endIndex: 19 } });
  });

  it('a quote that matches twice is refused with the context of each, and nothing is sent', async () => {
    const twice = reviewedDoc({ body: { content: [paragraph(1, 'Pay in 30 days or 30 days late.')] } });
    const { clients, batchUpdate } = clientsFor(twice);
    const result = await addComment(clients, 'd', 'x', '30 days');
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.matches.map((m) => m.context)).toEqual(['…Pay in ⟦30 days⟧ or 30 days late.⏎…', '…Pay in 30 days or ⟦30 days⟧ late.⏎…']);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('a quote that matches nowhere is refused', async () => {
    const { clients, batchUpdate } = clientsFor(reviewedDoc());
    expect((await addComment(clients, 'd', 'x', 'sixty days')).status).toBe('not_found');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('in a header, the range carries the header segment', async () => {
    const { clients, batchUpdate } = clientsFor(reviewedDoc(), { replies: [{ insertComment: { commentThread: { commentId: 'h', plainTextQuote: 'Acme' } } }] });
    const result = await addComment(clients, 'd', 'logo?', 'Acme', { segment: 'header' });
    expect(result).toMatchObject({ status: 'ok', range: { startIndex: 0, endIndex: 4, segmentId: 'h1' } });
    expect(requestsSent(batchUpdate)[0].insertComment).toMatchObject({ range: { segmentId: 'h1', startIndex: 0, endIndex: 4 } });
  });

  it('in a tab, the range carries the tab', async () => {
    const tabbed = { tabs: [{ tabProperties: { tabId: 't.1' } }, { tabProperties: { tabId: 't.2' }, documentTab: { body: { content: [paragraph(1, PARAGRAPH)] } } }] } as ReviewedDocument;
    const { clients, batchUpdate } = clientsFor(tabbed, insertedComment);
    await addComment(clients, 'd', 'x', '30 days', { tabId: 't.2' });
    expect(requestsSent(batchUpdate)[0].insertComment).toMatchObject({ range: { tabId: 't.2', startIndex: 12, endIndex: 19 } });
  });

  it('asking for a header the doc does not have is refused', async () => {
    const { clients, batchUpdate } = clientsFor(reviewedDoc({ documentStyle: {}, headers: {} }));
    expect((await addComment(clients, 'd', 'x', 'Acme', { segment: 'header' })).status).toBe('no_segment');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('a reply is an addCommentReply', async () => {
    const { clients, batchUpdate } = clientsFor(reviewedDoc(), { replies: [{ addCommentReply: { post: { postId: 'r1' } } }] });
    expect(await replyToComment(clients, 'd', 'c1', 'thanks')).toEqual({ id: 'r1' });
    expect(requestsSent(batchUpdate)).toEqual([{ addCommentReply: { commentId: 'c1', post: { content: 'thanks' } } }]);
  });
});

describe('resolve_comment is guarded by the comment’s quoted text', () => {
  const doc = reviewedDoc({ comments: [thread('c1', { plainTextQuote: 'fee schedule' })] });

  it('resolves with an addCommentReply that carries the RESOLVE action', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    expect(await resolveComment(clients, 'd', 'c1', { expectQuotedText: 'fee schedule' })).toMatchObject({ status: 'ok', commentStatus: 'resolved' });
    expect(requestsSent(batchUpdate)).toEqual([{ addCommentReply: { commentId: 'c1', post: { commentAction: 'RESOLVE' } } }]);
  });

  it('reopens with REOPEN', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    expect(await resolveComment(clients, 'd', 'c1', { expectQuotedText: 'fee schedule', reopen: true })).toMatchObject({ status: 'ok', commentStatus: 'open' });
    expect(requestsSent(batchUpdate)[0].addCommentReply).toMatchObject({ post: { commentAction: 'REOPEN' } });
  });

  it('refuses when the quoted text is not the comment’s, and sends nothing', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await resolveComment(clients, 'd', 'c1', { expectQuotedText: 'not here' });
    expect(result.status).toBe('mismatch');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses a snippet of the quote: the guard is the whole quoted text', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    expect((await resolveComment(clients, 'd', 'c1', { expectQuotedText: 'fee' })).status).toBe('mismatch');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses an id that is not in the doc', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    expect((await resolveComment(clients, 'd', 'gone', { expectQuotedText: 'fee schedule' })).status).toBe('mismatch');
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe('the tool schema', () => {
  async function callTool(name: string, args: Record<string, unknown>) {
    const server = createServer();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client.callTool({ name, arguments: args });
  }

  it('resolve_comment refuses a call with no expectQuotedText', async () => {
    const result = await callTool('resolve_comment', { path: 'd', commentId: 'c1' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('expectQuotedText');
  });

  it('add_comment with neither quotedText nor replyTo is refused', async () => {
    const result = await callTool('add_comment', { path: 'd', content: 'hello' });
    expect(result.isError).toBe(true);
  });
});
