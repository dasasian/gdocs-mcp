import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { insertRow } from '../src/docs/objects.js';
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
    const r = await insertRow(clientsFor(headerTableDoc(), b), 'd', 'h1c1', { segment: 'header' });
    expect(r.status).toBe('ok');
    expect(r.location).toMatchObject({ rowIndex: 1, columnIndex: 1 });
    const loc = reqs(b)[0].insertTableRow!.tableCellLocation!.tableStartLocation!;
    expect(loc.segmentId).toBe(HDR);
  });

  it('body-scoped calls do not see the header table', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await insertRow(clientsFor(headerTableDoc(), b), 'd', 'h1c1');
    expect(r.status).toBe('not_found');
    expect(b).not.toHaveBeenCalled();
  });

  it('reports no_segment (not not_found) when the segment is absent', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await insertRow(clientsFor(headerTableDoc(), b), 'd', 'h1c1', { segment: 'footer' });
    expect(r.status).toBe('no_segment');
    expect(r.message).toContain('no footer');
    expect(b).not.toHaveBeenCalled();
  });

  it('body tables still work unchanged', async () => {
    const b = vi.fn().mockResolvedValue({});
    const r = await insertRow(clientsFor(headerTableDoc(), b), 'd', 'b1c1');
    expect(r.status).toBe('ok');
    const loc = reqs(b)[0].insertTableRow!.tableCellLocation!.tableStartLocation!;
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

