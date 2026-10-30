import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { editDoc } from '../src/docs/edit.js';
import { addComment } from '../src/docs/add-comment.js';
import { segmentForWrite } from '../src/docs/segments.js';
import { renderMarkdownInto } from '../src/docs/render.js';
import { bodyDocWithTable, plain } from './table-fixtures.js';

const oneParagraph = (text: string): docs_v1.Schema$Document => ({
  revisionId: 'r1',
  body: { content: [{ startIndex: 1, endIndex: text.length + 2, paragraph: { elements: [{ startIndex: 1, endIndex: text.length + 2, textRun: { content: `${text}\n` } }] } }] },
});

function clientsFor(doc: docs_v1.Schema$Document, replies: docs_v1.Schema$Response[] = []) {
  const get = vi.fn().mockResolvedValue({ data: doc });
  const batchUpdate = vi.fn().mockResolvedValue({ data: { replies } });
  const clients: GoogleClients = {
    account: 'a',
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get, batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
  return { clients, get };
}

const modesOf = (get: ReturnType<typeof vi.fn>): unknown[] => get.mock.calls.map((call) => call[0].suggestionsViewMode);

describe('every read of the text sets the suggestions view mode (#65, DESIGN §5)', () => {
  it('add_comment', async () => {
    const { clients, get } = clientsFor(oneParagraph('Pay within 30 days.'));
    await addComment(clients, 'd', 'check', '30');
    expect(modesOf(get)).toEqual(['SUGGESTIONS_INLINE']);
  });

  it('the re-read after a header is created', async () => {
    const doc = { ...oneParagraph('Body'), documentStyle: { defaultHeaderId: 'h1' }, headers: { h1: { headerId: 'h1', content: [] } } };
    const { clients, get } = clientsFor(doc);
    const created = await segmentForWrite(clients, 'd', oneParagraph('Body'), { segment: 'header' });
    expect(created).toMatchObject({ segmentId: 'h1' });
    expect(modesOf(get)).toEqual(['SUGGESTIONS_INLINE']);
  });

  it('both reads around a table insert', async () => {
    const { clients, get } = clientsFor(oneParagraph('Body'));
    await renderMarkdownInto(clients, 'd', '| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(modesOf(get)).toEqual(['SUGGESTIONS_INLINE', 'SUGGESTIONS_INLINE']);
  });

  it('the read after the rows of a table edit are changed', async () => {
    const { clients, get } = clientsFor(bodyDocWithTable({ rows: [plain('Item', 'Price'), plain('Cake', '5')] }));
    get.mockResolvedValueOnce({ data: bodyDocWithTable({ rows: [plain('Item', 'Price'), plain('Cake', '5')] }) });
    get.mockResolvedValue({ data: bodyDocWithTable({ rows: [plain('Item', 'Price'), plain('Cake', '5'), plain('', '')] }) });
    await editDoc(clients, 'd', '| Cake | 5 |', '| Cake | 5 |\n| Pie | 6 |');
    expect(get.mock.calls.length).toBeGreaterThan(1);
    expect(modesOf(get).every((mode) => mode === 'SUGGESTIONS_INLINE')).toBe(true);
  });
});
