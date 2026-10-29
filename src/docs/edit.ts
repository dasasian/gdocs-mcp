import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project, type Projection } from './transformer.js';
import { resolveTabId, writeControlFor, startsParagraph, paragraphEdgesAt, tableHolding, isEmptyContent, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { parseInline, segmentTextStyle, inlineStyleIssues, type Segment } from './inline.js';
import { HEADING_BY_LEVEL, NAMED_STYLE_BY_CLASS } from './markdown-spec.js';
import { paragraphCssChange, paragraphStyleUpdate, StyleSyntaxError } from './css.js';
import { splitEditLine, type ParagraphLine, type ParagraphMarkup } from './paragraph-markup.js';
import { parseStyleBlock, namedStyleRequests, styleRulesOf, renderStyleBlock } from './style-block.js';
import { clearDirectRunStyling, pageBreakRequests, parseBlocks, holdsBlockMarkdown, isTableRow, isTableSep, splitRow } from './write.js';
import { renderMarkdownInto } from './render.js';
import { parsePageBreakLine } from './page-break.js';

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

function tableRowsAsCellText(s: string): string {
  return s
    .split('\n')
    .filter((line) => !(isTableRow(line) && isTableSep(line)))
    .map((line) => (isTableRow(line) ? splitRow(line).join('\n') : line))
    .join('\n');
}

/** Resolves old_string to its match positions: exact first, then markup-tolerant, with a markdown table matching as its cells' text. */
export function locate(text: string, oldString: string): { needle: string; positions: number[] } {
  let positions = findAll(text, oldString);
  if (positions.length) return { needle: oldString, positions };
  const cellText = tableRowsAsCellText(oldString);
  if (cellText !== oldString) {
    const needle = stripMarkdown(cellText);
    positions = findAll(text, needle);
    if (positions.length) return { needle, positions };
  }
  const stripped = stripMarkdown(oldString);
  if (stripped !== oldString) {
    positions = findAll(text, stripped);
    if (positions.length) return { needle: stripped, positions };
  }
  return { needle: oldString, positions: [] };
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
    { deleteContentRange: { range: { startIndex, endIndex, tabId, segmentId } } },
    ...(plain ? [...insertedTextRequests(segments, plain, startIndex, tabId, segmentId), ...newParagraphRequests(newLines, lineTexts, startIndex, tabId, segmentId)] : []),
    ...pageBreakRequests(breaks, tabId, segmentId),
  ];
}

interface UnchangedAnchor {
  side: 'after' | 'before';
  added: string;
}

function unchangedAnchorOf(oldString: string, newString: string): UnchangedAnchor | undefined {
  if (newString.length <= oldString.length) return undefined;
  const after = newString.startsWith(oldString) ? newString.slice(oldString.length) : undefined;
  if (after !== undefined && holdsBlockMarkdown(after)) return { side: 'after', added: after };
  const before = newString.endsWith(oldString) ? newString.slice(0, newString.length - oldString.length) : undefined;
  if (before !== undefined && holdsBlockMarkdown(before)) return { side: 'before', added: before };
  return undefined;
}

interface BlockEditContext {
  clients: GoogleClients;
  documentId: string;
  doc: docs_v1.Schema$Document;
  markdown: string;
  anchor: UnchangedAnchor | undefined;
  tabId: string | undefined;
  segmentId: string | undefined;
  baseDir: string | undefined;
}

function blockInsertionRange(context: BlockEditContext, matched: DocRange): DocRange {
  const { doc, anchor, tabId, segmentId } = context;
  if (!anchor) return matched;
  if (anchor.side === 'after') {
    const table = tableHolding(doc, tabId, segmentId, matched.endIndex - 1);
    const at = table?.endIndex ?? matched.endIndex;
    return { startIndex: at, endIndex: at };
  }
  const table = tableHolding(doc, tabId, segmentId, matched.startIndex);
  const at = table ? (table.startIndex ?? 1) - 1 : matched.startIndex;
  return { startIndex: at, endIndex: at };
}

async function applyBlockEdit(context: BlockEditContext, matched: DocRange, revisionId: string | undefined) {
  const { clients, documentId, doc, markdown, tabId, segmentId, baseDir } = context;
  const { startIndex, endIndex } = blockInsertionRange(context, matched);
  const startsAParagraph = paragraphEdgesAt(doc, tabId, segmentId, startIndex).atStart;
  const endsAtParagraphMark = paragraphEdgesAt(doc, tabId, segmentId, endIndex).atMark;
  const preRequests: docs_v1.Schema$Request[] = [
    ...(endIndex > startIndex ? [{ deleteContentRange: { range: { startIndex, endIndex, tabId, segmentId } } }] : []),
    ...(startsAParagraph ? [] : [{ insertText: { location: { index: startIndex, tabId, segmentId }, text: '\n' } }]),
  ];
  return renderMarkdownInto(clients, documentId, markdown, {
    tabId,
    segmentId,
    baseDir,
    preRequests,
    requiredRevisionId: revisionId,
    startIndex: startsAParagraph ? startIndex : startIndex + 1,
    resetParagraphStyles: true,
    startsParagraph: true,
    endsInExistingParagraphMark: endsAtParagraphMark,
  });
}

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

  const { needle, positions } = locate(proj.text, oldString);
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

  const anchor = unchangedAnchorOf(oldString, newString);
  const written = anchor ? anchor.added : newString;
  const highestIndexFirst = (opts.replaceAll ? positions : [positions[0]]).sort((x, y) => y - x);

  if (anchor || holdsBlockMarkdown(written)) {
    parseBlocks(written);
    const context: BlockEditContext = { clients, documentId, doc: res.data, markdown: written, anchor, tabId, segmentId, baseDir: opts.baseDir };
    const warnings: string[] = [];
    const images: { src: string; objectId: string }[] = [];
    for (const [n, a] of highestIndexFirst.entries()) {
      const done = await applyBlockEdit(context, rangeFor(proj, a, a + needle.length), n === 0 ? revisionId : undefined);
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

  const sameWords = plain === needle && replacement.breakOffsets.length === 0;
  const requests = highestIndexFirst.flatMap((a) =>
    sameWords
      ? styleOnlyRequestsFor(proj, a, needle.length, oldString, replacement, tabId, segmentId)
      : replacementRequestsFor(res.data, rangeFor(proj, a, a + needle.length), replacement, tabId, segmentId),
  );

  if (requests.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests, writeControl: writeControlFor(revisionId) },
    });
  }
  return { status: 'ok', replaced: highestIndexFirst.length };
}
