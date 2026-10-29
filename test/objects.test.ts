import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
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

