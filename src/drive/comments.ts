import type { GoogleClients } from '../google/clients.js';

// Spike-validated. `fields` is MANDATORY on Drive comments calls. Note:
// author.emailAddress is not returned (Drive privacy default) — display name only.

export interface CommentReply {
  author: string | null;
  content: string;
  createdTime: string | null;
  action: string | null;
}

export interface DocComment {
  id: string;
  author: string | null;
  createdTime: string | null;
  resolved: boolean;
  quotedText: string | null;
  content: string;
  replies: CommentReply[];
}

const FIELDS =
  'comments(id,author(displayName),content,quotedFileContent(value),resolved,createdTime,replies(author(displayName),content,createdTime,action))';

export async function addComment(
  clients: GoogleClients,
  fileId: string,
  content: string,
): Promise<{ id: string }> {
  const res = await clients.drive.comments.create({
    fileId,
    fields: 'id',
    requestBody: { content },
  });
  return { id: res.data.id ?? '' };
}

export async function replyComment(
  clients: GoogleClients,
  fileId: string,
  commentId: string,
  content: string,
): Promise<{ id: string }> {
  const res = await clients.drive.replies.create({
    fileId,
    commentId,
    fields: 'id',
    requestBody: { content },
  });
  return { id: res.data.id ?? '' };
}

// Resolve (or reopen) a comment = a reply carrying an action. Content is optional
// when an action is set, but Drive requires non-empty content, so we default it.
export async function resolveComment(
  clients: GoogleClients,
  fileId: string,
  commentId: string,
  reopen = false,
): Promise<{ id: string }> {
  const res = await clients.drive.replies.create({
    fileId,
    commentId,
    fields: 'id,action',
    requestBody: { action: reopen ? 'reopen' : 'resolve', content: reopen ? 'Reopened' : 'Resolved' },
  });
  return { id: res.data.id ?? '' };
}

export async function listComments(
  clients: GoogleClients,
  fileId: string,
): Promise<DocComment[]> {
  const res = await clients.drive.comments.list({
    fileId,
    pageSize: 100,
    includeDeleted: false,
    fields: FIELDS,
  });
  return (res.data.comments ?? []).map((c) => ({
    id: c.id ?? '',
    author: c.author?.displayName ?? null,
    createdTime: c.createdTime ?? null,
    resolved: Boolean(c.resolved),
    quotedText: c.quotedFileContent?.value ?? null,
    content: c.content ?? '',
    replies: (c.replies ?? []).map((r) => ({
      author: r.author?.displayName ?? null,
      content: r.content ?? '',
      createdTime: r.createdTime ?? null,
      action: r.action ?? null,
    })),
  }));
}
