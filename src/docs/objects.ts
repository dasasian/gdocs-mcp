import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { ALIGN_BY_CSS, type CssAlign } from './markdown-spec.js';
import { parseInline, segmentTextStyle } from './inline.js';

/** The segment/page pair every table op takes, so a letterhead table is reachable like a body one. */
export interface SegmentOpts {
  segment?: SegmentKind;
  page?: SegmentPage;
}

export interface CellTarget {
  tabId?: string;
  segmentId?: string;
}

/**
 * Requests that fill a freshly-inserted table's cells, rendering each cell's
 * inline markdown (bold/italic/code/links). Emitted in DESCENDING index order so
 * an earlier insert can't shift a later cell's index.
 */
export function fillCellRequests(
  tableEl: docs_v1.Schema$StructuralElement,
  rows: string[][],
  at: CellTarget = {},
): docs_v1.Schema$Request[] {
  const { tabId, segmentId } = at;
  const cells: { index: number; md: string }[] = [];
  tableEl.table?.tableRows?.forEach((row, r) =>
    row.tableCells?.forEach((cell, c) => {
      const md = rows[r]?.[c];
      const idx = cell.content?.[0]?.startIndex;
      if (md && idx != null) cells.push({ index: idx, md });
    }),
  );
  cells.sort((a, b) => b.index - a.index);

  const requests: docs_v1.Schema$Request[] = [];
  for (const cell of cells) {
    const segs = parseInline(cell.md);
    const plain = segs.map((sg) => sg.text).join('');
    if (!plain) continue;
    requests.push({ insertText: { location: { index: cell.index, tabId, segmentId }, text: plain } });
    let off = 0;
    for (const seg of segs) {
      const { textStyle, fields } = segmentTextStyle(seg);
      if (fields.length) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: cell.index + off, endIndex: cell.index + off + seg.text.length, tabId, segmentId },
            textStyle,
            fields: fields.join(','),
          },
        });
      }
      off += seg.text.length;
    }
  }
  return requests;
}

/**
 * Requests that set per-column paragraph alignment across a table. Must run
 * against a doc re-fetched AFTER the cell text is in, since the paragraph ranges
 * move; paragraph-style ops don't change length, so one pass is enough.
 */
export function columnAlignRequests(
  tableEl: docs_v1.Schema$StructuralElement | undefined,
  aligns: (CssAlign | null)[],
  at: CellTarget = {},
): docs_v1.Schema$Request[] {
  const { tabId, segmentId } = at;
  const requests: docs_v1.Schema$Request[] = [];
  tableEl?.table?.tableRows?.forEach((row) =>
    row.tableCells?.forEach((cell, c) => {
      const a = aligns[c];
      const para = cell.content?.[0];
      if (a && a !== 'left' && para?.startIndex != null) {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: para.startIndex, endIndex: para.endIndex ?? para.startIndex + 1, tabId, segmentId },
            paragraphStyle: { alignment: ALIGN_BY_CSS[a] },
            fields: 'alignment',
          },
        });
      }
    }),
  );
  return requests;
}


function cellTextOf(cell: docs_v1.Schema$TableCell): string {
  let s = '';
  for (const el of cell.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) if (pe.textRun?.content) s += pe.textRun.content;
  }
  return s.trim();
}

export interface StructureResult {
  status: 'ok' | 'not_found' | 'no_segment';
  message?: string;
  location?: { rowIndex: number; columnIndex: number };
}

async function tableOp(
  clients: GoogleClients,
  documentId: string,
  cellText: string,
  opts: SegmentOpts & { tabId?: string },
  build: (tcl: docs_v1.Schema$TableCellLocation) => docs_v1.Schema$Request,
): Promise<StructureResult> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tabId = resolveTabId(doc, opts.tabId);
  const seg = resolveSegmentTarget(doc, { segment: opts.segment, page: opts.page, tabId });
  if (seg.error) return { status: 'no_segment', message: seg.error };
  const loc = locateTable(seg.doc, cellText, tabId, seg.segmentId);
  if (!loc) return { status: 'not_found', message: `no table cell containing "${cellText}"${seg.segmentId ? ` in the ${opts.segment}` : ''}` };
  const tcl: docs_v1.Schema$TableCellLocation = {
    tableStartLocation: { index: loc.tableStart, tabId, segmentId: seg.segmentId },
    rowIndex: loc.rowIndex,
    columnIndex: loc.columnIndex,
  };
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [build(tcl)] } });
  return { status: 'ok', location: { rowIndex: loc.rowIndex, columnIndex: loc.columnIndex } };
}

export function insertRow(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { below?: boolean; tabId?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts, (tcl) => ({ insertTableRow: { tableCellLocation: tcl, insertBelow: opts.below ?? true } }));
}

export function deleteRow(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { tabId?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts, (tcl) => ({ deleteTableRow: { tableCellLocation: tcl } }));
}

export function insertColumn(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { right?: boolean; tabId?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts, (tcl) => ({ insertTableColumn: { tableCellLocation: tcl, insertRight: opts.right ?? true } }));
}

export function deleteColumn(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { tabId?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts, (tcl) => ({ deleteTableColumn: { tableCellLocation: tcl } }));
}

interface TableLoc {
  tableStart: number;
  rowIndex: number;
  columnIndex: number;
}

function locateTable(doc: docs_v1.Schema$Document, cellText: string, tabId?: string, segmentId?: string): TableLoc | null {
  for (const el of contentOf(doc, tabId, segmentId)) {
    const rowsArr = el.table?.tableRows;
    if (!rowsArr || el.startIndex == null) continue;
    for (let r = 0; r < rowsArr.length; r++) {
      const cells = rowsArr[r].tableCells ?? [];
      for (let c = 0; c < cells.length; c++) {
        if (cellTextOf(cells[c]).includes(cellText)) {
          return { tableStart: el.startIndex, rowIndex: r, columnIndex: c };
        }
      }
    }
  }
  return null;
}
