import { describe, it, expect, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import { listFolder, searchDrive, createFolder, listOrphans, isOrphanFolder } from '../src/drive/files.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

function clientsFor(drive: Partial<GoogleClients['drive']['files']>, calls: { list?: unknown[] } = {}): GoogleClients {
  void calls;
  return {
    auth: {} as GoogleClients['auth'],
    docs: {} as GoogleClients['docs'],
    drive: { files: drive } as unknown as GoogleClients['drive'],
  };
}

// files.list returning two docs that share a parent, plus a name lookup per parent id.
function listing(files: unknown[], names: Record<string, string> = {}) {
  const list = vi.fn().mockResolvedValue({ data: { files } });
  const get = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => {
    if (!(fileId in names)) throw new Error('404');
    return { data: { name: names[fileId] } };
  });
  return { list, get, clients: clientsFor({ list, get }) };
}

describe('parents on drive listings (#26)', () => {
  it('resolves each parent id to a name and asks for it once per distinct id', async () => {
    const { clients, list, get } = listing(
      [
        { id: 'd1', name: 'Lease', mimeType: DOC_MIME, modifiedTime: '2026-01-01T00:00:00Z', parents: ['p1'] },
        { id: 'd2', name: 'Addendum', mimeType: DOC_MIME, modifiedTime: null, parents: ['p1'] },
      ],
      { p1: 'Legal' },
    );
    const entries = await listFolder(clients, 'https://drive.google.com/drive/folders/p1');
    expect(list.mock.calls[0][0].fields).toContain('parents');
    expect(get).toHaveBeenCalledTimes(1);
    expect(entries[0]).toEqual({
      id: 'd1',
      name: 'Lease',
      type: 'document',
      modifiedTime: '2026-01-01T00:00:00Z',
      parents: [{ id: 'p1', name: 'Legal' }],
    });
    expect(entries[1].parents).toEqual([{ id: 'p1', name: 'Legal' }]);
  });

  it('keeps the id and degrades the name when the parent lookup fails', async () => {
    const { clients } = listing([{ id: 'f1', name: 'Onboarding', mimeType: FOLDER_MIME, parents: ['gone'] }]);
    const [entry] = await searchDrive(clients, 'Onboard', 'folder');
    expect(entry.type).toBe('folder');
    expect(entry.parents).toEqual([{ id: 'gone', name: '' }]);
  });

  it('omits parents entirely for an entry that has none (a shared-with-me root item)', async () => {
    const { clients, get } = listing([{ id: 'd1', name: 'Loose', mimeType: DOC_MIME }]);
    const [entry] = await searchDrive(clients, 'Loose');
    expect(entry.parents).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('orphaned files (#46)', () => {
  // files.list paged: each call returns the next page of the fixture.
  function pager(pages: { files: unknown[]; nextPageToken?: string }[]) {
    const list = vi.fn();
    pages.forEach((p) => list.mockResolvedValueOnce({ data: p }));
    return { list, clients: clientsFor({ list }) };
  }

  it('keeps only the files that have no parent', async () => {
    const { clients, list } = pager([
      {
        files: [
          { id: 'd1', name: 'Lease', mimeType: DOC_MIME, parents: ['p1'] },
          { id: 'd2', name: 'Roof', mimeType: DOC_MIME, modifiedTime: '2026-02-02T00:00:00Z' },
          { id: 'd3', name: 'Appliances', mimeType: DOC_MIME, parents: [] },
        ],
      },
    ]);
    const r = await listOrphans(clients);
    expect(r.orphaned.map((e) => e.name)).toEqual(['Roof', 'Appliances']);
    expect(r.orphaned[0]).toEqual({ id: 'd2', name: 'Roof', type: 'document', modifiedTime: '2026-02-02T00:00:00Z' });
    expect(r.scanned).toBe(3);
    expect(r.complete).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  // Shared-with-me files are parentless too, and re-homing them is not the
  // user's to do — the query must exclude them rather than report them as lost.
  it('asks only for files the user owns', async () => {
    const { clients, list } = pager([{ files: [] }]);
    await listOrphans(clients);
    expect(list.mock.calls[0][0].q).toBe("'me' in owners and trashed = false");
  });

  it('follows the page token and counts every file it looked at', async () => {
    const { clients, list } = pager([
      { files: [{ id: 'a', name: 'A', mimeType: DOC_MIME, parents: ['p'] }], nextPageToken: 't1' },
      { files: [{ id: 'b', name: 'B', mimeType: DOC_MIME }] },
    ]);
    const r = await listOrphans(clients);
    expect(list.mock.calls[1][0].pageToken).toBe('t1');
    expect(r.orphaned.map((e) => e.name)).toEqual(['B']);
    expect(r.scanned).toBe(2);
    expect(r.complete).toBe(true);
  });

  // A bound that lies is worse than no bound: a truncated scan must not read as
  // "that is all of them".
  it('reports an incomplete scan when the page cap stops it early', async () => {
    const list = vi.fn().mockResolvedValue({
      data: { files: [{ id: 'x', name: 'X', mimeType: DOC_MIME }], nextPageToken: 'more' },
    });
    const r = await listOrphans(clientsFor({ list }));
    expect(r.complete).toBe(false);
    expect(list).toHaveBeenCalledTimes(10);
    expect(r.scanned).toBe(10);
    expect(r.message).toContain('more remain unchecked');
  });

  it('says so plainly when nothing is orphaned', async () => {
    const { clients } = pager([{ files: [{ id: 'a', name: 'A', mimeType: DOC_MIME, parents: ['p'] }] }]);
    const r = await listOrphans(clients);
    expect(r.orphaned).toEqual([]);
    expect(r.message).toContain('none');
  });

  it('recognises the pseudo-folder without mistaking a real folder id for it', async () => {
    expect(isOrphanFolder('orphaned')).toBe(true);
    expect(isOrphanFolder(' Orphans ')).toBe(true);
    expect(isOrphanFolder('lost+found')).toBe(true);
    expect(isOrphanFolder(undefined)).toBe(false);
    expect(isOrphanFolder('1a2b3c')).toBe(false);
    expect(isOrphanFolder('https://drive.google.com/drive/folders/p1')).toBe(false);
  });
});

describe('createFolder (#25)', () => {
  it('creates a folder in My Drive root when no parent is given', async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: 'new1', name: 'Onboarding', parents: ['root'] } });
    const r = await createFolder(clientsFor({ create }), 'Onboarding');
    expect(create.mock.calls[0][0].requestBody).toEqual({ name: 'Onboarding', mimeType: FOLDER_MIME });
    expect(r).toEqual({ id: 'new1', name: 'Onboarding', parents: ['root'] });
  });

  it('nests under a parent given as a folder URL', async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: 'new2', name: 'Onboarding', parents: ['pA'] } });
    await createFolder(clientsFor({ create }), 'Onboarding', 'https://drive.google.com/drive/folders/pA?usp=sharing');
    expect(create.mock.calls[0][0].requestBody.parents).toEqual(['pA']);
  });
});
