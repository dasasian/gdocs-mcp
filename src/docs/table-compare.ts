import { placeCells, type LayoutCell, type Placement, type TableLayout } from './table-layout.js';
import { cellBlocksOf } from './write.js';
import { parseInline } from './inline.js';
import { pairLines, movedLines, refusal, type Axis, type Pairing } from './table-pairing.js';

export interface CellRef {
  row: number;
  column: number;
}

export interface Span extends CellRef {
  rowSpan: number;
  columnSpan: number;
}

export type StructureOperation =
  | { kind: 'unmerge' | 'merge'; span: Span }
  | { kind: 'deleteRow' | 'deleteColumn'; at: CellRef }
  | { kind: 'insertRow'; at: CellRef; below: boolean }
  | { kind: 'insertColumn'; at: CellRef; right: boolean };

/** The words of the old row or column that a move takes away, to be matched against the quoted text of comments. */
export interface MovedLine {
  axis: Axis;
  /** the index of the old row or column. */
  index: number;
  cells: string[];
}

export interface TableComparison {
  /** in the order they must be sent: unmerges and deletes address the old table, inserts and merges the table as it will be. */
  operations: StructureOperation[];
  moved: MovedLine[];
  /** for an inserted row or column, the new row or column whose style it copies. */
  styleSource: { rows: (number | undefined)[]; columns: (number | undefined)[] };
  pairing: { rows: Pairing; columns: Pairing };
}

export const plainTextOf = (text: string): string => parseInline(text).map((segment) => segment.text).join('');

export function cellWords(cell: LayoutCell): string {
  return cellBlocksOf(cell)
    .blocks.map((block) => (block.type === 'list' ? block.items.map((item) => plainTextOf(item.text)).join('\n') : block.type === 'code' ? block.text : plainTextOf(block.text)))
    .join('\n');
}

function wordsGridOf(placement: Placement): string[][] {
  const grid = Array.from({ length: placement.rowCount }, () => new Array<string>(placement.columnCount).fill(''));
  for (const { row, column, cell } of placement.cells) grid[row][column] = cellWords(cell);
  return grid;
}

const indices = (count: number): number[] => Array.from({ length: count }, (_, i) => i);
const keptIndices = (forThis: (number | undefined)[]): number[] => indices(forThis.length).filter((i) => forThis[i] !== undefined);

const columnLine = (grid: string[][], column: number, rows: number[]): string[] => rows.map((row) => grid[row][column]);
const rowLine = (grid: string[][], row: number, columns: number[]): string[] => columns.map((column) => grid[row][column]);

function mergedSpans(placement: Placement): Span[] {
  return placement.cells.filter(({ cell }) => cell.colspan > 1 || cell.rowspan > 1).map(({ row, column, cell }) => ({ row, column, rowSpan: cell.rowspan, columnSpan: cell.colspan }));
}

const spanKey = (span: Span): string => `${span.row},${span.column},${span.rowSpan},${span.columnSpan}`;

function mappedRange(first: number, length: number, forOld: (number | undefined)[]): { start: number; length: number } | undefined {
  const mapped = indices(length).map((i) => forOld[first + i]);
  const start = mapped[0];
  if (start === undefined || mapped.some((m, i) => m !== start + i)) return undefined;
  return { start, length };
}

function spanInNewTable(span: Span, rows: Pairing, columns: Pairing): Span | undefined {
  const rowRange = mappedRange(span.row, span.rowSpan, rows.forOld);
  const columnRange = mappedRange(span.column, span.columnSpan, columns.forOld);
  if (!rowRange || !columnRange) return undefined;
  return { row: rowRange.start, column: columnRange.start, rowSpan: span.rowSpan, columnSpan: span.columnSpan };
}

function covers(spans: Span[], keep: (span: Span) => boolean): Set<string> {
  const covered = new Set<string>();
  for (const span of spans.filter(keep)) {
    for (let r = span.row; r < span.row + span.rowSpan; r++) for (let c = span.column; c < span.column + span.columnSpan; c++) covered.add(`${r},${c}`);
  }
  return covered;
}

interface MergeChanges {
  unmerges: Span[];
  merges: Span[];
  keptSpans: Span[];
}

function mergeChanges(before: Placement, after: Placement, rows: Pairing, columns: Pairing): MergeChanges {
  const newSpans = new Set(mergedSpans(after).map(spanKey));
  const oldSpans = mergedSpans(before).map((span) => ({ span, mapped: spanInNewTable(span, rows, columns) }));
  const kept = oldSpans.filter(({ mapped }) => mapped && newSpans.has(spanKey(mapped)));
  const keptNew = new Set(kept.map(({ mapped }) => spanKey(mapped as Span)));
  return {
    unmerges: oldSpans.filter((span) => !kept.includes(span)).map(({ span }) => span),
    merges: mergedSpans(after).filter((span) => !keptNew.has(spanKey(span))),
    keptSpans: kept.map(({ span }) => span),
  };
}

function requireOneColPerColumn(after: TableLayout, placement: Placement): void {
  if (after.columns.length > 0 && after.columns.length !== placement.columnCount) {
    throw refusal(
      `The table has ${placement.columnCount} columns but ${after.columns.length} <col> lines. A <col> line is one column, so a column added or removed in the rows needs its <col> line added or removed too. Quote from <table> down to the rows you change.`,
    );
  }
}

function requireKept(pairing: Pairing, axis: Axis): void {
  if (!pairing.forOld.some((n) => n !== undefined)) {
    throw refusal(
      `The edit shares no ${axis} with the table, so there is nothing to compare: every ${axis} would be deleted, and a table cannot lose them all. Keep at least one ${axis} with the same words, or make the change in two edits.`,
    );
  }
}

function insertedAt(pairing: Pairing): number[] {
  return indices(pairing.forNew.length).filter((n) => pairing.forNew[n] === undefined);
}

function nearestKept(pairing: Pairing, from: number, step: 1 | -1): number | undefined {
  for (let i = from + step; i >= 0 && i < pairing.forNew.length; i += step) if (pairing.forNew[i] !== undefined) return i;
  return undefined;
}

interface Copy {
  /** the new line whose style the inserted line copies. */
  source: number;
  /** the inserted line goes after `source`, or before it. */
  after: boolean;
}

function rowCopy(pairing: Pairing, row: number, pinned: boolean[]): Copy {
  const above = nearestKept(pairing, row, -1);
  const below = nearestKept(pairing, row, 1);
  const underHeader = row > 0 && pinned[row - 1] && !pinned[row];
  const takeBelow = above === undefined || underHeader;
  if (takeBelow && below !== undefined) return { source: below, after: false };
  return { source: above ?? (below as number), after: above !== undefined };
}

function columnCopy(pairing: Pairing, column: number): Copy {
  const left = nearestKept(pairing, column, -1);
  if (left !== undefined) return { source: left, after: true };
  return { source: nearestKept(pairing, column, 1) as number, after: false };
}

function referenceLine(candidates: number[], blocked: (candidate: number) => boolean, what: string): number {
  const found = candidates.find((candidate) => !blocked(candidate));
  if (found === undefined) throw refusal(`${what} lies wholly inside merged cells, so no cell of it can be addressed. Unmerge them in one edit, then change the rows or columns in another.`);
  return found;
}

interface Plan {
  before: Placement;
  pairing: { rows: Pairing; columns: Pairing };
  merges: MergeChanges;
  pinned: boolean[];
}

function columnOperations(plan: Plan): { deletes: StructureOperation[]; inserts: StructureOperation[] } {
  const { before, pairing, merges } = plan;
  const horizontal = covers(merges.keptSpans, (span) => span.columnSpan > 1);
  const allRows = indices(before.rowCount);
  const deletes: StructureOperation[] = indices(before.columnCount)
    .filter((c) => pairing.columns.forOld[c] === undefined)
    .reverse()
    .map((c) => ({ kind: 'deleteColumn', at: { row: referenceLine(allRows, (r) => horizontal.has(`${r},${c}`), `Column ${c + 1}`), column: c } }));
  const keptRows = keptIndices(pairing.rows.forOld);
  let current = keptIndices(pairing.columns.forOld);
  const inserts: StructureOperation[] = insertedAt(pairing.columns).map((c) => {
    const copy = columnCopy(pairing.columns, c);
    const sourceOld = pairing.columns.forNew[copy.source] as number;
    const row = referenceLine(keptRows, (r) => horizontal.has(`${r},${sourceOld}`), `Column ${sourceOld + 1}`);
    const column = current.indexOf(sourceOld);
    const position = copy.after ? column + 1 : column;
    current = [...current.slice(0, position), -1, ...current.slice(position)];
    return { kind: 'insertColumn', at: { row: pairing.rows.forOld[row] as number, column }, right: copy.after };
  });
  return { deletes, inserts };
}

function rowOperations(plan: Plan): { deletes: StructureOperation[]; inserts: StructureOperation[] } {
  const { before, pairing, merges, pinned } = plan;
  const vertical = covers(merges.keptSpans, (span) => span.rowSpan > 1);
  const keptColumns = keptIndices(pairing.columns.forOld);
  const columnAfterDeletes = (oldColumn: number): number => keptColumns.indexOf(oldColumn);
  const deletes: StructureOperation[] = indices(before.rowCount)
    .filter((r) => pairing.rows.forOld[r] === undefined)
    .reverse()
    .map((r) => ({ kind: 'deleteRow', at: { row: r, column: columnAfterDeletes(referenceLine(keptColumns, (c) => vertical.has(`${r},${c}`), `Row ${r + 1}`)) } }));
  let current = keptIndices(pairing.rows.forOld);
  const inserts: StructureOperation[] = insertedAt(pairing.rows).map((r) => {
    const copy = rowCopy(pairing.rows, r, pinned);
    const sourceOld = pairing.rows.forNew[copy.source] as number;
    const column = columnAfterDeletes(referenceLine(keptColumns, (c) => vertical.has(`${sourceOld},${c}`), `Row ${sourceOld + 1}`));
    const row = current.indexOf(sourceOld);
    const position = copy.after ? row + 1 : row;
    current = [...current.slice(0, position), -1, ...current.slice(position)];
    return { kind: 'insertRow', at: { row, column }, below: copy.after };
  });
  return { deletes, inserts };
}

function styleSourceOf(pairing: Pairing, copyOf: (line: number) => Copy): (number | undefined)[] {
  return pairing.forNew.map((old, line) => (old === undefined ? copyOf(line).source : undefined));
}

/**
 * Compares the table as it is with the table the edit asks for, and says what to
 * send: unmerge, delete columns, delete rows, insert rows, insert columns,
 * merge, in that order. Columns are paired before rows, rows by the columns that
 * were kept. Throws a refusal, with what to quote instead, for a change it
 * cannot read as one clean set of changes.
 */
export function compareTables(before: TableLayout, after: TableLayout): TableComparison {
  const beforePlacement = placeCells(before);
  const afterPlacement = placeCells(after);
  requireOneColPerColumn(after, afterPlacement);
  const oldWords = wordsGridOf(beforePlacement);
  const newWords = wordsGridOf(afterPlacement);
  const allOldRows = indices(beforePlacement.rowCount);
  const allNewRows = indices(afterPlacement.rowCount);
  const columns = pairLines(
    indices(beforePlacement.columnCount).map((c) => columnLine(oldWords, c, allOldRows)),
    indices(afterPlacement.columnCount).map((c) => columnLine(newWords, c, allNewRows)),
    'column',
  );
  requireKept(columns, 'column');
  const keptOldColumns = keptIndices(columns.forOld);
  const keptNewColumns = keptIndices(columns.forNew);
  const oldRowLines = allOldRows.map((r) => rowLine(oldWords, r, keptOldColumns));
  const newRowLines = allNewRows.map((r) => rowLine(newWords, r, keptNewColumns));
  const rows = pairLines(oldRowLines, newRowLines, 'row');
  requireKept(rows, 'row');
  const keptOldRows = keptIndices(rows.forOld);
  const keptNewRows = keptIndices(rows.forNew);
  const movedRows = movedLines(rows, oldRowLines, newRowLines).map((r): MovedLine => ({ axis: 'row', index: r, cells: oldWords[r] }));
  const movedColumns = movedLines(
    columns,
    indices(beforePlacement.columnCount).map((c) => columnLine(oldWords, c, keptOldRows)),
    indices(afterPlacement.columnCount).map((c) => columnLine(newWords, c, keptNewRows)),
  ).map((c): MovedLine => ({ axis: 'column', index: c, cells: columnLine(oldWords, c, allOldRows) }));
  const pairing = { rows, columns };
  const merges = mergeChanges(beforePlacement, afterPlacement, rows, columns);
  const plan: Plan = { before: beforePlacement, pairing, merges, pinned: after.rows.map((row) => row.pinned) };
  const rowOps = rowOperations(plan);
  const columnOps = columnOperations(plan);
  const operations: StructureOperation[] = [
    ...merges.unmerges.map((span): StructureOperation => ({ kind: 'unmerge', span })),
    ...columnOps.deletes,
    ...rowOps.deletes,
    ...rowOps.inserts,
    ...columnOps.inserts,
    ...merges.merges.map((span): StructureOperation => ({ kind: 'merge', span })),
  ];
  return {
    operations,
    moved: [...movedRows, ...movedColumns],
    styleSource: { rows: styleSourceOf(rows, (r) => rowCopy(rows, r, plan.pinned)), columns: styleSourceOf(columns, (c) => columnCopy(columns, c)) },
    pairing,
  };
}
