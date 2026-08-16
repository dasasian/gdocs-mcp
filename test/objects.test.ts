import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { setTableStyle } from '../src/docs/objects.js';

// A 2-row × 3-column table with cell text "r{row}c{col}".
function tableDoc(): docs_v1.Schema$Document {
  const cell = (t: string): docs_v1.Schema$TableCell => ({
    content: [{ paragraph: { elements: [{ textRun: { content: t } }] } }],
  });
  return {
    tabs: [
      {
        documentTab: {
          body: {
            content: [
              {
                startIndex: 2,
                table: {
                  tableRows: [
                    { tableCells: [cell('r0c0'), cell('r0c1'), cell('r0c2')] },
                    { tableCells: [cell('r1c0'), cell('r1c1'), cell('r1c2')] },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

function clientsFor(doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: {
      documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate },
    } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

const reqs = (b: ReturnType<typeof vi.fn>) => b.mock.calls[0][0].requestBody.requests as docs_v1.Schema$Request[];

describe('setTableStyle', () => {
  it('spans the whole table for scope=table (default)', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r1c1', { padding: { left: 10 } });
    expect(r.status).toBe('ok');
    expect(r.table).toMatchObject({ rows: 2, columns: 3, matchedCell: { rowIndex: 1, columnIndex: 1 } });
    const ucs = reqs(b)[0].updateTableCellStyle!;
    expect(ucs.tableRange).toMatchObject({
      tableCellLocation: { tableStartLocation: { index: 2 }, rowIndex: 0, columnIndex: 0 },
      rowSpan: 2,
      columnSpan: 3,
    });
    expect(ucs.tableCellStyle!.paddingLeft).toEqual({ magnitude: 10, unit: 'PT' });
    expect(ucs.fields).toBe('paddingLeft');
  });

  it('spans one row for scope=row (at the matched cell’s row)', async () => {
    const b = vi.fn().mockResolvedValue({});
    await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r1c2', { scope: 'row', backgroundColor: '#f1f3f4' });
    const ucs = reqs(b)[0].updateTableCellStyle!;
    expect(ucs.tableRange).toMatchObject({ rowSpan: 1, columnSpan: 3, tableCellLocation: { rowIndex: 1, columnIndex: 0 } });
    expect(ucs.fields).toBe('backgroundColor');
  });

  it('spans one column for scope=column', async () => {
    const b = vi.fn().mockResolvedValue({});
    await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r0c2', { scope: 'column', padding: { right: 4 } });
    const ucs = reqs(b)[0].updateTableCellStyle!;
    expect(ucs.tableRange).toMatchObject({ rowSpan: 2, columnSpan: 1, tableCellLocation: { rowIndex: 0, columnIndex: 2 } });
  });

  it('emits updateTableColumnProperties for column widths', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r0c0', { columnWidths: [{ index: 0, width: 40 }] });
    const ucp = reqs(b).find((x) => x.updateTableColumnProperties)!.updateTableColumnProperties!;
    expect(ucp.columnIndices).toEqual([0]);
    expect(ucp.tableColumnProperties).toMatchObject({ widthType: 'FIXED_WIDTH', width: { magnitude: 40, unit: 'PT' } });
    expect(r.applied).toContain('width:col0');
  });

  it('ignores out-of-range column indices', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r0c0', { columnWidths: [{ index: 9, width: 40 }] });
    expect(r.status).toBe('empty');
  });

  it('sets all four borders by default, with color/dash defaults (#21)', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r0c0', { border: { width: 0 } });
    const ucs = reqs(b)[0].updateTableCellStyle!;
    expect(ucs.fields).toBe('borderTop,borderBottom,borderLeft,borderRight');
    expect(ucs.tableCellStyle!.borderTop).toEqual({
      width: { magnitude: 0, unit: 'PT' },
      color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
      dashStyle: 'SOLID',
    });
    expect(r.applied).toContain('table:borderTop');
  });

  it('restricts borders to the requested sides', async () => {
    const b = vi.fn().mockResolvedValue({});
    await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r0c0', {
      scope: 'row',
      border: { width: 2, color: '#ff0000', dashStyle: 'DASH', sides: ['bottom'] },
    });
    const ucs = reqs(b)[0].updateTableCellStyle!;
    expect(ucs.fields).toBe('borderBottom');
    expect(ucs.tableCellStyle!.borderBottom).toMatchObject({ width: { magnitude: 2 }, dashStyle: 'DASH' });
    expect(ucs.tableRange).toMatchObject({ rowSpan: 1, columnSpan: 3 });
  });

  it('pins the top N rows via pinTableHeaderRows (#19)', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r1c0', { headerRows: 1 });
    const pin = reqs(b).find((x) => x.pinTableHeaderRows)!.pinTableHeaderRows!;
    expect(pin).toMatchObject({ tableStartLocation: { index: 2 }, pinnedHeaderRowsCount: 1 });
    expect(r.applied).toContain('headerRows:1');
  });

  it('unpins with headerRows: 0', async () => {
    const b = vi.fn().mockResolvedValue({});
    await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r0c0', { headerRows: 0 });
    expect(reqs(b)[0].pinTableHeaderRows!.pinnedHeaderRowsCount).toBe(0);
  });

  it('clamps headerRows to the table height', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(tableDoc(), b), 'd', 'r0c0', { headerRows: 9 });
    expect(reqs(b)[0].pinTableHeaderRows!.pinnedHeaderRowsCount).toBe(2);
    expect(r.applied).toContain('headerRows:2');
  });

  it('returns not_found when no cell matches', async () => {
    const r = await setTableStyle(clientsFor(tableDoc()), 'd', 'nope', { padding: { left: 10 } });
    expect(r.status).toBe('not_found');
  });

  it('returns empty when no style fields are given', async () => {
    const r = await setTableStyle(clientsFor(tableDoc()), 'd', 'r0c0', {});
    expect(r.status).toBe('empty');
  });
});

// ---- #28: tables living in a header/footer --------------------------------
//
// A letterhead table is the common case. Before this, the table ops only ever
// walked the body, so a header table simply never matched — reported as
// "no table cell containing …" rather than as an unreachable segment.

const HDR = 'kix.hdr1';

// The header holds the real table; the body holds a decoy with different text,
// so a body-scoped scan cannot accidentally satisfy a header-scoped assertion.
function headerTableDoc(): docs_v1.Schema$Document {
  const cell = (t: string): docs_v1.Schema$TableCell => ({
    content: [{ paragraph: { elements: [{ textRun: { content: t } }] } }],
  });
  const table = (prefix: string) => ({
    startIndex: 2,
    table: {
      tableRows: [
        { tableCells: [cell(`${prefix}0c0`), cell(`${prefix}0c1`)] },
        { tableCells: [cell(`${prefix}1c0`), cell(`${prefix}1c1`)] },
      ],
    },
  });
  return {
    tabs: [
      {
        documentTab: {
          documentStyle: { defaultHeaderId: HDR },
          headers: { [HDR]: { headerId: HDR, content: [table('h')] } },
          body: { content: [table('b')] },
        },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

describe('table ops reach headers/footers (#28)', () => {
  it('finds a header table and scopes the write to that segment', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(headerTableDoc(), b), 'd', 'h1c1', {
      segment: 'header',
      backgroundColor: '#f1f3f4',
    });
    expect(r.status).toBe('ok');
    expect(r.table).toMatchObject({ matchedCell: { rowIndex: 1, columnIndex: 1 } });
    const loc = reqs(b)[0].updateTableCellStyle!.tableRange!.tableCellLocation!.tableStartLocation!;
    expect(loc.segmentId).toBe(HDR);
  });

  it('body-scoped calls do not see the header table', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(headerTableDoc(), b), 'd', 'h1c1', { backgroundColor: '#fff' });
    expect(r.status).toBe('not_found');
    expect(b).not.toHaveBeenCalled();
  });

  it('reports no_segment (not not_found) when the segment is absent', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(headerTableDoc(), b), 'd', 'h1c1', {
      segment: 'footer',
      backgroundColor: '#fff',
    });
    expect(r.status).toBe('no_segment');
    expect(r.message).toContain('no footer');
    expect(b).not.toHaveBeenCalled();
  });

  it('body tables still work unchanged', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await setTableStyle(clientsFor(headerTableDoc(), b), 'd', 'b1c1', { backgroundColor: '#fff' });
    expect(r.status).toBe('ok');
    const loc = reqs(b)[0].updateTableCellStyle!.tableRange!.tableCellLocation!.tableStartLocation!;
    expect(loc.segmentId).toBeUndefined();
  });
});

// ---- #29: one fill path for both table entry points ------------------------
//
// `insert_table` inserted cell text raw, so `data: [["**x**"]]` put literal
// asterisks in the document — and because read_doc renders real bold as `**x**`
// too, the round-trip looked correct while the text was corrupt.

import { fillCellRequests, columnAlignRequests } from '../src/docs/objects.js';

function freshTable(): docs_v1.Schema$StructuralElement {
  const cell = (start: number): docs_v1.Schema$TableCell => ({
    content: [{ startIndex: start, endIndex: start + 1, paragraph: { elements: [] } }],
  });
  return {
    startIndex: 2,
    table: {
      tableRows: [
        { tableCells: [cell(4), cell(6)] },
        { tableCells: [cell(8), cell(10)] },
      ],
    },
  };
}

describe('fillCellRequests (#29)', () => {
  it('renders inline markdown instead of inserting it literally', () => {
    const reqs = fillCellRequests(freshTable(), [['**b**']]);
    const inserted = reqs.filter((r) => r.insertText).map((r) => r.insertText!.text);
    expect(inserted).toEqual(['b']); // not '**b**'
    const style = reqs.find((r) => r.updateTextStyle)!.updateTextStyle!;
    expect(style.textStyle!.bold).toBe(true);
    expect(style.range).toMatchObject({ startIndex: 4, endIndex: 5 });
  });

  it('fills descending so an earlier insert cannot shift a later cell', () => {
    const reqs = fillCellRequests(freshTable(), [['a', 'b'], ['c', 'd']]);
    const idx = reqs.filter((r) => r.insertText).map((r) => r.insertText!.location!.index);
    expect(idx).toEqual([...idx].sort((x, y) => y! - x!));
  });

  it('carries tab and segment onto every request', () => {
    const reqs = fillCellRequests(freshTable(), [['**x**']], { tabId: 't.0', segmentId: 'kix.h' });
    for (const r of reqs) {
      const loc = r.insertText?.location ?? r.updateTextStyle?.range;
      expect(loc).toMatchObject({ tabId: 't.0', segmentId: 'kix.h' });
    }
  });

  it('skips cells with no content', () => {
    expect(fillCellRequests(freshTable(), [['', 'b']]).filter((r) => r.insertText)).toHaveLength(1);
  });
});

describe('columnAlignRequests (#29)', () => {
  it('aligns by column, leaving left/null columns alone', () => {
    const reqs = columnAlignRequests(freshTable(), ['center', null]);
    expect(reqs).toHaveLength(2); // column 0 of both rows
    for (const r of reqs) expect(r.updateParagraphStyle!.paragraphStyle!.alignment).toBe('CENTER');
  });

  it('treats an explicit left as the default (no request)', () => {
    expect(columnAlignRequests(freshTable(), ['left', 'left'])).toEqual([]);
  });

  it('is a no-op when the table could not be located', () => {
    expect(columnAlignRequests(undefined, ['center'])).toEqual([]);
  });
});

// ---- #33: reading a table's style ------------------------------------------
//
// set_table_style was the only setter with no getter, so column widths, header
// shading and borders were all settable and none of them could be read back.

import { getTableStyle } from '../src/docs/objects.js';

function styledTableDoc(): docs_v1.Schema$Document {
  const cell = (t: string, style?: docs_v1.Schema$TableCellStyle): docs_v1.Schema$TableCell => ({
    content: [{ paragraph: { elements: [{ textRun: { content: t } }] } }],
    tableCellStyle: style,
  });
  const pt = (n: number) => ({ magnitude: n, unit: 'PT' });
  const red = { color: { color: { rgbColor: { red: 0.8 } } } };
  return {
    tabs: [
      {
        documentTab: {
          body: {
            content: [
              {
                startIndex: 2,
                table: {
                  tableStyle: {
                    tableColumnProperties: [
                      { widthType: 'FIXED_WIDTH', width: pt(140) },
                      { widthType: 'EVENLY_DISTRIBUTED' },
                    ],
                  },
                  tableRows: [
                    {
                      tableRowStyle: { tableHeader: true },
                      tableCells: [
                        cell('H1', {
                          backgroundColor: { color: { rgbColor: { red: 0.945, green: 0.953, blue: 0.957 } } },
                          paddingLeft: pt(12),
                          borderTop: { ...red, width: pt(2), dashStyle: 'DASH' },
                        }),
                        cell('H2'),
                      ],
                    },
                    { tableCells: [cell('a'), cell('b')] },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

describe('getTableStyle (#33)', () => {
  it('reads table-wide facts and the matched cell together', async () => {
    const r = await getTableStyle(clientsFor(styledTableDoc()), 'd', 'H1');
    expect(r.status).toBe('ok');
    expect(r.table).toMatchObject({ rows: 2, columns: 2, matchedCell: { rowIndex: 0, columnIndex: 0 } });
    expect(r.headerRows).toBe(1);
    expect(r.cell?.backgroundColor).toBe('#f1f3f4');
    expect(r.cell?.padding).toEqual({ left: 12 });
    expect(r.cell?.borders?.top).toEqual({ width: 2, color: '#cc0000', dashStyle: 'DASH' });
  });

  // The point of the getter: its output is the setter's input.
  it('returns columnWidths in the shape set_table_style accepts', async () => {
    const r = await getTableStyle(clientsFor(styledTableDoc()), 'd', 'H1');
    expect(r.columnWidths).toEqual([{ index: 0, width: 140 }]);
  });

  it('omits a column with no explicit width rather than inventing one', async () => {
    const r = await getTableStyle(clientsFor(styledTableDoc()), 'd', 'H1');
    expect(r.columnWidths?.some((c) => c.index === 1)).toBe(false);
  });

  it('reports the matched cell, not the first — cells differ', async () => {
    const r = await getTableStyle(clientsFor(styledTableDoc()), 'd', 'b');
    expect(r.table?.matchedCell).toEqual({ rowIndex: 1, columnIndex: 1 });
    expect(r.cell).toBeUndefined(); // that cell carries no style of its own
  });

  it('reports nothing rather than defaults for an unstyled table', async () => {
    const r = await getTableStyle(clientsFor(styledTableDoc()), 'd', 'H2');
    expect(r.headerRows).toBe(1); // table-wide, still true
    expect(r.cell).toBeUndefined();
  });

  it('distinguishes a missing table from an unreachable segment', async () => {
    expect((await getTableStyle(clientsFor(styledTableDoc()), 'd', 'nope')).status).toBe('not_found');
    const seg = await getTableStyle(clientsFor(styledTableDoc()), 'd', 'H1', { segment: 'footer' });
    expect(seg.status).toBe('no_segment');
    expect(seg.message).toContain('no footer');
  });
});
