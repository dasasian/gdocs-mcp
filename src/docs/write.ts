import type { docs_v1 } from 'googleapis';
import { parseInline, segmentTextStyle, inlineStyleIssues } from './inline.js';
import { HEADING_BY_LEVEL, NAMED_STYLE_BY_CLASS, type ParagraphClass } from './markdown-spec.js';
import { paragraphStyleUpdate, StyleSyntaxError, type ParagraphCss } from './css.js';
import { splitWrappedLine } from './paragraph-markup.js';
import { parsePageBreakLine } from './page-break.js';
import { parseStyleBlock, namedStyleRequests, type StyleRule } from './style-block.js';
import { parseHtmlTable } from './table-html.js';
import { placeCells, type LayoutCell, type TableLayout } from './table-layout.js';
import { QUOTE_PARAGRAPH_FIELDS, QUOTE_PARAGRAPH_STYLE } from './quote.js';

export type CellAlign = 'left' | 'center' | 'right';

type Block =
  | { type: 'heading'; level: number; text: string; css?: ParagraphCss }
  | { type: 'paragraph'; text: string; css?: ParagraphCss; className?: ParagraphClass; quote?: true }
  | { type: 'code'; text: string }
  | { type: 'style'; rules: StyleRule[] }
  | { type: 'list'; ordered: boolean; items: { level: number; text: string }[] }
  | { type: 'table'; rows: string[][]; aligns: (CellAlign | null)[]; layout?: TableLayout }
  | { type: 'image'; alt: string; src: string; width?: number; height?: number; css?: ParagraphCss }
  | { type: 'pageBreak' };

// Every direct character-formatting field, cleared by listing it in `fields`
// while leaving it out of `textStyle`. Kept exhaustive on purpose: a field
// missing here is a field that can leak across an overwrite (#32).
const RESET_TEXT_FIELDS = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'smallCaps',
  'backgroundColor',
  'foregroundColor',
  'fontSize',
  'weightedFontFamily',
  'baselineOffset',
  'link',
].join(',');

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
// A whole line that is just an image: ![alt](src), with an optional trailing
// HTML comment (e.g. gdocs tracking metadata) that we ignore.
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*(?:<!--.*?-->)?\s*$/;
// A whole line that is an <img> tag — what read_doc emits, and the escape hatch
// for the sizing markdown can't express (DESIGN.md §2). Attributes in any order.
const IMG_TAG_RE = /^<img\s+[^>]*>$/i;
const ATTR_RE = /([a-z-]+)\s*=\s*"([^"]*)"/gi;
const STYLE_OPEN_RE = /^<style>/i;
const STYLE_CLOSE_RE = /<\/style>/i;
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;
const QUOTE_MARK_RE = /^ {0,3}>/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
const INDENTED_CODE_STRIP_RE = /^(?: {1,4}|\t)/;

export const isTableRow = (l: string): boolean => l.trim().startsWith('|');
// A separator line is only dashes/colons/pipes/spaces, with at least one dash.
export const isTableSep = (l: string): boolean => l.includes('-') && /^[\s|:-]+$/.test(l.trim());

export const unescapePipes = (cell: string): string => cell.replace(/\\\|/g, '|');

const WRAPPED_CELL_RE = /^<p>([\s\S]*)<\/p>$/i;

/** What a table cell holds before pipes are unescaped: trimmed, unless the whole cell is wrapped in `<p>`, which keeps every space and tab. */
export function cellContent(rawCell: string): string {
  const trimmed = rawCell.trim();
  return WRAPPED_CELL_RE.exec(trimmed)?.[1] ?? trimmed;
}

export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => unescapePipes(cellContent(c)));
}

// Per-column alignment from a separator row: :--- left, :---: center, ---: right.
function parseAligns(sepLine: string): (CellAlign | null)[] {
  return splitRow(sepLine).map((c) => {
    const t = c.trim();
    const l = t.startsWith(':');
    const r = t.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return null;
  });
}

function skipHtmlComment(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && !lines[i].includes('-->')) i++;
  return i + 1;
}

function parseTableAt(lines: string[], from: number): { block: Block; next: number } {
  const header = splitRow(lines[from]);
  const aligns = parseAligns(lines[from + 1]);
  let i = from + 2;
  const body: string[][] = [];
  while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
    body.push(splitRow(lines[i]));
    i++;
  }
  return { block: { type: 'table', rows: [header, ...body], aligns }, next: i };
}

const HTML_TABLE_START_RE = /^<table\b/i;
const HTML_TABLE_END_RE = /<\/table\s*>/i;

export type CellBlock = Extract<Block, { type: 'heading' | 'paragraph' | 'list' | 'code' }>;

/** What a cell of an HTML table holds. Anything a cell cannot carry (an image, a page break, a table) is a problem, not a block. */
export function cellBlocksOf(cell: LayoutCell): { blocks: CellBlock[]; issues: string[]; refused: string[] } {
  if (!cell.asBlocks) {
    const inline = cell.markdown === '' ? [] : [{ type: 'paragraph' as const, text: cell.markdown }];
    return { blocks: inline, issues: inlineStyleIssues(cell.markdown), refused: [] };
  }
  try {
    const parsed = parseBlocks(cell.markdown);
    const blocks = parsed.filter((b): b is CellBlock => b.type === 'heading' || b.type === 'paragraph' || b.type === 'list' || b.type === 'code');
    const refused = parsed.filter((b) => !blocks.includes(b as CellBlock)).map((b) => `a table cell cannot hold a ${b.type}`);
    return { blocks, issues: refused, refused };
  } catch (error) {
    if (error instanceof StyleSyntaxError) return { blocks: [], issues: error.issues, refused: [] };
    throw error;
  }
}

const CSS_ISSUE = /<[a-z]+ style> /;

type Reporter = (lineIndex: number, found: string[], aboutTableShape?: boolean) => void;

function parseHtmlTableAt(
  lines: string[],
  from: number,
  report: Reporter,
): { block: Block; next: number } {
  let last = from;
  while (last < lines.length && !HTML_TABLE_END_RE.test(lines[last])) last++;
  if (last === lines.length) {
    report(from, ['<table> is never closed'], true);
    return { block: { type: 'table', rows: [], aligns: [] }, next: lines.length };
  }
  const { layout, issues } = parseHtmlTable(lines.slice(from, last + 1).join('\n'));
  const placement = placeCells(layout);
  report(from, issues.filter((issue) => CSS_ISSUE.test(issue)));
  report(from, [...issues.filter((issue) => !CSS_ISSUE.test(issue)), ...placement.issues], true);
  const rows = Array.from({ length: placement.rowCount }, () => Array.from({ length: placement.columnCount }, () => ''));
  for (const { row, column, cell } of placement.cells) {
    rows[row][column] = cell.markdown;
    const { issues: cellIssues, refused } = cellBlocksOf(cell);
    const where = (issue: string): string => `row ${row + 1}, column ${column + 1}: ${issue}`;
    report(from, cellIssues.filter((issue) => !refused.includes(issue)).map(where));
    report(from, refused.map(where), true);
  }
  return { block: { type: 'table', rows, aligns: [], layout }, next: last + 1 };
}

function positiveNumber(v: string | undefined): number | undefined {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseImgTag(line: string): Extract<Block, { type: 'image' }> | undefined {
  const attrs: Record<string, string> = {};
  for (const a of line.matchAll(ATTR_RE)) attrs[a[1].toLowerCase()] = a[2];
  if (!attrs.src) return undefined;
  return {
    type: 'image',
    alt: unescapeAttr(attrs.alt ?? ''),
    src: attrs.src,
    width: positiveNumber(attrs.width),
    height: positiveNumber(attrs.height),
  };
}

const startsOtherBlockLine = (line: string): boolean =>
  isTableRow(line) || IMAGE_RE.test(line.trim()) || IMG_TAG_RE.test(line.trim()) || HTML_TABLE_START_RE.test(line.trim()) || STYLE_OPEN_RE.test(line.trim()) || line.trim().startsWith('<!--') || splitWrappedLine(line) !== undefined;

const endsParagraphBeforeLine = (line: string): boolean =>
  line.trim() === '' || HEADING_RE.test(line) || LIST_RE.test(line) || FENCE_OPEN_RE.test(line) || QUOTE_MARK_RE.test(line) || parsePageBreakLine(line) !== undefined;

function parseListAt(lines: string[], from: number): { block: Block; next: number } {
  const ordered = /\d/.test(LIST_RE.exec(lines[from])![2]);
  const items: { level: number; text: string }[] = [];
  let i = from;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (m) {
      const indent = m[1].replace(/\t/g, '  ').length;
      items.push({ level: Math.floor(indent / 2), text: m[3].trim() });
    } else if (endsParagraphBeforeLine(lines[i]) || startsOtherBlockLine(lines[i])) {
      break;
    } else {
      items[items.length - 1].text += ` ${lines[i].trim()}`;
    }
    i++;
  }
  return { block: { type: 'list', ordered, items }, next: i };
}

function parseSoftJoinedParagraphAt(lines: string[], from: number): { block: Block; next: number } {
  const para: string[] = [];
  let i = from;
  while (i < lines.length && !endsParagraphBeforeLine(lines[i])) {
    para.push(lines[i].trim());
    i++;
  }
  return { block: { type: 'paragraph', text: para.join(' ') }, next: i };
}

const withoutLeadingSpaces = (line: string, most: number): string => line.replace(new RegExp(`^ {0,${most}}`), '');

function parseFencedCodeAt(lines: string[], from: number, report: Reporter): { block: Block; next: number } {
  const [, indent, fence] = FENCE_OPEN_RE.exec(lines[from])!;
  const closeRe = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
  const code: string[] = [];
  let i = from + 1;
  while (i < lines.length && !closeRe.test(lines[i])) {
    code.push(withoutLeadingSpaces(lines[i], indent.length));
    i++;
  }
  if (i === lines.length) report(from, [`code fence ${fence} is never closed`], true);
  return { block: { type: 'code', text: code.join('\n') }, next: i + 1 };
}

function parseIndentedCodeAt(lines: string[], from: number): { block: Block; next: number } {
  let end = from;
  let i = from;
  while (i < lines.length && (lines[i].trim() === '' || INDENTED_CODE_RE.test(lines[i]))) {
    if (lines[i].trim() !== '') end = i;
    i++;
  }
  const code = lines.slice(from, end + 1).map((line) => (line.trim() === '' ? '' : line.replace(INDENTED_CODE_STRIP_RE, '')));
  return { block: { type: 'code', text: code.join('\n') }, next: end + 1 };
}

function parseQuoteAt(lines: string[], from: number, report: Reporter): { blocks: Block[]; next: number } {
  const paragraphs: string[][] = [[]];
  const open = (): string[] => paragraphs[paragraphs.length - 1];
  let i = from;
  while (i < lines.length) {
    const marked = QUOTE_MARK_RE.exec(lines[i]);
    const lazy = !marked && open().length > 0 && !endsParagraphBeforeLine(lines[i]);
    if (!marked && !lazy) break;
    const content = marked ? lines[i].slice(marked[0].length).replace(/^ /, '') : lines[i];
    const refusal = marked ? refusalInsideQuote(content, open().length === 0) : undefined;
    if (refusal) report(i, [refusal], true);
    else if (content.trim() === '') paragraphs.push([]);
    else {
      const wrapped = splitWrappedLine(content);
      if (wrapped && (wrapped.markup.heading || wrapped.markup.className || Object.keys(wrapped.markup.css).length || wrapped.issues.length)) {
        report(i, ['a paragraph style or heading cannot go inside a quote'], true);
      } else {
        report(i, inlineStyleIssues(content));
        open().push(wrapped ? wrapped.inner : content.trim());
      }
    }
    i++;
  }
  const blocks = paragraphs.filter((words) => words.length).map((words): Block => ({ type: 'paragraph', text: words.join(' '), quote: true }));
  return { blocks, next: i };
}

function refusalInsideQuote(content: string, startsParagraph: boolean): string | undefined {
  if (QUOTE_MARK_RE.test(content)) return 'a quote inside a quote (>>) is not supported';
  if (LIST_RE.test(content)) return 'a list inside a quote is not supported';
  if (FENCE_OPEN_RE.test(content) || (startsParagraph && INDENTED_CODE_RE.test(content))) return 'a code block inside a quote is not supported';
  if (HEADING_RE.test(content)) return 'a heading inside a quote is not supported';
  return undefined;
}

function parseStyleBlockAt(lines: string[], from: number, issues: string[]): number {
  let end = from;
  while (end < lines.length && !STYLE_CLOSE_RE.test(lines[end])) end++;
  if (end === lines.length) {
    issues.push(`line ${from + 1}: <style> is never closed`);
    return lines.length;
  }
  return end + 1;
}

const WRAPPED_IMAGE_LINE_RE = /^<p\b[^>]*>\s*<img\b/i;

/** True when the markdown holds more than inline text: a block construct, or a blank line between paragraphs. */
export function holdsBlockMarkdown(markdown: string): boolean {
  const hasBlockLine = markdown.split('\n').some((line) => {
    const trimmed = line.trim();
    return HEADING_RE.test(line) || LIST_RE.test(line) || FENCE_OPEN_RE.test(line) || QUOTE_MARK_RE.test(line) || isTableRow(line) || HTML_TABLE_START_RE.test(trimmed) || IMAGE_RE.test(trimmed) || IMG_TAG_RE.test(trimmed) || WRAPPED_IMAGE_LINE_RE.test(trimmed) || STYLE_OPEN_RE.test(trimmed);
  });
  return hasBlockLine || /\n[ \t]*\n/.test(markdown);
}

interface ParseContext {
  lines: string[];
  report: Reporter;
  issues: string[];
}

interface Parsed {
  blocks: Block[];
  next: number;
}

type BlockParser = (context: ParseContext, from: number) => Parsed | undefined;

const single = (block: Block, from: number): Parsed => ({ blocks: [block], next: from + 1 });

const parseIndentedCode: BlockParser = ({ lines }, from) => {
  if (!INDENTED_CODE_RE.test(lines[from])) return undefined;
  const code = parseIndentedCodeAt(lines, from);
  return { blocks: [code.block], next: code.next };
};

const parseHtmlComment: BlockParser = ({ lines }, from) =>
  lines[from].trim().startsWith('<!--') ? { blocks: [], next: skipHtmlComment(lines, from) } : undefined;

const parseStyleBlockLines: BlockParser = ({ lines, issues }, from) => {
  if (!STYLE_OPEN_RE.test(lines[from].trim())) return undefined;
  const next = parseStyleBlockAt(lines, from, issues);
  const parsed = parseStyleBlock(lines.slice(from, next).join('\n'), from + 1);
  issues.push(...parsed.issues);
  return { blocks: [{ type: 'style', rules: parsed.rules }], next };
};

const parseHeadingLine: BlockParser = ({ lines, report }, from) => {
  const heading = HEADING_RE.exec(lines[from]);
  if (!heading) return undefined;
  report(from, inlineStyleIssues(heading[2]));
  return single({ type: 'heading', level: heading[1].length, text: heading[2].trim() }, from);
};

const parseHtmlTableBlock: BlockParser = ({ lines, report }, from) => {
  if (!HTML_TABLE_START_RE.test(lines[from].trim())) return undefined;
  const table = parseHtmlTableAt(lines, from, report);
  return { blocks: [table.block], next: table.next };
};

const parsePipeTable: BlockParser = ({ lines }, from) => {
  if (!(isTableRow(lines[from]) && from + 1 < lines.length && isTableSep(lines[from + 1]))) return undefined;
  const table = parseTableAt(lines, from);
  return { blocks: [table.block], next: table.next };
};

const parseMarkdownImage: BlockParser = ({ lines }, from) => {
  const image = IMAGE_RE.exec(lines[from].trim());
  return image ? single({ type: 'image', alt: image[1], src: image[2] }, from) : undefined;
};

const parseImageTagLine: BlockParser = ({ lines }, from) => {
  const image = IMG_TAG_RE.test(lines[from].trim()) ? parseImgTag(lines[from].trim()) : undefined;
  return image ? single(image, from) : undefined;
};

const parsePageBreakBlock: BlockParser = ({ lines, report }, from) => {
  const pageBreak = parsePageBreakLine(lines[from]);
  if (!pageBreak) return undefined;
  report(from, pageBreak.issues);
  return single({ type: 'pageBreak' }, from);
};

const parseFencedCode: BlockParser = ({ lines, report }, from) => {
  if (!FENCE_OPEN_RE.test(lines[from])) return undefined;
  const code = parseFencedCodeAt(lines, from, report);
  return { blocks: [code.block], next: code.next };
};

const parseQuote: BlockParser = ({ lines, report }, from) => (QUOTE_MARK_RE.test(lines[from]) ? parseQuoteAt(lines, from, report) : undefined);

const parseWrappedParagraph: BlockParser = ({ lines, report }, from) => {
  const wrapped = splitWrappedLine(lines[from]);
  if (!wrapped) return undefined;
  report(from, [...wrapped.issues, ...inlineStyleIssues(wrapped.inner)]);
  const { markup } = wrapped;
  const css = Object.keys(markup.css).length ? markup.css : undefined;
  const wrappedImage = css && !markup.heading && IMG_TAG_RE.test(wrapped.inner.trim()) ? parseImgTag(wrapped.inner.trim()) : undefined;
  if (wrappedImage) return single({ ...wrappedImage, css }, from);
  return single(
    markup.heading ? { type: 'heading', level: markup.heading, text: wrapped.inner, css } : { type: 'paragraph', text: wrapped.inner, css, className: markup.className },
    from,
  );
};

const parseListOrParagraph: BlockParser = ({ lines, report }, from) => {
  const parsed = LIST_RE.test(lines[from]) ? parseListAt(lines, from) : parseSoftJoinedParagraphAt(lines, from);
  for (let n = from; n < parsed.next; n++) report(n, inlineStyleIssues(lines[n]));
  return { blocks: [parsed.block], next: parsed.next };
};

const BLOCK_PARSERS_IN_ORDER: BlockParser[] = [
  parseIndentedCode,
  parseHtmlComment,
  parseStyleBlockLines,
  parseHeadingLine,
  parseHtmlTableBlock,
  parsePipeTable,
  parseMarkdownImage,
  parseImageTagLine,
  parsePageBreakBlock,
  parseFencedCode,
  parseQuote,
  parseWrappedParagraph,
  parseListOrParagraph,
];

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  const issues: string[] = [];
  const structure = new Set<string>();
  const report: Reporter = (lineIndex, found, aboutTableShape = false) => {
    for (const issue of found) {
      issues.push(`line ${lineIndex + 1}: ${issue}`);
      if (aboutTableShape) structure.add(`line ${lineIndex + 1}: ${issue}`);
    }
  };
  const context: ParseContext = { lines, report, issues };
  let from = 0;
  while (from < lines.length) {
    if (lines[from].trim() === '') {
      from++;
      continue;
    }
    for (const parser of BLOCK_PARSERS_IN_ORDER) {
      const parsed = parser(context, from);
      if (!parsed) continue;
      if (parsed.next <= from) throw new Error(`The markdown parser made no progress at line ${from + 1}: ${lines[from]}`);
      blocks.push(...parsed.blocks);
      from = parsed.next;
      break;
    }
  }
  if (issues.length) throw new StyleSyntaxError(issues, structure);
  return blocks;
}

interface InlineOp {
  start: number;
  end: number;
  textStyle: docs_v1.Schema$TextStyle;
  fields: string[];
}

// A table can't be part of the text blob (it's structural). We emit a placeholder
// paragraph where it goes and record its position; the caller inserts the real
// table there afterward (see document.ts renderMarkdownInto).
export interface TablePlacement {
  index: number;
  rows: string[][];
  aligns: (CellAlign | null)[];
  layout?: TableLayout;
}

export interface ImagePlacement {
  index: number;
  alt: string;
  src: string;
  /** points; from an <img width|height>. Docs keeps aspect ratio, so it may adjust these. */
  width?: number;
  height?: number;
}

const unescapeAttr = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

export interface BuiltContent {
  requests: docs_v1.Schema$Request[];
  text: string;
  tables: TablePlacement[];
  images: ImagePlacement[];
}

interface ParagraphOp {
  start: number;
  end: number;
  namedStyleType?: string;
  css: ParagraphCss;
  quote?: true;
}

export interface BuildOptions {
  /** clear the paragraph style the inserted text inherits from where it lands; for a wholesale replace. */
  resetParagraphStyles?: boolean;
  /** the text goes in a place with no direct styling at all, so there is none to inherit and clearing it would change nothing (and, as a suggestion, would show as a Format change nobody made). */
  insertedTextInheritsNoStyling?: boolean;
  /** false when `startIndex` is inside a paragraph's text, so a page break first in the content follows that text instead of starting a paragraph. Default true. */
  startsParagraph?: boolean;
  /** true when the paragraph mark after `startIndex` already exists, so the content's last paragraph ends with it instead of a mark of its own. */
  endsInExistingParagraphMark?: boolean;
}

const RESET_PARAGRAPH_FIELDS = [
  'borderLeft',
  'namedStyleType',
  'alignment',
  'lineSpacing',
  'spaceAbove',
  'spaceBelow',
  'indentStart',
  'indentEnd',
  'indentFirstLine',
].join(',');

const clearDirectParagraphStyling = (startIndex: number, length: number, tabId?: string, segmentId?: string): docs_v1.Schema$Request => ({
  updateParagraphStyle: {
    range: { startIndex, endIndex: startIndex + length, tabId, segmentId },
    paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
    fields: RESET_PARAGRAPH_FIELDS,
  },
});

const PAGE_BREAK_PARAGRAPH_LENGTH = 2;

export interface PageBreakAt {
  /** position in the text as it is before any break is in it. */
  index: number;
  /** true when the break starts a paragraph, so the paragraph mark `insertPageBreak` adds makes a paragraph of its own. */
  ownParagraph: boolean;
}

/**
 * The requests that put page breaks in. Highest index first, so each index is
 * still true when it is used. A break with a paragraph of its own inherits the
 * style and bullet of the paragraph it lands in, so that paragraph is reset to
 * plain Normal text; a break that follows text in its paragraph leaves that
 * paragraph's style alone. Throws for a header or footer segment.
 */
export function pageBreakRequests(breaks: PageBreakAt[], tabId?: string, segmentId?: string): docs_v1.Schema$Request[] {
  if (segmentId && breaks.length > 0) throw new StyleSyntaxError(['a page break cannot go in a header or footer: the Docs API refuses it']);
  return [...breaks]
    .sort((a, b) => b.index - a.index)
    .flatMap(({ index, ownParagraph }) => [
      { insertPageBreak: { location: { index, tabId, segmentId } } },
      ...(ownParagraph
        ? [
            clearDirectParagraphStyling(index, PAGE_BREAK_PARAGRAPH_LENGTH, tabId, segmentId),
            { deleteParagraphBullets: { range: { startIndex: index, endIndex: index + PAGE_BREAK_PARAGRAPH_LENGTH, tabId, segmentId } } },
          ]
        : []),
    ]);
}

export const clearDirectRunStyling = (startIndex: number, length: number, tabId?: string, segmentId?: string): docs_v1.Schema$Request => ({
  updateTextStyle: {
    range: { startIndex, endIndex: startIndex + length, tabId, segmentId },
    textStyle: {},
    fields: RESET_TEXT_FIELDS,
  },
});

export function buildContentRequests(
  blocks: Block[],
  startIndex: number,
  tabId?: string,
  segmentId?: string,
  opts: BuildOptions = {},
): BuiltContent {
  let text = '';
  const paragraphOps: ParagraphOp[] = [];
  const styleRules: StyleRule[] = [];
  const inlineOps: InlineOp[] = [];
  const listOps: { start: number; end: number; ordered: boolean }[] = [];
  const tables: TablePlacement[] = [];
  const images: ImagePlacement[] = [];
  const breakOffsets: number[] = [];
  const pageBreaks = (): PageBreakAt[] => breakOffsets.map((at) => ({ index: at, ownParagraph: at > startIndex || opts.startsParagraph !== false }));
  const abs = (off: number): number => startIndex + off;

  const addInline = (lineContentStart: number, content: string): string => {
    const segs = parseInline(content);
    let plain = '';
    for (const s of segs) {
      const off = plain.length;
      plain += s.text;
      const { textStyle, fields } = segmentTextStyle(s);
      if (fields.length) {
        inlineOps.push({ start: abs(lineContentStart + off), end: abs(lineContentStart + off + s.text.length), textStyle, fields });
      }
    }
    return plain;
  };

  const addPlaceholderParagraph = (): number => {
    const at = abs(text.length);
    text += '\n';
    return at;
  };

  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') {
      const lineStart = text.length;
      const plain = addInline(lineStart, block.text);
      text += plain + '\n';
      const namedStyleType = block.type === 'heading' ? HEADING_BY_LEVEL[block.level] : block.className && NAMED_STYLE_BY_CLASS[block.className];
      const quote = block.type === 'paragraph' ? block.quote : undefined;
      if (namedStyleType || block.css || quote) {
        paragraphOps.push({ start: abs(lineStart), end: abs(lineStart + plain.length + 1), namedStyleType: namedStyleType || undefined, css: block.css ?? {}, quote });
      }
    } else if (block.type === 'code') {
      const lineStart = text.length;
      const lineBroken = block.text.replace(/\n/g, '\v');
      text += lineBroken + '\n';
      if (lineBroken) {
        const { textStyle, fields } = segmentTextStyle({ text: lineBroken, code: true });
        inlineOps.push({ start: abs(lineStart), end: abs(lineStart + lineBroken.length), textStyle, fields });
      }
    } else if (block.type === 'pageBreak') {
      breakOffsets.push(abs(text.length));
    } else if (block.type === 'style') {
      styleRules.push(...block.rules);
    } else if (block.type === 'table') {
      tables.push({ index: addPlaceholderParagraph(), rows: block.rows, aligns: block.aligns, layout: block.layout });
    } else if (block.type === 'image') {
      const lineStart = text.length;
      images.push({ index: addPlaceholderParagraph(), alt: block.alt, src: block.src, width: block.width, height: block.height });
      if (block.css) paragraphOps.push({ start: abs(lineStart), end: abs(lineStart + 1), css: block.css });
    } else {
      const listStart = text.length;
      for (const item of block.items) {
        const tabs = '\t'.repeat(item.level);
        const contentStart = text.length + tabs.length;
        const plain = addInline(contentStart, item.text);
        text += tabs + plain + '\n';
      }
      listOps.push({ start: abs(listStart), end: abs(text.length), ordered: block.ordered });
    }
  }

  const requests: docs_v1.Schema$Request[] = namedStyleRequests(styleRules, [], tabId);
  const afterBreaks = (index: number): number => index + PAGE_BREAK_PARAGRAPH_LENGTH * breakOffsets.filter((at) => at <= index).length;
  const placed = {
    tables: tables.map((t) => ({ ...t, index: afterBreaks(t.index) })),
    images: images.map((im) => ({ ...im, index: afterBreaks(im.index) })),
  };
  if (!text) return { requests: [...requests, ...pageBreakRequests(pageBreaks(), tabId, segmentId)], text, ...placed };
  const insertedText = opts.endsInExistingParagraphMark ? text.slice(0, -1) : text;
  if (insertedText) {
    requests.push({ insertText: { location: { index: startIndex, tabId, segmentId }, text: insertedText } });
    if (!opts.insertedTextInheritsNoStyling) requests.push(clearDirectRunStyling(startIndex, insertedText.length, tabId, segmentId));
  }
  if (opts.resetParagraphStyles && !opts.insertedTextInheritsNoStyling) {
    requests.push(clearDirectParagraphStyling(startIndex, text.length, tabId, segmentId));
    requests.push({ deleteParagraphBullets: { range: { startIndex, endIndex: startIndex + text.length, tabId, segmentId } } });
  }
  for (const op of paragraphOps) {
    const update = paragraphStyleUpdate(op.css);
    const quoteStyle = op.quote ? QUOTE_PARAGRAPH_STYLE : {};
    const fields = [...(op.namedStyleType ? ['namedStyleType'] : []), ...update.fields, ...(op.quote ? QUOTE_PARAGRAPH_FIELDS : [])];
    if (!fields.length) continue;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: op.start, endIndex: op.end, tabId, segmentId },
        paragraphStyle: { ...update.style, ...quoteStyle, ...(op.namedStyleType ? { namedStyleType: op.namedStyleType } : {}) },
        fields: fields.join(','),
      },
    });
  }
  for (const o of inlineOps) {
    requests.push({ updateTextStyle: { range: { startIndex: o.start, endIndex: o.end, tabId, segmentId }, textStyle: o.textStyle, fields: o.fields.join(',') } });
  }
  const bulletsLastAndDescending = [...listOps].sort((a, b) => b.start - a.start);
  for (const l of bulletsLastAndDescending) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: l.start, endIndex: l.end, tabId, segmentId },
        bulletPreset: l.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  requests.push(...pageBreakRequests(pageBreaks(), tabId, segmentId));
  return { requests, text, ...placed };
}

export function markdownToRequests(markdown: string, startIndex: number, tabId?: string, segmentId?: string, opts: BuildOptions = {}): BuiltContent {
  return buildContentRequests(parseBlocks(markdown), startIndex, tabId, segmentId, opts);
}
