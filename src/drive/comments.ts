import type { drive_v3 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';


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

const LIST_FIELDS =
  'nextPageToken,comments(id,author(displayName),content,quotedFileContent(value),resolved,createdTime,deleted,replies(author(displayName),content,createdTime,action))';

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

export async function resolveComment(
  clients: GoogleClients,
  fileId: string,
  commentId: string,
  reopen = false,
  opts: { expectQuote?: string } = {},
): Promise<{ status: 'ok' | 'mismatch'; id?: string; message?: string }> {
  if (opts.expectQuote !== undefined) {
    const c = (
      await clients.drive.comments.get({ fileId, commentId, fields: 'quotedFileContent/value,content' })
    ).data;
    const hay = `${c.quotedFileContent?.value ?? ''}\n${c.content ?? ''}`;
    if (!hay.includes(opts.expectQuote)) {
      return {
        status: 'mismatch',
        message: `expectQuote "${opts.expectQuote}" not found in comment (quoted="${c.quotedFileContent?.value ?? ''}", body="${c.content ?? ''}"). Re-check list_comments — this id may be a different comment.`,
      };
    }
  }
  const res = await clients.drive.replies.create({
    fileId,
    commentId,
    fields: 'id,action',
    requestBody: { action: reopen ? 'reopen' : 'resolve', content: reopen ? 'Reopened' : 'Resolved' },
  });
  return { status: 'ok', id: res.data.id ?? '' };
}

const COMMENTS_PAGE_SIZE = 100;

/** Every live comment on the file, paged to the end. `fields` must name `nextPageToken` and `deleted`. */
export async function allComments(clients: GoogleClients, fileId: string, fields: string): Promise<drive_v3.Schema$Comment[]> {
  const comments: drive_v3.Schema$Comment[] = [];
  let pageToken: string | undefined;
  do {
    const res = await clients.drive.comments.list({ fileId, pageSize: COMMENTS_PAGE_SIZE, pageToken, includeDeleted: false, fields });
    comments.push(...(res.data.comments ?? []).filter((c) => !c.deleted));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return comments;
}

export async function listComments(clients: GoogleClients, fileId: string): Promise<DocComment[]> {
  const comments = await allComments(clients, fileId, LIST_FIELDS);
  return comments.map((c) => ({
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

/** The quoted text of every comment on the file that has any, whether resolved or not. */
export async function quotedTexts(clients: GoogleClients, fileId: string): Promise<string[]> {
  const comments = await allComments(clients, fileId, 'nextPageToken,comments(quotedFileContent(value),deleted)');
  return comments.flatMap((c) => (c.quotedFileContent?.value ? [c.quotedFileContent.value] : []));
}

/** How many live comments the file has. */
export async function countComments(clients: GoogleClients, fileId: string): Promise<number> {
  return (await allComments(clients, fileId, 'nextPageToken,comments(id,deleted)')).length;
}
