import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { parseSuggestions, formatSuggestionPreview, applySuggestion } from '../src/docs/suggestions.js';

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
