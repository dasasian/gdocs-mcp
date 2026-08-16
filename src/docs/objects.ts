import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, tableInsertedAt, writeControlFor, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { resolveImageSource, uploadImageForInsert } from '../drive/images.js';
import { ALIGN_BY_CSS, type CssAlign } from './markdown-spec.js';
import { parseInline, segmentTextStyle } from './inline.js';
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
    /** resolve a relative local `uri` against this directory. */
    baseDir?: string;
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

  const source = resolveImageSource(uri, opts.baseDir);
  if ('error' in source) return { status: 'not_found', message: source.error };

  const objectSize =
    opts.width || opts.height
      ? {
          width: opts.width ? { magnitude: opts.width, unit: 'PT' } : undefined,
          height: opts.height ? { magnitude: opts.height, unit: 'PT' } : undefined,
        }
      : undefined;

  // A local file has to become a fetchable URL first — Docs embeds from a URL,
  // never from bytes. Same upload-embed-delete dance the markdown renderer does
  // for `![](./logo.png)`; it was previously reachable only from that path (#29).
  const upload = source.kind === 'local' ? await uploadImageForInsert(clients, source.path) : undefined;
  const uriToEmbed = upload ? upload.uri : (source as { kind: 'url'; uri: string }).uri;

  const requests: docs_v1.Schema$Request[] = [
    { insertInlineImage: { location: { index, tabId, segmentId }, uri: uriToEmbed, objectSize } },
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

  let objectId: string | undefined;
  try {
    const r = await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests, writeControl: writeControlFor(res.data.revisionId) },
    });
    const reply = r.data.replies?.[0] as { insertInlineImage?: { objectId?: string } } | undefined;
    objectId = reply?.insertInlineImage?.objectId ?? undefined;
  } finally {
    await upload?.cleanup();
  }

  return {
    status: 'ok',
    objectId,
    ...(seg.created ? { createdSegment: `${opts.segment}` } : {}),
  };
}

// Segment targeting is uniform across the table ops (#28): a table can live in a
// header/footer just as easily as the body (a letterhead is the common case), so
// they all take the same segment/page pair the text tools use.
export interface SegmentOpts {
  segment?: SegmentKind;
  page?: SegmentPage;
}

export interface TableOptions extends SegmentOpts {
  at?: string;
  tab?: string;
  data?: string[][];
  columnWidths?: number[]; // points per column
  headerShade?: string; // hex bg color for row 0, e.g. "#f1f3f4"
  /** per-column text alignment; null/'left' leaves the column at the default. */
  align?: (CssAlign | null)[];
  /** when segment is header/footer and the doc has none, create it first. */
  createSegment?: boolean;
}


// ---- Shared table-fill primitives -----------------------------------------
//
// Both entry points that create a table — the `insert_table` tool and the
// markdown renderer — insert an empty table, re-fetch to learn the new cell
// indices, then fill it. These are the parts that were duplicated with drifting
// feature sets (#29): the tool inserted cell text raw, so `data: [["**x**"]]`
// wrote literal asterisks into the document.

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

// ---- Table structure ops (surgical: preserve the rest of the table) ----

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
  opts: SegmentOpts & { tab?: string },
  build: (tcl: docs_v1.Schema$TableCellLocation) => docs_v1.Schema$Request,
): Promise<StructureResult> {
  const doc = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tabId = resolveTabId(doc, opts.tab);
  // create:false — you can't restructure a table in a header that doesn't exist,
  // so an absent segment is an error to report, not something to conjure up.
  const seg = await resolveSegmentTarget(clients, documentId, doc, { segment: opts.segment, page: opts.page, tabId });
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

export function insertRow(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { below?: boolean; tab?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts, (tcl) => ({ insertTableRow: { tableCellLocation: tcl, insertBelow: opts.below ?? true } }));
}

export function deleteRow(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { tab?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts, (tcl) => ({ deleteTableRow: { tableCellLocation: tcl } }));
}

export function insertColumn(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { right?: boolean; tab?: string } = {}) {
  return tableOp(clients, documentId, cellText, opts, (tcl) => ({ insertTableColumn: { tableCellLocation: tcl, insertRight: opts.right ?? true } }));
}

export function deleteColumn(clients: GoogleClients, documentId: string, cellText: string, opts: SegmentOpts & { tab?: string } = {}) {
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
          };
        }
      }
    }
  }
  return null;
}

export interface TableStyleOptions extends SegmentOpts {
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
  status: 'ok' | 'not_found' | 'empty' | 'no_segment';
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
  const seg = await resolveSegmentTarget(clients, documentId, res.data, { segment: opts.segment, page: opts.page, tabId });
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

export async function insertTable(
  clients: GoogleClients,
  documentId: string,
  rows: number,
  columns: number,
  opts: TableOptions = {},
): Promise<InsertResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tab);
  // Unlike the structure ops, inserting may legitimately need the segment made
  // first — same createSegment flag insert_image uses for the letterhead case.
  const seg = await resolveSegmentTarget(clients, documentId, res.data, {
    segment: opts.segment,
    page: opts.page,
    create: opts.createSegment,
    tabId,
  });
  if (seg.error) return { status: 'no_segment', message: seg.error };
  const segmentId = seg.segmentId;
  const resolved = resolveIndex(seg.doc, tabId, opts.at ?? 'end', segmentId);
  if ('error' in resolved) return resolved.error;
  const insertIndex = resolved.index;

  // 1. Insert the empty table.
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ insertTable: { location: { index: insertIndex, tabId, segmentId }, rows, columns } }],
      writeControl: writeControlFor(seg.doc.revisionId),
    },
  });

  const needsPass2 = opts.data || opts.columnWidths || opts.headerShade || opts.align?.some((a) => a && a !== 'left');
  if (!needsPass2) return { status: 'ok' };

  // 2. Re-fetch (the table now exists) and fill data + styling. Cell text inserts
  // go descending so earlier inserts don't shift later cell indices; width/shade
  // use logical table locations (stable regardless of text).
  const after = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tableEl = tableInsertedAt(after, insertIndex, tabId, segmentId);
  const tableStart = tableEl?.startIndex;
  if (!tableEl?.table?.tableRows || tableStart == null) return { status: 'ok' };

  const requests: docs_v1.Schema$Request[] = [];

  // Cell text goes through the same markdown-aware fill the markdown renderer
  // uses. Raw insertText here meant `data: [["**x**"]]` wrote literal asterisks
  // into the document — and since read_doc renders real bold as `**x**` too, the
  // round-trip looked correct while the text was corrupt (#29).
  if (opts.data) requests.push(...fillCellRequests(tableEl, opts.data, { tabId, segmentId }));

  if (opts.columnWidths) {
    opts.columnWidths.forEach((w, i) => {
      if (i < columns) {
        requests.push({
          updateTableColumnProperties: {
            tableStartLocation: { index: tableStart, tabId, segmentId },
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
          tableCellLocation: { tableStartLocation: { index: tableStart, tabId, segmentId }, rowIndex: 0, columnIndex: 0 },
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

  // Column alignment needs the post-fill indices, so it re-fetches — same shape
  // as the markdown renderer's alignment pass.
  if (opts.align?.some((a) => a && a !== 'left')) {
    const aligned = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
    const alignReqs = columnAlignRequests(tableInsertedAt(aligned, insertIndex, tabId, segmentId), opts.align, { tabId, segmentId });
    if (alignReqs.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: alignReqs } });
  }
  return { status: 'ok' };
}
