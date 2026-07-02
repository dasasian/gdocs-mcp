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

  it('returns not_found when no cell matches', async () => {
    const r = await setTableStyle(clientsFor(tableDoc()), 'd', 'nope', { padding: { left: 10 } });
    expect(r.status).toBe('not_found');
  });

  it('returns empty when no style fields are given', async () => {
    const r = await setTableStyle(clientsFor(tableDoc()), 'd', 'r0c0', {});
    expect(r.status).toBe('empty');
  });
});
