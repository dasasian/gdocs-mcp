import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project, type Projection } from './transformer.js';
import { resolveTabId, writeControlFor, startsParagraph, paragraphEdgesAt, spacesAround, tableHolding, isEmptyContent, namedStyleAt, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { parseInline, segmentTextStyle, inlineStyleIssues, type Segment } from './inline.js';
import { HEADING_BY_LEVEL, NAMED_STYLE_BY_CLASS } from './markdown-spec.js';
import { paragraphCssChange, paragraphStyleUpdate, StyleSyntaxError } from './css.js';
import { splitEditLine, type ParagraphLine, type ParagraphMarkup } from './paragraph-markup.js';
import { parseStyleBlock, namedStyleRequests, styleRulesOf, renderStyleBlock } from './style-block.js';
import { clearDirectRunStyling, pageBreakRequests, parseBlocks, holdsBlockMarkdown, isTableRow, isTableSep, splitRow } from './write.js';
import { planMarkdownRender, renderMarkdownInto, type RenderIntoOptions } from './render.js';
import { parsePageBreakLine } from './page-break.js';
import { editTableMarkup, mentionsTableMarkup, type TableEditInput } from './table-edit.js';
import { contextAround } from './context.js';
import { REVIEW_READ } from './comments.js';
import { refuseColumnWidthsIn, suggestingSession } from './suggest.js';
import { explainingCommentOnlyAccess, MUST_SUGGEST_MESSAGE } from './access.js';
import { parseInlineWithElements } from './inline.js';
import { splitAtKeptElements, type Gap } from './element-diff.js';
import { elementRequests, noteTextRequests, creationIssuesIn, listRequest, batchUpdateWithElements, ElementRefusal, type ListSpec, type PlacedElement } from './element-write.js';
import { unsuggestableDropdownIssues, refuseUnwritableTableEdit } from './element-checks.js';
import { chipTextChange, parseElement, type DropdownDefinition, type TokenTable } from './elements.js';
import { renderDatalists } from './transformer.js';
import { listSpecOfLine } from './write.js';
import { tabContainer } from './structure.js';

export interface EditResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'no_segment' | 'confirm_required';
  replaced?: number;
  /** with `suggest`, the ids of the suggestions that now hold the edited text, found by one read after the write. Docs folds a change into a touching suggestion of the same person, so an id can be one that already existed. */
  suggestions?: string[];
  warnings?: string[];
  images?: { src: string; objectId: string }[];
  matches?: { context: string }[];
  message?: string;
  confirmLoss?: string;
}

// Block- and annotation-level wrappers the reader (transformer.ts) puts around a
// line: the alignment wrapper, and the suggestion markers. They carry no text of
// their own, and parseInline deliberately doesn't know them (it handles inline
// runs only), so they come off before the inline grammar runs.
const READER_WRAPPERS = /<\/?(?:p|h[1-6]|ins|del)\b[^>]*>/gi;

// Strip markup so a needle copied from a rendered read still matches the doc's
// plain text. This MUST agree with the writer about what counts as markup, so it
// runs the writer's own parser (parseInline) rather than a second hand-rolled
// grammar — a private copy had already drifted on `__` (#27), breaking matches
// for signature lines (`____ ____`) and intraword underscores (`a__b__c`).
export function stripMarkdown(s: string): string {
  const unwrapped = s.replace(/^#{1,6}\s+/, '').replace(READER_WRAPPERS, '');
  return parseInline(unwrapped)
    .map((seg) => seg.text)
    .join('');
}

function findAll(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + needle.length;
  }
  return out;
}

type LineNormalizer = (line: string) => string[];

const keepLine: LineNormalizer = (line) => [line];
const stripLine: LineNormalizer = (line) => [stripMarkdown(line)];
const cellLine: LineNormalizer = (line) => {
  if (!isTableRow(line)) return [stripMarkdown(line)];
  return isTableSep(line) ? [] : splitRow(line).map(stripMarkdown);
};

const isBlank = (line: string): boolean => line.trim() === '';

export interface Located {
  needle: string;
  positions: number[];
  /** turns a slice of old_string into the text it matched, the way the whole of old_string became `needle`. */
  normalize: (text: string) => string;
}

/**
 * Resolves old_string to its match positions: exact first, then markup-tolerant
 * (a markdown table matches as its cells' text), then with each blank line taken
 * as the single paragraph break the read shows between paragraphs.
 */
export function locate(text: string, oldString: string): Located {
  const tried = new Set<string>();
  for (const dropBlankLines of [false, true]) {
    for (const normalizeLine of [keepLine, cellLine, stripLine]) {
      const normalize = (part: string): string =>
        part
          .split('\n')
          .filter((line) => !(dropBlankLines && isBlank(line)))
          .flatMap(normalizeLine)
          .join('\n');
      const needle = normalize(oldString);
      if (tried.has(needle)) continue;
      tried.add(needle);
      const positions = findAll(text, needle);
      if (positions.length) return { needle, positions, normalize };
    }
  }
  return { needle: oldString, positions: [], normalize: (part) => part };
}

// Docs range [startIndex, endIndex) for a plain-text [a, b) match.
export function rangeFor(proj: Projection, a: number, b: number): { startIndex: number; endIndex: number } {
  return { startIndex: proj.map[a], endIndex: proj.map[b - 1] + 1 };
}

const RESET_EMPHASIS_FIELDS = 'bold,italic,underline,strikethrough';

function segmentStyleRequests(
  segments: Segment[],
  startIndex: number,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [];
  let offset = 0;
  for (const seg of segments) {
    const segStart = startIndex + offset;
    offset += seg.text.length;
    const { textStyle, fields } = segmentTextStyle(seg);
    if (fields.length) {
      requests.push({
        updateTextStyle: { range: { startIndex: segStart, endIndex: segStart + seg.text.length, tabId, segmentId }, textStyle, fields: fields.join(',') },
      });
    }
  }
  return requests;
}

function insertedTextRequests(
  segments: Segment[],
  plain: string,
  startIndex: number,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  return [
    { insertText: { location: { index: startIndex, tabId, segmentId }, text: plain } },
    {
      updateTextStyle: {
        range: { startIndex, endIndex: startIndex + plain.length, tabId, segmentId },
        textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
        fields: RESET_EMPHASIS_FIELDS,
      },
    },
    ...segmentStyleRequests(segments, startIndex, tabId, segmentId),
  ];
}

function namedStyleOf(markup: ParagraphMarkup | undefined): string | undefined {
  if (markup?.heading) return HEADING_BY_LEVEL[markup.heading];
  return markup?.className ? NAMED_STYLE_BY_CLASS[markup.className] : undefined;
}

function paragraphStyleRequest(
  now: ParagraphMarkup | undefined,
  before: ParagraphMarkup | undefined,
  range: { startIndex: number; endIndex: number; tabId?: string; segmentId?: string },
): docs_v1.Schema$Request | undefined {
  const { set, cleared } = paragraphCssChange(before?.css ?? {}, now?.css ?? {});
  const update = paragraphStyleUpdate(set, cleared);
  const namedStyleType = namedStyleOf(now) ?? (namedStyleOf(before) ? 'NORMAL_TEXT' : undefined);
  const fields = [...(namedStyleType ? ['namedStyleType'] : []), ...update.fields];
  if (!fields.length) return undefined;
  return {
    updateParagraphStyle: {
      range,
      paragraphStyle: { ...update.style, ...(namedStyleType ? { namedStyleType } : {}) },
      fields: fields.join(','),
    },
  };
}

const styleOf = ({ text: _text, ...style }: Segment): Omit<Segment, 'text'> => style;
const styleSignature = (segments: Segment[]): string =>
  JSON.stringify(segments.map(styleOf).filter((style) => Object.keys(style).length > 0));

function styleOnlyRequests(
  proj: Projection,
  from: number,
  length: number,
  lines: { now: ParagraphLine; before?: ParagraphLine }[],
  lineTexts: string[],
  segments: Segment[],
  inlineChanged: boolean,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [];
  let offset = 0;
  lines.forEach((line, k) => {
    const size = lineTexts[k].length;
    if (size > 0 && (line.now.markup || line.before?.markup)) {
      const range = rangeFor(proj, from + offset, from + offset + size);
      const request = paragraphStyleRequest(line.now.markup, line.before?.markup, { ...range, tabId, segmentId });
      if (request) requests.push(request);
    }
    offset += size + 1;
  });
  if (inlineChanged) {
    const { startIndex, endIndex } = rangeFor(proj, from, from + length);
    requests.push(clearDirectRunStyling(startIndex, endIndex - startIndex, tabId, segmentId));
    requests.push(...segmentStyleRequests(segments, startIndex, tabId, segmentId));
  }
  return requests;
}

function newParagraphRequests(
  lines: ParagraphLine[],
  lineTexts: string[],
  startIndex: number,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [];
  let offset = 0;
  lines.forEach((line, k) => {
    const size = lineTexts[k].length;
    if (size > 0 && line.markup) {
      const request = paragraphStyleRequest(line.markup, undefined, { startIndex: startIndex + offset, endIndex: startIndex + offset + size, tabId, segmentId });
      if (request) requests.push(request);
    }
    offset += size + 1;
  });
  return requests;
}

function targetsStyleBlock(oldString: string, block: string, docText: string, isEmpty: boolean): boolean {
  if (/<style/i.test(oldString)) return true;
  if (isEmpty) return false;
  return block.includes(oldString) && locate(docText, oldString).positions.length === 0;
}

function occurrencesOf(haystack: string, needle: string): number {
  return findAll(haystack, needle).length;
}

async function editStyleBlock(
  clients: GoogleClients,
  documentId: string,
  block: string,
  oldString: string,
  newString: string,
  tabId: string | undefined,
  revisionId: string | undefined,
): Promise<EditResult> {
  const found = occurrencesOf(block, oldString);
  if (found === 0) {
    return { status: 'not_found', message: `old_string is not in the <style> block. The block reads:\n${block}` };
  }
  if (found > 1) return { status: 'ambiguous', message: `${found} matches in the <style> block — add surrounding context.` };
  const next = parseStyleBlock(block.replace(oldString, () => newString));
  if (next.issues.length) throw new StyleSyntaxError(next.issues);
  const requests = namedStyleRequests(next.rules, parseStyleBlock(block).rules, tabId);
  if (!requests.length) return { status: 'ok', replaced: 0, message: 'no rule changed' };
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests, writeControl: writeControlFor(revisionId) } });
  return { status: 'ok', replaced: requests.length };
}

interface NewString {
  /** the lines that are text, with their paragraph markup; page break lines are not among them. */
  lines: ParagraphLine[];
  /** for each page break line, how many text lines come before it. */
  breaksAfterLines: number[];
  issues: string[];
}

function partitionNewString(newString: string): NewString {
  const lines: ParagraphLine[] = [];
  const breaksAfterLines: number[] = [];
  const issues: string[] = [];
  newString.split('\n').forEach((text, k) => {
    const pageBreak = parsePageBreakLine(text);
    if (pageBreak) {
      breaksAfterLines.push(lines.length);
      issues.push(...pageBreak.issues.map((issue) => `line ${k + 1}: ${issue}`));
      return;
    }
    const line = splitEditLine(text);
    lines.push(line);
    issues.push(...line.issues.map((issue) => `line ${k + 1}: ${issue}`), ...inlineStyleIssues(text).map((issue) => `line ${k + 1}: ${issue}`));
  });
  return { lines, breaksAfterLines, issues };
}

function pageBreakOffsets(breaksAfterLines: number[], lineTexts: string[]): number[] {
  const lengthOfFirst = (count: number): number => lineTexts.slice(0, count).reduce((sum, text) => sum + text.length + 1, 0);
  return breaksAfterLines.map((count) => (count < lineTexts.length ? lengthOfFirst(count) : Math.max(0, lengthOfFirst(count) - 1)));
}

interface DocRange {
  startIndex: number;
  endIndex: number;
}

interface Replacement {
  newLines: ParagraphLine[];
  lineTexts: string[];
  segments: Segment[];
  plain: string;
  /** the plain text with each element as its one character, to compare with the doc's. */
  plainWithElements: string;
  breakOffsets: number[];
  elements: PlacedElement[];
  /** what the elements being made need from the markdown around them: the text of their notes, and their dropdown lists. */
  context: { notes: Map<string, string>; lists: Map<string, ListSpec> };
}

function styleOnlyRequestsFor(
  proj: Projection,
  from: number,
  length: number,
  oldString: string,
  { newLines, lineTexts, segments }: Replacement,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const oldLines = oldString.split('\n').map(splitEditLine);
  const lines = newLines.map((now, k) => ({ now, before: oldLines[k] }));
  const before = parseInline(oldLines.map((l) => l.inner).join('\n'));
  const inlineChanged = styleSignature(before) !== styleSignature(segments);
  return styleOnlyRequests(proj, from, length, lines, lineTexts, segments, inlineChanged, tabId, segmentId);
}

function replacementRequestsFor(
  doc: docs_v1.Schema$Document,
  { startIndex, endIndex }: DocRange,
  { newLines, lineTexts, segments, plain, breakOffsets, elements, context }: Replacement,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const elementsBefore = (offset: number): number => elements.filter((element) => element.index < offset).length;
  const breaks = breakOffsets.map((offset) => ({
    index: startIndex + offset + elementsBefore(offset),
    ownParagraph: offset === 0 ? startsParagraph(doc, tabId, segmentId, startIndex) : plain[offset - 1] === '\n',
  }));
  return [
    ...(endIndex > startIndex ? [{ deleteContentRange: { range: { startIndex, endIndex, tabId, segmentId } } }] : []),
    ...(plain ? [...insertedTextRequests(segments, plain, startIndex, tabId, segmentId), ...newParagraphRequests(newLines, lineTexts, startIndex, tabId, segmentId)] : []),
    ...elementRequests(elements.map((element) => ({ ...element, index: startIndex + element.index })), { tabId, segmentId }, context),
    ...pageBreakRequests(breaks, tabId, segmentId),
  ];
}

type InsertionSide = 'after' | 'before';

interface SharedLines {
  keepsPrefix: boolean;
  keepsSuffix: boolean;
  prefixLength: number;
  suffixLength: number;
  middleOld: string;
  middleNew: string;
  /** true when the new lines follow the one kept line with no blank line between, so CommonMark reads them as more of its paragraph. */
  continuesKeptLine: boolean;
}

const NOTHING_SHARED = (oldString: string, newString: string): SharedLines => ({ keepsPrefix: false, keepsSuffix: false, prefixLength: 0, suffixLength: 0, middleOld: oldString, middleNew: newString, continuesKeptLine: false });

function textLines(lines: string[]): string {
  return lines.join('\n');
}

function withoutLeadingBlanks(lines: string[]): string[] {
  const first = lines.findIndex((line) => !isBlank(line));
  return first < 0 ? [] : lines.slice(first);
}

function withoutTrailingBlanks(lines: string[]): string[] {
  return withoutLeadingBlanks([...lines].reverse()).reverse();
}

function sharedLinesOf(oldString: string, newString: string, located: Located): SharedLines {
  if (oldString === newString) return NOTHING_SHARED(oldString, newString);
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  const most = Math.min(oldLines.length, newLines.length);
  let head = 0;
  while (head < most && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < most - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;

  const prefixText = textLines(withoutTrailingBlanks(oldLines.slice(0, head)));
  const suffixText = textLines(withoutLeadingBlanks(oldLines.slice(oldLines.length - tail)));
  const prefixLength = prefixText ? located.normalize(prefixText).length : 0;
  const suffixLength = suffixText ? located.normalize(suffixText).length : 0;
  const { needle } = located;
  const prefixFits = !prefixText || (needle.startsWith(located.normalize(prefixText)) && [undefined, '\n'].includes(needle[prefixLength]));
  const suffixFits = !suffixText || (needle.endsWith(located.normalize(suffixText)) && [undefined, '\n'].includes(needle[needle.length - suffixLength - 1]));
  const keepsPrefix = Boolean(prefixText) && prefixFits && suffixFits;
  const keepsSuffix = Boolean(suffixText) && prefixFits && suffixFits;
  if (!keepsPrefix && !keepsSuffix) return NOTHING_SHARED(oldString, newString);

  let middleOld = oldLines.slice(keepsPrefix ? head : 0, oldLines.length - (keepsSuffix ? tail : 0));
  let middleNew = newLines.slice(keepsPrefix ? head : 0, newLines.length - (keepsSuffix ? tail : 0));
  if (keepsPrefix) {
    middleOld = withoutLeadingBlanks(middleOld);
    middleNew = withoutLeadingBlanks(middleNew);
  }
  if (keepsSuffix) {
    middleOld = withoutTrailingBlanks(middleOld);
    middleNew = withoutTrailingBlanks(middleNew);
  }
  const nextNewLine = keepsPrefix ? newLines[head] : newLines[newLines.length - tail - 1];
  return {
    keepsPrefix,
    keepsSuffix,
    prefixLength: keepsPrefix ? prefixLength : 0,
    suffixLength: keepsSuffix ? suffixLength : 0,
    middleOld: textLines(middleOld),
    middleNew: textLines(middleNew),
    continuesKeptLine: keepsPrefix !== keepsSuffix && nextNewLine !== undefined && !isBlank(nextNewLine),
  };
}

interface PlainSpan {
  from: number;
  to: number;
}

function middleSpan(shared: SharedLines, matchStart: number, matchLength: number, deleting: boolean): PlainSpan {
  const prefixEnd = matchStart + shared.prefixLength;
  const suffixStart = matchStart + matchLength - shared.suffixLength;
  if (deleting) {
    return { from: shared.keepsPrefix ? prefixEnd : matchStart, to: shared.keepsSuffix && shared.keepsPrefix ? suffixStart - 1 : shared.keepsSuffix ? suffixStart : matchStart + matchLength };
  }
  return { from: shared.keepsPrefix ? prefixEnd + 1 : matchStart, to: shared.keepsSuffix ? suffixStart - 1 : matchStart + matchLength };
}

function insertionPoint(proj: Projection, shared: SharedLines, matchStart: number, matchLength: number): { side: InsertionSide; matched: DocRange } {
  if (shared.keepsSuffix) {
    const suffixStart = matchStart + matchLength - shared.suffixLength;
    return { side: 'before', matched: rangeFor(proj, suffixStart, matchStart + matchLength) };
  }
  return { side: 'after', matched: rangeFor(proj, matchStart, matchStart + shared.prefixLength) };
}

function rangeOfSpan(proj: Projection, span: PlainSpan): DocRange {
  return rangeFor(proj, span.from, span.to);
}

function pointAt(side: InsertionSide | undefined, matched: DocRange): DocRange {
  if (!side) return matched;
  const at = side === 'after' ? matched.endIndex : matched.startIndex;
  return { startIndex: at, endIndex: at };
}

const HEADING_LIKE_STYLES = new Set(['TITLE', 'SUBTITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6']);

const isPlainTextLine = (line: string): boolean => !parsePageBreakLine(line) && splitEditLine(line).markup === undefined;

/** The new lines as one line of words, when CommonMark would read them as one paragraph with what they follow: no blank line, no block, no markup line. */
function softJoinedWords(newLines: string, continuesKeptLine: boolean): string | undefined {
  const lines = newLines.split('\n');
  const joinsSomething = continuesKeptLine || lines.length > 1;
  if (!joinsSomething || isBlank(newLines) || holdsBlockMarkdown(newLines) || !lines.every(isPlainTextLine)) return undefined;
  return lines.join(' ');
}

const wordsBeside = (words: string, keptLine: InsertionSide | undefined): string => (keptLine === 'after' ? ` ${words}` : keptLine === 'before' ? `${words} ` : words);

const isBlankOrPageBreak = (line: string): boolean => isBlank(line) || parsePageBreakLine(line) !== undefined;

function addsBlockText(markdown: string): boolean {
  return holdsBlockMarkdown(markdown) || !markdown.split('\n').every(isBlankOrPageBreak);
}

interface BlockEditContext {
  clients: GoogleClients;
  documentId: string;
  doc: docs_v1.Schema$Document;
  markdown: string;
  tabId: string | undefined;
  segmentId: string | undefined;
  baseDir: string | undefined;
}

function blockInsertionRange(context: BlockEditContext, matched: DocRange, side: InsertionSide | undefined): DocRange {
  const { doc, tabId, segmentId } = context;
  if (!side) return matched;
  if (side === 'after') {
    const table = tableHolding(doc, tabId, segmentId, matched.endIndex - 1);
    return pointAt('after', table ? { startIndex: matched.startIndex, endIndex: table.endIndex ?? matched.endIndex } : matched);
  }
  const table = tableHolding(doc, tabId, segmentId, matched.startIndex);
  const at = table ? (table.startIndex ?? 1) - 1 : matched.startIndex;
  return { startIndex: at, endIndex: at };
}

function blockRenderOptions(context: BlockEditContext, matched: DocRange, side: InsertionSide | undefined, revisionId: string | undefined): RenderIntoOptions {
  const { doc, tabId, segmentId, baseDir } = context;
  const { startIndex, endIndex } = blockInsertionRange(context, matched, side);
  const startsAParagraph = paragraphEdgesAt(doc, tabId, segmentId, startIndex).atStart;
  const trimmed = startsAParagraph ? { before: 0, after: 0 } : { before: spacesAround(doc, tabId, segmentId, startIndex).before, after: spacesAround(doc, tabId, segmentId, endIndex).after };
  const from = startIndex - trimmed.before;
  const to = endIndex + trimmed.after;
  const endsAtParagraphMark = paragraphEdgesAt(doc, tabId, segmentId, to).atMark;
  const preRequests: docs_v1.Schema$Request[] = [
    ...(to > from ? [{ deleteContentRange: { range: { startIndex: from, endIndex: to, tabId, segmentId } } }] : []),
    ...(startsAParagraph ? [] : [{ insertText: { location: { index: from, tabId, segmentId }, text: '\n' } }]),
  ];
  return {
    tabId,
    segmentId,
    baseDir,
    preRequests,
    requiredRevisionId: revisionId,
    startIndex: startsAParagraph ? startIndex : from + 1,
    resetParagraphStyles: true,
    startsParagraph: true,
    endsInExistingParagraphMark: endsAtParagraphMark,
  };
}

function applyBlockEdit(context: BlockEditContext, matched: DocRange, side: InsertionSide | undefined, revisionId: string | undefined) {
  return renderMarkdownInto(context.clients, context.documentId, context.markdown, blockRenderOptions(context, matched, side, revisionId));
}

async function applyBlockEditsInOneBatch(context: BlockEditContext, edits: { matched: DocRange; side: InsertionSide | undefined }[], revisionId: string | undefined): Promise<void> {
  const plans = edits.map(({ matched, side }) => planMarkdownRender(context.markdown, blockRenderOptions(context, matched, side, revisionId)));
  if (plans.some(({ tables, images }) => tables.length > 0 || images.length > 0)) {
    throw new Error(`Nothing was changed: replace_all matched ${edits.length} places and new_string holds a table or an image. Those are placed after the text, each with the doc read again, so the matches cannot all be written in one batch and a failure part-way would leave some changed. Edit one place at a time: quote enough context for one match.`);
  }
  const requests = plans.flatMap((plan) => plan.requests);
  if (requests.length) {
    await batchUpdateWithElements(context.clients, context.documentId, requests, writeControlFor(revisionId), context.tabId);
  }
}

const holdsOnlyTableRows = (text: string): boolean => {
  const lines = text.split('\n').filter((line) => !isBlank(line));
  return lines.length > 0 && lines.every(isTableRow);
};

const quotesTable = (oldString: string, newString: string): boolean =>
  mentionsTableMarkup(oldString) || (mentionsTableMarkup(newString) && oldString.split('\n').some(isTableRow)) || (holdsOnlyTableRows(oldString) && (holdsOnlyTableRows(newString) || isBlank(newString)));

const EMPTY_CONTENT_MESSAGE = 'There is nothing here to anchor an edit: the doc, tab or header/footer is empty. Use write_doc to write it.';

interface EditOptions {
  /** an edit to a footnote's text: the id of its segment. Set by the edit itself, from the `[^1]: …` line. */
  footnoteId?: string;
  replaceAll?: boolean;
  tabId?: string;
  segment?: SegmentKind;
  page?: SegmentPage;
  baseDir?: string;
  confirmLoss?: string;
  suggest?: boolean;
}

/**
 * Replaces `oldString` with `newString`. With `suggest` the same requests are sent as suggestions: a request Docs cannot
 * suggest refuses the whole edit before anything is sent, and the result lists the suggestion ids made.
 */
export async function editDoc(clients: GoogleClients, documentId: string, oldString: string, newString: string, opts: EditOptions = {}): Promise<EditResult> {
  if (!opts.suggest) return explainingCommentOnlyAccess(MUST_SUGGEST_MESSAGE, () => applyEdit(clients, documentId, oldString, newString, opts));
  const session = suggestingSession(clients);
  const result = await applyEdit(session.clients, documentId, oldString, newString, opts);
  return result.status === 'ok' ? { ...result, suggestions: await session.suggestionsNow(documentId) } : result;
}

async function applyEdit(clients: GoogleClients, documentId: string, oldString: string, newString: string, opts: EditOptions): Promise<EditResult> {
  const fetched = await clients.docs.documents.get({ documentId, ...REVIEW_READ });
  const revisionId = fetched.data.revisionId ?? undefined;
  const tabId = resolveTabId(fetched.data, opts.tabId);
  const target = resolveSegmentTarget(fetched.data, { segment: opts.segment, page: opts.page, tabId });
  if (target.error) return { status: 'no_segment', message: target.error };
  const segmentId = opts.footnoteId ?? target.segmentId;
  const projection = project(fetched.data, tabId, segmentId);
  const tokens = projection.tokens;

  const datalistEdit = await editDatalists(clients, documentId, fetched.data, tabId, oldString, newString, revisionId);
  if (datalistEdit) return datalistEdit;
  const noteEdit = noteEditOf(fetched.data, tabId, oldString, newString);
  if (noteEdit && noteEdit.oldText.trim() === '') {
    const requests = noteTextRequests(noteEdit.newText, noteEdit.footnoteId, tabId);
    if (requests.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests, writeControl: writeControlFor(revisionId) } });
    return { status: 'ok', replaced: requests.length ? 1 : 0 };
  }
  if (noteEdit) return applyEdit(clients, documentId, noteEdit.oldText, noteEdit.newText, { ...opts, footnoteId: noteEdit.footnoteId });

  const block = renderStyleBlock(styleRulesOf(fetched.data, tabId));
  const isEmpty = isEmptyContent(fetched.data, tabId, segmentId);
  if (targetsStyleBlock(oldString, block, projection.text, isEmpty)) {
    return editStyleBlock(clients, documentId, block, oldString, newString, tabId, revisionId);
  }
  if (isEmpty) throw new Error(EMPTY_CONTENT_MESSAGE);

  if (quotesTable(oldString, newString)) {
    refuseUnwritableTableEdit(oldString, newString, fetched.data, { tabId, segmentId, suggest: opts.suggest });
    const insertBlocks: TableEditInput['insertBlocks'] = (side, table, markdown, revisionId) => {
      const inside = (table.startIndex ?? 0) + 1;
      return applyBlockEdit({ clients, documentId, doc: fetched.data, markdown, tabId, segmentId, baseDir: opts.baseDir }, { startIndex: inside, endIndex: inside + 1 }, side, revisionId);
    };
    return editTableMarkup(clients, documentId, fetched.data, { oldString, newString, replaceAll: opts.replaceAll, tabId, segmentId, baseDir: opts.baseDir, confirmLoss: opts.confirmLoss, suggest: opts.suggest, insertBlocks });
  }
  if (mentionsTableMarkup(newString) && !holdsBlockMarkdown(newString)) {
    throw new StyleSyntaxError(['new_string holds table tags, but old_string does not quote a table. Quote the table markup from read_doc in old_string, or write a whole <table> block.']);
  }

  const definitions = definitionsIn(tokens.encode(newString, true));
  const oldText = tokens.encode(oldString, true);
  const newText = definitions.text;
  const located = locate(projection.text, oldText);
  const { needle, positions } = located;
  if (positions.length === 0) {
    return { status: 'not_found', message: `"${oldString}" not found.` };
  }
  if (positions.length > 1 && !opts.replaceAll) {
    return {
      status: 'ambiguous',
      message: `${positions.length} matches — add surrounding context, or set replace_all.`,
      matches: positions.map((p) => ({ context: contextAround(projection.text, p, p + needle.length) })),
    };
  }

  const shared = sharedLinesOf(oldText, newText, located);
  const keepsAnything = shared.keepsPrefix || shared.keepsSuffix;
  const insertsOnly = keepsAnything && isBlank(shared.middleOld);
  const writesNewRule = createsRule(shared.middleNew, shared.middleOld, tokens);
  const joinedWords = writesNewRule ? undefined : softJoinedWords(shared.middleNew, insertsOnly && shared.continuesKeptLine);
  const anchorPlainIndex = (matchStart: number): number => {
    if (!insertsOnly) return middleSpan(shared, matchStart, needle.length, false).from;
    return shared.keepsPrefix ? matchStart + shared.prefixLength - 1 : matchStart + needle.length - shared.suffixLength;
  };
  const joinsAnchorParagraphs =
    joinedWords !== undefined && positions.every((matchStart) => !HEADING_LIKE_STYLES.has(namedStyleAt(fetched.data, tabId, segmentId, projection.map[anchorPlainIndex(matchStart)])));
  const written = joinsAnchorParagraphs ? wordsBeside(joinedWords, insertsOnly ? (shared.keepsPrefix ? 'after' : 'before') : undefined) : shared.middleNew;
  const writesNothing = isBlank(written);
  const highestIndexFirst = (opts.replaceAll ? positions : [positions[0]]).sort((x, y) => y - x);

  if (insertsOnly && writesNothing) return { status: 'ok', replaced: 0 };

  const asBlocks = !joinsAnchorParagraphs && (writesNewRule || (insertsOnly ? addsBlockText(written) : holdsBlockMarkdown(written)));
  const oldMiddleText = (matchStart: number): string => {
    const span = insertsOnly ? { from: 0, to: 0 } : middleSpan(shared, matchStart, needle.length, writesNothing);
    return projection.text.slice(span.from, span.to);
  };
  refuseElementsThatCannotBeWritten(oldMiddleText(positions[0]), written, definitions, tokens, { doc: fetched.data, tabId, segmentId, suggest: opts.suggest });
  if (asBlocks) {
    const markdown = [tokens.decode(written), ...definitions.lines].join('\n\n');
    parseBlocks(markdown);
    const refused = creationIssuesIn(markdown, segmentId);
    if (refused.length) throw new ElementRefusal(refused);
    if (opts.suggest) refuseColumnWidthsIn(markdown);
    const context: BlockEditContext = { clients, documentId, doc: fetched.data, markdown, tabId, segmentId, baseDir: opts.baseDir };
    const keptGaps = insertsOnly || highestIndexFirst.length > 1 ? [] : gapsAroundKeptElements(projection, shared, highestIndexFirst[0], needle.length, writesNothing, written, tokens);
    if (keptGaps.length > 0) {
      const results = [];
      for (const [k, gap] of [...keptGaps].reverse().entries()) {
        const gapMarkdown = [tokens.decode(gap.written), ...definitions.lines].join('\n\n');
        parseBlocks(gapMarkdown);
        results.push(await applyBlockEdit({ ...context, markdown: gapMarkdown }, gap.matched, undefined, k === 0 ? revisionId : undefined));
      }
      const warnings = results.flatMap((result) => result.warnings);
      const images = results.flatMap((result) => result.images);
      return { status: 'ok', replaced: 1, ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
    }
    const edits = highestIndexFirst.map((matchStart) =>
      insertsOnly ? insertionPoint(projection, shared, matchStart, needle.length) : { side: undefined, matched: rangeOfSpan(projection, middleSpan(shared, matchStart, needle.length, false)) },
    );
    if (edits.length > 1) {
      await applyBlockEditsInOneBatch(context, edits, revisionId);
      return { status: 'ok', replaced: edits.length };
    }
    const { warnings, images } = await applyBlockEdit(context, edits[0].matched, edits[0].side, revisionId);
    return { status: 'ok', replaced: highestIndexFirst.length, ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
  }

  const replacementFor = (gapWritten: string): Replacement => {
    const { lines: newLines, breaksAfterLines, issues: problems } = partitionNewString(gapWritten);
    if (problems.length) throw new StyleSyntaxError(problems);
    const joined = newLines.map((l) => l.inner).join('\n');
    const { segments, elements } = parseInlineWithElements(joined, tokens);
    const plain = segments.map((s) => s.text).join('');
    const lineTexts = plain.split('\n');
    return {
      newLines,
      lineTexts,
      segments,
      plain,
      plainWithElements: parseInline(joined).map((segment) => segment.text).join(''),
      breakOffsets: pageBreakOffsets(breaksAfterLines, lineTexts),
      elements: elements.map(({ offset, token }) => ({ index: offset, token })),
      context: { notes: definitions.notes, lists: definitions.lists },
    };
  };
  replacementFor(written);

  const requests = highestIndexFirst.flatMap((matchStart) => {
    if (insertsOnly) {
      const { side, matched } = insertionPoint(projection, shared, matchStart, needle.length);
      return replacementRequestsFor(fetched.data, pointAt(side, matched), replacementFor(written), tabId, segmentId);
    }
    const span = middleSpan(shared, matchStart, needle.length, writesNothing);
    const gaps = splitAtKeptElements(shared.middleOld, projection.text.slice(span.from, span.to), written, tokens);
    return [...gaps].reverse().flatMap((gap) => {
      const from = span.from + gap.plainFrom;
      const to = span.from + gap.plainTo;
      const replacement = replacementFor(gap.written);
      const sameWords = replacement.plainWithElements === projection.text.slice(from, to) && replacement.breakOffsets.length === 0;
      if (sameWords) return styleOnlyRequestsFor(projection, from, to - from, gap.oldMarkup, replacement, tabId, segmentId);
      const point = gap.followsKept ? projection.map[from - 1] + 1 : projection.map[to];
      const range = from < to ? rangeFor(projection, from, to) : { startIndex: point, endIndex: point };
      return replacementRequestsFor(fetched.data, range, replacement, tabId, segmentId);
    });
  });

  if (requests.length) await batchUpdateWithElements(clients, documentId, requests, writeControlFor(revisionId), tabId);
  return { status: 'ok', replaced: highestIndexFirst.length };
}

/** The stretches of one match between the elements the edit gives back, each with the doc range it covers; none when it keeps no element. */
function gapsAroundKeptElements(projection: Projection, shared: SharedLines, matchStart: number, matchLength: number, deleting: boolean, written: string, tokens: TokenTable): (Gap & { matched: DocRange })[] {
  const span = middleSpan(shared, matchStart, matchLength, deleting);
  const gaps = splitAtKeptElements(shared.middleOld, projection.text.slice(span.from, span.to), written, tokens);
  if (!gaps.some((gap) => gap.followsKept)) return [];
  return gaps.map((gap) => {
    const from = span.from + gap.plainFrom;
    const to = span.from + gap.plainTo;
    const point = gap.followsKept ? projection.map[from - 1] + 1 : projection.map[to];
    return { ...gap, matched: from < to ? rangeFor(projection, from, to) : { startIndex: point, endIndex: point } };
  });
}

const NOTE_LINE = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

interface Definitions {
  /** the new string without its definition lines. */
  text: string;
  /** the definition lines themselves, to hand to the block writer. */
  lines: string[];
  notes: Map<string, string>;
  lists: Map<string, ListSpec>;
}

/** The `[^x]: note` and `<datalist>` lines of a new string are not text: they say what the footnotes and dropdowns it makes need. */
function definitionsIn(encodedNewString: string): Definitions {
  const notes = new Map<string, string>();
  const lists = new Map<string, ListSpec>();
  const lines: string[] = [];
  const kept: string[] = [];
  for (const line of encodedNewString.split('\n')) {
    const note = NOTE_LINE.exec(line);
    const list = listSpecOfLine(line);
    if (note) notes.set(note[1], note[2].trim());
    else if (list) lists.set(list.id, list);
    else kept.push(line);
    if (note || list) lines.push(line);
  }
  const text = lines.length === 0 ? encodedNewString : kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return { text, lines, notes, lists };
}

const createsRule = (written: string, oldMiddle: string, tokens: TokenTable): boolean => [...written].some((char) => tokens.tokenOf(char)?.startsWith('---') && !oldMiddle.includes(char));

/** Refuses, before anything is sent, an element the edit would make that cannot be made, a chip given other words, or a dropdown change Docs cannot suggest. */
function refuseElementsThatCannotBeWritten(
  oldMiddle: string,
  written: string,
  definitions: Definitions,
  tokens: TokenTable,
  where: { doc: docs_v1.Schema$Document; tabId: string | undefined; segmentId: string | undefined; suggest: boolean | undefined },
): void {
  const tokensOf = (text: string): string[] => [...text].flatMap((char) => tokens.tokenOf(char) ?? []);
  const was = new Set(tokensOf(oldMiddle));
  const made = [...new Set(tokensOf(written))].filter((token) => !was.has(token));
  const stillThere = new Set(tokensOf(written));
  const chipIssues = made.flatMap((token) => [...was].filter((before) => !stillThere.has(before)).flatMap((before) => chipTextChange(parseElement(before), parseElement(token)) ?? []));
  const suggestIssues = where.suggest ? unsuggestableDropdownIssues([...made, ...definitions.lines].join('\n'), where.doc, where.tabId).map((issue) => `Docs cannot suggest this: ${issue}`) : [];
  const issues = [...chipIssues, ...suggestIssues];
  if (issues.length) throw new ElementRefusal(issues);
}

function footnoteIdOf(doc: docs_v1.Schema$Document, tabId: string | undefined, number: string): string | undefined {
  const find = (content: docs_v1.Schema$StructuralElement[]): string | undefined => {
    for (const el of content) {
      const cells = (el.table?.tableRows ?? []).flatMap((row) => row.tableCells ?? []);
      const found = el.paragraph ? el.paragraph.elements?.find((pe) => pe.footnoteReference?.footnoteNumber === number)?.footnoteReference?.footnoteId : find(cells.flatMap((cell) => cell.content ?? []));
      if (found) return found;
    }
    return undefined;
  };
  return find(tabContainer(doc, tabId)?.body?.content ?? []);
}

const nonBlankLines = (text: string): string[] => text.split('\n').filter((line) => line.trim() !== '');

/** An edit whose old_string is one `[^1]: note` line edits that footnote's own text. Undefined for any other edit. */
function noteEditOf(doc: docs_v1.Schema$Document, tabId: string | undefined, oldString: string, newString: string): { oldText: string; newText: string; footnoteId: string } | undefined {
  const oldLines = nonBlankLines(oldString);
  if (oldLines.length === 0 || !oldLines.every((line) => NOTE_LINE.test(line))) return undefined;
  if (oldLines.length > 1) throw new Error('Edit one footnote at a time: old_string holds more than one [^n]: line.');
  const [, label, oldText] = NOTE_LINE.exec(oldLines[0])!;
  const newLine = nonBlankLines(newString).find((line) => NOTE_LINE.exec(line)?.[1] === label);
  if (newLine === undefined) throw new Error(`new_string must keep the [^${label}]: line, with the note's new words. To remove a footnote, edit the text that holds its [^${label}].`);
  const footnoteId = footnoteIdOf(doc, tabId, label);
  if (!footnoteId) throw new Error(`This doc has no footnote [^${label}].`);
  return { oldText, newText: NOTE_LINE.exec(newLine)![2], footnoteId };
}

/** An edit whose old_string is `<datalist>` lines changes those lists, everywhere they are used. Undefined for any other edit. */
async function editDatalists(
  clients: GoogleClients,
  documentId: string,
  doc: docs_v1.Schema$Document,
  tabId: string | undefined,
  oldString: string,
  newString: string,
  revisionId: string | undefined,
): Promise<EditResult | undefined> {
  const oldLines = nonBlankLines(oldString);
  if (oldLines.length === 0 || !oldLines.every((line) => listSpecOfLine(line) !== undefined)) return undefined;
  const shown = renderDatalists(doc, tabId);
  if (!shown.includes(oldString.trim())) return { status: 'not_found', message: `old_string is not in the dropdown lists. They read:\n${shown}` };
  const definitions = (tabContainer(doc, tabId) as { dropdownDefinitions?: Record<string, DropdownDefinition> } | undefined)?.dropdownDefinitions ?? {};
  const requests = shown
    .replace(oldString.trim(), () => newString.trim())
    .split('\n')
    .flatMap((line) => {
      const spec = listSpecOfLine(line);
      return spec ? [listRequest(spec, definitions[spec.id])] : [];
    })
    .filter((request): request is docs_v1.Schema$Request => request !== undefined);
  if (!requests.length) return { status: 'ok', replaced: 0, message: 'no list changed' };
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests, writeControl: writeControlFor(revisionId) } });
  return { status: 'ok', replaced: requests.length };
}
