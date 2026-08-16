import { describe, it, expect, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import { listFolder, searchDrive, createFolder } from '../src/drive/files.js';

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
