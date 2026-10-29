import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project, type Projection } from './transformer.js';
import { resolveTabId, writeControlFor, startsParagraph, paragraphEdgesAt, spacesAround, tableHolding, isEmptyContent, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { parseInline, segmentTextStyle, inlineStyleIssues, type Segment } from './inline.js';
import { HEADING_BY_LEVEL, NAMED_STYLE_BY_CLASS } from './markdown-spec.js';
import { paragraphCssChange, paragraphStyleUpdate, StyleSyntaxError } from './css.js';
import { splitEditLine, type ParagraphLine, type ParagraphMarkup } from './paragraph-markup.js';
import { parseStyleBlock, namedStyleRequests, styleRulesOf, renderStyleBlock } from './style-block.js';
import { clearDirectRunStyling, pageBreakRequests, parseBlocks, holdsBlockMarkdown, isTableRow, isTableSep, splitRow } from './write.js';
import { renderMarkdownInto } from './render.js';
import { parsePageBreakLine } from './page-break.js';
import { editTableMarkup, mentionsTableMarkup, type TableEditInput } from './table-edit.js';

export interface EditResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'no_segment';
  replaced?: number;
  warnings?: string[];
  images?: { src: string; objectId: string }[];
  matches?: { context: string }[];
  message?: string;
}

const CONTEXT = 30;

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

export function contextAround(text: string, start: number, end: number): string {
  const pre = text.slice(Math.max(0, start - CONTEXT), start);
  const hit = text.slice(start, end);
  const post = text.slice(end, end + CONTEXT);
  return `…${pre}⟦${hit}⟧${post}…`.replace(/\n/g, '⏎');
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

function targetsStyleBlock(oldString: string, block: string, docText: string): boolean {
  if (/<style/i.test(oldString)) return true;
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
  breakOffsets: number[];
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
  { newLines, lineTexts, segments, plain, breakOffsets }: Replacement,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const breaks = breakOffsets.map((offset) => ({
    index: startIndex + offset,
    ownParagraph: offset === 0 ? startsParagraph(doc, tabId, segmentId, startIndex) : plain[offset - 1] === '\n',
  }));
  return [
    ...(endIndex > startIndex ? [{ deleteContentRange: { range: { startIndex, endIndex, tabId, segmentId } } }] : []),
    ...(plain ? [...insertedTextRequests(segments, plain, startIndex, tabId, segmentId), ...newParagraphRequests(newLines, lineTexts, startIndex, tabId, segmentId)] : []),
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
}

const NOTHING_SHARED = (oldString: string, newString: string): SharedLines => ({ keepsPrefix: false, keepsSuffix: false, prefixLength: 0, suffixLength: 0, middleOld: oldString, middleNew: newString });

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
  return {
    keepsPrefix,
    keepsSuffix,
    prefixLength: keepsPrefix ? prefixLength : 0,
    suffixLength: keepsSuffix ? suffixLength : 0,
    middleOld: textLines(middleOld),
    middleNew: textLines(middleNew),
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

async function applyBlockEdit(context: BlockEditContext, matched: DocRange, side: InsertionSide | undefined, revisionId: string | undefined) {
  const { clients, documentId, doc, markdown, tabId, segmentId, baseDir } = context;
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
  return renderMarkdownInto(clients, documentId, markdown, {
    tabId,
    segmentId,
    baseDir,
    preRequests,
    requiredRevisionId: revisionId,
    startIndex: startsAParagraph ? startIndex : from + 1,
    resetParagraphStyles: true,
    startsParagraph: true,
    endsInExistingParagraphMark: endsAtParagraphMark,
  });
}

const quotesTable = (oldString: string, newString: string): boolean =>
  mentionsTableMarkup(oldString) || (mentionsTableMarkup(newString) && oldString.split('\n').some(isTableRow));

const EMPTY_CONTENT_MESSAGE = 'There is nothing here to anchor an edit: the doc, tab or header/footer is empty. Use write_doc to write it.';

export async function editDoc(
  clients: GoogleClients,
  documentId: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean; tabId?: string; segment?: SegmentKind; page?: SegmentPage; baseDir?: string } = {},
): Promise<EditResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const revisionId = res.data.revisionId ?? undefined;
  const tabId = resolveTabId(res.data, opts.tabId);
  const target = resolveSegmentTarget(res.data, { segment: opts.segment, page: opts.page, tabId });
  if (target.error) return { status: 'no_segment', message: target.error };
  const segmentId = target.segmentId;
  const proj = project(res.data, tabId, segmentId);

  const block = renderStyleBlock(styleRulesOf(res.data, tabId));
  if (targetsStyleBlock(oldString, block, proj.text)) {
    return editStyleBlock(clients, documentId, block, oldString, newString, tabId, revisionId);
  }
  if (isEmptyContent(res.data, tabId, segmentId)) throw new Error(EMPTY_CONTENT_MESSAGE);

  if (quotesTable(oldString, newString)) {
    const insertBlocks: TableEditInput['insertBlocks'] = (side, table, markdown, revisionId) => {
      const inside = (table.startIndex ?? 0) + 1;
      return applyBlockEdit({ clients, documentId, doc: res.data, markdown, tabId, segmentId, baseDir: opts.baseDir }, { startIndex: inside, endIndex: inside + 1 }, side, revisionId);
    };
    return editTableMarkup(clients, documentId, res.data, { oldString, newString, replaceAll: opts.replaceAll, tabId, segmentId, baseDir: opts.baseDir, insertBlocks });
  }
  if (mentionsTableMarkup(newString) && !holdsBlockMarkdown(newString)) {
    throw new StyleSyntaxError(['new_string holds table tags, but old_string does not quote a table. Quote the table markup from read_doc in old_string, or write a whole <table> block.']);
  }

  const located = locate(proj.text, oldString);
  const { needle, positions } = located;
  if (positions.length === 0) {
    return { status: 'not_found', message: `"${oldString}" not found.` };
  }
  if (positions.length > 1 && !opts.replaceAll) {
    return {
      status: 'ambiguous',
      message: `${positions.length} matches — add surrounding context, or set replace_all.`,
      matches: positions.map((p) => ({ context: contextAround(proj.text, p, p + needle.length) })),
    };
  }

  const shared = sharedLinesOf(oldString, newString, located);
  const keepsAnything = shared.keepsPrefix || shared.keepsSuffix;
  const written = shared.middleNew;
  const insertsOnly = keepsAnything && isBlank(shared.middleOld);
  const writesNothing = isBlank(written);
  const highestIndexFirst = (opts.replaceAll ? positions : [positions[0]]).sort((x, y) => y - x);

  if (insertsOnly && writesNothing) return { status: 'ok', replaced: 0 };

  const asBlocks = insertsOnly ? addsBlockText(written) : holdsBlockMarkdown(written);
  if (asBlocks) {
    parseBlocks(written);
    const context: BlockEditContext = { clients, documentId, doc: res.data, markdown: written, tabId, segmentId, baseDir: opts.baseDir };
    const warnings: string[] = [];
    const images: { src: string; objectId: string }[] = [];
    for (const [n, a] of highestIndexFirst.entries()) {
      const edit = insertsOnly
        ? insertionPoint(proj, shared, a, needle.length)
        : { side: undefined, matched: rangeOfSpan(proj, middleSpan(shared, a, needle.length, false)) };
      const done = await applyBlockEdit(context, edit.matched, edit.side, n === 0 ? revisionId : undefined);
      warnings.push(...done.warnings);
      images.push(...done.images);
    }
    return { status: 'ok', replaced: highestIndexFirst.length, ...(warnings.length ? { warnings } : {}), ...(images.length ? { images } : {}) };
  }

  const { lines: newLines, breaksAfterLines, issues: problems } = partitionNewString(written);
  if (problems.length) throw new StyleSyntaxError(problems);
  const segments = parseInline(newLines.map((l) => l.inner).join('\n'));
  const plain = segments.map((s) => s.text).join('');
  const lineTexts = plain.split('\n');
  const replacement: Replacement = { newLines, lineTexts, segments, plain, breakOffsets: pageBreakOffsets(breaksAfterLines, lineTexts) };

  const requests = highestIndexFirst.flatMap((a) => {
    if (insertsOnly) {
      const { side, matched } = insertionPoint(proj, shared, a, needle.length);
      return replacementRequestsFor(res.data, pointAt(side, matched), replacement, tabId, segmentId);
    }
    const span = middleSpan(shared, a, needle.length, writesNothing);
    const sameWords = plain === proj.text.slice(span.from, span.to) && replacement.breakOffsets.length === 0;
    if (sameWords) return styleOnlyRequestsFor(proj, span.from, span.to - span.from, shared.middleOld, replacement, tabId, segmentId);
    return replacementRequestsFor(res.data, rangeFor(proj, span.from, span.to), replacement, tabId, segmentId);
  });

  if (requests.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests, writeControl: writeControlFor(revisionId) },
    });
  }
  return { status: 'ok', replaced: highestIndexFirst.length };
}
