import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { deleteTab, moveDoc, overwriteDoc } from '../src/docs/document.js';
import { resolveComment } from '../src/drive/comments.js';

// Verification guards (#10): each mutating tool checks a caller-echoed human-readable
// label against live state and refuses (status 'mismatch') rather than mutate the wrong target.

function docClients(data: unknown, batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: {
      documents: { get: vi.fn().mockResolvedValue({ data }), batchUpdate },
    } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

const tabDoc = {
  title: 'My Doc',
  tabs: [{ tabProperties: { tabId: 't.0', title: 'Chapter 1' } }],
} as unknown as docs_v1.Schema$Document;

describe('deleteTab guard', () => {
  it('refuses when expectTitle does not match the live tab title', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const r = await deleteTab(docClients(tabDoc, batchUpdate), 'd', 't.0', { expectTitle: 'Chapter 9' });
    expect(r.status).toBe('mismatch');
    expect(r.title).toBe('Chapter 1');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('deletes when the title matches', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const r = await deleteTab(docClients(tabDoc, batchUpdate), 'd', 't.0', { expectTitle: 'Chapter 1' });
    expect(r.status).toBe('ok');
    expect(batchUpdate).toHaveBeenCalledOnce();
  });

  it('reports not_found for an unknown tabId', async () => {
    const r = await deleteTab(docClients(tabDoc), 'd', 't.9', { expectTitle: 'x' });
    expect(r.status).toBe('not_found');
  });
});

describe('overwriteDoc guard', () => {
  it('refuses when expectTitle does not match', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const r = await overwriteDoc(docClients({ title: 'Real', body: { content: [] } }, batchUpdate), 'd', 'hi', {
      expectTitle: 'Wrong',
    });
    expect(r.status).toBe('mismatch');
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe('moveDoc guard', () => {
  function moveClients(name: string): GoogleClients {
    return {
      auth: {} as GoogleClients['auth'],
      docs: {} as GoogleClients['docs'],
      drive: {
        files: {
          get: vi.fn().mockResolvedValue({ data: { parents: ['p0'], name } }),
          update: vi.fn().mockResolvedValue({ data: { parents: ['f1'] } }),
        },
      } as unknown as GoogleClients['drive'],
    };
  }
  it('refuses when expectTitle does not match the file name', async () => {
    const r = await moveDoc(moveClients('Actual Doc'), 'd', 'https://drive.google.com/drive/folders/f1', {
      expectTitle: 'Other Doc',
    });
    expect(r.status).toBe('mismatch');
  });
  it('moves when the name matches', async () => {
    const r = await moveDoc(moveClients('Actual Doc'), 'd', 'f1', { expectTitle: 'Actual Doc' });
    expect(r.status).toBe('ok');
    expect(r.parents).toEqual(['f1']);
  });
});

describe('resolveComment guard', () => {
  function commentClients(quoted: string, replies = vi.fn().mockResolvedValue({ data: { id: 'r1' } })): GoogleClients {
    return {
      auth: {} as GoogleClients['auth'],
      docs: {} as GoogleClients['docs'],
      drive: {
        comments: { get: vi.fn().mockResolvedValue({ data: { quotedFileContent: { value: quoted }, content: '' } }) },
        replies: { create: replies },
      } as unknown as GoogleClients['drive'],
    };
  }
  it('refuses when expectQuote is absent from the comment', async () => {
    const replies = vi.fn().mockResolvedValue({ data: { id: 'r1' } });
    const r = await resolveComment(commentClients('fee schedule', replies), 'd', 'c1', false, { expectQuote: 'not here' });
    expect(r.status).toBe('mismatch');
    expect(replies).not.toHaveBeenCalled();
  });
  it('resolves when expectQuote matches', async () => {
    const r = await resolveComment(commentClients('the fee schedule table'), 'd', 'c1', false, { expectQuote: 'fee schedule' });
    expect(r.status).toBe('ok');
    expect(r.id).toBe('r1');
  });
});
