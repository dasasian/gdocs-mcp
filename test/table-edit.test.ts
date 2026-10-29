import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { editDoc } from '../src/docs/edit.js';
import { renderMarkdown } from '../src/docs/transformer.js';
import { StyleSyntaxError } from '../src/docs/css.js';
import { bodyDocWithTable, plain, type TableSpec } from './table-fixtures.js';

function clientsFor(doc: docs_v1.Schema$Document) {
  const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [] } });
  const clients: GoogleClients = {
    account: 'a',
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
  return { clients, batchUpdate };
}

const RED = { foregroundColor: { color: { rgbColor: { red: 1 } } } };
const PRICING: TableSpec = { rows: [plain('Item', 'Price'), { cells: [{ text: 'Design', runStyle: RED }, { text: '$1,200' }] }, plain('Client', '$0')] };

const allRequests = (batchUpdate: ReturnType<typeof vi.fn>): docs_v1.Schema$Request[] => batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
const kinds = (batchUpdate: ReturnType<typeof vi.fn>): string[] => allRequests(batchUpdate).map((r) => Object.keys(r)[0]);
const TEXT_REQUESTS = ['insertText', 'deleteContentRange', 'updateTextStyle', 'insertTable'];

describe('a style-only table edit retypes nothing (#61 rule 6)', () => {
  it('a cell style: the same words in a tag with a style send one updateTableCellStyle', async () => {
    const doc = bodyDocWithTable({ rows: [{ cells: [{ text: 'Item', style: { contentAlignment: 'MIDDLE' } }, { text: 'Client', style: { contentAlignment: 'MIDDLE' } }], style: { tableHeader: true } }] });
    const { clients, batchUpdate } = clientsFor(doc);
    const markup = renderMarkdown(doc);
    expect(markup).toContain('<th>Client</th>');
    const result = await editDoc(clients, 'd', '<th>Client</th>', '<th style="background:#eeeeee">Client</th>');
    expect(result.status).toBe('ok');
    expect(kinds(batchUpdate)).toEqual(['updateTableCellStyle']);
    expect(allRequests(batchUpdate)[0].updateTableCellStyle).toMatchObject({ tableRange: { tableCellLocation: { rowIndex: 0, columnIndex: 1 }, rowSpan: 1, columnSpan: 1 }, fields: 'backgroundColor' });
  });

  it('the first style on a pipe table: the table written back as HTML sends only style requests, and the red text survives', async () => {
    const doc = bodyDocWithTable(PRICING);
    const { clients, batchUpdate } = clientsFor(doc);
    const pipe = renderMarkdown(doc);
    expect(pipe).toMatch(/^\| Item \| Price \|/);
    expect(pipe).toContain('<span style="color:#ff0000">Design</span>');
    const html = [
      '<table style="border:0.5pt solid #cccccc">',
      '<thead>',
      '<tr style="background:#eeeeee"><th>Item</th><th>Price</th></tr>',
      '</thead>',
      '<tr><td><span style="color:#ff0000">Design</span></td><td>$1,200</td></tr>',
      '<tr><td>Client</td><td>$0</td></tr>',
      '</table>',
    ].join('\n');
    const result = await editDoc(clients, 'd', pipe, html);
    expect(result.status).toBe('ok');
    const sent = kinds(batchUpdate);
    expect(sent.filter((k) => TEXT_REQUESTS.includes(k))).toEqual([]);
    expect(sent).toContain('updateTableCellStyle');
    expect(sent).toContain('pinTableHeaderRows');
  });

  it('a column width and a row height are style requests too', async () => {
    const doc = bodyDocWithTable(PRICING);
    const { clients, batchUpdate } = clientsFor(doc);
    const html = '<table>\n<col style="width:200pt"><col>\n<tr style="height:30pt"><td>Item</td><td>Price</td></tr>\n<tr><td><span style="color:#ff0000">Design</span></td><td>$1,200</td></tr>\n<tr><td>Client</td><td>$0</td></tr>\n</table>';
    await editDoc(clients, 'd', renderMarkdown(doc), html);
    expect(kinds(batchUpdate).filter((k) => TEXT_REQUESTS.includes(k))).toEqual([]);
    expect(kinds(batchUpdate)).toEqual(['updateTableColumnProperties', 'updateTableRowStyle']);
  });

  it('an old_string that is not in the table says what the table reads', async () => {
    const doc = bodyDocWithTable(PRICING);
    const { clients } = clientsFor(doc);
    const result = await editDoc(clients, 'd', '| Nope |', '<table>\n<tr><td>x</td></tr>\n</table>');
    expect(result.status).toBe('not_found');
    expect(result.message).toContain('| Item | Price |');
  });

  it('the same words with new inline markup restyle that cell’s text and type nothing', async () => {
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('Item', 'Price')], columns: [{ widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }, { widthType: 'EVENLY_DISTRIBUTED' }] }));
    await editDoc(clients, 'd', '<td>Item</td>', '<td>**Item**</td>');
    expect(kinds(batchUpdate).filter((k) => ['insertText', 'deleteContentRange'].includes(k))).toEqual([]);
    expect(kinds(batchUpdate)).toContain('updateTextStyle');
  });

  it('changed words retype that cell and nothing else', async () => {
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('Item', 'Price')], columns: [{ widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }, { widthType: 'EVENLY_DISTRIBUTED' }] }));
    await editDoc(clients, 'd', '<td>Price</td>', '<td>Cost</td>');
    const sent = allRequests(batchUpdate);
    expect(sent.filter((r) => r.insertText).map((r) => r.insertText!.text)).toEqual(['Cost']);
    expect(sent.filter((r) => r.deleteContentRange)).toHaveLength(1);
  });

  it('a change of rows replaces the table', async () => {
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('a'), plain('b')], columns: [{ widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }] }));
    const result = await editDoc(clients, 'd', '<tr><td>b</td></tr>', '<tr><td>b</td></tr>\n<tr><td>c</td></tr>');
    expect(result.status).toBe('ok');
    expect(allRequests(batchUpdate).some((r) => r.deleteContentRange)).toBe(true);
  });
});

describe('unsupported CSS in a table edit is refused before any request (#61 rule 5)', () => {
  it('names the property and sends nothing', async () => {
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('Item', 'Price')], columns: [{ widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }, { widthType: 'EVENLY_DISTRIBUTED' }] }));
    await expect(editDoc(clients, 'd', '<td>Item</td>', '<td style="float:left">Item</td>')).rejects.toThrow(StyleSyntaxError);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('table tags in new_string without a table in old_string are refused, not typed into the doc', async () => {
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable(PRICING));
    await expect(editDoc(clients, 'd', 'Client', '<td style="background:#eeeeee">Client</td>')).rejects.toThrow(/quote/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});
