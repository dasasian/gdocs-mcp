import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { renderMarkdown } from '../src/docs/transformer.js';
import { background, bodyDocWithTable, plain, type TableSpec } from './table-fixtures.js';

const PRICES: TableSpec = { rows: [plain('Item', 'Price'), plain('Tea', '3'), plain('Cake', '5')] };

function tag(doc: docs_v1.Schema$Document, row: number, tags: { insertion?: string; deletion?: string; cell?: number }): docs_v1.Schema$Document {
  const copy = JSON.parse(JSON.stringify(doc)) as docs_v1.Schema$Document;
  const tableRow = copy.body!.content![0].table!.tableRows![row];
  for (const [at, cell] of tableRow.tableCells!.entries()) {
    if (tags.cell !== undefined && tags.cell !== at) continue;
    for (const el of cell.content!) for (const pe of el.paragraph!.elements!) {
      if (tags.insertion) pe.textRun!.suggestedInsertionIds = [tags.insertion];
      if (tags.deletion) pe.textRun!.suggestedDeletionIds = [tags.deletion];
    }
  }
  return copy;
}

describe('tracked mode marks suggestions inside table cells like it does in paragraphs', () => {
  it('a pipe table: a suggested row is <ins> in every cell, a suggested deleted row is <del>', () => {
    const added = tag(bodyDocWithTable(PRICES), 2, { insertion: 's1' });
    expect(renderMarkdown(added, { tracked: true })).toContain('| <ins data-sug="s1">Cake</ins> | <ins data-sug="s1">5</ins> |');
    const deleted = tag(bodyDocWithTable(PRICES), 1, { deletion: 's2' });
    expect(renderMarkdown(deleted, { tracked: true })).toContain('| <del data-sug="s2">Tea</del> | <del data-sug="s2">3</del> |');
  });

  it('a suggested edit inside one cell is the <ins> and <del> of its words', () => {
    const doc = bodyDocWithTable(PRICES);
    const cell = doc.body!.content![0].table!.tableRows![2].tableCells![1];
    cell.content![0].paragraph!.elements = [
      { startIndex: 20, endIndex: 21, textRun: { content: '6', suggestedInsertionIds: ['s3'] } },
      { startIndex: 21, endIndex: 22, textRun: { content: '5', suggestedDeletionIds: ['s3'] } },
      { startIndex: 22, endIndex: 23, textRun: { content: '\n' } },
    ];
    expect(renderMarkdown(doc, { tracked: true })).toContain('| Cake | <ins data-sug="s3">6</ins><del data-sug="s3">5</del> |');
  });

  it('an HTML table (one with a style) marks them too', () => {
    const doc = bodyDocWithTable({ rows: [{ cells: [{ text: 'Item', style: { backgroundColor: background('eee') } }, { text: 'Price' }] }, plain('Tea', '3')] });
    const tracked = renderMarkdown(tag(doc, 1, { insertion: 's4' }), { tracked: true });
    expect(tracked).toContain('<table');
    expect(tracked).toContain('<td><ins data-sug="s4">Tea</ins></td>');
    expect(tracked).toContain('<td><ins data-sug="s4">3</ins></td>');
  });

  it('an empty cell of a suggested row is marked by the suggestion on the cell, in a pipe table and an HTML table', () => {
    const empty = (row: number, key: 'suggestedInsertionIds' | 'suggestedDeletionIds', id: string) => {
      const doc = bodyDocWithTable({ rows: [plain('Item', 'Price'), plain('', '')] });
      for (const cell of doc.body!.content![0].table!.tableRows![row].tableCells!) cell[key] = [id];
      return doc;
    };
    expect(renderMarkdown(empty(1, 'suggestedInsertionIds', 's5'), { tracked: true })).toContain('| <ins data-sug="s5"></ins> | <ins data-sug="s5"></ins> |');
    expect(renderMarkdown(empty(1, 'suggestedDeletionIds', 's6'), { tracked: true })).toContain('| <del data-sug="s6"></del> | <del data-sug="s6"></del> |');
    expect(renderMarkdown(empty(1, 'suggestedInsertionIds', 's5'))).toContain('|  |  |');
    const styled = empty(1, 'suggestedInsertionIds', 's7');
    styled.body!.content![0].table!.tableRows![0].tableCells![0].tableCellStyle = { backgroundColor: background('eee') };
    expect(renderMarkdown(styled, { tracked: true })).toContain('<td><ins data-sug="s7"></ins></td>');
  });

  it('the same doc read without tracking shows plain text', () => {
    expect(renderMarkdown(tag(bodyDocWithTable(PRICES), 2, { insertion: 's1' }))).toContain('| Cake | 5 |');
  });
});
