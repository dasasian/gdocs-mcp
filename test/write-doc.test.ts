import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { writeDoc } from '../src/docs/document.js';
import { measureLoss, lossSummary, confirmLossToken } from '../src/docs/loss.js';
import { StyleSyntaxError } from '../src/docs/css.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const lossDoc = JSON.parse(readFileSync(path.join(here, 'fixtures', 'loss-doc.json'), 'utf8')) as docs_v1.Schema$Document;

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

function withoutLoss(mutate: (doc: docs_v1.Schema$Document) => void): docs_v1.Schema$Document {
  const copy = JSON.parse(JSON.stringify(lossDoc)) as docs_v1.Schema$Document;
  mutate(copy);
  return copy;
}

function paragraphsOf(doc: docs_v1.Schema$Document): docs_v1.Schema$Paragraph[] {
  return (doc.tabs![0].documentTab!.body!.content ?? []).flatMap((e) => (e.paragraph ? [e.paragraph] : []));
}

describe('the loss summary counts what a read cannot carry (#55)', () => {
  const loss = measureLoss(lossDoc, 't.0', 2);

  it('paragraphs with text', () => expect(loss.paragraphs).toBe(6));
  it('comments, as counted by Drive', () => expect(loss.comments).toBe(2));
  it('suggestions, from suggestedInsertionIds and suggestedDeletionIds', () => expect(loss.suggestions).toBe(1));
  it('tab stops, from paragraphStyle.tabStops', () => {
    expect(loss.tabStops).toBe(2);
    expect(loss.tabStopLines).toEqual(['Signature:', 'Date:']);
  });
  it('person, date and link chips', () => {
    expect([loss.people, loss.dates, loss.richLinks]).toEqual([1, 1, 1]);
  });
  it('links that point at a bookmark', () => expect(loss.bookmarkLinks).toBe(1));

  it('each count drops to zero when its item is removed from the fixture', () => {
    const noTabStops = withoutLoss((d) => paragraphsOf(d).forEach((p) => delete p.paragraphStyle!.tabStops));
    const noChips = withoutLoss((d) => paragraphsOf(d).forEach((p) => (p.elements = p.elements!.filter((e) => !e.person && !(e as { dateElement?: unknown }).dateElement && !e.richLink))));
    const noLinks = withoutLoss((d) => paragraphsOf(d).forEach((p) => p.elements!.forEach((e) => delete e.textRun?.textStyle?.link)));
    const noSuggestions = withoutLoss((d) =>
      paragraphsOf(d).forEach((p) => p.elements!.forEach((e) => {
        delete e.textRun?.suggestedInsertionIds;
        delete e.textRun?.suggestedDeletionIds;
      })),
    );
    expect(measureLoss(noTabStops, 't.0', 0).tabStops).toBe(0);
    expect(measureLoss(noChips, 't.0', 0)).toMatchObject({ people: 0, dates: 0, richLinks: 0 });
    expect(measureLoss(noLinks, 't.0', 0).bookmarkLinks).toBe(0);
    expect(measureLoss(noSuggestions, 't.0', 0).suggestions).toBe(0);
  });

  it('names only what is present, and always the paragraphs', () => {
    expect(lossSummary(loss)).toBe('6 paragraphs, 2 comments, 1 suggestion, 2 tab stops, 1 person chip, 1 date chip, 1 link chip, 1 link to a bookmark or heading');
    expect(lossSummary(measureLoss(withoutLoss(() => undefined), 't.0', 0)).startsWith('6 paragraphs, 1 suggestion')).toBe(true);
  });

  it('a signature line alone reads as one tab stop', () => {
    const signature = withoutLoss((d) => {
      const content = d.tabs![0].documentTab!.body!.content!;
      d.tabs![0].documentTab!.body!.content = content.filter((e) => e.paragraph && /^Signature/.test(e.paragraph.elements![0].textRun?.content ?? ''));
    });
    expect(lossSummary(measureLoss(signature, 't.0', 0))).toBe('1 paragraph, 1 tab stop');
  });
});

interface World {
  revisionId: string;
  comments: number;
  requests: Record<string, unknown>[][];
  writeControls: unknown[];
  created: Record<string, unknown>[];
}

function worldClients(world: World): GoogleClients {
  const files = [
    { id: 'work', name: 'Work', mimeType: FOLDER, parents: ['ROOT'] },
    { id: 'memo', name: 'Memo', mimeType: DOC, parents: ['work'] },
    { id: 'contract', name: 'Contract', mimeType: DOC, parents: ['work'] },
  ];
  const contractTabs = [
    { tabProperties: { tabId: 't.a', title: 'Summary', index: 0 } },
    { tabProperties: { tabId: 't.b', title: 'Part 2', index: 1 }, childTabs: [{ tabProperties: { tabId: 't.c', title: 'Ch.4', index: 0, parentTabId: 't.b' } }] },
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
  const create = vi.fn().mockImplementation(async (p: { requestBody: Record<string, unknown> }) => {
    world.created.push(p.requestBody);
    return { data: { id: 'newdoc' } };
  });
  const docsGet = vi.fn().mockImplementation(async ({ documentId }: { documentId: string }) => {
    if (documentId === 'memo') return { data: { ...lossDoc, revisionId: world.revisionId } };
    if (documentId === 'contract') return { data: { title: 'Contract', revisionId: world.revisionId, tabs: contractTabs } };
    return { data: { title: 'New', revisionId: world.revisionId, tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1', index: 0 } }] } };
  });
  const batchUpdate = vi.fn().mockImplementation(async (p: { requestBody: { requests: Record<string, unknown>[]; writeControl?: unknown } }) => {
    world.requests.push(p.requestBody.requests);
    world.writeControls.push(p.requestBody.writeControl);
    return { data: { replies: p.requestBody.requests.map((r) => ('addDocumentTab' in r ? { addDocumentTab: { tabProperties: { tabId: 't.new' } } } : {})) } };
  });
  return {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: docsGet, batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {
      files: { list, get, create },
      drives: { list: vi.fn() },
      comments: { list: vi.fn().mockImplementation(async () => ({ data: { comments: Array.from({ length: world.comments }, (_, i) => ({ id: `c${i}` })) } })) },
    } as unknown as GoogleClients['drive'],
  };
}

const newWorld = (): World => ({ revisionId: 'rev-1', comments: 2, requests: [], writeControls: [], created: [] });

describe('write_doc creates without asking (#55)', () => {
  it('a new path in a folder creates a doc there', async () => {
    const world = newWorld();
    const r = await writeDoc(worldClients(world), '/Work/Brief', 'hello');
    expect(r).toMatchObject({ status: 'created', kind: 'doc', path: '/Work/Brief', documentId: 'newdoc' });
    expect(world.created).toEqual([{ name: 'Brief', mimeType: DOC, parents: ['work'] }]);
  });

  it('a new path inside a doc creates a tab, then writes into it', async () => {
    const world = newWorld();
    const r = await writeDoc(worldClients(world), '/Work/Contract/Notes', 'hello');
    expect(r).toMatchObject({ status: 'created', kind: 'tab', documentId: 'contract', tabId: 't.new' });
    expect(world.requests[0]).toEqual([{ addDocumentTab: { tabProperties: { title: 'Notes' } } }]);
    expect(JSON.stringify(world.requests[1])).toContain('"tabId":"t.new"');
  });

  it('a new nested path creates a child tab under the tab it names', async () => {
    const world = newWorld();
    await writeDoc(worldClients(world), '/Work/Contract/Part 2/Ch.5', 'hello');
    expect(world.requests[0]).toEqual([{ addDocumentTab: { tabProperties: { title: 'Ch.5', parentTabId: 't.b' } } }]);
  });

  it('a folder id followed by a new name creates a doc in that folder, and a folder URL does too', async () => {
    const world = newWorld();
    const byId = await writeDoc(worldClients(world), 'work/Brief', 'hello');
    const byUrl = await writeDoc(worldClients(world), 'https://drive.google.com/drive/folders/work/Brief2', 'hello');
    expect(byId).toMatchObject({ status: 'created', kind: 'doc', path: 'work/Brief' });
    expect(byUrl).toMatchObject({ status: 'created', kind: 'doc' });
    expect(world.created).toEqual([
      { name: 'Brief', mimeType: DOC, parents: ['work'] },
      { name: 'Brief2', mimeType: DOC, parents: ['work'] },
    ]);
  });

  it('an id followed by a new tab step also creates a tab', async () => {
    const world = newWorld();
    const r = await writeDoc(worldClients(world), 'contract/Notes', 'hello');
    expect(r).toMatchObject({ status: 'created', kind: 'tab' });
  });

  it('a step that is two levels short is not created', async () => {
    const world = newWorld();
    await expect(writeDoc(worldClients(world), '/Work/Nope/Brief', 'hello')).rejects.toThrow(/No folder named "Nope"/);
    expect(world.created).toEqual([]);
  });

  it('bad style fails before anything is created or sent', async () => {
    const world = newWorld();
    await expect(writeDoc(worldClients(world), '/Work/Brief', '<p style="border:1px">a</p>')).rejects.toThrow(StyleSyntaxError);
    await expect(writeDoc(worldClients(world), '/Work/Memo', '<p style="border:1px">a</p>')).rejects.toThrow(StyleSyntaxError);
    expect(world.created).toEqual([]);
    expect(world.requests).toEqual([]);
  });
});

describe('write_doc replaces only when the loss summary is passed back (#55)', () => {
  it('is refused first, naming the paragraph count and everything else lost', async () => {
    const world = newWorld();
    const r = await writeDoc(worldClients(world), '/Work/Memo', 'new text');
    expect(r.status).toBe('confirm_required');
    if (r.status !== 'confirm_required') return;
    expect(r.message).toContain('Replacing "/Work/Memo" removes 6 paragraphs, 2 comments, 1 suggestion, 2 tab stops');
    expect(r.confirmLoss).toBe(confirmLossToken(measureLoss(lossDoc, 't.0', 2), 'rev-1'));
    expect(world.requests).toEqual([]);
  });

  it('proceeds with confirmLoss, pinned to the revision it was computed against', async () => {
    const world = newWorld();
    const clients = worldClients(world);
    const first = await writeDoc(clients, '/Work/Memo', 'new text');
    if (first.status !== 'confirm_required') throw new Error('expected a refusal');
    const second = await writeDoc(clients, '/Work/Memo', 'new text', { confirmLoss: first.confirmLoss });
    expect(second).toMatchObject({ status: 'replaced', path: '/Work/Memo/Tab 1', documentId: 'memo', tabId: 't.0' });
    expect(JSON.stringify(world.requests[0])).toContain('deleteContentRange');
    expect(world.writeControls[0]).toEqual({ requiredRevisionId: 'rev-1' });
  });

  it('is refused again when the doc was edited in between, even if no count changed', async () => {
    const world = newWorld();
    const clients = worldClients(world);
    const first = await writeDoc(clients, '/Work/Memo', 'new text');
    if (first.status !== 'confirm_required') throw new Error('expected a refusal');
    world.revisionId = 'rev-2';
    const second = await writeDoc(clients, '/Work/Memo', 'new text', { confirmLoss: first.confirmLoss });
    expect(second.status).toBe('confirm_required');
    expect(world.requests).toEqual([]);
    if (second.status === 'confirm_required') {
      expect(second.message).toContain('changed since');
      expect(second.confirmLoss).not.toBe(first.confirmLoss);
    }
  });

  it('is refused again when a comment was added in between, which changes no revision', async () => {
    const world = newWorld();
    const clients = worldClients(world);
    const first = await writeDoc(clients, '/Work/Memo', 'new text');
    if (first.status !== 'confirm_required') throw new Error('expected a refusal');
    world.comments = 3;
    const second = await writeDoc(clients, '/Work/Memo', 'new text', { confirmLoss: first.confirmLoss });
    expect(second.status).toBe('confirm_required');
    expect(world.requests).toEqual([]);
  });

  it('a summary from some other doc does not confirm this one', async () => {
    const world = newWorld();
    const r = await writeDoc(worldClients(world), '/Work/Memo', 'new text', { confirmLoss: '0 paragraphs' });
    expect(r.status).toBe('confirm_required');
  });

  it('a multi-tab doc with no tab step is refused, listing every tab path', async () => {
    const world = newWorld();
    const error = await writeDoc(worldClients(world), '/Work/Contract', 'x').catch((e: Error) => e);
    expect((error as Error).message).toContain('/Work/Contract/Summary');
    expect((error as Error).message).toContain('/Work/Contract/Part 2/Ch.4');
    expect(world.requests).toEqual([]);
  });
});
