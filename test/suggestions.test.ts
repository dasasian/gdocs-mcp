import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import { parseSuggestions } from '../src/docs/suggestions.js';

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
