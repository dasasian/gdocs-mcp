import type { docs_v1 } from 'googleapis';
import { cellCssOfDocs, type CellCss } from './table-css.js';
import { levelsOf, type LayoutCell, type TableLayout } from './table-layout.js';
import { renderHtmlTable } from './table-html.js';
import type { CssAlign } from './markdown-spec.js';

/** How the reader writes a cell's words. The table code decides the shape; the document reader supplies the text. */
export interface CellReader {
  /** the cell's alignment when it holds one plain paragraph that a pipe table can carry; undefined when it holds more. */
  plainAlignment(cell: docs_v1.Schema$TableCell): CssAlign | null | undefined;
  inPipeRow(cell: docs_v1.Schema$TableCell): string;
  /** a plain, unaligned cell as one line of inline markdown. */
  inHtmlRow(cell: docs_v1.Schema$TableCell): string;
  /** any cell as block markdown, one paragraph or list per block. */
  asBlocks(cell: docs_v1.Schema$TableCell): string;
}

const BLOCK_START = /^<(?:p|h[1-6])\b/i;

const spansOf = (cell: docs_v1.Schema$TableCell): { rowspan: number; colspan: number } => ({
  rowspan: cell.tableCellStyle?.rowSpan ?? 1,
  colspan: cell.tableCellStyle?.columnSpan ?? 1,
});

function coveredPositions(rows: docs_v1.Schema$TableRow[]): boolean[][] {
  const covered = rows.map((row) => (row.tableCells ?? []).map(() => false));
  rows.forEach((row, r) =>
    (row.tableCells ?? []).forEach((cell, c) => {
      if (covered[r][c]) return;
      const { rowspan, colspan } = spansOf(cell);
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if ((dr > 0 || dc > 0) && covered[r + dr]?.[c + dc] !== undefined) covered[r + dr][c + dc] = true;
        }
      }
    }),
  );
  return covered;
}

function pinnedRowCount(rows: docs_v1.Schema$TableRow[]): number {
  const firstUnpinned = rows.findIndex((row) => !row.tableRowStyle?.tableHeader);
  return firstUnpinned < 0 ? rows.length : firstUnpinned;
}

function columnWidths(table: docs_v1.Schema$Table, columnCount: number): (number | undefined)[] {
  const properties = table.tableStyle?.tableColumnProperties ?? [];
  return Array.from({ length: columnCount }, (_, c) => {
    const property = properties[c];
    const magnitude = property?.widthType === 'FIXED_WIDTH' ? property.width?.magnitude : undefined;
    return magnitude == null ? undefined : Math.round(magnitude * 100) / 100;
  });
}

function rowHeight(row: docs_v1.Schema$TableRow): number | undefined {
  const magnitude = row.tableRowStyle?.minRowHeight?.magnitude;
  return magnitude ? Math.round(magnitude * 100) / 100 : undefined;
}

function pipeAlignments(rows: docs_v1.Schema$TableRow[], read: CellReader, columnCount: number): (CssAlign | null)[] | undefined {
  const aligns: (CssAlign | null | undefined)[] = Array.from({ length: columnCount }, () => undefined);
  for (const row of rows) {
    for (const [c, cell] of (row.tableCells ?? []).entries()) {
      const align = read.plainAlignment(cell);
      if (align === undefined || align === 'left' || align === 'justify') return undefined;
      if (aligns[c] !== undefined && aligns[c] !== align) return undefined;
      aligns[c] = align;
    }
  }
  return aligns.map((a) => a ?? null);
}

function pipeTable(rows: docs_v1.Schema$TableRow[], aligns: (CssAlign | null)[], read: CellReader): string {
  const line = (cells: string[]): string => `| ${[...cells, ...Array(aligns.length - cells.length).fill('')].join(' | ')} |`;
  const separators = aligns.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : '---'));
  const [first, ...rest] = rows.map((row) => (row.tableCells ?? []).map((cell) => read.inPipeRow(cell)));
  return [line(first), line(separators), ...rest.map(line)].join('\n');
}

function layoutCell(cell: docs_v1.Schema$TableCell, css: CellCss, read: CellReader): LayoutCell {
  const markdown = read.plainAlignment(cell) === null ? read.inHtmlRow(cell) : read.asBlocks(cell);
  return { markdown, asBlocks: markdown.includes('\n') || BLOCK_START.test(markdown), css, ...spansOf(cell) };
}

function layoutFrom(table: docs_v1.Schema$Table, read: CellReader, covered: boolean[][], levels: ReturnType<typeof levelsOf>): TableLayout {
  const rows = table.tableRows ?? [];
  const pinned = pinnedRowCount(rows);
  const widths = columnWidths(table, levels.columns.length);
  return {
    css: levels.table,
    columns: levels.columns.map((css, c) => ({ css, width: widths[c] })),
    rows: rows.map((row, r) => ({
      css: levels.rows[r],
      height: rowHeight(row),
      pinned: r < pinned,
      cells: (row.tableCells ?? []).flatMap((cell, c) => (covered[r][c] ? [] : [layoutCell(cell, levels.cells[r][c], read)])),
    })),
  };
}

function analyse(table: docs_v1.Schema$Table) {
  const rows = table.tableRows ?? [];
  const covered = coveredPositions(rows);
  const styles = rows.map((row, r) => (row.tableCells ?? []).map((_, c) => (covered[r][c] ? undefined : styleOfHead(rows, r, c))));
  return { rows, covered, levels: levelsOf(styles) };
}

/** The table as the HTML form spells it, whether or not it would read as a pipe table. */
export function tableLayoutOf(table: docs_v1.Schema$Table, read: CellReader): TableLayout {
  const { covered, levels } = analyse(table);
  return layoutFrom(table, read, covered, levels);
}

function holdsOnlyDefaults(table: docs_v1.Schema$Table, covered: boolean[][], levels: ReturnType<typeof levelsOf>): boolean {
  const rows = table.tableRows ?? [];
  const unstyled = (css: CellCss): boolean => Object.keys(css).length === 0;
  return (
    unstyled(levels.table) &&
    levels.columns.every(unstyled) &&
    levels.rows.every(unstyled) &&
    levels.cells.every((row) => row.every(unstyled)) &&
    pinnedRowCount(rows) === 0 &&
    rows.every((row) => rowHeight(row) === undefined) &&
    columnWidths(table, levels.columns.length).every((width) => width === undefined) &&
    rows.every((row, r) => (row.tableCells ?? []).every((cell, c) => !covered[r][c] && spansOf(cell).rowspan === 1 && spansOf(cell).colspan === 1))
  );
}

function withEdgeFromCell(css: CellCss, property: 'border-right' | 'border-bottom', edgeCell: docs_v1.Schema$TableCell | undefined): CellCss {
  const { [property]: _own, ...rest } = css;
  const edge = cellCssOfDocs(edgeCell?.tableCellStyle)[property];
  return edge === undefined ? rest : { ...rest, [property]: edge };
}

function styleOfHead(rows: docs_v1.Schema$TableRow[], r: number, c: number): CellCss {
  const cell = rows[r].tableCells?.[c];
  const { rowspan, colspan } = spansOf(cell ?? {});
  let css = cellCssOfDocs(cell?.tableCellStyle);
  if (colspan > 1) css = withEdgeFromCell(css, 'border-right', rows[r].tableCells?.[c + colspan - 1]);
  if (rowspan > 1) css = withEdgeFromCell(css, 'border-bottom', rows[r + rowspan - 1]?.tableCells?.[c]);
  return css;
}

/** A pipe table when the table holds nothing but Docs defaults, an HTML table with its style as CSS when it does not. */
export function tableMarkup(table: docs_v1.Schema$Table, read: CellReader): string {
  const { rows, covered, levels } = analyse(table);
  if (!rows.length) return '';
  const aligns = pipeAlignments(rows, read, levels.columns.length);
  return aligns && holdsOnlyDefaults(table, covered, levels) ? pipeTable(rows, aligns, read) : renderHtmlTable(layoutFrom(table, read, covered, levels));
}
