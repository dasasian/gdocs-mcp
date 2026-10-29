import { CELL_PROPERTIES, withoutDefaults, isDefaultValue, type CellCss, type CellProperty } from './table-css.js';

export interface LayoutCell {
  /** inline markdown, or block markdown when `asBlocks`. */
  markdown: string;
  asBlocks: boolean;
  css: CellCss;
  colspan: number;
  rowspan: number;
}

export interface LayoutRow {
  css: CellCss;
  /** points; Docs' minimum row height. */
  height?: number;
  pinned: boolean;
  /** the cells that start in this row. A cell a merge covers is not here. */
  cells: LayoutCell[];
}

export interface LayoutColumn {
  css: CellCss;
  /** points. */
  width?: number;
}

/** A table as the HTML form spells it: style at the table, column, row and cell. */
export interface TableLayout {
  css: CellCss;
  columns: LayoutColumn[];
  rows: LayoutRow[];
}

export interface PlacedCell {
  row: number;
  column: number;
  cell: LayoutCell;
}

export interface Placement {
  rowCount: number;
  columnCount: number;
  cells: PlacedCell[];
  issues: string[];
}

/** Puts each cell where the HTML table model puts it: left to right, around the cells a rowspan reaches down into. */
export function placeCells(layout: TableLayout): Placement {
  const taken = new Set<string>();
  const cells: PlacedCell[] = [];
  const issues: string[] = [];
  const rowCount = layout.rows.length;
  let columnCount = layout.columns.length;
  layout.rows.forEach((row, r) => {
    let column = 0;
    for (const cell of row.cells) {
      while (taken.has(`${r},${column}`)) column++;
      if (r + cell.rowspan > rowCount) issues.push(`row ${r + 1}: rowspan="${cell.rowspan}" runs past the last row`);
      for (let dr = 0; dr < cell.rowspan; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          if (taken.has(`${r + dr},${column + dc}`)) issues.push(`row ${r + 1}: a cell overlaps another at column ${column + dc + 1}`);
          taken.add(`${r + dr},${column + dc}`);
        }
      }
      cells.push({ row: r, column, cell });
      columnCount = Math.max(columnCount, column + cell.colspan);
      column += cell.colspan;
    }
  });
  return { rowCount, columnCount, cells, issues };
}

export function cascade(layout: TableLayout, placed: PlacedCell): CellCss {
  const merged: CellCss = { ...layout.css, ...layout.columns[placed.column]?.css, ...layout.rows[placed.row].css, ...placed.cell.css };
  return withoutDefaults(merged);
}

/** The cell style at each grid position; `undefined` where a merged cell covers it. */
export function effectiveGrid(layout: TableLayout, placement: Placement): (CellCss | undefined)[][] {
  const grid: (CellCss | undefined)[][] = Array.from({ length: placement.rowCount }, () => Array.from({ length: placement.columnCount }, () => undefined));
  for (const placed of placement.cells) grid[placed.row][placed.column] = cascade(layout, placed);
  return grid;
}

/**
 * Spells a grid of cell styles as the fewest declarations: a value goes on the
 * <table> when every cell has it, else on each <col> or <tr> whose cells all
 * have it, else on the cells left over. Cascading them back gives the grid.
 */
export function levelsOf(grid: (CellCss | undefined)[][]): { table: CellCss; columns: CellCss[]; rows: CellCss[]; cells: CellCss[][] } {
  const rowCount = grid.length;
  const columnCount = Math.max(0, ...grid.map((row) => row.length));
  const table: CellCss = {};
  const columns: CellCss[] = Array.from({ length: columnCount }, () => ({}));
  const rows: CellCss[] = Array.from({ length: rowCount }, () => ({}));
  const cells: CellCss[][] = grid.map((row) => row.map(() => ({})));
  const valueAt = (r: number, c: number, property: CellProperty): string | undefined => grid[r][c]?.[property];
  const covers = (positions: [number, number][]): [number, number][] => positions.filter(([r, c]) => grid[r][c] !== undefined);
  const sharedBy = (positions: [number, number][], property: CellProperty, atLeast: number): string | undefined => {
    const live = covers(positions);
    if (live.length < atLeast) return undefined;
    const first = valueAt(live[0][0], live[0][1], property);
    const same = first !== undefined && !isDefaultValue(property, first) && live.every(([r, c]) => valueAt(r, c, property) === first);
    return same ? first : undefined;
  };
  const everyPosition: [number, number][] = grid.flatMap((row, r) => row.map((_, c) => [r, c] as [number, number]));
  for (const property of CELL_PROPERTIES) {
    const wholeTable = sharedBy(everyPosition, property, 1);
    if (wholeTable !== undefined) {
      table[property] = wholeTable;
      continue;
    }
    columns.forEach((css, c) => {
      const shared = sharedBy(grid.map((_, r) => [r, c] as [number, number]), property, 2);
      if (shared !== undefined) css[property] = shared;
    });
    rows.forEach((css, r) => {
      const shared = sharedBy(grid[r].map((_, c) => [r, c] as [number, number]), property, 2);
      if (shared !== undefined) css[property] = shared;
    });
    grid.forEach((row, r) =>
      row.forEach((css, c) => {
        const value = css?.[property];
        if (value !== undefined && value !== columns[c][property] && value !== rows[r][property]) cells[r][c][property] = value;
      }),
    );
  }
  return { table, columns, rows, cells };
}
