import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, writeControlFor, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { ALIGN_BY_CSS, type CssAlign } from './markdown-spec.js';
import { parseInline, segmentTextStyle } from './inline.js';
import { hexToRgb, rgbToHex } from './color.js';

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

// Locate a table (and the matched cell's position + the table's dimensions) by
// the text of any one of its cells — same anchor pattern as insertRow/deleteRow.
interface TableLoc {
  tableStart: number;
  rows: number;
  cols: number;
  rowIndex: number;
  columnIndex: number;
  /** the table itself, so a reader doesn't have to walk the content again. */
  table: docs_v1.Schema$Table;
}

function locateTable(doc: docs_v1.Schema$Document, cellText: string, tabId?: string, segmentId?: string): TableLoc | null {
  for (const el of contentOf(doc, tabId, segmentId)) {
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
            table: el.table!,
          };
        }
      }
    }
  }
  return null;
}

export interface TableStyleOptions extends SegmentOpts {
  tabId?: string;
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
  status: 'ok' | 'not_found' | 'empty' | 'no_segment';
  message?: string;
  applied?: string[];
  table?: { rows: number; columns: number; matchedCell: { rowIndex: number; columnIndex: number } };
}

// ---- Reading table style (#33) ---------------------------------------------

export interface BorderInfo {
  /** points; 0 means Docs is hiding the border (they cannot be transparent). */
  width?: number;
  /** hex, e.g. "#cccccc". */
  color?: string;
  dashStyle?: string;
}

export interface TableStyleInfo {
  status: 'ok' | 'not_found' | 'no_segment';
  message?: string;
  table?: { rows: number; columns: number; matchedCell: { rowIndex: number; columnIndex: number } };
  /** every column that carries an explicit width, in points. Feeds straight back to set_table_style. */
  columnWidths?: { index: number; width: number }[];
  /** how many leading rows repeat on every page. */
  headerRows?: number;
  /** the MATCHED cell's own style. Cells in one table can differ, so a table-wide
   *  answer would have to average or guess; this reports one cell exactly, a
   *  range would mix cells. */
  cell?: {
    /** Docs gives every cell 5pt padding by default, so this is present on tables
     *  nobody has styled. It is the real value, not a guess at intent. */
    padding?: { left?: number; right?: number; top?: number; bottom?: number };
    backgroundColor?: string;
    /** per side, since sides genuinely differ; set_table_style applies one style to `sides`. */
    borders?: { top?: BorderInfo; bottom?: BorderInfo; left?: BorderInfo; right?: BorderInfo };
  };
}

const ptOf = (d: docs_v1.Schema$Dimension | undefined): number | undefined =>
  d?.magnitude == null ? undefined : Math.round(d.magnitude * 100) / 100;

function borderInfo(b: docs_v1.Schema$TableCellBorder | undefined): BorderInfo | undefined {
  if (!b) return undefined;
  const out: BorderInfo = {};
  const w = ptOf(b.width);
  if (w !== undefined) out.width = w;
  const color = rgbToHex(b.color?.color?.rgbColor ?? undefined);
  if (color) out.color = color;
  if (b.dashStyle) out.dashStyle = b.dashStyle;
  return Object.keys(out).length ? out : undefined;
}

// The read counterpart to setTableStyle. Located the same way — by the text of any
// one cell — so the pair addresses tables identically.
export async function getTableStyle(
  clients: GoogleClients,
  documentId: string,
  cellText: string,
  opts: SegmentOpts & { tabId?: string } = {},
): Promise<TableStyleInfo> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tabId);
  const seg = resolveSegmentTarget(res.data, { segment: opts.segment, page: opts.page, tabId });
  if (seg.error) return { status: 'no_segment', message: seg.error };
  const loc = locateTable(seg.doc, cellText, tabId, seg.segmentId);
  if (!loc) return { status: 'not_found', message: `no table cell containing "${cellText}"${seg.segmentId ? ` in the ${opts.segment}` : ''}` };

  const out: TableStyleInfo = {
    status: 'ok',
    table: { rows: loc.rows, columns: loc.cols, matchedCell: { rowIndex: loc.rowIndex, columnIndex: loc.columnIndex } },
  };

  const widths = (loc.table.tableStyle?.tableColumnProperties ?? []).flatMap((cp, index) => {
    const width = ptOf(cp.width ?? undefined);
    // Docs reports EVENLY_DISTRIBUTED columns with no width; only a set one is a fact.
    return width !== undefined && cp.widthType === 'FIXED_WIDTH' ? [{ index, width }] : [];
  });
  if (widths.length) out.columnWidths = widths;

  let headerRows = 0;
  for (const row of loc.table.tableRows ?? []) {
    if (row.tableRowStyle?.tableHeader) headerRows += 1;
    else break;
  }
  if (headerRows) out.headerRows = headerRows;

  const style = loc.table.tableRows?.[loc.rowIndex]?.tableCells?.[loc.columnIndex]?.tableCellStyle ?? {};
  const cell: NonNullable<TableStyleInfo['cell']> = {};
  const padding = {
    left: ptOf(style.paddingLeft ?? undefined),
    right: ptOf(style.paddingRight ?? undefined),
    top: ptOf(style.paddingTop ?? undefined),
    bottom: ptOf(style.paddingBottom ?? undefined),
  };
  if (Object.values(padding).some((v) => v !== undefined)) {
    cell.padding = Object.fromEntries(Object.entries(padding).filter(([, v]) => v !== undefined));
  }
  const bg = rgbToHex(style.backgroundColor?.color?.rgbColor ?? undefined);
  if (bg) cell.backgroundColor = bg;
  const borders = {
    top: borderInfo(style.borderTop ?? undefined),
    bottom: borderInfo(style.borderBottom ?? undefined),
    left: borderInfo(style.borderLeft ?? undefined),
    right: borderInfo(style.borderRight ?? undefined),
  };
  if (Object.values(borders).some(Boolean)) {
    cell.borders = Object.fromEntries(Object.entries(borders).filter(([, v]) => v));
  }
  if (Object.keys(cell).length) out.cell = cell;

  return out;
}

export async function setTableStyle(
  clients: GoogleClients,
  documentId: string,
  cellText: string,
  opts: TableStyleOptions = {},
): Promise<TableStyleResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tabId);
  const seg = resolveSegmentTarget(res.data, { segment: opts.segment, page: opts.page, tabId });
  if (seg.error) return { status: 'no_segment', message: seg.error };
  const loc = locateTable(seg.doc, cellText, tabId, seg.segmentId);
  if (!loc) return { status: 'not_found', message: `no table cell containing "${cellText}"${seg.segmentId ? ` in the ${opts.segment}` : ''}` };

  const scope = opts.scope ?? 'table';
  const tableStartLocation = { index: loc.tableStart, tabId, segmentId: seg.segmentId };
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
