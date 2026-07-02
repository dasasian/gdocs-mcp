import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import type { Suggestion } from '../src/docs/suggestions.js';
import {
  parseSuggestions,
  formatSuggestionPreview,
  applySuggestion,
  applySuggestions,
  clusterSuggestions,
  resolveRegionText,
} from '../src/docs/suggestions.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('parseSuggestions', () => {
  it('groups an insertion + deletion run into one replacement diff', () => {
    const doc: docs_v1.Schema$Document = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { startIndex: 1, endIndex: 5, textRun: { content: 'new ', suggestedInsertionIds: ['s1'] } },
                { startIndex: 5, endIndex: 9, textRun: { content: 'old ', suggestedDeletionIds: ['s1'] } },
              ],
            },
          },
        ],
      },
    };
    const [s] = parseSuggestions(doc);
    expect(s).toMatchObject({ id: 's1', type: 'replacement', before: 'old ', after: 'new ', start: 1, end: 9, contiguous: true });
  });

  it('classifies a pure insertion', () => {
    const doc: docs_v1.Schema$Document = {
      body: { content: [{ paragraph: { elements: [{ startIndex: 1, endIndex: 4, textRun: { content: 'add', suggestedInsertionIds: ['s2'] } }] } }] },
    };
    const [s] = parseSuggestions(doc);
    expect(s.type).toBe('insertion');
    expect(s.before).toBe('');
    expect(s.after).toBe('add');
  });

  it('parses the real fixture (2 weeks ⇄ 3 weeks)', () => {
    const doc = JSON.parse(readFileSync(path.join(here, 'fixtures/replacement-suggestion.json'), 'utf8')) as docs_v1.Schema$Document;
    const suggestions = parseSuggestions(doc, doc.tabs?.[0]?.tabProperties?.tabId);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ type: 'replacement', before: '3 weeks', after: '2 weeks', contiguous: true });
  });
});

describe('formatSuggestionPreview', () => {
  it('formats an insertion', () => {
    expect(formatSuggestionPreview({ type: 'insertion', before: '', after: 'add' })).toBe('insert: "add"');
  });

  it('formats a deletion', () => {
    expect(formatSuggestionPreview({ type: 'deletion', before: 'old', after: '' })).toBe('delete: "old"');
  });

  it('formats a replacement', () => {
    expect(formatSuggestionPreview({ type: 'replacement', before: '3 weeks', after: '2 weeks' })).toBe('"3 weeks" → "2 weeks"');
  });

  it('formats a style-only change', () => {
    expect(formatSuggestionPreview({ type: 'style', before: '', after: '' })).toBe('(style change)');
  });

  it('trims whitespace so previews match regardless of trailing spaces in the doc', () => {
    expect(formatSuggestionPreview({ type: 'insertion', before: '', after: 'add ' })).toBe('insert: "add"');
  });
});

describe('applySuggestion staleness check', () => {
  const doc: docs_v1.Schema$Document = {
    revisionId: 'rev1',
    body: {
      content: [
        { paragraph: { elements: [{ startIndex: 1, endIndex: 4, textRun: { content: 'add', suggestedInsertionIds: ['s1'] } }] } },
      ],
    },
  };

  function fakeClients(batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients {
    return {
      account: 'test@example.com',
      auth: {} as GoogleClients['auth'],
      docs: {
        documents: {
          get: vi.fn().mockResolvedValue({ data: doc }),
          batchUpdate,
        },
      } as unknown as GoogleClients['docs'],
      drive: {} as GoogleClients['drive'],
    };
  }

  it('refuses to apply when expectedChange does not match the live suggestion', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const clients = fakeClients(batchUpdate);
    const result = await applySuggestion(clients, 'doc1', 's1', 'reject', 'insert: "something else"');
    expect(result.status).toBe('stale');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('applies when expectedChange matches the live suggestion', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const clients = fakeClients(batchUpdate);
    const result = await applySuggestion(clients, 'doc1', 's1', 'reject', 'insert: "add"');
    expect(result.status).toBe('ok');
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });
});

// ---- Cluster-aware resolution (#7) ----

const sug = (id: string, start: number, end: number, type: Suggestion['type'] = 'replacement'): Suggestion => ({
  id,
  type,
  before: '',
  after: '',
  start,
  end,
  contiguous: true,
});

describe('clusterSuggestions', () => {
  it('keeps well-separated suggestions in separate clusters', () => {
    expect(clusterSuggestions([sug('a', 1, 4), sug('b', 10, 13)])).toHaveLength(2);
  });

  it('merges overlapping suggestions into one cluster', () => {
    expect(clusterSuggestions([sug('a', 1, 6), sug('b', 4, 9)])).toEqual([{ ids: ['a', 'b'], start: 1, end: 9 }]);
  });

  it('merges adjacent (touching) suggestions', () => {
    expect(clusterSuggestions([sug('a', 1, 4), sug('b', 4, 7)])).toEqual([{ ids: ['a', 'b'], start: 1, end: 7 }]);
  });

  it('groups a non-contiguous suggestion with the ones it spans across', () => {
    // 'a' spans [1,10); 'b' sits inside at [4,6) — the interleave that corrupts.
    const c = clusterSuggestions([sug('a', 1, 10), sug('b', 4, 6)]);
    expect(c).toHaveLength(1);
    expect([...c[0].ids].sort()).toEqual(['a', 'b']);
  });

  it('excludes style-only suggestions (no text span)', () => {
    expect(clusterSuggestions([sug('s', Infinity, -Infinity, 'style')])).toEqual([]);
  });
});

const run = (start: number, text: string, tag?: { ins?: string; del?: string }) => ({
  start,
  end: start + text.length,
  text,
  ...(tag?.ins ? { insertionId: tag.ins } : {}),
  ...(tag?.del ? { deletionId: tag.del } : {}),
});

describe('resolveRegionText', () => {
  const replacement = [run(1, '2 weeks', { ins: 's' }), run(8, '3 weeks', { del: 's' })];

  it('accept keeps insertions, drops deletions', () => {
    expect(resolveRegionText(replacement, 1, 15, new Map([['s', 'accept']]))).toBe('2 weeks');
  });

  it('reject keeps deletions, drops insertions', () => {
    expect(resolveRegionText(replacement, 1, 15, new Map([['s', 'reject']]))).toBe('3 weeks');
  });

  it('handles interleaved suggestions with mixed decisions and plain text', () => {
    const runs = [run(1, 'new', { ins: 'a' }), run(4, ' mid ', {}), run(9, 'old', { del: 'b' })];
    expect(resolveRegionText(runs, 1, 12, new Map([['a', 'accept'], ['b', 'reject']]))).toBe('new mid old');
    expect(resolveRegionText(runs, 1, 12, new Map([['a', 'reject'], ['b', 'accept']]))).toBe(' mid ');
  });
});

function docFromRuns(runs: { content: string; start: number; ins?: string; del?: string }[]): docs_v1.Schema$Document {
  return {
    revisionId: 'rev1',
    body: {
      content: [
        {
          paragraph: {
            elements: runs.map((r) => ({
              startIndex: r.start,
              endIndex: r.start + r.content.length,
              textRun: {
                content: r.content,
                ...(r.ins ? { suggestedInsertionIds: [r.ins] } : {}),
                ...(r.del ? { suggestedDeletionIds: [r.del] } : {}),
              },
            })),
          },
        },
      ],
    },
  };
}

function clientsFor(doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients {
  return {
    account: 'test@example.com',
    auth: {} as GoogleClients['auth'],
    docs: {
      documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate },
    } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

// A cluster: adjacent insertion 's1' ("new") + deletion 's2' ("old").
const clusterDoc = () =>
  docFromRuns([
    { content: 'new', start: 1, ins: 's1' },
    { content: 'old', start: 4, del: 's2' },
  ]);

describe('applySuggestion — cluster safety (#7)', () => {
  it('refuses to resolve a clustered suggestion and does NOT mutate', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const res = await applySuggestion(clientsFor(clusterDoc(), batchUpdate), 'd', 's1', 'accept', 'insert: "new"');
    expect(res.status).toBe('cluster');
    expect(res.cluster?.map((c) => c.suggestionId).sort()).toEqual(['s1', 's2']);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('resolves an isolated (replacement) suggestion atomically', async () => {
    const doc = docFromRuns([
      { content: '2 weeks', start: 1, ins: 's1' },
      { content: '3 weeks', start: 8, del: 's1' },
    ]);
    const batchUpdate = vi.fn().mockResolvedValue({});
    const res = await applySuggestion(clientsFor(doc, batchUpdate), 'd', 's1', 'accept', '"3 weeks" → "2 weeks"');
    expect(res.status).toBe('ok');
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    const reqs = batchUpdate.mock.calls[0][0].requestBody.requests;
    expect(reqs[0].deleteContentRange.range).toMatchObject({ startIndex: 1, endIndex: 15 });
    expect(reqs[1].insertText).toMatchObject({ text: '2 weeks' });
  });
});

describe('applySuggestions — atomic cluster resolution (#7)', () => {
  it('resolves a full cluster in one batchUpdate with correct merged text', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const res = await applySuggestions(clientsFor(clusterDoc(), batchUpdate), 'd', [
      { suggestionId: 's1', decision: 'accept', expectedChange: 'insert: "new"' },
      { suggestionId: 's2', decision: 'accept', expectedChange: 'delete: "old"' },
    ]);
    expect(res.status).toBe('ok');
    expect(res.resolved).toBe(2);
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    const reqs = batchUpdate.mock.calls[0][0].requestBody.requests;
    expect(reqs[0].deleteContentRange.range).toMatchObject({ startIndex: 1, endIndex: 7 });
    expect(reqs[1].insertText).toMatchObject({ text: 'new' }); // keep insertion, drop deletion
  });

  it('refuses a partially-resolved cluster (incomplete) and does NOT mutate', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const res = await applySuggestions(clientsFor(clusterDoc(), batchUpdate), 'd', [
      { suggestionId: 's1', decision: 'accept', expectedChange: 'insert: "new"' },
    ]);
    expect(res.status).toBe('incomplete');
    expect(res.errors?.[0]).toMatch(/s2/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses on any expectedChange mismatch and does NOT mutate', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const res = await applySuggestions(clientsFor(clusterDoc(), batchUpdate), 'd', [
      { suggestionId: 's1', decision: 'accept', expectedChange: 'insert: "WRONG"' },
      { suggestionId: 's2', decision: 'accept', expectedChange: 'delete: "old"' },
    ]);
    expect(res.status).toBe('error');
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe('applySuggestion — style metadata on edit runs (#7 regression)', () => {
  it('resolves an insertion run that also carries suggestedTextStyleChanges (not treated as style-only)', async () => {
    const doc = {
      revisionId: 'r',
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { startIndex: 1, endIndex: 4, textRun: { content: 'new', suggestedInsertionIds: ['s1'], suggestedTextStyleChanges: { s1: {} } } },
              ],
            },
          },
        ],
      },
    } as unknown as docs_v1.Schema$Document;
    const batchUpdate = vi.fn().mockResolvedValue({});
    const res = await applySuggestion(clientsFor(doc, batchUpdate), 'd', 's1', 'accept', 'insert: "new"');
    expect(res.status).toBe('ok');
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });
});
