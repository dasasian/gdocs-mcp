import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import type { EditResult } from './edit.js';
import { contentOf, INLINE_READ, writeControlFor } from './structure.js';
import { renderTableMarkup, readTableLayout } from './transformer.js';
import { threadsOnRangesIn, threadsWithoutRange } from './comments.js';
import { movedCommentsToken } from './loss.js';
import { parseBlocks, buildContentRequests, cellBlocksOf, clearDirectRunStyling, type CellBlock } from './write.js';
import { placeCells, effectiveGrid, type LayoutCell, type Placement, type TableLayout } from './table-layout.js';
import { lookOf, lookRequests, structureRequests, type TableSite } from './table-write.js';
import { compareTables, plainTextOf, type MovedLine, type TableComparison } from './table-compare.js';
import { refusal } from './table-pairing.js';
import { refuseColumnWidthChange } from './suggest.js';
import { parseInline, segmentTextStyle } from './inline.js';
import { paragraphCssChange, paragraphStyleUpdate } from './css.js';

const TABLE_MARKUP_TAG = /(?<!\\)<\/?(?:table|thead|tbody|tr|td|th|col)\b/i;
const CONTEXT = 30;

export const mentionsTableMarkup = (text: string): boolean => TABLE_MARKUP_TAG.test(text);

export type BlockSide = 'before' | 'after';

export interface TableEditInput {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  tabId?: string;
  segmentId?: string;
  baseDir?: string;
  /** the string from an earlier refusal of this same edit, to go ahead with a move that loses comments. */
  confirmLoss?: string;
  /** the edit is sent as suggestions, so one Docs cannot suggest is refused before anything is sent. */
  suggest?: boolean;
  /** puts markdown blocks before or after a table, as an insertion next to it, in Normal text. */
  insertBlocks: (side: BlockSide, table: docs_v1.Schema$StructuralElement, markdown: string, revisionId: string | undefined) => Promise<unknown>;
}

interface TableInDoc {
  element: docs_v1.Schema$StructuralElement;
  table: docs_v1.Schema$Table;
  markup: string;
}

interface Match {
  found: TableInDoc;
  at: number[];
  needle: string;
  replacement: string;
}

function tablesOf(doc: docs_v1.Schema$Document, tabId: string | undefined, segmentId: string | undefined): TableInDoc[] {
  return contentOf(doc, tabId, segmentId).flatMap((element) => (element.table ? [{ element, table: element.table, markup: renderTableMarkup(doc, element.table, { tabId }) }] : []));
}

function positionsOf(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); needle && i >= 0; i = haystack.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

function matchesFor(tables: TableInDoc[], { oldString, newString }: TableEditInput): Match[] {
  const spellings = [
    { needle: oldString, replacement: newString },
    { needle: oldString.trim(), replacement: newString.trim() },
  ];
  for (const { needle, replacement } of spellings) {
    const matches = tables.flatMap((found) => {
      const at = positionsOf(found.markup, needle);
      return at.length ? [{ found, at, needle, replacement }] : [];
    });
    if (matches.length) return matches;
  }
  return [];
}

const withoutBlankLine = (markup: string): string => markup.replace(/\n\n(?=<tr|\|)/g, '\n');

function editedMarkup({ found, at, needle, replacement }: Match, replaceAll: boolean | undefined): string {
  const edited = replaceAll ? found.markup.split(needle).join(replacement) : found.markup.slice(0, at[0]) + replacement + found.markup.slice(at[0] + needle.length);
  return replacement === '' ? withoutBlankLine(edited) : edited;
}

function pipeLayout(rows: string[][], aligns: (string | null)[]): TableLayout {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const cellOf = (markdown: string, column: number): LayoutCell => {
    const align = aligns[column];
    const aligned = align === 'center' || align === 'right';
    return { markdown: aligned ? `<p style="text-align:${align}">${markdown}</p>` : markdown, asBlocks: aligned, css: {}, colspan: 1, rowspan: 1 };
  };
  return {
    css: {},
    columns: Array.from({ length: columnCount }, () => ({ css: {} })),
    rows: rows.map((row) => ({ css: {}, pinned: false, cells: Array.from({ length: columnCount }, (_, c) => cellOf(row[c] ?? '', c)) })),
  };
}

const TABLE_CLOSE = /<\/table\s*>/gi;

interface TableAndNeighbours {
  table: string;
  before: string;
  after: string;
}

function splitAroundTable(edited: string): TableAndNeighbours {
  const start = edited.search(/<table\b/i);
  const closes = [...edited.matchAll(TABLE_CLOSE)];
  const last = closes[closes.length - 1];
  if (start < 0 || !last) return { table: edited, before: '', after: '' };
  const end = last.index + last[0].length;
  return { table: edited.slice(start, end), before: edited.slice(0, start).trim(), after: edited.slice(end).trim() };
}

function layoutAfterEdit(markup: string): TableLayout {
  const blocks = parseBlocks(markup);
  const [only] = blocks;
  if (blocks.length !== 1 || only.type !== 'table') {
    throw refusal(
      `old_string and new_string must stay inside one table. The edit leaves ${blocks.map((b) => b.type).join(', ') || 'nothing'} where the table was. Quote the table markup from read_doc: a row, </table>, or the whole table.`,
    );
  }
  return only.layout ?? pipeLayout(only.rows, only.aligns);
}

function signatureOf(blocks: CellBlock[]): string {
  return JSON.stringify(
    blocks.map((block) => {
      if (block.type === 'list') return { ...block, items: block.items.map((item) => ({ level: item.level, text: parseInline(item.text) })) };
      if (block.type === 'code') return block;
      return { ...block, text: parseInline(block.text) };
    }),
  );
}

function onlyParagraph(blocks: CellBlock[]): Extract<CellBlock, { type: 'paragraph' }> | undefined {
  return blocks.length === 1 && blocks[0].type === 'paragraph' ? blocks[0] : undefined;
}

function cellRange(cell: docs_v1.Schema$TableCell): { start: number; end: number; paragraph: docs_v1.Schema$StructuralElement } | undefined {
  const content = cell.content ?? [];
  const first = content[0];
  const last = content[content.length - 1];
  if (first?.startIndex == null || last?.endIndex == null) return undefined;
  return { start: first.startIndex, end: last.endIndex - 1, paragraph: first };
}

function restyleRequests(
  before: Extract<CellBlock, { type: 'paragraph' }>,
  after: Extract<CellBlock, { type: 'paragraph' }>,
  range: NonNullable<ReturnType<typeof cellRange>>,
  tabId: string | undefined,
  segmentId: string | undefined,
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [clearDirectRunStyling(range.start, range.end - range.start, tabId, segmentId)];
  let offset = 0;
  for (const segment of parseInline(after.text)) {
    const { textStyle, fields } = segmentTextStyle(segment);
    if (fields.length) requests.push({ updateTextStyle: { range: { startIndex: range.start + offset, endIndex: range.start + offset + segment.text.length, tabId, segmentId }, textStyle, fields: fields.join(',') } });
    offset += segment.text.length;
  }
  const { set, cleared } = paragraphCssChange(before.css ?? {}, after.css ?? {});
  const update = paragraphStyleUpdate(set, cleared);
  if (update.fields.length) {
    requests.push({
      updateParagraphStyle: { range: { startIndex: range.paragraph.startIndex, endIndex: range.paragraph.endIndex, tabId, segmentId }, paragraphStyle: update.style, fields: update.fields.join(',') },
    });
  }
  return requests;
}

const isZero = (dimension: docs_v1.Schema$Dimension | null | undefined): boolean => !dimension?.magnitude;

function isDefaultParagraph(paragraph: docs_v1.Schema$Paragraph): boolean {
  const style = paragraph.paragraphStyle ?? {};
  return (
    !paragraph.bullet &&
    (style.namedStyleType ?? 'NORMAL_TEXT') === 'NORMAL_TEXT' &&
    (style.alignment ?? 'START') === 'START' &&
    (style.lineSpacing ?? 100) === 100 &&
    [style.spaceAbove, style.spaceBelow, style.indentStart, style.indentEnd, style.indentFirstLine, style.borderLeft?.width].every(isZero)
  );
}

/** True for a cell of words with no style of their own: plain runs in default paragraphs. A cell with no words yet is not, since Docs may have copied a neighbour's style into it. */
function holdsOnlyUnstyledText(cell: docs_v1.Schema$TableCell): boolean {
  const paragraphs = (cell.content ?? []).flatMap((el) => (el.paragraph ? [el.paragraph] : []));
  const runs = paragraphs.flatMap((paragraph) => paragraph.elements ?? []).flatMap((pe) => (pe.textRun ? [pe.textRun] : []));
  const hasWords = runs.some((run) => (run.content ?? '').trim() !== '');
  return hasWords && paragraphs.length === (cell.content ?? []).length && paragraphs.every(isDefaultParagraph) && runs.every((run) => Object.keys(run.textStyle ?? {}).length === 0);
}

function cellRequests(
  docCell: docs_v1.Schema$TableCell,
  before: LayoutCell,
  after: LayoutCell,
  tabId: string | undefined,
  segmentId: string | undefined,
): { start: number; requests: docs_v1.Schema$Request[] } | undefined {
  const range = cellRange(docCell);
  if (!range) return undefined;
  const beforeBlocks = cellBlocksOf(before).blocks;
  const afterBlocks = cellBlocksOf(after).blocks;
  if (signatureOf(beforeBlocks) === signatureOf(afterBlocks)) return undefined;
  const was = onlyParagraph(beforeBlocks);
  const now = onlyParagraph(afterBlocks);
  if (was && now && !was.className && !now.className && Boolean(was.quote) === Boolean(now.quote) && plainTextOf(was.text) === plainTextOf(now.text)) {
    return { start: range.start, requests: restyleRequests(was, now, range, tabId, segmentId) };
  }
  const insertedTextInheritsNoStyling = holdsOnlyUnstyledText(docCell);
  const retyped = buildContentRequests(afterBlocks, range.start, tabId, segmentId, { startsParagraph: true, endsInExistingParagraphMark: true, resetParagraphStyles: true, insertedTextInheritsNoStyling });
  const deletion: docs_v1.Schema$Request[] = range.end > range.start ? [{ deleteContentRange: { range: { startIndex: range.start, endIndex: range.end, tabId, segmentId } } }] : [];
  return { start: range.start, requests: [...deletion, ...retyped.requests] };
}

function surgicalRequests(found: TableElementAndTable, before: TableLayout, after: TableLayout, tabId: string | undefined, segmentId: string | undefined, axes: Pick<TableSite, 'rowAt' | 'columnAt'> = {}): docs_v1.Schema$Request[] {
  const placements = { before: placeCells(before), after: placeCells(after) };
  const site: TableSite = { tableStart: found.element.startIndex ?? 0, tabId, segmentId, ...axes };
  const requests = lookRequests(lookOf(before, placements.before), lookOf(after, placements.after), site);
  const afterAt = new Map(placements.after.cells.map((placed) => [`${placed.row},${placed.column}`, placed.cell]));
  const changes = placements.before.cells.flatMap((placed) => {
    const docCell = found.table.tableRows?.[placed.row]?.tableCells?.[placed.column];
    const now = afterAt.get(`${placed.row},${placed.column}`);
    const change = docCell && now && cellRequests(docCell, placed.cell, now, tabId, segmentId);
    return change ? [change] : [];
  });
  return [...requests, ...changes.sort((a, b) => b.start - a.start).flatMap((change) => change.requests)];
}

type TableElementAndTable = Pick<TableInDoc, 'element' | 'table'>;

function withNeighbourStyle(after: TableLayout, comparison: TableComparison): TableLayout {
  const placement = placeCells(after);
  const grid = effectiveGrid(after, placement);
  const { rows: rowSource, columns: columnSource } = comparison.styleSource;
  const positionOf = new Map(placement.cells.map((placed) => [placed.cell, placed]));
  const copiedHeight = (r: number): number | undefined => after.rows[r].height ?? (rowSource[r] === undefined ? undefined : after.rows[rowSource[r] as number].height);
  return {
    ...after,
    columns: Array.from({ length: placement.columnCount }, (_, c) => {
      const column = after.columns[c] ?? { css: {} };
      const source = columnSource[c];
      return source === undefined ? column : { ...column, width: column.width ?? after.columns[source]?.width };
    }),
    rows: after.rows.map((row, r) => ({
      ...row,
      height: copiedHeight(r),
      cells: row.cells.map((cell) => {
        const at = positionOf.get(cell) as { row: number; column: number };
        const fromRow = rowSource[at.row];
        const fromColumn = columnSource[at.column];
        if (fromRow === undefined && fromColumn === undefined) return cell;
        const neighbour = grid[fromRow ?? at.row][fromColumn ?? at.column] ?? {};
        const written = { ...(fromRow === undefined ? {} : row.css), ...(fromColumn === undefined ? {} : after.columns[at.column]?.css), ...cell.css };
        return { ...cell, css: { ...neighbour, ...written } };
      }),
    })),
  };
}

function tableStartingAt(doc: docs_v1.Schema$Document, startIndex: number, tabId: string | undefined, segmentId: string | undefined): TableElementAndTable {
  const element = contentOf(doc, tabId, segmentId).find((el) => el.table && el.startIndex === startIndex);
  if (!element?.table) throw new Error(`The table that began at index ${startIndex} is no longer there after the rows and columns were changed. Read the doc again to see what it holds now.`);
  return { element, table: element.table };
}

const deletedBy = (node: { suggestedDeletionIds?: string[] | null }, suggestionIds: ReadonlySet<string>): boolean => (node.suggestedDeletionIds ?? []).some((id) => suggestionIds.has(id));

function deletionIdsIn(table: docs_v1.Schema$Table): Set<string> {
  const nodes = (table.tableRows ?? []).flatMap((row) => [row, ...(row.tableCells ?? [])]);
  return new Set(nodes.flatMap((node) => node.suggestedDeletionIds ?? []));
}

interface SettledTable extends TableElementAndTable {
  rowAt: number[];
  columnAt: number[];
}

/** The table without the rows and columns this edit has just suggested deleting, which stay in the doc until accepted, and where each remaining row and column sits in the doc's table. */
function withoutDeletedBy(found: TableElementAndTable, suggestionIds: ReadonlySet<string>): SettledTable {
  const rows = (found.table.tableRows ?? []).map((row, at) => ({ row, at })).filter(({ row }) => !deletedBy(row, suggestionIds));
  const kept = rows.map(({ row }) => ({ ...row, tableCells: (row.tableCells ?? []).filter((cell) => !deletedBy(cell, suggestionIds)) }));
  const columnAt = (rows[0]?.row.tableCells ?? []).flatMap((cell, at) => (deletedBy(cell, suggestionIds) ? [] : [at]));
  return { element: found.element, table: { ...found.table, tableRows: kept }, rowAt: rows.map(({ at }) => at), columnAt };
}

const mergesOf = (placement: Placement): string =>
  JSON.stringify(placement.cells.filter(({ cell }) => cell.colspan > 1 || cell.rowspan > 1).map(({ row, column, cell }) => [row, column, cell.rowspan, cell.colspan]));

function requireExpectedShape(read: TableLayout, expected: TableLayout): void {
  const got = placeCells(read);
  const wanted = placeCells(expected);
  if (got.rowCount !== wanted.rowCount || got.columnCount !== wanted.columnCount || mergesOf(got) !== mergesOf(wanted)) {
    throw new Error(
      `After the rows and columns were changed the table is ${got.rowCount} x ${got.columnCount}, not the ${wanted.rowCount} x ${wanted.columnCount} the edit asked for, and its cells were not typed. Read the doc to see what it holds now.`,
    );
  }
}

const quoteMatches = (quote: string, word: string): boolean => word !== '' && (word.includes(quote) || quote.includes(word));

function cellsOfMovedLine(table: docs_v1.Schema$Table, line: MovedLine): docs_v1.Schema$TableCell[] {
  const rows = table.tableRows ?? [];
  if (line.axis === 'row') return rows[line.index]?.tableCells ?? [];
  return rows.flatMap((row) => row.tableCells?.[line.index] ?? []);
}

interface MovedInTable {
  table: docs_v1.Schema$Table;
  moved: MovedLine[];
}

/** Ids of the comments on the text of the moved rows and columns: by range when Docs gives one, by quote when it does not. */
function commentsOnMoved(doc: docs_v1.Schema$Document, tabId: string | undefined, segmentId: string | undefined, { table, moved }: MovedInTable): Set<string> {
  const cellRanges = moved.flatMap((line) => cellsOfMovedLine(table, line).flatMap((cell) => cellRange(cell) ?? []));
  const words = moved.flatMap((line) => line.cells.map((cell) => cell.trim()));
  const onRange = threadsOnRangesIn(doc, tabId, segmentId).filter(({ range }) => cellRanges.some((cell) => cell.start <= range.startIndex && range.startIndex < cell.end));
  const byQuote = (segmentId ? [] : threadsWithoutRange(doc)).filter((thread) => {
    const quote = (thread.plainTextQuote ?? '').trim();
    return quote !== '' && words.some((word) => quoteMatches(quote, word));
  });
  return new Set([...onRange.map(({ thread }) => thread.commentId), ...byQuote.map((thread) => thread.commentId)]);
}

function movedCommentsRefusal(doc: docs_v1.Schema$Document, movedByTable: MovedInTable[], input: TableEditInput): EditResult | undefined {
  const comments = new Set(movedByTable.filter(({ moved }) => moved.length > 0).flatMap((moved) => [...commentsOnMoved(doc, input.tabId, input.segmentId, moved)])).size;
  if (comments === 0) return undefined;
  const token = movedCommentsToken(comments, doc.revisionId);
  if (input.confirmLoss === token) return undefined;
  const changed = input.confirmLoss !== undefined;
  return {
    status: 'confirm_required',
    message: `Ask the user before doing anything else: nothing has been changed, and the user has not agreed to this yet. ${changed ? 'The doc changed since the earlier summary, or the summary was not passed back as given, so this is a fresh one. ' : ''}The API cannot move a row or column, so this edit deletes it and types it again, and the ${token.split(' [')[0]} would be lost. Show the user that and wait for a yes. Only after a yes, call edit_doc again with the same old_string and new_string and confirmLoss set to the string below, exactly.`,
    confirmLoss: token,
  };
}

interface PreparedEdit {
  match: Match;
  around: TableAndNeighbours;
  before: TableLayout;
  after: TableLayout;
  comparison: TableComparison;
}

function prepareEdit(doc: docs_v1.Schema$Document, match: Match, input: TableEditInput): PreparedEdit {
  const around = splitAroundTable(editedMarkup(match, input.replaceAll));
  parseBlocks(`${around.before}\n\n${around.after}`);
  const after = layoutAfterEdit(around.table);
  const before = readTableLayout(doc, match.found.table, { tabId: input.tabId });
  return { match, around, before, after, comparison: compareTables(before, after) };
}

/**
 * An edit whose old_string quotes a table's markup. The edited markup is read as
 * a table and compared with the table as it is, and only the difference is sent:
 * rows, columns and merges by their own requests (a row or column the edit moves
 * is a delete and an insert, and asks first when comments quote its text), then
 * the text and style of the cells that differ. A cell whose words are unchanged
 * is never retyped, and no table is ever rewritten whole.
 */
export async function editTableMarkup(clients: GoogleClients, documentId: string, doc: docs_v1.Schema$Document, input: TableEditInput): Promise<EditResult> {
  const { tabId, segmentId } = input;
  const tables = tablesOf(doc, tabId, segmentId);
  const matches = matchesFor(tables, input);
  if (matches.length === 0) {
    const reads = tables.map((t) => t.markup).join('\n\n');
    return { status: 'not_found', message: `old_string is not in the markup of any table. ${tables.length ? `The table${tables.length === 1 ? '' : 's'} read${tables.length === 1 ? 's' : ''}:\n${reads}` : 'There is no table here.'}` };
  }
  const total = matches.reduce((sum, m) => sum + m.at.length, 0);
  if (total > 1 && !input.replaceAll) {
    const contexts = matches.flatMap((m) => m.at.map((i) => ({ context: `…${m.found.markup.slice(Math.max(0, i - CONTEXT), i)}⟦${m.needle}⟧${m.found.markup.slice(i + m.needle.length, i + m.needle.length + CONTEXT)}…`.replace(/\n/g, '⏎') })));
    return { status: 'ambiguous', message: `${total} matches — add surrounding context, or set replace_all.`, matches: contexts };
  }
  const edits = matches.map((match) => prepareEdit(doc, match, input)).sort((a, b) => (b.match.found.element.startIndex ?? 0) - (a.match.found.element.startIndex ?? 0));
  if (edits.length > 1 && edits.some(({ around }) => around.before || around.after)) {
    throw refusal('replace_all cannot add blocks next to a table: it matches more than one table. Quote one table with enough context to be unique.');
  }
  if (edits.length > 1 && edits.some(({ comparison }) => comparison.operations.length > 0)) {
    throw refusal('Nothing was changed: replace_all matches more than one table and the edit adds, removes or merges rows or columns. Each such change needs the table read again before its cells are filled, so the tables cannot all be written in one batch. Edit one table at a time: quote enough context for one.');
  }
  if (input.suggest) {
    for (const { before, after, comparison } of edits) refuseColumnWidthChange(before, after, comparison.operations.some(({ kind }) => kind === 'insertColumn' || kind === 'deleteColumn'));
  }
  const refused = movedCommentsRefusal(doc, edits.map(({ match, comparison }) => ({ table: match.found.table, moved: comparison.moved })), input);
  if (refused) return refused;
  let changed = 0;
  let revisionId = doc.revisionId ?? undefined;
  const send = async (requests: docs_v1.Schema$Request[]): Promise<string[]> => {
    if (requests.length === 0) return [];
    const res = await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests, writeControl: writeControlFor(revisionId) } });
    revisionId = undefined;
    changed++;
    return ((res?.data as { suggestionResponses?: { createdSuggestionIds?: string[] }[] } | undefined)?.suggestionResponses ?? []).flatMap((response) => response.createdSuggestionIds ?? []);
  };
  const insertNextToTable = async (side: BlockSide, found: TableInDoc, markdown: string): Promise<void> => {
    if (!markdown) return;
    await input.insertBlocks(side, found.element, markdown, revisionId);
    revisionId = undefined;
    changed++;
  };
  if (edits.length > 1) {
    await send(edits.flatMap(({ match, before, after }) => surgicalRequests(match.found, before, after, tabId, segmentId)));
    return { status: 'ok', replaced: edits.length };
  }
  for (const { match, around, before, after, comparison } of edits) {
    const { found } = match;
    await insertNextToTable('after', found, around.after);
    if (comparison.operations.length === 0) {
      await send(surgicalRequests(found, before, after, tabId, segmentId));
    } else {
      const tableStart = found.element.startIndex ?? 0;
      const shape = input.suggest ? { rows: placeCells(before).rowCount, columns: placeCells(before).columnCount } : undefined;
      const reportedSuggestions = await send(structureRequests(comparison.operations, { tableStart, tabId, segmentId }, shape));
      const fresh = (await clients.docs.documents.get({ documentId, ...INLINE_READ })).data;
      const freshInDoc = tableStartingAt(fresh, tableStart, tabId, segmentId);
      const pendingBefore = deletionIdsIn(found.table);
      const mine = new Set([...reportedSuggestions, ...[...deletionIdsIn(freshInDoc.table)].filter((id) => !pendingBefore.has(id))]);
      const freshTable = withoutDeletedBy(freshInDoc, mine);
      const freshLayout = readTableLayout(fresh, freshTable.table, { tabId });
      const wanted = withNeighbourStyle(after, comparison);
      requireExpectedShape(freshLayout, wanted);
      await send(surgicalRequests(freshTable, freshLayout, wanted, tabId, segmentId, { rowAt: freshTable.rowAt, columnAt: freshTable.columnAt }));
    }
    await insertNextToTable('before', found, around.before);
  }
  return { status: 'ok', replaced: changed };
}
