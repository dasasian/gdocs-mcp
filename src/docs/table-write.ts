import type { docs_v1 } from 'googleapis';
import { patchBetween, cellStyleUpdate, type CellCss, type CellPatch } from './table-css.js';
import { effectiveGrid, type Placement, type TableLayout } from './table-layout.js';
import { buildContentRequests, cellBlocksOf } from './write.js';
import { contentOf } from './structure.js';
import type { CellRef, Span, StructureOperation } from './table-compare.js';

export interface TableSite {
  tableStart: number;
  tabId?: string;
  segmentId?: string;
}

/** Everything a table's look is made of, as Docs holds it: the style at each grid position, column widths, row heights and how many rows repeat. */
export interface TableLook {
  grid: (CellCss | undefined)[][];
  widths: (number | undefined)[];
  heights: (number | 'unknown' | undefined)[];
  pinned: number;
}

export function lookOf(layout: TableLayout, placement: Placement): TableLook {
  return {
    grid: effectiveGrid(layout, placement),
    widths: Array.from({ length: placement.columnCount }, (_, c) => layout.columns[c]?.width),
    heights: layout.rows.map((row) => row.height),
    pinned: layout.rows.filter((row) => row.pinned).length,
  };
}

/** A table straight from `insertTable`. Docs gives a row a height of its own when a merge touches it, so those rows are `unknown` and get set. */
export function plainLook(rowCount: number, columnCount: number, rowsMerged: ReadonlySet<number>): TableLook {
  return {
    grid: Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => ({}))),
    widths: Array.from({ length: columnCount }, () => undefined),
    heights: Array.from({ length: rowCount }, (_, r) => (rowsMerged.has(r) ? 'unknown' : undefined)),
    pinned: 0,
  };
}

export function rowsTouchedByMerges(placement: Placement): Set<number> {
  const rows = new Set<number>();
  for (const { row, cell } of placement.cells) {
    for (let r = row; r < row + cell.rowspan; r++) if (cell.colspan > 1 || cell.rowspan > 1) rows.add(r);
  }
  return rows;
}

interface Run {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  patch: CellPatch;
}

const patchKey = (patch: CellPatch | undefined): string | undefined => (patch && Object.keys(patch).length ? JSON.stringify(patch) : undefined);

function rectanglesOf(patches: (CellPatch | undefined)[][]): Run[] {
  const rectangles: Run[] = [];
  patches.forEach((row, r) => {
    const runs: Run[] = [];
    row.forEach((patch, c) => {
      const key = patchKey(patch);
      const last = runs[runs.length - 1];
      if (!key) return;
      if (last && last.column + last.columnSpan === c && patchKey(last.patch) === key) last.columnSpan++;
      else runs.push({ row: r, column: c, rowSpan: 1, columnSpan: 1, patch: patch as CellPatch });
    });
    for (const run of runs) {
      const above = rectangles.find((rect) => rect.row + rect.rowSpan === r && rect.column === run.column && rect.columnSpan === run.columnSpan && patchKey(rect.patch) === patchKey(run.patch));
      if (above) above.rowSpan++;
      else rectangles.push(run);
    }
  });
  return rectangles;
}

const tableSizeInIndices = (rowCount: number, columnCount: number): number => 2 + rowCount * (1 + 2 * columnCount);

const holdsNothing = (el: docs_v1.Schema$StructuralElement): boolean =>
  Boolean(el.paragraph) && (el.paragraph?.elements ?? []).every((pe) => pe.textRun?.content === '\n');

/**
 * The requests that put an empty table where the placeholder paragraph at
 * `index` is, without leaving empty paragraphs around it. `insertTable` at the
 * start of a paragraph adds an empty paragraph before the table and the API
 * refuses to delete it, so when a paragraph ends right before the placeholder
 * the table goes in at the end of that paragraph's text instead, and the
 * paragraph mark it leaves after the table goes in the same batch. The
 * placeholder goes too, unless it is the last paragraph of the doc or segment,
 * which Docs requires. With no paragraph before it (the top of a doc or segment,
 * or another table), the empty paragraph before the table is kept: Docs
 * requires it.
 */
export function insertTableRequests(doc: docs_v1.Schema$Document, index: number, rowCount: number, columnCount: number, tabId?: string, segmentId?: string): docs_v1.Schema$Request[] {
  const content = contentOf(doc, tabId, segmentId);
  const startOf = (el: docs_v1.Schema$StructuralElement): number => el.startIndex ?? 0;
  const placeholder = content.find((el) => startOf(el) === index && holdsNothing(el));
  const following = placeholder && content.find((el) => startOf(el) === placeholder.endIndex);
  const removesPlaceholder = Boolean(following?.paragraph);
  const previous = content.find((el) => el.paragraph && el.endIndex === index);
  const size = tableSizeInIndices(rowCount, columnCount);
  const deleteMarkAt = (at: number): docs_v1.Schema$Request => ({ deleteContentRange: { range: { startIndex: at, endIndex: at + 1, tabId, segmentId } } });
  const insertAt = (at: number): docs_v1.Schema$Request => ({ insertTable: { location: { index: at, tabId, segmentId }, rows: rowCount, columns: columnCount } });
  if (previous) return [...(removesPlaceholder ? [deleteMarkAt(index)] : []), insertAt(index - 1), deleteMarkAt(index + size)];
  return [insertAt(index), ...(removesPlaceholder ? [deleteMarkAt(index + 1 + size)] : [])];
}

const location = (site: TableSite) => ({ index: site.tableStart, tabId: site.tabId, segmentId: site.segmentId });

export function mergeRequests(placement: Placement, site: TableSite): docs_v1.Schema$Request[] {
  return placement.cells
    .filter(({ cell }) => cell.colspan > 1 || cell.rowspan > 1)
    .map(({ row, column, cell }) => ({
      mergeTableCells: {
        tableRange: { tableCellLocation: { tableStartLocation: location(site), rowIndex: row, columnIndex: column }, rowSpan: cell.rowspan, columnSpan: cell.colspan },
      },
    }));
}

const cellLocation = (site: TableSite, ref: CellRef): docs_v1.Schema$TableCellLocation => ({ tableStartLocation: location(site), rowIndex: ref.row, columnIndex: ref.column });

const tableRangeOf = (site: TableSite, span: Span): docs_v1.Schema$TableRange => ({ tableCellLocation: cellLocation(site, span), rowSpan: span.rowSpan, columnSpan: span.columnSpan });

function structureRequest(operation: StructureOperation, site: TableSite): docs_v1.Schema$Request {
  switch (operation.kind) {
    case 'unmerge':
      return { unmergeTableCells: { tableRange: tableRangeOf(site, operation.span) } };
    case 'merge':
      return { mergeTableCells: { tableRange: tableRangeOf(site, operation.span) } };
    case 'deleteRow':
      return { deleteTableRow: { tableCellLocation: cellLocation(site, operation.at) } };
    case 'deleteColumn':
      return { deleteTableColumn: { tableCellLocation: cellLocation(site, operation.at) } };
    case 'insertRow':
      return { insertTableRow: { tableCellLocation: cellLocation(site, operation.at), insertBelow: operation.below } };
    case 'insertColumn':
      return { insertTableColumn: { tableCellLocation: cellLocation(site, operation.at), insertRight: operation.right } };
  }
}

/** The requests for a comparison's operations, in the order given: each addresses the table as the ones before it leave it. */
export const structureRequests = (operations: StructureOperation[], site: TableSite): docs_v1.Schema$Request[] => operations.map((operation) => structureRequest(operation, site));

/** The requests that take a table from one look to another. A cell that already looks right gets nothing. Neighbours that change the same way share one request. */
export function lookRequests(before: TableLook, after: TableLook, site: TableSite): docs_v1.Schema$Request[] {
  const patches = after.grid.map((row, r) => row.map((css, c) => (css ? patchBetween(before.grid[r]?.[c] ?? {}, css) : undefined)));
  const requests: docs_v1.Schema$Request[] = rectanglesOf(patches).map(({ row, column, rowSpan, columnSpan, patch }) => {
    const { style, fields } = cellStyleUpdate(patch);
    return {
      updateTableCellStyle: {
        tableRange: { tableCellLocation: { tableStartLocation: location(site), rowIndex: row, columnIndex: column }, rowSpan, columnSpan },
        tableCellStyle: style,
        fields: fields.join(','),
      },
    };
  });
  after.widths.forEach((width, column) => {
    if (width === before.widths[column]) return;
    requests.push({
      updateTableColumnProperties: {
        tableStartLocation: location(site),
        columnIndices: [column],
        tableColumnProperties: width === undefined ? { widthType: 'EVENLY_DISTRIBUTED' } : { widthType: 'FIXED_WIDTH', width: { magnitude: width, unit: 'PT' } },
        fields: 'width,widthType',
      },
    });
  });
  after.heights.forEach((height, row) => {
    if (height === before.heights[row]) return;
    requests.push({
      updateTableRowStyle: {
        tableStartLocation: location(site),
        rowIndices: [row],
        tableRowStyle: { minRowHeight: { magnitude: typeof height === 'number' ? height : 0, unit: 'PT' } },
        fields: 'minRowHeight',
      },
    });
  });
  if (after.pinned !== before.pinned) requests.push({ pinTableHeaderRows: { tableStartLocation: location(site), pinnedHeaderRowsCount: after.pinned } });
  return requests;
}

/** The words of every cell, typed into a table whose cells are empty. Highest index first, so no cell moves another. */
export function fillLayoutRequests(table: docs_v1.Schema$Table, placement: Placement, tabId?: string, segmentId?: string): docs_v1.Schema$Request[] {
  const filled = placement.cells.flatMap(({ row, column, cell }) => {
    const start = table.tableRows?.[row]?.tableCells?.[column]?.content?.[0]?.startIndex;
    const { blocks } = cellBlocksOf(cell);
    if (start == null || blocks.length === 0) return [];
    const { requests } = buildContentRequests(blocks, start, tabId, segmentId, { startsParagraph: true, endsInExistingParagraphMark: true });
    return [{ start, requests }];
  });
  return filled.sort((a, b) => b.start - a.start).flatMap((cell) => cell.requests);
}
