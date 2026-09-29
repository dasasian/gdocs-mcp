import { describe, it, expect, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import { resolveComment } from '../src/drive/comments.js';

// Verification guards (#10): each mutating tool checks a caller-echoed human-readable
// label against live state and refuses (status 'mismatch') rather than mutate the wrong target.

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
