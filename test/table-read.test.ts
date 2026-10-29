import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/docs/transformer.js';
import { DOCS_DEFAULT_CELL, STYLED_TABLE, background, border, bodyDocWithTable, headerDocWithTable, plain, type TableSpec } from './table-fixtures.js';

const readBody = (spec: TableSpec): string => renderMarkdown(bodyDocWithTable(spec));

const FRESH: TableSpec = { rows: [plain('', '', ''), plain('', '', '')] };

describe('a table is a pipe table when it is plain, HTML when it is not (#61 rule 1)', () => {
  it('a table nothing has styled reads as a pipe table, Docs defaults and all', () => {
    expect(readBody(FRESH)).toBe('|  |  |  |\n| --- | --- | --- |\n|  |  |  |');
  });

  it('reads the same when Docs leaves the defaults unset', () => {
    const unset: TableSpec = { rows: [{ cells: [{ text: 'a', style: { rowSpan: 1, columnSpan: 1 } }, { text: 'b', style: { rowSpan: 1, columnSpan: 1 } }] }] };
    expect(readBody(unset)).toBe('| a | b |\n| --- | --- |');
  });

  it('a table whose borders Docs reports at its own default still reads as a pipe table', () => {
    const defaultBorder = { width: { magnitude: 1, unit: 'PT' }, color: { color: { rgbColor: {} } }, dashStyle: 'SOLID' };
    const spec: TableSpec = { rows: [{ cells: [{ text: 'a', style: { borderTop: defaultBorder, borderLeft: defaultBorder } }] }] };
    expect(readBody(spec)).toBe('| a |\n| --- |');
  });

  it.each([
    ['a cell background', { rows: [{ cells: [{ text: 'a', style: { backgroundColor: background('eee') } }, { text: 'b' }] }] }],
    ['a border', { rows: [{ cells: [{ text: 'a', style: { borderTop: border(2) } }, { text: 'b' }] }] }],
    ['padding that is not 5pt', { rows: [{ cells: [{ text: 'a', style: { paddingLeft: { magnitude: 2, unit: 'PT' } } }, { text: 'b' }] }] }],
    ['vertical alignment', { rows: [{ cells: [{ text: 'a', style: { contentAlignment: 'MIDDLE' } }, { text: 'b' }] }] }],
    ['a column width', { rows: [plain('a', 'b')], columns: [{ widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }, { widthType: 'EVENLY_DISTRIBUTED' }] }],
    ['a pinned row', { rows: [{ cells: [{ text: 'a' }, { text: 'b' }], style: { tableHeader: true } }] }],
    ['a row height', { rows: [{ cells: [{ text: 'a' }, { text: 'b' }], style: { minRowHeight: { magnitude: 30, unit: 'PT' } } }] }],
    ['a merged cell', { rows: [{ cells: [{ text: 'a', style: { columnSpan: 2 } }, { text: '' }] }] }],
    ['a cell holding a list', { rows: [{ cells: [{ text: 'a', bullet: true }, { text: 'b' }] }] }],
    ['a cell holding two paragraphs', { rows: [{ cells: [{ text: ['a', 'b'] }, { text: 'c' }] }] }],
  ] as [string, TableSpec][])('%s makes it an HTML table', (_name, spec) => {
    expect(readBody(spec)).toMatch(/^<table/);
  });

  it('column alignment keeps a table plain, and a column that disagrees does not', () => {
    const right = { text: '1', paragraphStyle: { alignment: 'END' } };
    expect(readBody({ rows: [{ cells: [{ text: 'a' }, right] }, { cells: [{ text: 'b' }, right] }] })).toBe('| a | 1 |\n| --- | ---: |\n| b | 1 |');
    expect(readBody({ rows: [{ cells: [{ text: 'a' }, right] }, { cells: [{ text: 'b' }, { text: '2' }] }] })).toMatch(/^<table/);
  });

  it('paragraph spacing a cell inherits from the table is not a style', () => {
    expect(readBody({ rows: [plain('a')] })).toBe('| a |\n| --- |');
  });
});

describe('the HTML form', () => {
  it('reads a styled, merged, pinned table as the form the design shows', () => {
    expect(readBody(STYLED_TABLE)).toBe(
      [
        '<table style="border:0.5pt solid #cccccc">',
        '<col style="width:120pt"><col><col>',
        '<thead>',
        '<tr style="background:#eeeeee"><th>Item</th><th>Price</th><th>Notes</th></tr>',
        '</thead>',
        '<tr><td>Design</td><td>$1,200</td><td>**Fixed fee**</td></tr>',
        '<tr><td colspan="2" style="background:#ffffcc">Total</td><td>$4,200</td></tr>',
        '</table>',
      ].join('\n'),
    );
  });

  it('puts a merged cell’s far borders where Docs stores them, on the cells it covers', () => {
    expect(readBody(STYLED_TABLE)).toContain('<table style="border:0.5pt solid #cccccc">');
  });
});

describe('style sits at the narrowest level every cell under it shares (#61 rule 3)', () => {
  const shaded = { backgroundColor: background('eee') };

  it('one row shaded: on the <tr>', () => {
    const md = readBody({ rows: [{ cells: [{ text: 'a', style: shaded }, { text: 'b', style: shaded }] }, plain('c', 'd')] });
    expect(md).toContain('<tr style="background:#eeeeee"><td>a</td><td>b</td></tr>');
    expect(md).toContain('<tr><td>c</td><td>d</td></tr>');
  });

  it('one column shaded: on the <col>', () => {
    const md = readBody({ rows: [{ cells: [{ text: 'a', style: shaded }, { text: 'b' }] }, { cells: [{ text: 'c', style: shaded }, { text: 'd' }] }] });
    expect(md).toContain('<col style="background:#eeeeee"><col>');
    expect(md).not.toContain('<tr style');
  });

  it('every cell shaded: on the <table> alone', () => {
    const md = readBody({ rows: [{ cells: [{ text: 'a', style: shaded }, { text: 'b', style: shaded }] }, { cells: [{ text: 'c', style: shaded }, { text: 'd', style: shaded }] }] });
    expect(md).toMatch(/^<table style="background:#eeeeee">\n<tr><td>a<\/td><td>b<\/td><\/tr>/);
  });

  it('one cell shaded: on the <td>', () => {
    const md = readBody({ rows: [{ cells: [{ text: 'a', style: shaded }, { text: 'b' }] }, plain('c', 'd')] });
    expect(md).toContain('<tr><td style="background:#eeeeee">a</td><td>b</td></tr>');
  });

  it('four equal sides read as one border, and unequal sides as one each', () => {
    const all = { borderTop: border(1), borderBottom: border(1), borderLeft: border(1), borderRight: border(1) };
    expect(readBody({ rows: [{ cells: [{ text: 'a', style: all }] }] })).toContain('<table style="border:1pt solid #cccccc">');
    expect(readBody({ rows: [{ cells: [{ text: 'a', style: { borderBottom: border(2) } }] }] })).toContain('<table style="border-bottom:2pt solid #cccccc">');
  });

  it('a border of width 0 is a border that hides, not a missing one', () => {
    const hidden = { width: { unit: 'PT' }, color: { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } }, dashStyle: 'SOLID' };
    expect(readBody({ rows: [{ cells: [{ text: 'a', style: { borderTop: hidden } }] }] })).toContain('border-top:0pt solid #cccccc');
  });
});

describe('<thead> is exactly the pinned rows (#61 rule 4)', () => {
  it('writes <th> in <thead> and <td> elsewhere', () => {
    const md = readBody({ rows: [{ cells: [{ text: 'a' }], style: { tableHeader: true } }, { cells: [{ text: 'b' }], style: { tableHeader: true } }, plain('c')] });
    expect(md).toBe('<table>\n<thead>\n<tr><th>a</th></tr>\n<tr><th>b</th></tr>\n</thead>\n<tr><td>c</td></tr>\n</table>');
  });

  it('writes no <thead> when no row is pinned', () => {
    expect(readBody({ rows: [plain('a'), plain('b')], columns: [{ widthType: 'FIXED_WIDTH', width: { magnitude: 90, unit: 'PT' } }] })).not.toContain('thead');
  });
});

describe('markdown inside cells (#61 rule 2)', () => {
  const html = (cell: TableSpec['rows'][0]['cells'][0]): string => readBody({ rows: [{ cells: [cell, { text: 'x' }], style: { tableHeader: true } }] });

  it('a cell’s words are markdown: bold reads as **', () => {
    expect(html({ text: 'Fixed fee', runStyle: { bold: true } })).toContain('<th>**Fixed fee**</th>');
  });

  it('paragraphs and lists sit on their own lines between <td> and </td>', () => {
    const md = readBody({ rows: [{ cells: [{ text: ['phase 1', 'phase 2'] }, { text: 'x' }], style: { tableHeader: true } }] });
    expect(md).toContain('<th>\n\nphase 1\n\nphase 2\n\n</th><th>x</th></tr>');
    const list = readBody({ rows: [{ cells: [{ text: ['one', 'two'], bullet: true }, { text: 'x' }], style: { tableHeader: true } }] });
    expect(list).toContain('<th>\n\n- one\n- two\n\n</th>');
  });

  it('text that looks like markup is marked literal in a cell, as anywhere else', () => {
    expect(html({ text: '5 * 3 * 2' })).toContain('<th>5 \\* 3 \\* 2</th>');
    expect(html({ text: '4. Term' })).toContain('<th>4. Term</th>');
  });

  it('text that spells a table tag cannot end the cell', () => {
    expect(html({ text: 'a </td> b' })).toContain('<th>a \\</td> b</th>');
  });

  it('a cell with edge whitespace is wrapped in <p>, which keeps it', () => {
    expect(html({ text: '\tb' })).toContain('<th><p>\tb</p></th>');
  });

  it('an aligned cell carries its paragraph style', () => {
    expect(html({ text: '$1', paragraphStyle: { alignment: 'END' } })).toContain('<th><p style="text-align:right">$1</p></th>');
  });
});

describe('a table reads the same in a header (#61 rule 8)', () => {
  it('a table in a header segment reads as the same markup as in the body', () => {
    expect(renderMarkdown(headerDocWithTable(STYLED_TABLE), { segmentId: 'h1' })).toBe(readBody(STYLED_TABLE));
  });

  it('defaults are the defaults there too', () => {
    expect(renderMarkdown(headerDocWithTable({ rows: [plain('a', 'b')] }), { segmentId: 'h1' })).toBe('| a | b |\n| --- | --- |');
    expect(DOCS_DEFAULT_CELL.paddingLeft?.magnitude).toBe(5);
  });
});
