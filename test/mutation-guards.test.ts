import { describe, it, expect, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import { overwriteDoc } from '../src/docs/document.js';
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
