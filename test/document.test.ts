import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDriveId, resolveContentSource, copyDoc } from '../src/docs/document.js';
import type { GoogleClients } from '../src/google/clients.js';

describe('resolveContentSource', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gdocs-content-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes inline content through unchanged', async () => {
    expect(await resolveContentSource({ content: '# Hi', baseDir: '/x' })).toEqual({ content: '# Hi', baseDir: '/x' });
  });

  it('reads contentFile and defaults baseDir to the file folder', async () => {
    const file = path.join(dir, 'lease.md');
    writeFileSync(file, '# Lease\n\nbody text');
    expect(await resolveContentSource({ contentFile: file })).toEqual({ content: '# Lease\n\nbody text', baseDir: dir });
  });

  it('keeps an explicit baseDir and resolves a relative contentFile against it', async () => {
    writeFileSync(path.join(dir, 'doc.md'), 'relative body');
    expect(await resolveContentSource({ contentFile: 'doc.md', baseDir: dir })).toEqual({ content: 'relative body', baseDir: dir });
  });

  it('throws when both content and contentFile are given', async () => {
    await expect(resolveContentSource({ content: 'x', contentFile: '/a.md' })).rejects.toThrow(/not both/);
  });

  it('throws when the file does not exist', async () => {
    await expect(resolveContentSource({ contentFile: path.join(dir, 'missing.md') })).rejects.toThrow();
  });
});

describe('parseDriveId', () => {
  it('extracts a folder id from a Drive folder URL', () => {
    expect(parseDriveId('https://drive.google.com/drive/folders/1AbC_dEf-123?usp=sharing')).toBe('1AbC_dEf-123');
  });
  it('extracts a doc id from a Docs URL', () => {
    expect(parseDriveId('https://docs.google.com/document/d/12w2cyDJ_x-Y/edit?tab=t.0#h')).toBe('12w2cyDJ_x-Y');
  });
  it('passes a raw id through', () => {
    expect(parseDriveId('1AbC_dEf-123')).toBe('1AbC_dEf-123');
  });
  it('strips query/hash from a raw id', () => {
    expect(parseDriveId('1AbC_dEf-123?x=1')).toBe('1AbC_dEf-123');
  });
});

describe('copyDoc (#24)', () => {
  const clientsFor = (copy: ReturnType<typeof vi.fn>) =>
    ({
      auth: {} as GoogleClients['auth'],
      docs: {} as GoogleClients['docs'],
      drive: { files: { copy } } as unknown as GoogleClients['drive'],
    }) as GoogleClients;

  it('sends an empty body when neither name nor folder is given (Drive picks "Copy of …")', async () => {
    const copy = vi.fn().mockResolvedValue({ data: { id: 'c1', name: 'Copy of Lease', parents: ['p1'] } });
    const r = await copyDoc(clientsFor(copy), 'src1');
    expect(copy.mock.calls[0][0]).toMatchObject({ fileId: 'src1', requestBody: {} });
    expect(r).toEqual({
      documentId: 'c1',
      name: 'Copy of Lease',
      parents: ['p1'],
      url: 'https://docs.google.com/document/d/c1/edit',
    });
  });

  it('passes a new name and a folder parsed from a URL', async () => {
    const copy = vi.fn().mockResolvedValue({ data: { id: 'c2', name: 'Lease 2027', parents: ['pA'] } });
    const r = await copyDoc(clientsFor(copy), 'src2', {
      name: 'Lease 2027',
      folder: 'https://drive.google.com/drive/folders/pA',
    });
    expect(copy.mock.calls[0][0].requestBody).toEqual({ name: 'Lease 2027', parents: ['pA'] });
    expect(r.folderId).toBe('pA');
  });
});
