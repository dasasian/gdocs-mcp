import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import type { EditResult } from './edit.js';
import { contentOf, writeControlFor } from './structure.js';
import { renderTableMarkup, readTableLayout } from './transformer.js';
import { parseBlocks, buildContentRequests, cellBlocksOf, clearDirectRunStyling, type CellBlock } from './write.js';
import { placeCells, type LayoutCell, type Placement, type TableLayout } from './table-layout.js';
import { lookOf, lookRequests } from './table-write.js';
import { parseInline, segmentTextStyle } from './inline.js';
import { paragraphCssChange, paragraphStyleUpdate, StyleSyntaxError } from './css.js';
import { renderMarkdownInto } from './render.js';

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

function editedMarkup({ found, at, needle, replacement }: Match, replaceAll: boolean | undefined): string {
  if (replaceAll) return found.markup.split(needle).join(replacement);
  return found.markup.slice(0, at[0]) + replacement + found.markup.slice(at[0] + needle.length);
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

function structureError(message: string): StyleSyntaxError {
  return new StyleSyntaxError([message], new Set([message]));
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
    throw structureError(
      `old_string and new_string must stay inside one table. The edit leaves ${blocks.map((b) => b.type).join(', ') || 'nothing'} where the table was. Quote the table markup from read_doc: a row, </table>, or the whole table.`,
    );
  }
  return only.layout ?? pipeLayout(only.rows, only.aligns);
}

const mergesOf = (placement: Placement): string =>
  JSON.stringify(placement.cells.filter(({ cell }) => cell.colspan > 1 || cell.rowspan > 1).map(({ row, column, cell }) => [row, column, cell.rowspan, cell.colspan]));

const sameShape = (before: Placement, after: Placement): boolean =>
  before.rowCount === after.rowCount && before.columnCount === after.columnCount && mergesOf(before) === mergesOf(after);

function signatureOf(blocks: CellBlock[]): string {
  return JSON.stringify(blocks.map((block) => (block.type === 'list' ? { ...block, items: block.items.map((item) => ({ level: item.level, text: parseInline(item.text) })) } : { ...block, text: parseInline(block.text) })));
}

const plainTextOf = (text: string): string => parseInline(text).map((segment) => segment.text).join('');

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
  if (was && now && !was.className && !now.className && plainTextOf(was.text) === plainTextOf(now.text)) {
    return { start: range.start, requests: restyleRequests(was, now, range, tabId, segmentId) };
  }
  const retyped = buildContentRequests(afterBlocks, range.start, tabId, segmentId, { startsParagraph: true, endsInExistingParagraphMark: true, resetParagraphStyles: true });
  const deletion: docs_v1.Schema$Request[] = range.end > range.start ? [{ deleteContentRange: { range: { startIndex: range.start, endIndex: range.end, tabId, segmentId } } }] : [];
  return { start: range.start, requests: [...deletion, ...retyped.requests] };
}

function surgicalRequests(found: TableInDoc, before: TableLayout, after: TableLayout, placements: { before: Placement; after: Placement }, tabId: string | undefined, segmentId: string | undefined): docs_v1.Schema$Request[] {
  const site = { tableStart: found.element.startIndex ?? 0, tabId, segmentId };
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

/**
 * An edit whose old_string quotes a table's markup. The edited markup is read as
 * a table, compared with the table as it is, and only the difference is sent: a
 * cell whose words are unchanged is never retyped, so a style change sends style
 * requests alone. A change in rows, columns or merges replaces the whole table.
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
  const edits = matches
    .map((match) => {
      const around = splitAroundTable(editedMarkup(match, input.replaceAll));
      parseBlocks(`${around.before}\n\n${around.after}`);
      return { match, around, after: layoutAfterEdit(around.table) };
    })
    .sort((a, b) => (b.match.found.element.startIndex ?? 0) - (a.match.found.element.startIndex ?? 0));
  if (edits.length > 1 && edits.some(({ around }) => around.before || around.after)) {
    throw structureError('replace_all cannot add blocks next to a table: it matches more than one table. Quote one table with enough context to be unique.');
  }
  let changed = 0;
  let revisionId = doc.revisionId ?? undefined;
  const insertNextToTable = async (side: BlockSide, found: TableInDoc, markdown: string): Promise<void> => {
    if (!markdown) return;
    await input.insertBlocks(side, found.element, markdown, revisionId);
    revisionId = undefined;
    changed++;
  };
  for (const { match, around, after } of edits) {
    const { found } = match;
    await insertNextToTable('after', found, around.after);
    const before = readTableLayout(doc, found.table, { tabId });
    const placements = { before: placeCells(before), after: placeCells(after) };
    if (sameShape(placements.before, placements.after)) {
      const requests = surgicalRequests(found, before, after, placements, tabId, segmentId);
      if (requests.length > 0) {
        await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests, writeControl: writeControlFor(revisionId) } });
        revisionId = undefined;
        changed++;
      }
    } else {
      const replacement = around.table;
      const start = found.element.startIndex ?? 0;
      const preRequests: docs_v1.Schema$Request[] = [{ deleteContentRange: { range: { startIndex: start, endIndex: found.element.endIndex ?? start, tabId, segmentId } } }];
      await renderMarkdownInto(clients, documentId, replacement, { tabId, segmentId, baseDir: input.baseDir, preRequests, requiredRevisionId: revisionId, startIndex: start, resetParagraphStyles: true, startsParagraph: true });
      revisionId = undefined;
      changed++;
    }
    await insertNextToTable('before', found, around.before);
  }
  return { status: 'ok', replaced: changed };
}
