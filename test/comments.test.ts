import { describe, expect, it, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import { countComments, listComments, quotedTexts } from '../src/drive/comments.js';

const TOTAL = 150;
const PAGE = 100;

function clientsWithComments(total: number): { clients: GoogleClients; pageTokensAsked: (string | undefined)[] } {
  const pageTokensAsked: (string | undefined)[] = [];
  const list = vi.fn().mockImplementation(async ({ pageToken }: { pageToken?: string }) => {
    pageTokensAsked.push(pageToken);
    const start = pageToken ? Number(pageToken) : 0;
    const end = Math.min(start + PAGE, total);
    const comments = Array.from({ length: end - start }, (_, i) => ({ id: `c${start + i}`, content: `body ${start + i}`, quotedFileContent: { value: `quote ${start + i}` } }));
    return { data: { comments, ...(end < total ? { nextPageToken: String(end) } : {}) } };
  });
  return { clients: { drive: { comments: { list } } } as unknown as GoogleClients, pageTokensAsked };
}

describe('comments are paged to the end', () => {
  it('list_comments returns all of them, not the first page', async () => {
    const { clients, pageTokensAsked } = clientsWithComments(TOTAL);
    const comments = await listComments(clients, 'doc');
    expect(comments).toHaveLength(TOTAL);
    expect(comments[TOTAL - 1]?.id).toBe(`c${TOTAL - 1}`);
    expect(pageTokensAsked).toEqual([undefined, String(PAGE)]);
  });

  it('the quoted texts cover every page', async () => {
    const { clients } = clientsWithComments(TOTAL);
    expect(await quotedTexts(clients, 'doc')).toHaveLength(TOTAL);
  });

  it('the count covers every page', async () => {
    const { clients } = clientsWithComments(TOTAL);
    expect(await countComments(clients, 'doc')).toBe(TOTAL);
  });

  it('a deleted comment is not listed', async () => {
    const list = vi.fn().mockResolvedValue({ data: { comments: [{ id: 'a' }, { id: 'b', deleted: true }] } });
    const clients = { drive: { comments: { list } } } as unknown as GoogleClients;
    expect((await listComments(clients, 'doc')).map((c) => c.id)).toEqual(['a']);
  });
});
