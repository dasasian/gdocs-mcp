import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GoogleClients } from '../src/google/clients.js';
import { exportDoc, EXPORT_FORMATS } from '../src/drive/export.js';

function clientsFor(bytes = 'PDFBYTES', name = 'Driving Log') {
  const exportFn = vi.fn().mockResolvedValue({ data: new TextEncoder().encode(bytes).buffer });
  const get = vi.fn().mockResolvedValue({ data: { name } });
  const clients = {
    auth: {} as GoogleClients['auth'],
    docs: {} as GoogleClients['docs'],
    drive: { files: { export: exportFn, get } } as unknown as GoogleClients['drive'],
  } as GoogleClients;
  return { clients, exportFn, get };
}

describe('exportDoc (#22)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gdocs-export-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to pdf and names the file after the doc title', async () => {
    const { clients, exportFn } = clientsFor();
    const r = await exportDoc(clients, 'doc1', dir);
    expect(exportFn.mock.calls[0][0]).toEqual({ fileId: 'doc1', mimeType: 'application/pdf' });
    expect(exportFn.mock.calls[0][1]).toEqual({ responseType: 'arraybuffer' });
    expect(r).toMatchObject({ format: 'pdf', bytes: 8, title: 'Driving Log', path: path.join(dir, 'Driving Log.pdf') });
    expect(readFileSync(r.path, 'utf8')).toBe('PDFBYTES');
  });

  it('maps each supported format to its Drive mime type', async () => {
    for (const format of EXPORT_FORMATS) {
      const { clients, exportFn } = clientsFor();
      const r = await exportDoc(clients, 'doc1', dir, { format });
      expect(exportFn.mock.calls[0][0].mimeType).toBeTruthy();
      expect(r.path.endsWith(`.${format}`)).toBe(true);
    }
  });

  it('strips characters a filesystem cannot take from the title', async () => {
    const { clients } = clientsFor('X', 'Q3/Q4: plan?');
    const r = await exportDoc(clients, 'doc1', dir);
    expect(path.basename(r.path)).toBe('Q3-Q4- plan-.pdf');
  });

  it('honours an explicit filename and creates a missing directory', async () => {
    const nested = path.join(dir, 'a', 'b');
    const { clients } = clientsFor();
    const r = await exportDoc(clients, 'doc1', nested, { filename: 'log.pdf' });
    expect(r.path).toBe(path.join(nested, 'log.pdf'));
    expect(existsSync(r.path)).toBe(true);
  });

  it('accepts a doc URL as the id', async () => {
    const { clients, exportFn } = clientsFor();
    await exportDoc(clients, 'https://docs.google.com/document/d/abc123/edit', dir);
    expect(exportFn.mock.calls[0][0].fileId).toBe('abc123');
  });
});
