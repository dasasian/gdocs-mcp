import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { google } from 'googleapis';
import { editDoc } from '../src/docs/edit.js';
import { refuseUnsuggestable, SuggestRefusal, suggestingClients } from '../src/docs/suggest.js';
import { bodyDocWithTable, plain } from './table-fixtures.js';

const PARAGRAPH = 'Pay within 30 days of invoice.';

const paragraphDoc = (): docs_v1.Schema$Document => ({
  revisionId: 'r1',
  body: { content: [{ startIndex: 1, endIndex: PARAGRAPH.length + 2, paragraph: { elements: [{ startIndex: 1, endIndex: PARAGRAPH.length + 2, textRun: { content: `${PARAGRAPH}\n` } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } }] },
});

function clientsFor(doc: docs_v1.Schema$Document, createdSuggestionIds: string[] = ['suggest.a']) {
  const get = vi.fn().mockResolvedValue({ data: doc });
  const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [], suggestionResponses: [{ createdSuggestionIds }] } });
  const clients = { account: 'a', auth: {} as GoogleClients['auth'], docs: { documents: { get, batchUpdate } } as unknown as GoogleClients['docs'], drive: {} as GoogleClients['drive'] } as GoogleClients;
  return { clients, get, batchUpdate };
}

const requestNames = (batchUpdate: ReturnType<typeof vi.fn>): string[] => batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests.map((r: docs_v1.Schema$Request) => Object.keys(r)[0]));

describe('a suggested edit_doc', () => {
  it('sends the same requests with writeMode SUGGEST, keeping the revision check', async () => {
    const direct = clientsFor(paragraphDoc());
    await editDoc(direct.clients, 'd', '30 days', '45 days');
    const suggested = clientsFor(paragraphDoc());
    await editDoc(suggested.clients, 'd', '30 days', '45 days', { suggest: true });
    expect(suggested.batchUpdate).toHaveBeenCalledTimes(1);
    expect(suggested.batchUpdate.mock.calls[0][0].requestBody.requests).toEqual(direct.batchUpdate.mock.calls[0][0].requestBody.requests);
    expect(suggested.batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'r1', writeMode: 'SUGGEST' });
  });

  it('lists the ids of the suggestions it made', async () => {
    const { clients } = clientsFor(paragraphDoc(), ['suggest.qfm833r2i6yr']);
    expect(await editDoc(clients, 'd', '30 days', '45 days', { suggest: true })).toMatchObject({ status: 'ok', suggestions: ['suggest.qfm833r2i6yr'] });
  });

  it('an id Docs reports twice is listed once', async () => {
    const { clients } = clientsFor(paragraphDoc(), ['suggest.a', 'suggest.a']);
    expect((await editDoc(clients, 'd', '30 days', '45 days', { suggest: true })).suggestions).toEqual(['suggest.a']);
  });

  it('is not sent as a suggestion unless asked, and then names no suggestions', async () => {
    const { clients, batchUpdate } = clientsFor(paragraphDoc());
    const result = await editDoc(clients, 'd', '30 days', '45 days');
    expect(batchUpdate.mock.calls[0][0].requestBody.writeControl).toEqual({ requiredRevisionId: 'r1' });
    expect(result.suggestions).toBeUndefined();
  });

  it('a refusal such as not_found carries no suggestions', async () => {
    const { clients } = clientsFor(paragraphDoc());
    const result = await editDoc(clients, 'd', 'absent', 'x', { suggest: true });
    expect(result).toMatchObject({ status: 'not_found' });
    expect(result.suggestions).toBeUndefined();
  });
});

describe('what Docs cannot suggest is refused before anything is sent', () => {
  it.each([
    ['addDocumentTab', 'a new tab'],
    ['updateDocumentTabProperties', 'renaming, moving or nesting a tab'],
    ['deleteHeader', 'deleting a header'],
    ['deleteFooter', 'deleting a footer'],
    ['createNamedRange', 'a named range'],
    ['deleteNamedRange', 'a named range'],
    ['updateTableColumnProperties', 'a table column width'],
  ])('%s is refused, naming it', (request, what) => {
    expect(() => refuseUnsuggestable([{ insertText: { text: 'x' } }, { [request]: {} } as docs_v1.Schema$Request])).toThrow(new RegExp(`${what}.*${request}`));
  });

  it('a request Docs can suggest passes', () => {
    expect(() => refuseUnsuggestable([{ insertText: { text: 'x' } }, { updateTableCellStyle: {} }, { insertInlineImage: {} }, { updateDocumentStyle: {} }])).not.toThrow();
  });

  it('the suggesting clients refuse a batch that holds one, and send nothing', async () => {
    const { clients, batchUpdate } = clientsFor(paragraphDoc());
    const made: string[] = [];
    const suggesting = suggestingClients(clients, made);
    await expect(suggesting.docs.documents.batchUpdate({ documentId: 'd', requestBody: { requests: [{ insertText: { text: 'x' } }, { updateTableColumnProperties: {} } as docs_v1.Schema$Request] } })).rejects.toThrow(SuggestRefusal);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('works on the real googleapis client, whose documents property cannot be replaced', async () => {
    const docs = google.docs({ version: 'v1' });
    const sent = vi.spyOn(docs.documents, 'batchUpdate').mockResolvedValue({ data: { suggestionResponses: [{ createdSuggestionIds: ['suggest.real'] }] } } as never);
    const made: string[] = [];
    const suggesting = suggestingClients({ account: 'a', auth: {} as GoogleClients['auth'], docs, drive: {} as GoogleClients['drive'] }, made);
    await suggesting.docs.documents.batchUpdate({ documentId: 'd', requestBody: { requests: [{ insertText: { text: 'x' } }] } });
    expect(sent.mock.calls[0][0]).toMatchObject({ requestBody: { writeControl: { writeMode: 'SUGGEST' } } });
    expect(made).toEqual(['suggest.real']);
    expect(suggesting.docs.documents.get).toBe(docs.documents.get);
  });

  it('the suggesting clients leave reads alone', async () => {
    const { clients, get } = clientsFor(paragraphDoc());
    await suggestingClients(clients, []).docs.documents.get({ documentId: 'd' });
    expect(get).toHaveBeenCalledWith({ documentId: 'd' });
  });

  it('a new table with a column width is refused with nothing sent', async () => {
    const { clients, batchUpdate } = clientsFor(paragraphDoc());
    const table = '<table>\n<col style="width:120pt"><col>\n<tr><td>a</td><td>b</td></tr>\n</table>';
    await expect(editDoc(clients, 'd', 'Pay within', `Pay within\n\n${table}`, { suggest: true })).rejects.toThrow(/a table column width.*updateTableColumnProperties/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('a table edit that changes a column width is refused with nothing sent', async () => {
    const fixed = (width: number) => [{ widthType: 'FIXED_WIDTH' as const, width: { magnitude: width, unit: 'PT' as const } }, { widthType: 'EVENLY_DISTRIBUTED' as const }];
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('a', 'b')], columns: fixed(120) }));
    await expect(editDoc(clients, 'd', '<col style="width:120pt">', '<col style="width:200pt">', { suggest: true })).rejects.toThrow(/a table column width/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('a table edit that leaves the widths alone can be suggested', async () => {
    const fixed = [{ widthType: 'FIXED_WIDTH' as const, width: { magnitude: 120, unit: 'PT' as const } }, { widthType: 'EVENLY_DISTRIBUTED' as const }];
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('a', 'b')], columns: fixed }));
    const result = await editDoc(clients, 'd', '<td>a</td>', '<td style="background:#eeeeee">a</td>', { suggest: true });
    expect(result).toMatchObject({ status: 'ok', suggestions: ['suggest.a'] });
    expect(requestNames(batchUpdate)).toEqual(['updateTableCellStyle']);
    expect(batchUpdate.mock.calls[0][0].requestBody.writeControl.writeMode).toBe('SUGGEST');
  });
});
