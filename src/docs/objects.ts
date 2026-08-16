import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, tableInsertedAt, writeControlFor, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { ALIGN_BY_CSS } from './markdown-spec.js';
import { project } from './transformer.js';
import { locate, rangeFor, contextAround } from './edit.js';
import { hexToRgb } from './color.js';

// Objects markdown can't size/place: images (and tables). Position is `top`,
// `end`, or a unique text anchor (insert right after the matched text).

function tabEndIndex(doc: docs_v1.Schema$Document, tabId?: string, segmentId?: string): number {
  const content = contentOf(doc, tabId, segmentId);
  const last = content[content.length - 1];
  return last?.endIndex ?? 2;
}

export interface InsertResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'no_segment';
  objectId?: string;
  message?: string;
  matches?: { context: string }[];
  /** set when the call had to create the header/footer it wrote into. */
  createdSegment?: string;
}

// Resolve an `at` selector to a Docs insertion index.
export function resolveIndex(
  doc: docs_v1.Schema$Document,
  tabId: string | undefined,
  at: string,
  segmentId?: string,
): { index: number } | { error: InsertResult } {
  // A header/footer segment starts at index 0, not 1 (the body's leading
  // section break doesn't exist there) — verified live.
  if (at === 'top') return { index: segmentId ? 0 : 1 };
  if (at === 'end') return { index: tabEndIndex(doc, tabId, segmentId) - 1 };
  const proj = project(doc, tabId, segmentId);
  const { needle, positions } = locate(proj.text, at);
  if (positions.length === 0) return { error: { status: 'not_found', message: `anchor "${at}" not found` } };
  if (positions.length > 1) {
    return {
      error: {
        status: 'ambiguous',
        message: `${positions.length} matches for anchor — add context.`,
        matches: positions.map((p) => ({ context: contextAround(proj.text, p, p + needle.length) })),
      },
    };
  }
  const p = positions[0];
  return { index: rangeFor(proj, p, p + needle.length).endIndex };
}

export async function insertImage(
  clients: GoogleClients,
  documentId: string,
  uri: string,
  opts: {
    at?: string;
    width?: number;
    height?: number;
    align?: 'left' | 'center' | 'right';
    tab?: string;
    segment?: SegmentKind;
    page?: SegmentPage;
    createSegment?: boolean;
  } = {},
): Promise<InsertResult> {
  const first = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(first.data, opts.tab);
  // The letterhead case (#23): a logo belongs in the page header, where it
  // repeats and stays sized — not pasted into the body of page 1.
  const seg = await resolveSegmentTarget(clients, documentId, first.data, {
    segment: opts.segment,
    page: opts.page,
    create: opts.createSegment,
    tabId,
  });
  if (seg.error) return { status: 'no_segment', message: seg.error };
  const segmentId = seg.segmentId;
  const res = { data: seg.doc };
  const resolved = resolveIndex(res.data, tabId, opts.at ?? 'top', segmentId);
  if ('error' in resolved) return resolved.error;
  const index = resolved.index;

  const objectSize =
    opts.width || opts.height
      ? {
          width: opts.width ? { magnitude: opts.width, unit: 'PT' } : undefined,
          height: opts.height ? { magnitude: opts.height, unit: 'PT' } : undefined,
        }
      : undefined;

  const requests: docs_v1.Schema$Request[] = [
    { insertInlineImage: { location: { index, tabId, segmentId }, uri, objectSize } },
  ];
  // To align, isolate the image on its own paragraph (newline after it) and set
  // that paragraph's alignment. The image occupies one index unit at `index`.
  if (opts.align) {
    requests.push({ insertText: { location: { index: index + 1, tabId, segmentId }, text: '\n' } });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: index, endIndex: index + 1, tabId, segmentId },
        paragraphStyle: { alignment: ALIGN_BY_CSS[opts.align] },
        fields: 'alignment',
      },
    });
  }

  const r = await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests,
      writeControl: writeControlFor(res.data.revisionId),
    },
  });
  const reply = r.data.replies?.[0] as { insertInlineImage?: { objectId?: string } } | undefined;
  return {
    status: 'ok',
    objectId: reply?.insertInlineImage?.objectId,
    ...(seg.created ? { createdSegment: `${opts.segment}` } : {}),
  };
}

export interface TableOptions {
  at?: string;
  tab?: string;
  data?: string[][];
  columnWidths?: number[]; // points per column
  headerShade?: string; // hex bg color for row 0, e.g. "#f1f3f4"
}

// ---- Table structure ops (surgical: preserve the rest of the table) ----

function cellTextOf(cell: docs_v1.Schema$TableCell): string {
  let s = '';
  for (const el of cell.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) if (pe.textRun?.content) s += pe.textRun.content;
  }
  return s.trim();
}

export interface StructureResult {
  status: 'ok' | 'not_found';
  message?: string;
  location?: { rowIndex: number; columnIndex: number };
}

async function tableOp(
  clients: GoogleClients,
  documentId: string,
  cellText: string,
  tab: string | undefined,
  build: (tcl: docs_v1.Schema$TableCellLocation) => docs_v1.Schema$Request,
): Promise<StructureResult> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tabId = resolveTabId(doc, tab);
  const loc = locateTable(doc, cellText, tabId);
  if (!loc) return { status: 'not_found', message: `no table cell containing "${cellText}"` };
  const tcl: docs_v1.Schema$TableCellLocation = {
    tableStartLocation: { index: loc.tableStart, tabId },
    rowIndex: loc.rowIndex,
    columnIndex: loc.columnIndex,
  };
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: [build(tcl)] } });
  return { status: 'ok', location: { rowIndex: loc.rowIndex, columnIndex: loc.columnIndex } };
}

export function insertRow(clients: GoogleClients, documentId: string, cellText: string, opts: { below?: boolean; tab?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts.tab, (tcl) => ({ insertTableRow: { tableCellLocation: tcl, insertBelow: opts.below ?? true } }));
}

export function deleteRow(clients: GoogleClients, documentId: string, cellText: string, opts: { tab?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts.tab, (tcl) => ({ deleteTableRow: { tableCellLocation: tcl } }));
}

export function insertColumn(clients: GoogleClients, documentId: string, cellText: string, opts: { right?: boolean; tab?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts.tab, (tcl) => ({ insertTableColumn: { tableCellLocation: tcl, insertRight: opts.right ?? true } }));
}

export function deleteColumn(clients: GoogleClients, documentId: string, cellText: string, opts: { tab?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts.tab, (tcl) => ({ deleteTableColumn: { tableCellLocation: tcl } }));
}

// Locate a table (and the matched cell's position + the table's dimensions) by
// the text of any one of its cells — same anchor pattern as insertRow/deleteRow.
interface TableLoc {
  tableStart: number;
  rows: number;
  cols: number;
  rowIndex: number;
  columnIndex: number;
}

function locateTable(doc: docs_v1.Schema$Document, cellText: string, tabId?: string): TableLoc | null {
  for (const el of contentOf(doc, tabId)) {
    const rowsArr = el.table?.tableRows;
    if (!rowsArr || el.startIndex == null) continue;
    for (let r = 0; r < rowsArr.length; r++) {
      const cells = rowsArr[r].tableCells ?? [];
      for (let c = 0; c < cells.length; c++) {
        if (cellTextOf(cells[c]).includes(cellText)) {
          return {
            tableStart: el.startIndex,
            rows: rowsArr.length,
            cols: rowsArr[0].tableCells?.length ?? cells.length,
            rowIndex: r,
            columnIndex: c,
          };
        }
      }
    }
  }
  return null;
}

export interface TableStyleOptions {
  tab?: string;
  /** which cells padding/background apply to; default 'table' (the whole table). */
  scope?: 'table' | 'row' | 'column' | 'cell';
  /** cell padding in points (any subset). */
  padding?: { left?: number; right?: number; top?: number; bottom?: number };
  /** cell background as hex, e.g. "#f1f3f4". */
  backgroundColor?: string;
  /** cell borders (#21). width 0 hides them; sides defaults to all four. */
  border?: {
    width?: number;
    color?: string;
    dashStyle?: 'SOLID' | 'DOT' | 'DASH';
    sides?: ('top' | 'bottom' | 'left' | 'right')[];
  };
  /** set specific column widths (points), by column index. */
  columnWidths?: { index: number; width: number }[];
  /** repeat the top N rows on every page (#19). 0 unpins. */
  headerRows?: number;
}

export interface TableStyleResult {
  status: 'ok' | 'not_found' | 'empty';
  message?: string;
  applied?: string[];
  table?: { rows: number; columns: number; matchedCell: { rowIndex: number; columnIndex: number } };
}

// Edit style/layout of an EXISTING table (#8): cell padding, background, column
// widths — reusing the same request types insert_table builds, but against a
// located table rather than a freshly-created one.
export async function setTableStyle(
  clients: GoogleClients,
  documentId: string,
  cellText: string,
  opts: TableStyleOptions = {},
): Promise<TableStyleResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tab);
  const loc = locateTable(res.data, cellText, tabId);
  if (!loc) return { status: 'not_found', message: `no table cell containing "${cellText}"` };

  const scope = opts.scope ?? 'table';
  const tableStartLocation = { index: loc.tableStart, tabId };
  const requests: docs_v1.Schema$Request[] = [];
  const applied: string[] = [];

  // Build the padding/background cell style, if requested.
  const cellStyle: docs_v1.Schema$TableCellStyle = {};
  const cellFields: string[] = [];
  const dim = (v: number) => ({ magnitude: v, unit: 'PT' });
  if (opts.padding) {
    const p = opts.padding;
    if (p.left !== undefined) (cellStyle.paddingLeft = dim(p.left)), cellFields.push('paddingLeft');
    if (p.right !== undefined) (cellStyle.paddingRight = dim(p.right)), cellFields.push('paddingRight');
    if (p.top !== undefined) (cellStyle.paddingTop = dim(p.top)), cellFields.push('paddingTop');
    if (p.bottom !== undefined) (cellStyle.paddingBottom = dim(p.bottom)), cellFields.push('paddingBottom');
  }
  if (opts.backgroundColor !== undefined) {
    cellStyle.backgroundColor = { color: { rgbColor: hexToRgb(opts.backgroundColor) } };
    cellFields.push('backgroundColor');
  }
  if (opts.border) {
    // A border can't be transparent — width 0 is how Docs hides one, so a
    // borderless table is border:{width:0} (#21). Color/dash carry defaults so a
    // width-only or color-only call still sends a complete border object.
    const b = opts.border;
    const border: docs_v1.Schema$TableCellBorder = {
      width: dim(b.width ?? 1),
      color: { color: { rgbColor: hexToRgb(b.color ?? '#000000') } },
      dashStyle: b.dashStyle ?? 'SOLID',
    };
    const sides = b.sides?.length ? b.sides : (['top', 'bottom', 'left', 'right'] as const);
    for (const side of sides) {
      const field = `border${side[0].toUpperCase()}${side.slice(1)}` as 'borderTop' | 'borderBottom' | 'borderLeft' | 'borderRight';
      cellStyle[field] = border;
      cellFields.push(field);
    }
  }

  if (cellFields.length) {
    // Cover the requested scope with one tableRange.
    const range =
      scope === 'row'
        ? { rowIndex: loc.rowIndex, columnIndex: 0, rowSpan: 1, columnSpan: loc.cols }
        : scope === 'column'
          ? { rowIndex: 0, columnIndex: loc.columnIndex, rowSpan: loc.rows, columnSpan: 1 }
          : scope === 'cell'
            ? { rowIndex: loc.rowIndex, columnIndex: loc.columnIndex, rowSpan: 1, columnSpan: 1 }
            : { rowIndex: 0, columnIndex: 0, rowSpan: loc.rows, columnSpan: loc.cols };
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: { tableStartLocation, rowIndex: range.rowIndex, columnIndex: range.columnIndex },
          rowSpan: range.rowSpan,
          columnSpan: range.columnSpan,
        },
        tableCellStyle: cellStyle,
        fields: cellFields.join(','),
      },
    });
    applied.push(...cellFields.map((f) => `${scope}:${f}`));
  }

  for (const cw of opts.columnWidths ?? []) {
    if (cw.index < 0 || cw.index >= loc.cols) continue;
    requests.push({
      updateTableColumnProperties: {
        tableStartLocation,
        columnIndices: [cw.index],
        tableColumnProperties: { widthType: 'FIXED_WIDTH', width: dim(cw.width) },
        fields: 'width,widthType',
      },
    });
    applied.push(`width:col${cw.index}`);
  }

  if (opts.headerRows !== undefined) {
    // Pin the top N rows so they repeat on each page (#19). Note this is its own
    // request type — tableRowStyle.tableHeader is read-only, and sending it on
    // updateTableRowStyle is rejected live with "Unallowed field: tableHeader".
    const n = Math.max(0, Math.min(Math.floor(opts.headerRows), loc.rows));
    requests.push({ pinTableHeaderRows: { tableStartLocation, pinnedHeaderRowsCount: n } });
    applied.push(`headerRows:${n}`);
  }

  if (!requests.length) return { status: 'empty', message: 'no style fields provided' };

  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests,
      writeControl: writeControlFor(res.data.revisionId),
    },
  });
  return {
    status: 'ok',
    applied,
    table: { rows: loc.rows, columns: loc.cols, matchedCell: { rowIndex: loc.rowIndex, columnIndex: loc.columnIndex } },
  };
}

export async function insertTable(
  clients: GoogleClients,
  documentId: string,
  rows: number,
  columns: number,
  opts: TableOptions = {},
): Promise<InsertResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tab);
  const resolved = resolveIndex(res.data, tabId, opts.at ?? 'end');
  if ('error' in resolved) return resolved.error;
  const insertIndex = resolved.index;

  // 1. Insert the empty table.
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ insertTable: { location: { index: insertIndex, tabId }, rows, columns } }],
      writeControl: writeControlFor(res.data.revisionId),
    },
  });

  const needsPass2 = opts.data || opts.columnWidths || opts.headerShade;
  if (!needsPass2) return { status: 'ok' };

  // 2. Re-fetch (the table now exists) and fill data + styling. Cell text inserts
  // go descending so earlier inserts don't shift later cell indices; width/shade
  // use logical table locations (stable regardless of text).
  const after = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tableEl = tableInsertedAt(after, insertIndex, tabId);
  const tableStart = tableEl?.startIndex;
  if (!tableEl?.table?.tableRows || tableStart == null) return { status: 'ok' };

  const requests: docs_v1.Schema$Request[] = [];

  if (opts.data) {
    const inserts: { index: number; text: string }[] = [];
    tableEl.table.tableRows.forEach((row, r) => {
      row.tableCells?.forEach((cell, c) => {
        const text = opts.data?.[r]?.[c];
        const idx = cell.content?.[0]?.startIndex;
        if (text && idx != null) inserts.push({ index: idx, text });
      });
    });
    inserts.sort((a, b) => b.index - a.index);
    for (const i of inserts) requests.push({ insertText: { location: { index: i.index, tabId }, text: i.text } });
  }

  if (opts.columnWidths) {
    opts.columnWidths.forEach((w, i) => {
      if (i < columns) {
        requests.push({
          updateTableColumnProperties: {
            tableStartLocation: { index: tableStart, tabId },
            columnIndices: [i],
            tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: w, unit: 'PT' } },
            fields: 'width,widthType',
          },
        });
      }
    });
  }

  if (opts.headerShade) {
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: { tableStartLocation: { index: tableStart, tabId }, rowIndex: 0, columnIndex: 0 },
          rowSpan: 1,
          columnSpan: columns,
        },
        tableCellStyle: { backgroundColor: { color: { rgbColor: hexToRgb(opts.headerShade) } } },
        fields: 'backgroundColor',
      },
    });
  }

  if (requests.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: writeControlFor(after.revisionId),
      },
    });
  }
  return { status: 'ok' };
}
