import { describe, it, expect, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import { driveShell } from '../src/drive/shell.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

interface FakeFile {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
}

// A fake Drive: files.list answers name queries out of the fixture the way the
// real API does — case-folded, and happy to return two files with one name.
interface FakeTab {
  id: string;
  title: string;
  children?: FakeTab[];
}

function tabTree(tabs: FakeTab[]): unknown[] {
  return tabs.map((t, index) => ({
    tabProperties: { tabId: t.id, title: t.title, index },
    ...(t.children ? { childTabs: tabTree(t.children) } : {}),
  }));
}

function driveWith(files: FakeFile[], drives: { id: string; name: string }[] = [], tabsByDoc: Record<string, FakeTab[]> = {}) {
  const calls = { list: [] as Record<string, unknown>[], copy: [] as Record<string, unknown>[], update: [] as Record<string, unknown>[], create: [] as Record<string, unknown>[] };

  const list = vi.fn().mockImplementation(async (params: Record<string, string>) => {
    calls.list.push(params);
    const q = params.q ?? '';
    let out = files.filter((f) => !q.includes('trashed = false') || true);
    const names = [...q.matchAll(/name = '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'").toLowerCase());
    if (names.length) out = out.filter((f) => names.includes(f.name.toLowerCase()));
    const parent = /'([^']+)' in parents/.exec(q);
    if (parent) out = out.filter((f) => (f.parents ?? []).includes(parent[1]));
    if (q.includes('sharedWithMe = true')) out = [];
    if (q.includes("'me' in owners")) out = files.filter((f) => !(f.parents ?? []).length);
    if (q.includes(`mimeType = '${FOLDER}'`)) out = out.filter((f) => f.mimeType === FOLDER);
    if (q.includes('name contains')) {
      const needle = /name contains '([^']*)'/.exec(q)![1].toLowerCase();
      out = files.filter((f) => f.name.toLowerCase().includes(needle));
    }
    return { data: { files: out.map((f) => ({ ...f, mimeType: f.mimeType ?? DOC })) } };
  });

  const get = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => {
    if (fileId === 'root') return { data: { id: 'ROOT' } };
    const f = files.find((x) => x.id === fileId);
    if (!f) throw new Error('404');
    return { data: { id: f.id, name: f.name, mimeType: f.mimeType ?? DOC, parents: f.parents ?? [] } };
  });

  const copy = vi.fn().mockImplementation(async (p: Record<string, unknown>) => {
    calls.copy.push(p);
    return { data: { id: 'copy1', name: 'Copy', parents: ['x'], mimeType: DOC } };
  });
  const update = vi.fn().mockImplementation(async (p: Record<string, unknown>) => {
    calls.update.push(p);
    return { data: { id: 'moved', name: 'Moved', parents: ['x'] } };
  });
  const create = vi.fn().mockImplementation(async (p: Record<string, unknown>) => {
    calls.create.push(p);
    const body = p.requestBody as { name: string; parents?: string[] };
    const made = { id: `new-${body.name}`, name: body.name, mimeType: FOLDER, parents: body.parents ?? [] };
    files.push(made);
    return { data: { id: made.id, name: made.name, parents: made.parents } };
  });

  const tabUpdates: Record<string, unknown>[] = [];
  const docsGet = vi.fn().mockImplementation(async ({ documentId }: { documentId: string }) => {
    const f = files.find((x) => x.id === documentId);
    return { data: { title: f?.name ?? '', tabs: tabTree(tabsByDoc[documentId] ?? [{ id: 't.0', title: 'Tab 1' }]) } };
  });
  const batchUpdate = vi.fn().mockImplementation(async (p: { requestBody: { requests: Record<string, unknown>[] } }) => {
    tabUpdates.push(...p.requestBody.requests);
    return { data: { replies: [{}] } };
  });

  const clients = {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: docsGet, batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {
      files: { list, get, copy, update, create },
      drives: { list: vi.fn().mockResolvedValue({ data: { drives } }) },
    } as unknown as GoogleClients['drive'],
  };
  return { clients, calls, list, copy, update, create, tabUpdates, docsGet };
}

const TREE: FakeFile[] = [
  { id: 'work', name: 'Work', mimeType: FOLDER, parents: ['ROOT'] },
  { id: 'y2026', name: '2026', mimeType: FOLDER, parents: ['work'] },
  { id: 'reports', name: 'Reports', mimeType: FOLDER, parents: ['y2026'] },
  { id: 'lease', name: 'Lease', mimeType: DOC, parents: ['reports'] },
  { id: 'archive', name: 'Archive', mimeType: FOLDER, parents: ['ROOT'] },
];

describe('path resolution (#44)', () => {
  it('walks a whole path in a single files.list call', async () => {
    const { clients, list } = driveWith([...TREE]);
    const r = await driveShell(clients, 'ls', ['/Work/2026/Reports']);
    expect(r.id).toBe('reports');
    // one query for the segment names, one to list the folder's children
    const nameQueries = list.mock.calls.filter((c) => (c[0].q as string).includes("name = "));
    expect(nameQueries).toHaveLength(1);
  });

  // The decoy: a second "Reports" under a different parent must not be reachable
  // through /Work/2026/Reports.
  it('does not take a same-named entry from the wrong parent', async () => {
    const { clients } = driveWith([...TREE, { id: 'decoy', name: 'Reports', mimeType: FOLDER, parents: ['archive'] }]);
    const r = await driveShell(clients, 'ls', ['/Work/2026/Reports']);
    expect(r.id).toBe('reports');
  });

  // Drive permits two files with one name in one parent, which no filesystem the
  // model learned from does. Guessing would hand back the wrong file silently.
  it('refuses a path that matches twice in the same folder, and names both', async () => {
    const { clients } = driveWith([...TREE, { id: 'reports2', name: 'Reports', mimeType: FOLDER, parents: ['y2026'] }]);
    const r = await driveShell(clients, 'ls', ['/Work/2026/Reports']);
    expect(r.status).toBe('ambiguous');
    expect((r.candidates as { id: string }[]).map((c) => c.id).sort()).toEqual(['reports', 'reports2']);
  });

  // Drive folds case on match, so Reports and reports collide even though a
  // Linux-trained prior says they are two different things.
  it('treats a case variant as the same name, and so as a collision', async () => {
    const { clients } = driveWith([...TREE, { id: 'lower', name: 'reports', mimeType: FOLDER, parents: ['y2026'] }]);
    const r = await driveShell(clients, 'ls', ['/Work/2026/Reports']);
    expect(r.status).toBe('ambiguous');
    expect(r.message).toContain('folds case');
  });

  it('says which segment was missing rather than failing blankly', async () => {
    const { clients } = driveWith([...TREE]);
    const r = await driveShell(clients, 'ls', ['/Work/2027/Reports']);
    expect(r.status).toBe('not_found');
    expect(r.message).toContain('2027');
  });

  it('accepts ~ for My Drive', async () => {
    const { clients } = driveWith([...TREE]);
    expect((await driveShell(clients, 'ls', ['~/Work'])).id).toBe('work');
  });

  it('reads anything that is not a path as an id', async () => {
    const { clients } = driveWith([...TREE]);
    expect((await driveShell(clients, 'ls', ['reports'])).id).toBe('reports');
  });
});

describe('ls (#44)', () => {
  it('lists My Drive root with no argument', async () => {
    const { clients } = driveWith([...TREE]);
    const r = await driveShell(clients, 'ls', []);
    expect((r.entries as { name: string }[]).map((e) => e.name).sort()).toEqual(['Archive', 'Work']);
  });

  it('surfaces the parentless files at /lost+found, with the scan report (#46)', async () => {
    const { clients } = driveWith([...TREE, { id: 'roof', name: 'Roof', mimeType: FOLDER }]);
    const r = await driveShell(clients, 'ls', ['/lost+found']);
    expect((r.entries as { name: string }[]).map((e) => e.name)).toEqual(['Roof']);
    expect(r.complete).toBe(true);
    expect(r.scanned).toBe(1);
  });

  it('lists the shared drives at /shared', async () => {
    const { clients } = driveWith([...TREE], [{ id: 'sd1', name: 'Team' }]);
    const r = await driveShell(clients, 'ls', ['/shared']);
    expect((r.entries as { name: string }[]).map((e) => e.name)).toEqual(['Team']);
  });

  it('refuses to list a file as though it were a folder', async () => {
    const { clients } = driveWith([...TREE, { id: 'scan', name: 'Scan', mimeType: 'application/pdf', parents: ['reports'] }]);
    const r = await driveShell(clients, 'ls', ['/Work/2026/Reports/Scan']);
    expect(r.status).toBe('not_a_folder');
  });
});

describe('find (#44)', () => {
  it('searches by name and ignores -name, which means the same thing here', async () => {
    const { clients } = driveWith([...TREE]);
    const r = await driveShell(clients, 'find', ['-name', 'Lease']);
    expect((r.entries as { id: string }[]).map((e) => e.id)).toEqual(['lease']);
  });

  it('restricts to folders with -type d', async () => {
    const { clients, list } = driveWith([...TREE]);
    await driveShell(clients, 'find', ['Reports', '-type', 'd']);
    expect((list.mock.calls.at(-1)![0].q as string)).toContain(FOLDER);
  });

  it('rejects a -type it does not know instead of ignoring it', async () => {
    const { clients } = driveWith([...TREE]);
    expect((await driveShell(clients, 'find', ['x', '-type', 'z'])).status).toBe('error');
  });
});

describe('mkdir (#44)', () => {
  it('creates a folder inside an existing parent', async () => {
    const { clients, create } = driveWith([...TREE]);
    const r = await driveShell(clients, 'mkdir', ['/Work/Drafts']);
    expect(r.status).toBe('ok');
    expect(create.mock.calls[0][0].requestBody).toEqual({ name: 'Drafts', mimeType: FOLDER, parents: ['work'] });
  });

  it('refuses to create intermediate folders without -p', async () => {
    const { clients, create } = driveWith([...TREE]);
    const r = await driveShell(clients, 'mkdir', ['/Work/2027/Q1']);
    expect(r.status).toBe('error');
    expect(r.message).toContain('-p');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates the whole chain with -p', async () => {
    const { clients, create } = driveWith([...TREE]);
    const r = await driveShell(clients, 'mkdir', ['-p', '/Work/2027/Q1']);
    expect(r.status).toBe('ok');
    expect(create.mock.calls.map((c) => (c[0].requestBody as { name: string }).name)).toEqual(['2027', 'Q1']);
  });

  it('is a no-op on a folder that already exists', async () => {
    const { clients, create } = driveWith([...TREE]);
    expect((await driveShell(clients, 'mkdir', ['/Work'])).status).toBe('exists');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('cp (#44)', () => {
  // Drive's files.copy defaults to "Copy of Lease"; `cp file /dir` on a
  // filesystem produces "Lease". The name is set explicitly for that reason.
  it('copies into an existing folder, keeping the source name', async () => {
    const { clients, copy } = driveWith([...TREE]);
    await driveShell(clients, 'cp', ['/Work/2026/Reports/Lease', '/Archive']);
    expect(copy.mock.calls[0][0].requestBody).toEqual({ name: 'Lease', parents: ['archive'] });
  });

  // Creating a second "Lease" in one folder would manufacture the very ambiguity
  // resolvePath refuses to guess through.
  it('refuses to copy into a folder that already holds that name', async () => {
    const { clients, copy } = driveWith([...TREE, { id: 'old', name: 'Lease', mimeType: DOC, parents: ['archive'] }]);
    const r = await driveShell(clients, 'cp', ['/Work/2026/Reports/Lease', '/Archive']);
    expect(r.status).toBe('exists');
    expect(copy).not.toHaveBeenCalled();
  });

  it('copies to a new name when the destination does not exist', async () => {
    const { clients, copy } = driveWith([...TREE]);
    await driveShell(clients, 'cp', ['/Work/2026/Reports/Lease', '/Archive/Lease 2027']);
    expect(copy.mock.calls[0][0].requestBody).toEqual({ name: 'Lease 2027', parents: ['archive'] });
  });

  // Verified live: Drive answers "This file cannot be copied by the user" for a
  // folder, and its own web UI cannot copy one either. The shell prior says
  // `cp -r` works, so the refusal has to explain itself.
  it('refuses to copy a folder, and says -r cannot help', async () => {
    const { clients, copy } = driveWith([...TREE]);
    const r = await driveShell(clients, 'cp', ['-r', '/Work', '/Archive']);
    expect(r.status).toBe('unsupported');
    expect(r.message).toContain('-r does not change that');
    expect(copy).not.toHaveBeenCalled();
  });

  it('refuses to clobber an existing file', async () => {
    const { clients, copy } = driveWith([...TREE, { id: 'old', name: 'Lease', mimeType: DOC, parents: ['archive'] }]);
    const r = await driveShell(clients, 'cp', ['/Work/2026/Reports/Lease', '/Archive/Lease']);
    expect(r.status).toBe('exists');
    expect(copy).not.toHaveBeenCalled();
  });
});

describe('mv (#44)', () => {
  it('moves into an existing folder', async () => {
    const { clients, update } = driveWith([...TREE]);
    const r = await driveShell(clients, 'mv', ['/Work/2026/Reports/Lease', '/Archive']);
    expect(r.status).toBe('ok');
    expect(update.mock.calls[0][0].addParents).toBe('archive');
    expect(update.mock.calls[0][0].removeParents).toBe('reports');
  });

  // Shell semantics, kept exactly: a destination that does not exist is a rename.
  it('renames when the destination does not exist', async () => {
    const { clients, update } = driveWith([...TREE]);
    const r = await driveShell(clients, 'mv', ['/Work/2026/Reports/Lease', '/Archive/Lease 2027']);
    expect((update.mock.calls[0][0].requestBody as { name: string }).name).toBe('Lease 2027');
    expect(r.renamedFrom).toBe('Lease');
  });

  it('refuses to move into a folder that already holds that name', async () => {
    const { clients, update } = driveWith([...TREE, { id: 'old', name: 'Lease', mimeType: DOC, parents: ['archive'] }]);
    const r = await driveShell(clients, 'mv', ['/Work/2026/Reports/Lease', '/Archive']);
    expect(r.status).toBe('exists');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when expectName does not match what the path resolved to', async () => {
    const { clients, update } = driveWith([...TREE]);
    const r = await driveShell(clients, 'mv', ['/Work/2026/Reports/Lease', '/Archive'], { expectName: 'Contract' });
    expect(r.status).toBe('mismatch');
    expect(update).not.toHaveBeenCalled();
  });

  it('proceeds when expectName matches', async () => {
    const { clients, update } = driveWith([...TREE]);
    const r = await driveShell(clients, 'mv', ['/Work/2026/Reports/Lease', '/Archive'], { expectName: 'Lease' });
    expect(r.status).toBe('ok');
    expect(update).toHaveBeenCalled();
  });

  // The prior is wrong in a way that costs you the file: shell `mv` across
  // filesystems leaves you owning it; Drive hands it to the organisation.
  it('refuses to move into a shared drive without acceptOwnershipTransfer', async () => {
    const { clients, update } = driveWith(
      [...TREE, { id: 'teamroot', name: 'Docs', mimeType: FOLDER, parents: ['sd1'] }],
      [{ id: 'sd1', name: 'Team' }],
    );
    const r = await driveShell(clients, 'mv', ['/Work/2026/Reports/Lease', '/shared/Team/Docs']);
    expect(r.status).toBe('ownership_transfer');
    expect(r.message).toContain('cannot move it back out');
    expect(update).not.toHaveBeenCalled();
  });

  it('moves into a shared drive once the transfer is accepted, and says it happened', async () => {
    const { clients, update } = driveWith(
      [...TREE, { id: 'teamroot', name: 'Docs', mimeType: FOLDER, parents: ['sd1'] }],
      [{ id: 'sd1', name: 'Team' }],
    );
    const r = await driveShell(clients, 'mv', ['/Work/2026/Reports/Lease', '/shared/Team/Docs'], {
      acceptOwnershipTransfer: true,
    });
    expect(r.status).toBe('ok');
    expect(r.ownershipTransferred).toBe(true);
    expect(update).toHaveBeenCalled();
  });

  it('names the shared drives it knows when the path names one that does not exist', async () => {
    const { clients } = driveWith([...TREE], [{ id: 'sd1', name: 'Team' }]);
    const r = await driveShell(clients, 'ls', ['/shared/Nope']);
    expect(r.message).toContain('Team');
  });
});

// Flags and operands in any order, because a terminal accepts them that way and
// that is the whole point of borrowing the vocabulary.
describe('argument order (#44)', () => {
  const tree = () => driveWith([...TREE]);

  it('accepts a flag before or after the path', async () => {
    expect((await driveShell(tree().clients, 'ls', ['-la', '/Work'])).id).toBe('work');
    expect((await driveShell(tree().clients, 'ls', ['/Work', '-la'])).id).toBe('work');
  });

  it('accepts -type before or after the search term', async () => {
    expect((await driveShell(tree().clients, 'find', ['-type', 'd', 'Reports'])).query).toBe('Reports');
    expect((await driveShell(tree().clients, 'find', ['Reports', '-type', 'd'])).query).toBe('Reports');
  });

  it('accepts -p before or after the path', async () => {
    const a = tree();
    expect((await driveShell(a.clients, 'mkdir', ['-p', '/Work/x/y'])).status).toBe('ok');
    const b = tree();
    expect((await driveShell(b.clients, 'mkdir', ['/Work/x/y', '-p'])).status).toBe('ok');
  });

  it('accepts -r anywhere among the operands', async () => {
    expect((await driveShell(tree().clients, 'cp', ['/Work', '/Archive', '-r'])).status).toBe('unsupported');
    expect((await driveShell(tree().clients, 'cp', ['/Work', '-r', '/Archive'])).status).toBe('unsupported');
  });

  // `--` is the shell's own end-of-options marker, and pre-trained like the rest.
  it('treats -- as the end of the options', async () => {
    expect((await driveShell(tree().clients, 'ls', ['--', '/Work'])).id).toBe('work');
  });

  it('does not leak -- into a search query', async () => {
    expect((await driveShell(tree().clients, 'find', ['--', 'Reports'])).query).toBe('Reports');
  });

  // An unrecognised -token means different things per command: `ls -la` wants it
  // ignored, `find -2026` wants it searched for.
  it('ignores an unknown flag for ls but searches for one in find', async () => {
    expect((await driveShell(tree().clients, 'ls', ['--color', '/Work'])).id).toBe('work');
    expect((await driveShell(tree().clients, 'find', ['-2026'])).query).toBe('-2026');
  });

  it('still requires both operands for cp and mv', async () => {
    expect((await driveShell(tree().clients, 'mv', ['-r', '/Work'])).status).toBe('error');
  });
});

describe('dispatch (#44)', () => {
  it('lists the available commands when given one it does not have', async () => {
    const { clients } = driveWith([...TREE]);
    const r = await driveShell(clients, 'rm' as 'ls', []);
    expect(r.message).toContain('ls, find, mkdir, cp, mv');
  });
});

const CONTRACT: FakeFile[] = [
  ...TREE,
  { id: 'contract', name: 'Contract', mimeType: DOC, parents: ['work'] },
  { id: 'single', name: 'Memo', mimeType: DOC, parents: ['work'] },
];
const CONTRACT_TABS: Record<string, FakeTab[]> = {
  contract: [
    { id: 't.a', title: 'Summary' },
    { id: 't.b', title: 'Part 2', children: [{ id: 't.c', title: 'Ch.4' }] },
    { id: 't.d', title: 'Notes' },
  ],
};

describe('a doc is a folder of tabs (#55)', () => {
  it('ls <doc> lists its tabs, each with the path to pass back', async () => {
    const { clients } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const r = await driveShell(clients, 'ls', ['/Work/Contract']);
    expect(r.entries).toEqual([
      { type: 'tab', tabId: 't.a', name: 'Summary', index: 0, path: '/Work/Contract/Summary', childTabs: 0 },
      { type: 'tab', tabId: 't.b', name: 'Part 2', index: 1, path: '/Work/Contract/Part 2', childTabs: 1 },
      { type: 'tab', tabId: 't.d', name: 'Notes', index: 2, path: '/Work/Contract/Notes', childTabs: 0 },
    ]);
  });

  it('ls <tab> lists its child tabs, and a step can be a tabId', async () => {
    const { clients } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const byTitle = await driveShell(clients, 'ls', ['/Work/Contract/Part 2']);
    const byId = await driveShell(clients, 'ls', ['/Work/Contract/t.b']);
    expect((byTitle.entries as { name: string }[]).map((e) => e.name)).toEqual(['Ch.4']);
    expect((byTitle.entries as { path: string }[])[0].path).toBe('/Work/Contract/Part 2/Ch.4');
    expect(byId.entries).toEqual(byTitle.entries);
  });

  it('starts from an id or a URL and continues into tabs', async () => {
    const { clients } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const fromId = await driveShell(clients, 'ls', ['contract/Part 2']);
    const fromUrl = await driveShell(clients, 'ls', ['https://docs.google.com/document/d/contract/edit?tab=t.b']);
    expect((fromId.entries as { name: string }[]).map((e) => e.name)).toEqual(['Ch.4']);
    expect(fromUrl.entries).toEqual(fromId.entries);
  });

  it('ls <folder> shows each doc with its tab count', async () => {
    const { clients } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const r = await driveShell(clients, 'ls', ['/Work']);
    const docs = (r.entries as { name: string; tabs?: number }[]).filter((e) => e.name === 'Contract' || e.name === 'Memo');
    expect(docs.map((d) => [d.name, d.tabs])).toEqual([['Contract', 4], ['Memo', 1]]);
  });

  it('refuses two tabs with one name, listing each with its id', async () => {
    const twins = { contract: [{ id: 't.a', title: 'Notes' }, { id: 't.b', title: 'notes' }] };
    const { clients } = driveWith([...CONTRACT], [], twins);
    const r = await driveShell(clients, 'ls', ['/Work/Contract/Notes']);
    expect(r.status).toBe('ambiguous');
    expect((r.candidates as { id: string }[]).map((c) => c.id)).toEqual(['t.a', 't.b']);
  });

  it('refuses a folder and a doc with one name, listing each with its id', async () => {
    const { clients } = driveWith([...CONTRACT, { id: 'contractdir', name: 'contract', mimeType: FOLDER, parents: ['work'] }], [], CONTRACT_TABS);
    const r = await driveShell(clients, 'ls', ['/Work/Contract/Summary']);
    expect(r.status).toBe('ambiguous');
    expect((r.candidates as { id: string }[]).map((c) => c.id).sort()).toEqual(['contract', 'contractdir']);
  });

  it('mv renames a tab', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const r = await driveShell(clients, 'mv', ['/Work/Contract/Notes', '/Work/Contract/Appendix']);
    expect(r.status).toBe('ok');
    expect(tabUpdates).toEqual([{ updateDocumentTabProperties: { tabProperties: { tabId: 't.d', title: 'Appendix' }, fields: 'title' } }]);
  });

  it('mv nests a tab into another tab, keeping its name', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    await driveShell(clients, 'mv', ['/Work/Contract/Notes', '/Work/Contract/Part 2']);
    expect(tabUpdates).toEqual([{ updateDocumentTabProperties: { tabProperties: { tabId: 't.d', parentTabId: 't.b' }, fields: 'parentTabId' } }]);
  });

  it('mv to the doc un-nests a tab, and index reorders it', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    await driveShell(clients, 'mv', ['/Work/Contract/Part 2/Ch.4', '/Work/Contract'], { index: 0 });
    expect(tabUpdates).toEqual([{ updateDocumentTabProperties: { tabProperties: { tabId: 't.c', parentTabId: '', index: 0 }, fields: 'index,parentTabId' } }]);
  });

  it('mv with only an index reorders in place', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    await driveShell(clients, 'mv', ['/Work/Contract/Notes', '/Work/Contract'], { index: 0 });
    expect(tabUpdates).toEqual([{ updateDocumentTabProperties: { tabProperties: { tabId: 't.d', index: 0 }, fields: 'index' } }]);
  });

  it('mv of a tab to another doc or a folder is refused, with the reason', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const toDoc = await driveShell(clients, 'mv', ['/Work/Contract/Notes', '/Work/Memo']);
    const toFolder = await driveShell(clients, 'mv', ['/Work/Contract/Notes', '/Archive']);
    for (const r of [toDoc, toFolder]) {
      expect(r.status).toBe('unsupported');
      expect(r.message).toMatch(/cannot leave its doc/);
    }
    expect(tabUpdates).toEqual([]);
  });

  it('mv refuses to create a second tab with the same name', async () => {
    const clashing = { contract: [{ id: 't.a', title: 'Notes' }, { id: 't.b', title: 'Part 2', children: [{ id: 't.c', title: 'notes' }] }] };
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], clashing);
    const r = await driveShell(clients, 'mv', ['/Work/Contract/Part 2/notes', '/Work/Contract']);
    expect(tabUpdates).toEqual([]);
    expect(r.status).toBe('exists');
  });

  it('mv of a tab onto itself with an index reorders it in place, under the same parent', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const top = await driveShell(clients, 'mv', ['/Work/Contract/Notes', '/Work/Contract/Notes'], { index: 0 });
    const nested = await driveShell(clients, 'mv', ['/Work/Contract/Part 2/Ch.4', '/Work/Contract/Part 2/Ch.4'], { index: 0 });
    expect([top.status, nested.status]).toEqual(['ok', 'ok']);
    expect(tabUpdates).toEqual([
      { updateDocumentTabProperties: { tabProperties: { tabId: 't.d', index: 0 }, fields: 'index' } },
      { updateDocumentTabProperties: { tabProperties: { tabId: 't.c', index: 0 }, fields: 'index' } },
    ]);
  });

  it('mv of a tab onto itself with no index changes nothing and says so', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const r = await driveShell(clients, 'mv', ['/Work/Contract/Notes', '/Work/Contract/Notes']);
    expect(r).toMatchObject({ status: 'ok', unchanged: true });
    expect(tabUpdates).toEqual([]);
  });

  it('mv of a tab under itself or its own descendant is refused', async () => {
    const { clients, tabUpdates } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const underItself = await driveShell(clients, 'mv', ['/Work/Contract/Part 2', '/Work/Contract/Part 2/Part 2']);
    const underChild = await driveShell(clients, 'mv', ['/Work/Contract/Part 2', '/Work/Contract/Part 2/Ch.4']);
    const underChildByName = await driveShell(clients, 'mv', ['/Work/Contract/Part 2', '/Work/Contract/Part 2/Ch.4/Deeper']);
    for (const r of [underItself, underChild, underChildByName]) {
      expect(r.status).not.toBe('ok');
      expect(r.message).toMatch(/itself|its own/);
    }
    expect(tabUpdates).toEqual([]);
  });

  it('cp of a tab is refused', async () => {
    const { clients } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const r = await driveShell(clients, 'cp', ['/Work/Contract/Notes', '/Archive']);
    expect(r.status).toBe('unsupported');
  });

  it('a folder id or folder URL starts a path, and the walk goes on into a doc and its tabs', async () => {
    const { clients } = driveWith([...CONTRACT], [], CONTRACT_TABS);
    const byId = await driveShell(clients, 'ls', ['work/Contract/Part 2']);
    const byUrl = await driveShell(clients, 'ls', ['https://drive.google.com/drive/folders/work']);
    expect((byId.entries as { name: string }[]).map((e) => e.name)).toEqual(['Ch.4']);
    expect((byUrl.entries as { name: string }[]).map((e) => e.name)).toContain('Contract');
    expect(byUrl.id).toBe('work');
  });
});
