import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../src/docs/write.js';
import { StyleSyntaxError } from '../src/docs/css.js';
import type { TableLayout } from '../src/docs/table-layout.js';
import { compareTables, type StructureOperation } from '../src/docs/table-compare.js';

function layoutOf(markup: string): TableLayout {
  const [block] = parseBlocks(markup);
  if (block.type !== 'table' || !block.layout) throw new Error('not an HTML table');
  return block.layout;
}

const row = (...cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
const table = (...lines: string[]): TableLayout => layoutOf(['<table>', ...lines, '</table>'].join('\n'));
const kinds = (operations: StructureOperation[]): string[] => operations.map((operation) => operation.kind);

const PRICING = [row('Item', 'Price'), row('Design', '$1,200'), row('Build', '$3,000'), row('Total', '$4,200')];

describe('rows and columns are paired by the cells they share (#62 rules 1 and 2)', () => {
  it('a row added between two kept rows is one insertRow below the row above it', () => {
    const { operations } = compareTables(table(...PRICING), table(PRICING[0], PRICING[1], PRICING[2], row('Hosting', '$300'), PRICING[3]));
    expect(operations).toEqual([{ kind: 'insertRow', at: { row: 2, column: 0 }, below: true }]);
  });

  it('a row that is gone is one deleteRow', () => {
    const { operations } = compareTables(table(...PRICING), table(PRICING[0], PRICING[1], PRICING[3]));
    expect(operations).toEqual([{ kind: 'deleteRow', at: { row: 2, column: 0 } }]);
  });

  it('a column added in every row is one insertColumn right of the column to its left', () => {
    const { operations } = compareTables(table(...PRICING), table(row('Item', 'Qty', 'Price'), row('Design', '1', '$1,200'), row('Build', '1', '$3,000'), row('Total', '1', '$4,200')));
    expect(operations).toEqual([{ kind: 'insertColumn', at: { row: 0, column: 0 }, right: true }]);
  });

  it('old Build | $3,000 against new Build | $3,500 and Hosting | $300 is Build edited and Hosting inserted', () => {
    const { operations, pairing } = compareTables(table(PRICING[0], PRICING[1], row('Build', '$3,000')), table(PRICING[0], PRICING[1], row('Build', '$3,500'), row('Hosting', '$300')));
    expect(pairing.rows.forOld).toEqual([0, 1, 2]);
    expect(operations).toEqual([{ kind: 'insertRow', at: { row: 2, column: 0 }, below: true }]);
  });

  it('a column is paired before the rows: a row moved while a column is added is still a move', () => {
    const { moved } = compareTables(table(row('A', '1'), row('B', '2')), table(row('B', '9', '2'), row('A', '8', '1')));
    expect(moved).toEqual([{ axis: 'row', index: 0, cells: expect.arrayContaining(['A', '1']) }]);
  });

  it('a row that shares a cell with two new rows is a tie and is refused, saying to change one row at a time', () => {
    const before = table(PRICING[0], row('Design', '$1,200'), PRICING[3]);
    const after = table(PRICING[0], row('Design', '$900'), row('Fee', '$1,200'), PRICING[3]);
    const refused = (): unknown => compareTables(before, after);
    expect(refused).toThrow(StyleSyntaxError);
    expect(refused).toThrow(/one row at a time/);
  });

  it('a row whose every cell changed, with as many new rows as old ones in the gap, is an edit of that row', () => {
    const { operations, pairing } = compareTables(table(PRICING[0], row('Design', '$1,200')), table(PRICING[0], row('Consulting', '$900')));
    expect(pairing.rows.forOld).toEqual([0, 1]);
    expect(operations).toEqual([]);
  });
});

describe('a new row or column copies its neighbour’s style (#62 rule 4)', () => {
  it('a new row copies the row above it', () => {
    const { styleSource } = compareTables(table(...PRICING), table(PRICING[0], PRICING[1], row('Hosting', '$300'), PRICING[2], PRICING[3]));
    expect(styleSource.rows).toEqual([undefined, undefined, 1, undefined, undefined]);
  });

  it('a new row under a <thead> row copies the row below, and goes in above it', () => {
    const header = '<thead>\n<tr><th>Item</th><th>Price</th></tr>\n</thead>';
    const { styleSource, operations } = compareTables(
      layoutOf(['<table>', header, ...PRICING.slice(1), '</table>'].join('\n')),
      layoutOf(['<table>', header, row('Hosting', '$300'), ...PRICING.slice(1), '</table>'].join('\n')),
    );
    expect(styleSource.rows[1]).toBe(2);
    expect(operations).toEqual([{ kind: 'insertRow', at: { row: 1, column: 0 }, below: false }]);
  });

  it('a new row inside <thead> copies the header row above it', () => {
    const { styleSource } = compareTables(
      layoutOf(['<table>', '<thead>', row('Item', 'Price'), '</thead>', ...PRICING.slice(1), '</table>'].join('\n')),
      layoutOf(['<table>', '<thead>', row('Item', 'Price'), row('Sub', 'Heading'), '</thead>', ...PRICING.slice(1), '</table>'].join('\n')),
    );
    expect(styleSource.rows[1]).toBe(0);
  });

  it('a new column copies the column to its left', () => {
    const { styleSource } = compareTables(table(...PRICING), table(row('Item', 'Qty', 'Price'), row('Design', '1', '$1,200'), row('Build', '1', '$3,000'), row('Total', '1', '$4,200')));
    expect(styleSource.columns).toEqual([undefined, 0, undefined]);
  });

  it('a new first column copies the column to its right, and goes in left of it', () => {
    const { styleSource, operations } = compareTables(table(...PRICING), table(row('No', 'Item', 'Price'), row('1', 'Design', '$1,200'), row('2', 'Build', '$3,000'), row('3', 'Total', '$4,200')));
    expect(styleSource.columns[0]).toBe(1);
    expect(operations).toEqual([{ kind: 'insertColumn', at: { row: 0, column: 0 }, right: false }]);
  });
});

describe('merges are their own requests (#62 rule 5)', () => {
  it('a new colspan is a mergeTableCells over the cells it covers', () => {
    const { operations } = compareTables(table(PRICING[0], row('Total', '')), table(PRICING[0], '<tr><td colspan="2">Total</td></tr>'));
    expect(operations).toEqual([{ kind: 'merge', span: { row: 1, column: 0, rowSpan: 1, columnSpan: 2 } }]);
  });

  it('a removed colspan is an unmergeTableCells', () => {
    const { operations } = compareTables(table(PRICING[0], '<tr><td colspan="2">Total</td></tr>'), table(PRICING[0], row('Total', '$4,200')));
    expect(operations).toEqual([{ kind: 'unmerge', span: { row: 1, column: 0, rowSpan: 1, columnSpan: 2 } }]);
  });

  it('a merge that stays is not touched, even when a row is added next to it', () => {
    const merged = '<tr><td colspan="2">Notes</td></tr>';
    const { operations } = compareTables(table(PRICING[0], PRICING[1], merged), table(PRICING[0], PRICING[1], row('Hosting', '$300'), merged));
    expect(kinds(operations)).toEqual(['insertRow']);
  });

  it('a row inserted inside a merge unmerges it first, then merges again if the new table says so', () => {
    const before = table('<tr><td rowspan="2">Item</td><td>a</td></tr>', row('b'));
    const after = table('<tr><td rowspan="3">Item</td><td>a</td></tr>', row('x'), row('b'));
    expect(kinds(compareTables(before, after).operations)).toEqual(['unmerge', 'insertRow', 'merge']);
  });
});

describe('a move is a delete and an insert (#62 rule 6)', () => {
  it('a row that moves is reported with its cells', () => {
    const { moved, operations } = compareTables(table(...PRICING), table(PRICING[0], PRICING[2], PRICING[1], PRICING[3]));
    expect(moved).toHaveLength(1);
    expect(kinds(operations)).toEqual(['deleteRow', 'insertRow']);
  });

  it('a row that is only deleted is not a move', () => {
    expect(compareTables(table(...PRICING), table(PRICING[0], PRICING[1], PRICING[3])).moved).toEqual([]);
  });

  it('a column that moves is reported too', () => {
    const { moved } = compareTables(table(row('A', 'B', 'C'), row('1', '2', '3')), table(row('B', 'C', 'A'), row('2', '3', '1')));
    expect(moved.map((line) => line.axis)).toEqual(['column']);
  });
});

describe('a change that cannot be read cleanly is refused with what to quote (#62 rule 7)', () => {
  it('a column added to the rows but not to the <col> lines', () => {
    const before = layoutOf('<table>\n<col style="width:100pt"><col>\n<tr><td>a</td><td>b</td></tr>\n</table>');
    const after = layoutOf('<table>\n<col style="width:100pt"><col>\n<tr><td>a</td><td>x</td><td>b</td></tr>\n</table>');
    expect(() => compareTables(before, after)).toThrow(/<col> line.*Quote from <table>/);
  });

  it('a table that shares nothing with the new one', () => {
    const refused = (): unknown => compareTables(table(row('a', 'b')), table(row('x', 'y'), row('z', 'w')));
    expect(refused).toThrow(/shares no/);
  });

  it('a row whose every cell sits under a merge cannot take an insert next to it', () => {
    const before = table('<tr><td rowspan="2">Item</td></tr>', '<tr></tr>');
    const after = table('<tr><td rowspan="2">Item</td></tr>', '<tr></tr>', row('d'));
    expect(() => compareTables(before, after)).toThrow(/merged cells/);
  });
});
