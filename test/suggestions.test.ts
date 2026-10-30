import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import type { ReviewedDocument } from '../src/docs/comments.js';
import { REVIEW_READ } from '../src/docs/comments.js';
import { applySuggestions, countSuggestions, listSuggestions, readSuggestions } from '../src/docs/suggestions.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Run {
  text: string;
  ins?: string[];
  del?: string[];
  style?: string[];
}

function paragraph(startIndex: number, runs: Run[]): docs_v1.Schema$StructuralElement {
  let index = startIndex;
  const elements = runs.map((run) => {
    const element = {
      startIndex: index,
      endIndex: index + run.text.length,
      textRun: {
        content: run.text,
        ...(run.ins ? { suggestedInsertionIds: run.ins } : {}),
        ...(run.del ? { suggestedDeletionIds: run.del } : {}),
        ...(run.style ? { suggestedTextStyleChanges: Object.fromEntries(run.style.map((id) => [id, {}])) } : {}),
      },
    };
    index += run.text.length;
    return element;
  });
  return { startIndex, endIndex: index, paragraph: { elements } };
}

const thread = (suggestionId: string, summaryText: string, displayName = 'Sam Lee', createTime = '2026-10-29T23:38:45Z') => ({ suggestionId, summaryText, status: 'OPEN', headPost: { author: { displayName }, createTime } });

function docWith(content: docs_v1.Schema$StructuralElement[], extra: Partial<ReviewedDocument> = {}): ReviewedDocument {
  return { title: 'Contract', revisionId: 'r1', body: { content }, ...extra } as ReviewedDocument;
}

const PAY = paragraph(1, [{ text: 'Pay within ' }, { text: '45', ins: ['s1'] }, { text: '30', del: ['s1'] }, { text: ' days of invoice.\n' }]);
const REPLACEMENT = docWith([PAY], { suggestions: [thread('s1', 'Replace: “30” with “45”')] });

function clientsFor(doc: ReviewedDocument) {
  const get = vi.fn().mockResolvedValue({ data: doc });
  const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
  const clients = { account: 'a', auth: {} as GoogleClients['auth'], docs: { documents: { get, batchUpdate } } as unknown as GoogleClients['docs'], drive: {} as GoogleClients['drive'] } as GoogleClients;
  return { clients, get, batchUpdate };
}

const requestsSent = (batchUpdate: ReturnType<typeof vi.fn>): docs_v1.Schema$Request[] => batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);

describe('list_suggestions reads the SuggestionThreads of the doc', () => {
  it('asks for suggestions inline with comments included', async () => {
    const { clients, get } = clientsFor(REPLACEMENT);
    await listSuggestions(clients, 'd');
    expect(get).toHaveBeenCalledWith({ documentId: 'd', ...REVIEW_READ });
  });

  it('a replacement: Docs’ summary, the change in its sentence, author and time', () => {
    expect(readSuggestions(REPLACEMENT, undefined)).toEqual([
      { id: 's1', summary: 'Replace: “30” with “45”', context: 'Pay within [30→45] days of invoice.', author: 'Sam Lee', time: '2026-10-29T23:38:45Z' },
    ]);
  });

  it('an insertion has nothing before the arrow, a deletion nothing after it', () => {
    const doc = docWith([paragraph(1, [{ text: 'A' }, { text: ' big', ins: ['i'] }, { text: ' red', del: ['d'] }, { text: ' ball.\n' }])]);
    expect(readSuggestions(doc, undefined).map((s) => [s.id, s.context])).toEqual([
      ['i', 'A[→ big] ball.'],
      ['d', 'A big[ red→] ball.'],
    ]);
  });

  it('another suggestion’s insertion reads as text and its deletion is left out', () => {
    const doc = docWith([paragraph(1, [{ text: 'Pay within ' }, { text: '45', ins: ['a'] }, { text: '30', del: ['a'] }, { text: ' business', ins: ['b'] }, { text: ' days.\n' }])]);
    expect(readSuggestions(doc, undefined).map((s) => s.context)).toEqual(['Pay within [30→45] business days.', 'Pay within 45[→ business] days.']);
  });

  it('a style-only suggestion shows its words unchanged, and its summary says what changed', () => {
    const doc = docWith([paragraph(1, [{ text: 'Pay ', style: ['f'] }, { text: 'within 30 days.\n' }])], { suggestions: [thread('f', 'Format: bold')] });
    expect(readSuggestions(doc, undefined)).toMatchObject([{ id: 'f', summary: 'Format: bold', context: 'Pay within 30 days.' }]);
  });

  it('two identical summaries are told apart by their context', () => {
    const doc = docWith([paragraph(1, [{ text: 'Pay within ' }, { text: '45', ins: ['a'] }, { text: '30', del: ['a'] }, { text: ' days, or ' }, { text: '45', ins: ['b'] }, { text: '30', del: ['b'] }, { text: ' days.\n' }])], {
      suggestions: [thread('a', 'Replace: “30” with “45”'), thread('b', 'Replace: “30” with “45”')],
    });
    expect(new Set(readSuggestions(doc, undefined).map((s) => s.context)).size).toBe(2);
  });

  it('is in document order, across paragraphs and table cells', () => {
    const cell = { content: [paragraph(10, [{ text: 'x', ins: ['in-table'] }, { text: '\n' }])] };
    const doc = docWith([paragraph(1, [{ text: 'a', ins: ['first'] }, { text: '\n' }]), { table: { tableRows: [{ tableCells: [cell] }] } }, paragraph(20, [{ text: 'b', ins: ['last'] }, { text: '\n' }])]);
    expect(readSuggestions(doc, undefined).map((s) => s.id)).toEqual(['first', 'in-table', 'last']);
  });

  it('a long paragraph is cut around the change', () => {
    const long = `${'word '.repeat(40)}`;
    const doc = docWith([paragraph(1, [{ text: long }, { text: 'X', ins: ['s'] }, { text: `${long}\n` }])]);
    const [suggestion] = readSuggestions(doc, undefined);
    expect(suggestion.context).toBe(`…${long.slice(-40)}[→X]${long.slice(0, 40)}…`);
  });

  it('a suggestion that adds a table row is listed with the text of the row', () => {
    const row = { suggestedInsertionIds: ['row'], tableCells: [{ content: [paragraph(5, [{ text: 'Ann\n' }])] }, { content: [paragraph(9, [{ text: '1\n' }])] }] };
    const doc = docWith([{ table: { tableRows: [row] } }]);
    expect(readSuggestions(doc, undefined)).toMatchObject([{ id: 'row', context: 'Ann 1' }]);
  });

  it('a suggestion with no text to show has its summary for context', () => {
    const doc = docWith([paragraph(1, [{ text: 'Hello\n' }])], { documentStyle: { suggestedDocumentStyleChanges: { 'doc-style': {} } }, suggestions: [thread('doc-style', 'Change page setup')] } as Partial<ReviewedDocument>);
    expect(readSuggestions(doc, undefined)).toMatchObject([{ id: 'doc-style', context: 'Change page setup' }]);
  });

  it('a suggestion found nowhere in the content, such as a named style, is listed last from its thread', () => {
    const doc = docWith([paragraph(1, [{ text: 'a', ins: ['s'] }, { text: '\n' }])], { suggestions: [thread('named-style', 'Format normal text: style'), thread('s', 'Add text')] });
    expect(readSuggestions(doc, undefined).map((s) => [s.id, s.context])).toEqual([['s', '[→a]'], ['named-style', 'Format normal text: style']]);
  });

  it('a thread that was accepted or rejected is not listed, though Docs keeps it', () => {
    const doc = docWith([paragraph(1, [{ text: 'a\n' }])], { suggestions: [{ ...thread('gone', 'Add text'), status: 'REJECTED' }, { ...thread('done', 'Add text'), status: 'ACCEPTED' }] });
    expect(readSuggestions(doc, undefined)).toEqual([]);
  });

  it('a suggestion placed in another tab is not listed as one found nowhere', () => {
    const tabbed = {
      suggestions: [thread('s1', 'Add text')],
      tabs: [{ tabProperties: { tabId: 't.1' }, documentTab: { body: { content: [paragraph(1, [{ text: 'x', ins: ['s1'] }, { text: '\n' }])] } } }, { tabProperties: { tabId: 't.2' }, documentTab: { body: { content: [paragraph(1, [{ text: 'y\n' }])] } } }],
    } as ReviewedDocument;
    expect(readSuggestions(tabbed, 't.2')).toEqual([]);
  });

  it('shows a line break inside a change as ⏎', () => {
    const doc = docWith([paragraph(1, [{ text: 'End.' }, { text: '\n', ins: ['p'] }, { text: '\n' }])]);
    expect(readSuggestions(doc, undefined)[0].context).toBe('End.[→⏎]');
  });

  it('a suggestion with no thread has no author', () => {
    expect(readSuggestions(docWith([PAY]), undefined)).toMatchObject([{ id: 's1', summary: '', author: null, time: null }]);
  });

  it('reads the real fixture (2 weeks over 3 weeks)', () => {
    const doc = JSON.parse(readFileSync(path.join(here, 'fixtures/replacement-suggestion.json'), 'utf8')) as ReviewedDocument;
    expect(readSuggestions(doc, doc.tabs?.[0]?.tabProperties?.tabId ?? undefined).map((s) => s.context)).toEqual(['The timeline is [3 weeks→2 weeks].']);
  });
});

describe('suggestions in a tab, a header and a footer', () => {
  const tabbed = {
    title: 'Contract',
    tabs: [
      { tabProperties: { tabId: 't.1' }, documentTab: { body: { content: [paragraph(1, [{ text: 'one', ins: ['s1'] }, { text: '\n' }])] } } },
      {
        tabProperties: { tabId: 't.2' },
        documentTab: {
          documentStyle: { defaultHeaderId: 'h1' },
          headers: { h1: { headerId: 'h1', content: [paragraph(0, [{ text: 'Acme', ins: ['s3'] }, { text: '\n' }])] } },
          body: { content: [paragraph(1, [{ text: 'two', ins: ['s2'] }, { text: '\n' }])] },
        },
      },
    ],
  } as ReviewedDocument;

  it('each tab lists its own', () => {
    expect(readSuggestions(tabbed, 't.1').map((s) => s.id)).toEqual(['s1']);
    expect(readSuggestions(tabbed, 't.2').map((s) => s.id)).toEqual(['s2']);
  });

  it('the body does not list the header’s, and the header lists only its own', () => {
    expect(readSuggestions(tabbed, 't.2', undefined).map((s) => s.id)).not.toContain('s3');
    expect(readSuggestions(tabbed, 't.2', 'h1').map((s) => [s.id, s.context])).toEqual([['s3', '[→Acme]']]);
  });

  it('counts those in the content being replaced', () => {
    expect(countSuggestions(tabbed, 't.1')).toBe(1);
    expect(countSuggestions(tabbed, 't.2')).toBe(1);
    expect(countSuggestions(tabbed, 't.2', 'h1')).toBe(1);
  });

  it('a header the doc does not have is reported, not guessed', async () => {
    const { clients } = clientsFor(REPLACEMENT);
    const result = await listSuggestions(clients, 'd', undefined, { segment: 'footer' });
    expect(result.suggestions).toEqual([]);
    expect(result.message).toContain('no footer');
  });
});

describe('apply_suggestions sends the native accept and reject', () => {
  const context = 'Pay within [30→45] days of invoice.';

  it('an accept is one acceptSuggestion and a reject one rejectSuggestion, in one batch pinned to the revision', async () => {
    const doc = docWith([paragraph(1, [{ text: 'a', ins: ['a'] }, { text: 'b', ins: ['b'] }, { text: '\n' }])]);
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await applySuggestions(clients, 'd', 'Contract', [
      { suggestionId: 'a', decision: 'accept', expectContext: '[→a]b' },
      { suggestionId: 'b', decision: 'reject', expectContext: 'a[→b]' },
    ]);
    expect(result).toEqual({ status: 'ok', resolved: 2 });
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'r1' });
    expect(requestsSent(batchUpdate)).toEqual([{ acceptSuggestion: { suggestionId: 'a' } }, { rejectSuggestion: { suggestionId: 'b' } }]);
  });

  it('touching suggestions are resolved one at a time: no cluster rule, no reconstruction of the text', async () => {
    const doc = docWith([paragraph(1, [{ text: 'Pay within ' }, { text: '45', ins: ['a'] }, { text: '30', del: ['a'] }, { text: ' business', ins: ['b'] }, { text: ' days.\n' }])]);
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await applySuggestions(clients, 'd', 'Contract', [{ suggestionId: 'b', decision: 'accept', expectContext: 'Pay within 45[→ business] days.' }]);
    expect(result.status).toBe('ok');
    expect(requestsSent(batchUpdate)).toEqual([{ acceptSuggestion: { suggestionId: 'b' } }]);
  });

  it('a comment-only user is told in plain words what comment access can resolve (#65)', async () => {
    const { clients, batchUpdate } = clientsFor(REPLACEMENT);
    batchUpdate.mockRejectedValue(new Error('Forbidden requests[0].acceptSuggestion: Write access is required, comment-only access is not sufficient.'));
    await expect(applySuggestions(clients, 'd', 'Contract', [{ suggestionId: 's1', decision: 'accept', expectContext: 'Pay within [30→45] days of invoice.' }])).rejects.toThrow(/can reject your own suggestions only/);
  });

  it('a style-only suggestion resolves like any other', async () => {
    const doc = docWith([paragraph(1, [{ text: 'Pay ', style: ['f'] }, { text: 'within.\n' }])]);
    const { clients, batchUpdate } = clientsFor(doc);
    expect((await applySuggestions(clients, 'd', 'Contract', [{ suggestionId: 'f', decision: 'accept', expectContext: 'Pay within.' }])).status).toBe('ok');
    expect(requestsSent(batchUpdate)).toEqual([{ acceptSuggestion: { suggestionId: 'f' } }]);
  });

  it('refuses an expectTitle that is not the live document’s, and sends nothing', async () => {
    const { clients, batchUpdate } = clientsFor(REPLACEMENT);
    const result = await applySuggestions(clients, 'd', 'Other doc', [{ suggestionId: 's1', decision: 'accept', expectContext: context }]);
    expect(result.status).toBe('wrong_doc');
    expect(result.errors?.[0]).toContain('expectTitle');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses an expectContext that is not the live suggestion’s, and sends nothing', async () => {
    const { clients, batchUpdate } = clientsFor(REPLACEMENT);
    const result = await applySuggestions(clients, 'd', 'Contract', [{ suggestionId: 's1', decision: 'reject', expectContext: 'Pay within [30→60] days of invoice.' }]);
    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toContain('expectContext mismatch');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('one wrong context in several refuses all of them', async () => {
    const doc = docWith([paragraph(1, [{ text: 'a', ins: ['a'] }, { text: 'b', ins: ['b'] }, { text: '\n' }])]);
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await applySuggestions(clients, 'd', 'Contract', [
      { suggestionId: 'a', decision: 'accept', expectContext: '[→a]b' },
      { suggestionId: 'b', decision: 'accept', expectContext: 'WRONG' },
    ]);
    expect(result.status).toBe('error');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses an id that is gone, and an id given twice', async () => {
    const { clients, batchUpdate } = clientsFor(REPLACEMENT);
    const gone = await applySuggestions(clients, 'd', 'Contract', [{ suggestionId: 'nope', decision: 'accept', expectContext: context }]);
    expect(gone.errors?.[0]).toContain('not found');
    const twice = await applySuggestions(clients, 'd', 'Contract', [
      { suggestionId: 's1', decision: 'accept', expectContext: context },
      { suggestionId: 's1', decision: 'reject', expectContext: context },
    ]);
    expect(twice.errors?.[0]).toContain('more than once');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('finds the context in the header when told the segment, and refuses a segment the doc lacks', async () => {
    const doc = {
      title: 'Contract',
      revisionId: 'r1',
      documentStyle: { defaultHeaderId: 'h1' },
      headers: { h1: { headerId: 'h1', content: [paragraph(0, [{ text: 'new', ins: ['h'] }, { text: '\n' }])] } },
      body: { content: [paragraph(1, [{ text: 'body\n' }])] },
    } as ReviewedDocument;
    const { clients, batchUpdate } = clientsFor(doc);
    const resolution = { suggestionId: 'h', decision: 'accept' as const, expectContext: '[→new]' };
    expect((await applySuggestions(clients, 'd', 'Contract', [resolution], undefined, { segment: 'header' })).status).toBe('ok');
    expect(requestsSent(batchUpdate)).toEqual([{ acceptSuggestion: { suggestionId: 'h' } }]);
    expect((await applySuggestions(clients, 'd', 'Contract', [resolution], undefined, { segment: 'footer' })).status).toBe('no_segment');
    expect((await applySuggestions(clients, 'd', 'Contract', [resolution])).status).toBe('error');
  });
});
