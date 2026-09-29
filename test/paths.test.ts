import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { GoogleClients } from '../src/google/clients.js';
import { resolveTab, resolveDocument } from '../src/drive/paths.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

interface FakeTab {
  id: string;
  title: string;
  children?: FakeTab[];
}

function tree(tabs: FakeTab[]): unknown[] {
  return tabs.map((t, index) => ({ tabProperties: { tabId: t.id, title: t.title, index }, ...(t.children ? { childTabs: tree(t.children) } : {}) }));
}

function clientsWith(tabsByDoc: Record<string, FakeTab[]>): GoogleClients {
  const files = [
    { id: 'work', name: 'Work', mimeType: FOLDER, parents: ['ROOT'] },
    { id: 'contract', name: 'Contract', mimeType: DOC, parents: ['work'] },
    { id: 'memo', name: 'Memo', mimeType: DOC, parents: ['work'] },
  ];
  const list = vi.fn().mockImplementation(async (params: { q: string }) => {
    const names = [...params.q.matchAll(/name = '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].toLowerCase());
    return { data: { files: files.filter((f) => names.includes(f.name.toLowerCase())) } };
  });
  const get = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => {
    if (fileId === 'root') return { data: { id: 'ROOT' } };
    const f = files.find((x) => x.id === fileId);
    if (!f) throw new Error('404');
    return { data: f };
  });
  const docsGet = vi.fn().mockImplementation(async ({ documentId }: { documentId: string }) => ({
    data: { title: files.find((f) => f.id === documentId)?.name, tabs: tree(tabsByDoc[documentId] ?? [{ id: 't.0', title: 'Tab 1' }]) },
  }));
  return {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: docsGet } } as unknown as GoogleClients['docs'],
    drive: { files: { list, get }, drives: { list: vi.fn() } } as unknown as GoogleClients['drive'],
  };
}

const CONTRACT = {
  contract: [
    { id: 't.a', title: 'Summary' },
    { id: 't.b', title: 'Part 2', children: [{ id: 't.c', title: 'Ch.4' }] },
  ],
};

describe('resolveTab (#55)', () => {
  it('a doc with one tab means that tab, by path, id or URL', async () => {
    const clients = clientsWith({});
    for (const input of ['/Work/Memo', 'memo', 'https://docs.google.com/document/d/memo/edit']) {
      expect(await resolveTab(clients, input)).toMatchObject({ documentId: 'memo', tabId: 't.0' });
    }
  });

  it('accepts a tab by title, by tabId, nested, and from an id or a ?tab= URL', async () => {
    const clients = clientsWith(CONTRACT);
    const inputs = ['/Work/Contract/Part 2/Ch.4', '/Work/Contract/Part 2/t.c', 'contract/Part 2/Ch.4', 'https://docs.google.com/document/d/contract/edit?tab=t.c'];
    for (const input of inputs) expect(await resolveTab(clients, input)).toMatchObject({ documentId: 'contract', tabId: 't.c', path: expect.stringMatching(/Part 2\/Ch\.4$/) });
  });

  it('refuses a multi-tab doc with no tab step, listing every tab path', async () => {
    const clients = clientsWith(CONTRACT);
    for (const input of ['/Work/Contract', 'contract']) {
      const error = await resolveTab(clients, input).catch((e: Error) => e);
      expect((error as Error).message).toContain('has 3 tabs');
      for (const tabPath of ['Summary', 'Part 2', 'Part 2/Ch.4']) expect((error as Error).message).toContain(`${input.startsWith('/') ? '/Work/Contract' : 'contract'}/${tabPath}`);
    }
  });

  it('refuses two tabs with one name, listing each with its id', async () => {
    const clients = clientsWith({ contract: [{ id: 't.a', title: 'Notes' }, { id: 't.b', title: 'notes' }] });
    const error = await resolveTab(clients, '/Work/Contract/Notes').catch((e: Error) => e);
    expect((error as Error).message).toMatch(/t\.a.*\n.*t\.b/);
  });

  it('refuses a folder, and a tab that does not exist', async () => {
    const clients = clientsWith(CONTRACT);
    await expect(resolveTab(clients, '/Work')).rejects.toThrow(/folder/);
    await expect(resolveTab(clients, '/Work/Contract/Nope')).rejects.toThrow(/No tab named "Nope"/);
  });
});

describe('resolveDocument (#55)', () => {
  it('names the doc for a file-level tool, even for a tab path or a multi-tab doc', async () => {
    const clients = clientsWith(CONTRACT);
    for (const input of ['/Work/Contract', '/Work/Contract/Part 2/Ch.4', 'contract']) {
      expect(await resolveDocument(clients, input)).toEqual({ documentId: 'contract', title: 'Contract' });
    }
  });
});

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'), 'utf8');
const toolBlocks = SRC.split('  server.registerTool(\n').slice(1).map((block) => ({ name: /'([a-z_]+)'/.exec(block)![1], block }));

describe('every doc tool takes one path (#55)', () => {
  const docTools = [
    'read_doc', 'edit_doc', 'overwrite_doc', 'insert_content', 'export_doc', 'get_page_setup', 'set_page_setup', 'insert_image', 'download_images',
    'insert_table', 'edit_table', 'set_table_style', 'get_table_style', 'list_suggestions', 'apply_suggestions', 'list_comments', 'add_comment',
    'resolve_comment', 'list_permissions', 'share_doc', 'unshare_doc',
  ];

  it('has a path input and no documentId or tab input', () => {
    const registered = toolBlocks.map((t) => t.name);
    for (const name of docTools) expect(registered, name).toContain(name);
    for (const { name, block } of toolBlocks.filter((t) => docTools.includes(t.name))) {
      expect(block, name).toMatch(/\bpath: (tab|doc)PathArg/);
      expect(block, name).not.toMatch(/documentId: z\./);
      expect(block, name).not.toMatch(/\btab: z\./);
    }
  });
});
