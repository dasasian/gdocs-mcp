import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { editDoc } from '../src/docs/edit.js';
import { renderMarkdown } from '../src/docs/transformer.js';
import { StyleSyntaxError } from '../src/docs/css.js';
import { parseBlocks } from '../src/docs/write.js';
import { background, bodyDocWithTable, headerDocWithTable, plain, tableElement, type TableSpec } from './table-fixtures.js';

interface Reads {
  /** the doc as it reads after the rows and columns were changed. */
  afterStructure?: docs_v1.Schema$Document;
  /** the quoted text of each comment on the doc. */
  quotes?: string[];
}

function clientsFor(doc: docs_v1.Schema$Document, { afterStructure, quotes = [] }: Reads = {}) {
  const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [] } });
  const get = vi.fn().mockResolvedValueOnce({ data: doc }).mockResolvedValue({ data: afterStructure ?? doc });
  const list = vi.fn().mockResolvedValue({ data: { comments: quotes.map((value) => ({ quotedFileContent: { value } })) } });
  const clients: GoogleClients = {
    account: 'a',
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get, batchUpdate } } as unknown as GoogleClients['docs'],
    drive: { comments: { list } } as unknown as GoogleClients['drive'],
  };
  return { clients, batchUpdate, list };
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

describe('blocks next to a table go through the normal insertion (#61 review)', () => {
  const SHADE = { backgroundColor: { color: { rgbColor: { red: 0.93333334, green: 0.93333334, blue: 0.93333334 } } } };
  const STYLED: TableSpec = {
    rows: [{ cells: [{ text: 'Item', style: SHADE }, { text: 'Price', style: SHADE }] }, plain('Total', '$4,200')],
  };
  const PAYMENT = 'Payment is due within 30 days of invoice.';
  const LAST_ROW = '<tr><td>Total</td><td>$4,200</td></tr>';
  const doc = (): docs_v1.Schema$Document => bodyDocWithTable(STYLED);
  const tableEnd = (): number => doc().body!.content![0].endIndex!;

  it.each([
    ['</table>', `</table>\n\n${PAYMENT}`],
    [`${LAST_ROW}\n</table>`, `${LAST_ROW}\n</table>\n\n${PAYMENT}`],
    [renderMarkdown(doc()), `${renderMarkdown(doc())}\n\n${PAYMENT}`],
  ])('a paragraph after the table, anchored on %j, keeps the table and adds the paragraph after it', async (oldString, newString) => {
    const { clients, batchUpdate } = clientsFor(doc());
    const result = await editDoc(clients, 'd', oldString, newString);
    expect(result.status).toBe('ok');
    const sent = allRequests(batchUpdate);
    expect(sent.some((r) => r.deleteContentRange || r.updateTableCellStyle || r.insertTable)).toBe(false);
    const typed = sent.filter((r) => r.insertText);
    expect(typed.map((r) => r.insertText!.text)).toEqual([PAYMENT]);
    expect(typed[0].insertText!.location!.index).toBe(tableEnd());
    expect(sent.some((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT')).toBe(true);
  });

  it('a paragraph before the table, anchored on <table>, is inserted before it', async () => {
    const { clients, batchUpdate } = clientsFor(doc());
    const open = renderMarkdown(doc()).split('\n')[0];
    await editDoc(clients, 'd', open, `Intro line\n\n${open}`);
    const sent = allRequests(batchUpdate);
    expect(sent.filter((r) => r.insertText).map((r) => r.insertText!.text.trim())).toContain('Intro line');
    expect(sent.some((r) => r.updateTableCellStyle || r.insertTable)).toBe(false);
  });

  it('a restyle and a paragraph in one edit do both', async () => {
    const { clients, batchUpdate } = clientsFor(doc());
    await editDoc(clients, 'd', `${LAST_ROW}\n</table>`, `<tr style="background:#ffffcc"><td>Total</td><td>$4,200</td></tr>\n</table>\n\n${PAYMENT}`);
    expect(kinds(batchUpdate)).toContain('updateTableCellStyle');
    expect(allRequests(batchUpdate).filter((r) => r.insertText).map((r) => r.insertText!.text)).toEqual([PAYMENT]);
  });

  it('</table> in a doc with two tables is ambiguous, with context', async () => {
    const two = bodyDocWithTable(STYLED);
    const second = tableElement(STYLED, two.body!.content![1].endIndex! + 1);
    two.body!.content!.splice(2, 0, second, { startIndex: second.endIndex!, endIndex: second.endIndex! + 1, paragraph: { elements: [{ textRun: { content: '\n' } }] } });
    const { clients, batchUpdate } = clientsFor(two);
    const result = await editDoc(clients, 'd', '</table>', `</table>\n\n${PAYMENT}`);
    expect(result.status).toBe('ambiguous');
    expect(result.matches).toHaveLength(2);
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe('a table problem is not reported as a style problem (#61 review)', () => {
  it('an edit that leaves no table says what to quote and lists no CSS', async () => {
    const doc = bodyDocWithTable({ rows: [plain('a', 'b')], columns: [{ widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }, { widthType: 'EVENLY_DISTRIBUTED' }] });
    const { clients, batchUpdate } = clientsFor(doc);
    const error = await editDoc(clients, 'd', renderMarkdown(doc), 'just text').catch((e: Error) => e);
    expect(error).toBeInstanceOf(StyleSyntaxError);
    expect((error as Error).message).toContain('</table>');
    expect((error as Error).message).not.toMatch(/style problem|Supported in/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('a table that is never closed is a table problem too', () => {
    expect(() => parseBlocks('<table>\n<tr><td>a</td></tr>')).toThrow(/table cannot be written/);
    expect(() => parseBlocks('<table>\n<tr><td>a</td></tr>')).not.toThrow(/Supported in/);
  });

  it('unsupported CSS in a table still lists the supported CSS', () => {
    expect(() => parseBlocks('<table>\n<tr><td style="float:left">a</td></tr>\n</table>')).toThrow(/Supported in <table>/);
  });
});

const FIXED = [{ widthType: 'FIXED_WIDTH' as const, width: { magnitude: 90, unit: 'PT' as const } }];
const TWO_FIXED = [...FIXED, ...FIXED];
const pipe = (...cells: string[]): string => `| ${cells.join(' | ')} |`;
const BLANK = plain('', '');
const PRICES = [plain('Item', 'Price'), plain('Design', '$1,200'), plain('Build', '$3,000'), plain('Total', '$4,200')];
const withRows = (...rows: TableSpec['rows']): docs_v1.Schema$Document => bodyDocWithTable({ rows });
const typed = (batchUpdate: ReturnType<typeof vi.fn>): string[] => allRequests(batchUpdate).filter((r) => r.insertText).map((r) => r.insertText!.text!);
const batchKinds = (batchUpdate: ReturnType<typeof vi.fn>): string[][] => batchUpdate.mock.calls.map((call) => call[0].requestBody.requests.map((r: docs_v1.Schema$Request) => Object.keys(r)[0]));

describe('a change of rows is a comparison, never a rewrite (#62 rules 1, 2, 3, 8)', () => {
  it('an added row is an insertTableRow and the text of its cells; the table is not deleted', async () => {
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('a'), plain('b')], columns: FIXED }), { afterStructure: bodyDocWithTable({ rows: [plain('a'), plain('b'), plain('')], columns: FIXED }) });
    const result = await editDoc(clients, 'd', '<tr><td>b</td></tr>', '<tr><td>b</td></tr>\n<tr><td>c</td></tr>');
    expect(result.status).toBe('ok');
    expect(batchKinds(batchUpdate)[0]).toEqual(['insertTableRow']);
    expect(allRequests(batchUpdate)[0].insertTableRow).toMatchObject({ tableCellLocation: { tableStartLocation: { index: 1 }, rowIndex: 1, columnIndex: 0 }, insertBelow: true });
    expect(typed(batchUpdate)).toEqual(['c']);
    expect(allRequests(batchUpdate).some((r) => r.deleteContentRange || r.insertTable)).toBe(false);
  });

  it('quoting only the rows around the change adds the row and touches no other cell (the partial quote)', async () => {
    const before = withRows(...PRICES, plain('Tax', '$0'), plain('Due', '$4,200'));
    const after = withRows(...PRICES.slice(0, 3), BLANK, ...PRICES.slice(3), plain('Tax', '$0'), plain('Due', '$4,200'));
    const { clients, batchUpdate } = clientsFor(before, { afterStructure: after });
    await editDoc(clients, 'd', `${pipe('Build', '$3,000')}\n${pipe('Total', '$4,200')}`, `${pipe('Build', '$3,000')}\n${pipe('Hosting', '$300')}\n${pipe('Total', '$4,200')}`);
    expect(batchKinds(batchUpdate)[0]).toEqual(['insertTableRow']);
    expect(allRequests(batchUpdate)[0].insertTableRow!.tableCellLocation).toMatchObject({ rowIndex: 2 });
    expect(typed(batchUpdate)).toEqual(['$300', 'Hosting']);
    expect(allRequests(batchUpdate).some((r) => r.deleteContentRange)).toBe(false);
  });

  it('a deleted row is one deleteTableRow and nothing is typed', async () => {
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: withRows(PRICES[0], PRICES[1], PRICES[3]) });
    await editDoc(clients, 'd', pipe('Build', '$3,000'), '');
    expect(batchKinds(batchUpdate)).toEqual([['deleteTableRow']]);
    expect(allRequests(batchUpdate)[0].deleteTableRow!.tableCellLocation).toMatchObject({ rowIndex: 2, columnIndex: 0 });
  });

  it('an added column is one insertTableColumn and the text of its cells', async () => {
    const after = withRows(plain('Item', '', 'Price'), plain('Design', '', '$1,200'), plain('Build', '', '$3,000'), plain('Total', '', '$4,200'));
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: after });
    const oldTable = '| Item | Price |\n| --- | --- |\n| Design | $1,200 |\n| Build | $3,000 |\n| Total | $4,200 |';
    const newTable = '| Item | Qty | Price |\n| --- | --- | --- |\n| Design | 1 | $1,200 |\n| Build | 2 | $3,000 |\n| Total | 3 | $4,200 |';
    await editDoc(clients, 'd', oldTable, newTable);
    expect(batchKinds(batchUpdate)[0]).toEqual(['insertTableColumn']);
    expect(allRequests(batchUpdate)[0].insertTableColumn).toMatchObject({ tableCellLocation: { rowIndex: 0, columnIndex: 0 }, insertRight: true });
    expect(typed(batchUpdate).sort()).toEqual(['1', '2', '3', 'Qty']);
  });

  it('a price changed and a row added in one edit retype the price cells and type the new row, and nothing else', async () => {
    const after = withRows(PRICES[0], PRICES[1], PRICES[2], BLANK, PRICES[3]);
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: after });
    await editDoc(clients, 'd', `${pipe('Build', '$3,000')}\n${pipe('Total', '$4,200')}`, `${pipe('Build', '$3,500')}\n${pipe('Hosting', '$300')}\n${pipe('Total', '$4,500')}`);
    expect(typed(batchUpdate).sort()).toEqual(['$3,500', '$300', '$4,500', 'Hosting']);
    expect(allRequests(batchUpdate).filter((r) => r.deleteContentRange)).toHaveLength(2);
  });

  it('a row moved without any change of words types only the moved row', async () => {
    const after = withRows(PRICES[0], PRICES[2], BLANK, PRICES[3]);
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: after });
    await editDoc(clients, 'd', `${pipe('Design', '$1,200')}\n${pipe('Build', '$3,000')}`, `${pipe('Build', '$3,000')}\n${pipe('Design', '$1,200')}`);
    expect(batchKinds(batchUpdate)[0]).toEqual(['deleteTableRow', 'insertTableRow']);
    expect(typed(batchUpdate).sort()).toEqual(['$1,200', 'Design']);
  });
});

describe('new cells copy their neighbour and explicit style wins (#62 rule 4)', () => {
  const SHADE = { backgroundColor: background('eee') };
  const shaded = (...texts: string[]): TableSpec['rows'][number] => ({ cells: texts.map((text) => ({ text, style: SHADE })) });
  const before = withRows(plain('Item', 'Price'), shaded('Design', '$1,200'), plain('Total', '$4,200'));
  const NEW_ROW = '<tr><td>Hosting</td><td>$300</td></tr>\n<tr><td>Total</td>';
  const editWith = (newRow: string, afterStructure: docs_v1.Schema$Document) => {
    const harness = clientsFor(before, { afterStructure });
    const markup = renderMarkdown(before);
    return { ...harness, run: () => editDoc(harness.clients, 'd', markup, markup.replace('<tr><td>Total</td>', newRow)) };
  };
  const unstyledNewRow = withRows(plain('Item', 'Price'), shaded('Design', '$1,200'), BLANK, plain('Total', '$4,200'));
  const copiedNewRow = withRows(plain('Item', 'Price'), shaded('Design', '$1,200'), shaded('', ''), plain('Total', '$4,200'));

  it('a new row whose cells came back unstyled is given the style of the row above', async () => {
    const { run, batchUpdate } = editWith(NEW_ROW, unstyledNewRow);
    await run();
    const styled = allRequests(batchUpdate).filter((r) => r.updateTableCellStyle);
    expect(styled).toHaveLength(1);
    expect(styled[0].updateTableCellStyle).toMatchObject({ tableRange: { tableCellLocation: { rowIndex: 2, columnIndex: 0 }, columnSpan: 2 }, fields: 'backgroundColor' });
  });

  it('the shading is the row above’s, not the opposite of it', async () => {
    const { run, batchUpdate } = editWith(NEW_ROW, unstyledNewRow);
    await run();
    const styled = allRequests(batchUpdate).find((r) => r.updateTableCellStyle)!.updateTableCellStyle!;
    expect(styled.tableCellStyle!.backgroundColor!.color!.rgbColor!.red).toBeCloseTo(0.9333, 3);
  });

  it('a new row Docs already styled like the row above is sent no style', async () => {
    const { run, batchUpdate } = editWith(NEW_ROW, copiedNewRow);
    await run();
    expect(kinds(batchUpdate)).not.toContain('updateTableCellStyle');
  });

  it('a style written on the new row wins over the row above', async () => {
    const { run, batchUpdate } = editWith('<tr style="background:#ffffcc"><td>Hosting</td><td>$300</td></tr>\n<tr><td>Total</td>', copiedNewRow);
    await run();
    const styled = allRequests(batchUpdate).find((r) => r.updateTableCellStyle)!.updateTableCellStyle!;
    expect(styled.tableRange).toMatchObject({ tableCellLocation: { rowIndex: 2 }, columnSpan: 2 });
    expect(styled.tableCellStyle!.backgroundColor!.color!.rgbColor).toMatchObject({ red: 1, green: 1 });
  });

  it('a link is never copied: the new cell’s text is typed with direct styling cleared and no link', async () => {
    const linked = { cells: [{ text: 'Design', runStyle: { link: { url: 'https://example.com' }, italic: true } }] };
    const before = bodyDocWithTable({ rows: [plain('Item'), linked] });
    const { clients, batchUpdate } = clientsFor(before, { afterStructure: bodyDocWithTable({ rows: [plain('Item'), linked, plain('')] }) });
    const designRow = renderMarkdown(before).split('\n').at(-1)!;
    expect(designRow).toContain('https://example.com');
    await editDoc(clients, 'd', designRow, `${designRow}\n| Hosting |`);
    const styles = allRequests(batchUpdate).filter((r) => r.updateTextStyle).map((r) => r.updateTextStyle!);
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.every((u) => u.textStyle?.link === undefined)).toBe(true);
    expect(styles[0].fields).toContain('link');
    expect(typed(batchUpdate)).toEqual(['Hosting']);
  });
});

describe('merges (#62 rule 5)', () => {
  const THREE = [plain('Item', 'Price', 'Notes'), plain('Design', '$1,200', 'fixed')];
  const html = (lastRow: string): string => ['<table>', '<tr><td>Item</td><td>Price</td><td>Notes</td></tr>', '<tr><td>Design</td><td>$1,200</td><td>fixed</td></tr>', lastRow, '</table>'].join('\n');
  const mergedTotal: TableSpec['rows'][number] = { cells: [{ text: 'Total', style: { columnSpan: 2 } }, { text: '' }, { text: '' }] };

  it('a new colspan is a mergeTableCells, and the head cell is not retyped when its words are what the merge left', async () => {
    const before = withRows(...THREE, plain('Total', '', ''));
    const { clients, batchUpdate } = clientsFor(before, { afterStructure: withRows(...THREE, mergedTotal) });
    await editDoc(clients, 'd', renderMarkdown(before), html('<tr><td colspan="2">Total</td><td></td></tr>'));
    expect(batchKinds(batchUpdate)[0]).toEqual(['mergeTableCells']);
    expect(allRequests(batchUpdate)[0].mergeTableCells!.tableRange).toMatchObject({ tableCellLocation: { rowIndex: 2, columnIndex: 0 }, rowSpan: 1, columnSpan: 2 });
    expect(typed(batchUpdate)).toEqual([]);
  });

  it('the head cell is retyped when the merge joined words that are not the new words', async () => {
    const before = withRows(...THREE, plain('Total', '$4,200', ''));
    const joined: TableSpec['rows'][number] = { cells: [{ text: ['Total', '$4,200'], style: { columnSpan: 2 } }, { text: '' }, { text: '' }] };
    const { clients, batchUpdate } = clientsFor(before, { afterStructure: withRows(...THREE, joined) });
    await editDoc(clients, 'd', renderMarkdown(before), html('<tr><td colspan="2">Total</td><td></td></tr>'));
    expect(batchKinds(batchUpdate)[0]).toEqual(['mergeTableCells']);
    expect(typed(batchUpdate)).toEqual(['Total']);
  });

  it('a removed colspan is an unmergeTableCells, then the cell it freed is typed', async () => {
    const before = withRows(...THREE, mergedTotal);
    const { clients, batchUpdate } = clientsFor(before, { afterStructure: withRows(...THREE, plain('Total', '', '')) });
    await editDoc(clients, 'd', renderMarkdown(before), html('<tr><td>Total</td><td>$4,200</td><td></td></tr>'));
    expect(batchKinds(batchUpdate)[0]).toEqual(['unmergeTableCells']);
    expect(typed(batchUpdate)).toEqual(['$4,200']);
  });
});

describe('a moved row asks once when comments quote its text (#62 rule 6)', () => {
  const OLD = `${pipe('Design', '$1,200')}\n${pipe('Build', '$3,000')}`;
  const NEW = `${pipe('Build', '$3,000')}\n${pipe('Design', '$1,200')}`;
  const moved = (): docs_v1.Schema$Document => withRows(PRICES[0], PRICES[2], BLANK, PRICES[3]);
  const TOKEN = '1 comment on text in a moved row or column [revision r1]';

  it('with no comments it moves without asking', async () => {
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: moved(), quotes: [] });
    const result = await editDoc(clients, 'd', OLD, NEW);
    expect(result.status).toBe('ok');
    expect(batchKinds(batchUpdate)[0]).toEqual(['deleteTableRow', 'insertTableRow']);
  });

  it('with a comment quoting the moved row, the first call is refused with the count and the revision, and nothing is sent', async () => {
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: moved(), quotes: ['$1,200'] });
    const result = await editDoc(clients, 'd', OLD, NEW);
    expect(result.status).toBe('confirm_required');
    expect(result.confirmLoss).toBe(TOKEN);
    expect(result.message).toMatch(/^Ask the user before doing anything else/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('the same call with that string goes through', async () => {
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: moved(), quotes: ['$1,200'] });
    const result = await editDoc(clients, 'd', OLD, NEW, { confirmLoss: TOKEN });
    expect(result.status).toBe('ok');
    expect(batchKinds(batchUpdate)[0]).toEqual(['deleteTableRow', 'insertTableRow']);
  });

  it('a string from an older revision is refused again with a fresh one', async () => {
    const { clients, batchUpdate } = clientsFor(withRows(...PRICES), { afterStructure: moved(), quotes: ['$1,200'] });
    const result = await editDoc(clients, 'd', OLD, NEW, { confirmLoss: TOKEN.replace('r1', 'r0') });
    expect(result.status).toBe('confirm_required');
    expect(result.message).toContain('fresh one');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('comments that quote other rows, or none of the table, do not ask', async () => {
    const { clients } = clientsFor(withRows(...PRICES), { afterStructure: moved(), quotes: ['the intro paragraph', '$4,200'] });
    expect((await editDoc(clients, 'd', OLD, NEW)).status).toBe('ok');
  });

  it('a quote that spans the moved row and its neighbour still counts', async () => {
    const { clients } = clientsFor(withRows(...PRICES), { afterStructure: moved(), quotes: ['Design\n$1,200\nBuild'] });
    expect((await editDoc(clients, 'd', OLD, NEW)).status).toBe('confirm_required');
  });

  it('a row that is only deleted does not ask even when a comment quotes it', async () => {
    const { clients } = clientsFor(withRows(...PRICES), { afterStructure: withRows(PRICES[0], PRICES[1], PRICES[3]), quotes: ['$3,000'] });
    expect((await editDoc(clients, 'd', `${pipe('Build', '$3,000')}\n`, '')).status).toBe('ok');
  });
});

describe('a change that cannot be read cleanly is refused and nothing is sent (#62 rule 7)', () => {
  it('a row that could be an edit of two different new rows', async () => {
    const { clients, batchUpdate } = clientsFor(withRows(PRICES[0], PRICES[1], PRICES[3]));
    await expect(editDoc(clients, 'd', pipe('Design', '$1,200'), `${pipe('Design', '$900')}\n${pipe('Fee', '$1,200')}`)).rejects.toThrow(/one row at a time/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('a table that shares nothing with the new one', async () => {
    const { clients, batchUpdate } = clientsFor(withRows(plain('a', 'b')));
    await expect(editDoc(clients, 'd', `${pipe('a', 'b')}\n| --- | --- |`, `${pipe('x', 'y')}\n| --- | --- |\n${pipe('z', 'w')}`)).rejects.toThrow(/shares no/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('a table that Docs did not leave the shape the edit asked for is reported, not typed into', async () => {
    const { clients, batchUpdate } = clientsFor(bodyDocWithTable({ rows: [plain('a'), plain('b')], columns: FIXED }));
    await expect(editDoc(clients, 'd', '<tr><td>b</td></tr>', '<tr><td>b</td></tr>\n<tr><td>c</td></tr>')).rejects.toThrow(/2 x 1, not the 3 x 1/);
    expect(typed(batchUpdate)).toEqual([]);
  });
});

describe('a table in a header behaves the same (#62 rule 9)', () => {
  it('an added row is an insertTableRow addressed to the header, and the new cells are typed in it', async () => {
    const before = headerDocWithTable({ rows: [plain('Name', 'Phone'), plain('Ann', '1')], columns: TWO_FIXED });
    const after = headerDocWithTable({ rows: [plain('Name', 'Phone'), plain('Ann', '1'), plain('', '')], columns: TWO_FIXED });
    const { clients, batchUpdate } = clientsFor(before, { afterStructure: after });
    const result = await editDoc(clients, 'd', '<tr><td>Ann</td><td>1</td></tr>', '<tr><td>Ann</td><td>1</td></tr>\n<tr><td>Bob</td><td>2</td></tr>', { segment: 'header' });
    expect(result.status).toBe('ok');
    expect(allRequests(batchUpdate)[0].insertTableRow).toMatchObject({ tableCellLocation: { tableStartLocation: { index: 0, segmentId: 'h1' }, rowIndex: 1 }, insertBelow: true });
    expect(allRequests(batchUpdate).filter((r) => r.insertText).map((r) => r.insertText!.location!.segmentId)).toEqual(['h1', 'h1']);
    expect(allRequests(batchUpdate).some((r) => r.deleteContentRange)).toBe(false);
  });

  it('a moved row asks nothing, because a comment cannot be anchored in a header', async () => {
    const before = headerDocWithTable({ rows: [plain('Ann', '1'), plain('Bob', '2'), plain('Cy', '3')], columns: TWO_FIXED });
    const after = headerDocWithTable({ rows: [plain('Bob', '2'), plain('', ''), plain('Cy', '3')], columns: TWO_FIXED });
    const { clients, list } = clientsFor(before, { afterStructure: after, quotes: ['Ann'] });
    const result = await editDoc(clients, 'd', '<tr><td>Ann</td><td>1</td></tr>\n<tr><td>Bob</td><td>2</td></tr>', '<tr><td>Bob</td><td>2</td></tr>\n<tr><td>Ann</td><td>1</td></tr>', { segment: 'header' });
    expect(result.status).toBe('ok');
    expect(list).not.toHaveBeenCalled();
  });
});
