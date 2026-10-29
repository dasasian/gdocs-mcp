import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { parseBlocks, markdownToRequests } from '../src/docs/write.js';
import { StyleSyntaxError } from '../src/docs/css.js';
import { effectiveGrid, placeCells, type TableLayout } from '../src/docs/table-layout.js';
import { renderHtmlTable, parseHtmlTable } from '../src/docs/table-html.js';
import { cellCssOfDocs } from '../src/docs/table-css.js';
import { fillLayoutRequests, insertTableRequests, lookOf, lookRequests, mergeRequests, plainLook, rowsTouchedByMerges } from '../src/docs/table-write.js';
import { readTableLayout, renderMarkdown } from '../src/docs/transformer.js';
import { STYLED_TABLE, bodyDocWithTable, headerDocWithTable, plain, tableElement } from './table-fixtures.js';

function layoutOf(markup: string): TableLayout {
  const [block] = parseBlocks(markup);
  if (block.type !== 'table' || !block.layout) throw new Error('not an HTML table');
  return block.layout;
}

const SITE = { tableStart: 7 };
const requestsFor = (markup: string): docs_v1.Schema$Request[] => {
  const layout = layoutOf(markup);
  const placement = placeCells(layout);
  return lookRequests(plainLook(placement.rowCount, placement.columnCount, rowsTouchedByMerges(placement)), lookOf(layout, placement), SITE);
};
const kinds = (requests: docs_v1.Schema$Request[]): string[] => requests.map((r) => Object.keys(r)[0]);

describe('style cascades cell, then row, then column, then table (#61 rule 3)', () => {
  const markup = [
    '<table style="background:#111111">',
    '<col><col style="background:#222222">',
    '<tr style="background:#333333"><td>a</td><td>b</td></tr>',
    '<tr><td>c</td><td style="background:#444444">d</td></tr>',
    '<tr><td>e</td><td>f</td></tr>',
    '</table>',
  ].join('\n');

  it('a cell’s own style beats its row’s, the row’s beats its column’s, the column’s beats the table’s', () => {
    const layout = layoutOf(markup);
    const grid = effectiveGrid(layout, placeCells(layout));
    expect(grid.map((row) => row.map((css) => css?.background))).toEqual([
      ['#333333', '#333333'],
      ['#111111', '#444444'],
      ['#111111', '#222222'],
    ]);
  });

  it('a style on the table reaches every cell with one request', () => {
    const requests = requestsFor('<table style="background:#111111">\n<tr><td>a</td><td>b</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</table>');
    expect(requests).toHaveLength(1);
    expect(requests[0].updateTableCellStyle).toMatchObject({
      tableRange: { tableCellLocation: { rowIndex: 0, columnIndex: 0 }, rowSpan: 2, columnSpan: 2 },
      fields: 'backgroundColor',
    });
  });
});

describe('<thead> is exactly the pinned rows (#61 rule 4)', () => {
  it('pins as many rows as <thead> holds, whether the cells are <th> or <td>', () => {
    const requests = requestsFor('<table>\n<thead>\n<tr><th>a</th></tr>\n<tr><td>b</td></tr>\n</thead>\n<tr><td>c</td></tr>\n</table>');
    expect(requests.find((r) => r.pinTableHeaderRows)?.pinTableHeaderRows).toMatchObject({ pinnedHeaderRowsCount: 2 });
  });

  it('a <th> outside <thead> pins nothing', () => {
    const requests = requestsFor('<table style="border:1pt solid #cccccc">\n<tr><th>a</th></tr>\n<tr><td>c</td></tr>\n</table>');
    expect(kinds(requests)).not.toContain('pinTableHeaderRows');
  });

  it('<th> and <td> read as the same cell', () => {
    const asTh = layoutOf('<table>\n<tr><th>a</th></tr>\n</table>');
    const asTd = layoutOf('<table>\n<tr><td>a</td></tr>\n</table>');
    expect(asTh).toEqual(asTd);
  });

  it('a <thead> after other rows is refused', () => {
    expect(() => parseBlocks('<table>\n<tr><td>a</td></tr>\n<thead>\n<tr><td>b</td></tr>\n</thead>\n</table>')).toThrow(/thead/);
  });
});

describe('merged cells (#61)', () => {
  it('colspan and rowspan are mergeTableCells over that range', () => {
    const layout = layoutOf('<table>\n<tr><td colspan="2">a</td><td rowspan="2">b</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</table>');
    const placement = placeCells(layout);
    expect(placement.columnCount).toBe(3);
    expect(mergeRequests(placement, SITE).map((r) => r.mergeTableCells!.tableRange)).toEqual([
      { tableCellLocation: expect.objectContaining({ rowIndex: 0, columnIndex: 0 }), rowSpan: 1, columnSpan: 2 },
      { tableCellLocation: expect.objectContaining({ rowIndex: 0, columnIndex: 2 }), rowSpan: 2, columnSpan: 1 },
    ]);
  });

  it('a row that merges is given back the height Docs gave it when it merged', () => {
    const requests = requestsFor('<table>\n<tr><td colspan="2">a</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</table>');
    expect(requests.find((r) => r.updateTableRowStyle)?.updateTableRowStyle).toMatchObject({ rowIndices: [0], tableRowStyle: { minRowHeight: { magnitude: 0 } } });
  });

  it('a span past the table is refused', () => {
    expect(() => parseBlocks('<table>\n<tr><td rowspan="3">a</td></tr>\n</table>')).toThrow(/rowspan/);
  });
});

describe('only the supported CSS is accepted, and the rest is refused before any request (#61 rule 5)', () => {
  it.each([
    ['float on a cell', '<table>\n<tr><td style="float:left">a</td></tr>\n</table>', /td style> float/],
    ['a px border', '<table style="border:1px solid red">\n<tr><td>a</td></tr>\n</table>', /border/],
    ['width on a row', '<table>\n<tr style="width:10pt"><td>a</td></tr>\n</table>', /tr style> width/],
    ['height on a column', '<table>\n<col style="height:10pt">\n<tr><td>a</td></tr>\n</table>', /col style> height/],
    ['an unknown attribute', '<table>\n<tr><td align="center">a</td></tr>\n</table>', /align/],
    ['an unknown vertical-align', '<table>\n<tr><td style="vertical-align:baseline">a</td></tr>\n</table>', /vertical-align/],
  ])('%s', (_name, markup, problem) => {
    expect(() => parseBlocks(markup)).toThrow(StyleSyntaxError);
    expect(() => parseBlocks(markup)).toThrow(problem);
  });

  it('names every problem and the supported set at once', () => {
    try {
      parseBlocks('<table style="float:left">\n<tr><td style="color:red">a</td></tr>\n</table>');
      expect.unreachable();
    } catch (error) {
      expect((error as StyleSyntaxError).issues).toHaveLength(2);
      expect((error as Error).message).toContain('vertical-align');
    }
  });

  it('supports border per side, dotted and dashed, and width 0', () => {
    const layout = layoutOf('<table style="border-top:2pt dashed #ff0000; border-left:0">\n<tr><td>a</td></tr>\n</table>');
    expect(layout.css).toEqual({ 'border-top': '2pt dashed #ff0000', 'border-left': '0pt solid #000000' });
  });

  it('writes a border into the Docs shape', () => {
    const [request] = requestsFor('<table style="border-top:2pt dotted #ff0000">\n<tr><td>a</td></tr>\n</table>');
    expect(request.updateTableCellStyle!.tableCellStyle!.borderTop).toMatchObject({ width: { magnitude: 2 }, dashStyle: 'DOT', color: { color: { rgbColor: { red: 1 } } } });
  });

  it('vertical-align is contentAlignment, <col width> a fixed column width and <tr height> a minimum row height', () => {
    const requests = requestsFor('<table>\n<col style="width:90pt"><col>\n<tr style="height:40pt"><td style="vertical-align:middle">a</td><td>b</td></tr>\n</table>');
    expect(requests.find((r) => r.updateTableCellStyle)?.updateTableCellStyle).toMatchObject({ tableCellStyle: { contentAlignment: 'MIDDLE' }, fields: 'contentAlignment' });
    expect(requests.find((r) => r.updateTableColumnProperties)?.updateTableColumnProperties).toMatchObject({ columnIndices: [0], tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: 90 } } });
    expect(requests.find((r) => r.updateTableRowStyle)?.updateTableRowStyle).toMatchObject({ rowIndices: [0], tableRowStyle: { minRowHeight: { magnitude: 40 } } });
  });
});

describe('markdown inside cells (#61 rule 2)', () => {
  const fresh = (rows: number, columns: number) =>
    tableElement({ rows: Array.from({ length: rows }, () => plain(...Array.from({ length: columns }, () => ''))) }, 5).table!;
  const fill = (markup: string): docs_v1.Schema$Request[] => {
    const layout = layoutOf(markup);
    const placement = placeCells(layout);
    return fillLayoutRequests(fresh(placement.rowCount, placement.columnCount), placement);
  };

  it('a cell’s words are markdown: ** is bold, and the markers are not typed', () => {
    const requests = fill('<table>\n<tr><td>**Fixed** fee</td></tr>\n</table>');
    expect(requests.find((r) => r.insertText)?.insertText?.text).toBe('Fixed fee');
    expect(requests.find((r) => r.updateTextStyle && r.updateTextStyle.fields === 'bold')?.updateTextStyle?.range).toMatchObject({ startIndex: 8, endIndex: 13 });
  });

  it('block content on its own lines becomes paragraphs and a list in the cell', () => {
    const requests = fill('<table>\n<tr><td>\n\nIntro\n\n- phase 1\n- phase 2\n\n</td></tr>\n</table>');
    expect(requests.find((r) => r.insertText)?.insertText?.text).toBe('Intro\nphase 1\nphase 2');
    expect(requests.some((r) => r.createParagraphBullets)).toBe(true);
  });

  it('literal-text marking works in a cell: an escaped marker is text, an escaped tag cannot end the cell', () => {
    const requests = fill('<table>\n<tr><td>5 \\* 3 \\* 2</td><td>a \\</td> b</td></tr>\n</table>');
    expect(requests.filter((r) => r.insertText).map((r) => r.insertText!.text)).toContain('5 * 3 * 2');
    expect(requests.filter((r) => r.insertText).map((r) => r.insertText!.text)).toContain('a </td> b');
  });

  it('a <p> cell keeps its edge whitespace and carries its paragraph style', () => {
    const requests = fill('<table>\n<tr><td><p style="text-align:right"> $1 </p></td></tr>\n</table>');
    expect(requests.find((r) => r.insertText)?.insertText?.text).toBe(' $1 ');
    expect(requests.find((r) => r.updateParagraphStyle)?.updateParagraphStyle?.paragraphStyle?.alignment).toBe('END');
  });

  it('fills the last cell first, so no insert moves the next', () => {
    const starts = fill('<table>\n<tr><td>a</td><td>b</td></tr>\n</table>').flatMap((r) => (r.insertText ? [r.insertText.location!.index!] : []));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
  });

  it.each([
    ['an image', '<table>\n<tr><td>\n\n![x](a.png)\n\n</td></tr>\n</table>'],
    ['a page break', '<table>\n<tr><td>\n\n<div style="page-break-after:always"></div>\n\n</td></tr>\n</table>'],
  ])('%s in a cell is refused', (_name, markup) => {
    expect(() => parseBlocks(markup)).toThrow(/cannot hold/);
  });
});

describe('no stray empty paragraphs (#61 rule 7)', () => {
  const paragraph = (startIndex: number, endIndex: number, text = '') => ({ startIndex, endIndex, paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } });
  const docOf = (content: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$Document => ({ body: { content } });
  const TABLE_SIZE_2X2 = 12;

  it('between two paragraphs: in at the end of the paragraph before, with the placeholder and the leftover mark deleted', () => {
    const doc = docOf([{ endIndex: 1, sectionBreak: {} }, paragraph(1, 7, 'Scope'), paragraph(7, 8), paragraph(8, 21, 'This project')]);
    expect(insertTableRequests(doc, 7, 2, 2)).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 8 } } },
      { insertTable: { location: { index: 6 }, rows: 2, columns: 2 } },
      { deleteContentRange: { range: { startIndex: 7 + TABLE_SIZE_2X2, endIndex: 8 + TABLE_SIZE_2X2 } } },
    ]);
  });

  it('at the end of the doc: the placeholder is the paragraph Docs requires, so it stays', () => {
    const doc = docOf([{ endIndex: 1, sectionBreak: {} }, paragraph(1, 7, 'Scope'), paragraph(7, 8)]);
    expect(insertTableRequests(doc, 7, 2, 2)).toEqual([
      { insertTable: { location: { index: 6 }, rows: 2, columns: 2 } },
      { deleteContentRange: { range: { startIndex: 7 + TABLE_SIZE_2X2, endIndex: 8 + TABLE_SIZE_2X2 } } },
    ]);
  });

  it('at the very top: the empty paragraph before the table is the one Docs requires, and the placeholder after it goes', () => {
    const doc = docOf([{ endIndex: 1, sectionBreak: {} }, paragraph(1, 2), paragraph(2, 8, 'Scope')]);
    expect(insertTableRequests(doc, 1, 2, 2)).toEqual([
      { insertTable: { location: { index: 1 }, rows: 2, columns: 2 } },
      { deleteContentRange: { range: { startIndex: 2 + TABLE_SIZE_2X2, endIndex: 3 + TABLE_SIZE_2X2 } } },
    ]);
  });

  it('after a table: the paragraph between two tables stays', () => {
    const doc = docOf([{ endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 20, table: { tableRows: [] } }, paragraph(20, 21), paragraph(21, 27, 'After')]);
    expect(insertTableRequests(doc, 20, 2, 2)[0]).toEqual({ insertTable: { location: { index: 20 }, rows: 2, columns: 2 } });
  });

  it('in a header, the segment rides on every request', () => {
    const doc: docs_v1.Schema$Document = { headers: { h1: { headerId: 'h1', content: [paragraph(0, 11, 'Letterhead'), paragraph(11, 12)] } }, documentStyle: { defaultHeaderId: 'h1' } };
    const requests = insertTableRequests(doc, 11, 1, 2, undefined, 'h1');
    expect(requests.map((r) => (r.insertTable?.location ?? r.deleteContentRange?.range)?.segmentId)).toEqual(['h1', 'h1']);
  });

  it('a markdown table is a placeholder paragraph in the text, which the batch above removes', () => {
    const { text, tables } = markdownToRequests('Scope\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter', 1);
    expect(text).toBe('Scope\n\nAfter\n');
    expect(tables[0].index).toBe(7);
  });
});

describe('read → write → read gives the same markup (#61 rule 8)', () => {
  it.each([
    ['the body', (): string => renderMarkdown(bodyDocWithTable(STYLED_TABLE))],
    ['a header', (): string => renderMarkdown(headerDocWithTable(STYLED_TABLE), { segmentId: 'h1' })],
  ])('a styled, merged, pinned table in %s writes back to the same table', (_name, read) => {
    const markup = read();
    const layout = layoutOf(markup);
    expect(renderHtmlTable(layout)).toBe(markup);
  });

  it('writes back the style the document had, cell by cell', () => {
    const doc = bodyDocWithTable(STYLED_TABLE);
    const table = doc.body!.content![0].table!;
    const layout = layoutOf(renderMarkdown(doc));
    const grid = effectiveGrid(layout, placeCells(layout));
    const fromDoc = table.tableRows!.map((row) => row.tableCells!.map((cell) => cellCssOfDocs(cell.tableCellStyle)));
    expect(grid[0]).toEqual(fromDoc[0]);
    expect(grid[1]).toEqual(fromDoc[1]);
    expect(grid[2][0]).toEqual({ ...fromDoc[2][0], 'border-right': fromDoc[2][1]['border-right'] });
    expect(grid[2][1]).toBeUndefined();
    expect(grid[2][2]).toEqual(fromDoc[2][2]);
  });

  it('the layout the reader builds is the layout the parser reads back', () => {
    const layout = readTableLayout(bodyDocWithTable(STYLED_TABLE), bodyDocWithTable(STYLED_TABLE).body!.content![0].table!);
    expect(parseHtmlTable(renderHtmlTable(layout)).layout).toEqual(layout);
  });
});
