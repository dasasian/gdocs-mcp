import type { docs_v1 } from 'googleapis';
import { parseInline, segmentTextStyle, inlineStyleIssues } from './inline.js';
import { HEADING_BY_LEVEL, NAMED_STYLE_BY_CLASS, type ParagraphClass } from './markdown-spec.js';
import { paragraphStyleUpdate, StyleSyntaxError, type ParagraphCss } from './css.js';
import { splitWrappedLine } from './paragraph-markup.js';
import { parsePageBreakLine } from './page-break.js';
import { parseStyleBlock, namedStyleRequests, type StyleRule } from './style-block.js';

export type CellAlign = 'left' | 'center' | 'right';

type Block =
  | { type: 'heading'; level: number; text: string; css?: ParagraphCss }
  | { type: 'paragraph'; text: string; css?: ParagraphCss; className?: ParagraphClass }
  | { type: 'style'; rules: StyleRule[] }
  | { type: 'list'; ordered: boolean; items: { level: number; text: string }[] }
  | { type: 'table'; rows: string[][]; aligns: (CellAlign | null)[] }
  | { type: 'image'; alt: string; src: string; width?: number; height?: number }
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

const isTableRow = (l: string): boolean => l.trim().startsWith('|');
// A separator line is only dashes/colons/pipes/spaces, with at least one dash.
const isTableSep = (l: string): boolean => l.includes('-') && /^[\s|:-]+$/.test(l.trim());

export const unescapePipes = (cell: string): string => cell.replace(/\\\|/g, '|');

const WRAPPED_CELL_RE = /^<p>([\s\S]*)<\/p>$/i;

/** What a table cell holds before pipes are unescaped: trimmed, unless the whole cell is wrapped in `<p>`, which keeps every space and tab. */
export function cellContent(rawCell: string): string {
  const trimmed = rawCell.trim();
  return WRAPPED_CELL_RE.exec(trimmed)?.[1] ?? trimmed;
}

function splitRow(line: string): string[] {
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

function positiveNumber(v: string | undefined): number | undefined {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseImgTag(line: string): Block | undefined {
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

function parseListAt(lines: string[], from: number): { block: Block; next: number } {
  const ordered = /\d/.test(LIST_RE.exec(lines[from])![2]);
  const items: { level: number; text: string }[] = [];
  let i = from;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) break;
    const indent = m[1].replace(/\t/g, '  ').length;
    items.push({ level: Math.floor(indent / 2), text: m[3].trim() });
    i++;
  }
  return { block: { type: 'list', ordered, items }, next: i };
}

function parseSoftJoinedParagraphAt(lines: string[], from: number): { block: Block; next: number } {
  const para: string[] = [];
  let i = from;
  while (i < lines.length && lines[i].trim() !== '' && !HEADING_RE.test(lines[i]) && !LIST_RE.test(lines[i]) && !parsePageBreakLine(lines[i])) {
    para.push(lines[i].trim());
    i++;
  }
  return { block: { type: 'paragraph', text: para.join(' ') }, next: i };
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

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  const issues: string[] = [];
  const report = (lineIndex: number, found: string[]): void => {
    for (const issue of found) issues.push(`line ${lineIndex + 1}: ${issue}`);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.trim().startsWith('<!--')) {
      i = skipHtmlComment(lines, i);
      continue;
    }
    if (STYLE_OPEN_RE.test(line.trim())) {
      const next = parseStyleBlockAt(lines, i, issues);
      const parsed = parseStyleBlock(lines.slice(i, next).join('\n'), i + 1);
      issues.push(...parsed.issues);
      blocks.push({ type: 'style', rules: parsed.rules });
      i = next;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      report(i, inlineStyleIssues(h[2]));
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    const startsTable = isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]);
    if (startsTable) {
      const t = parseTableAt(lines, i);
      blocks.push(t.block);
      i = t.next;
      continue;
    }
    const img = IMAGE_RE.exec(line.trim());
    if (img) {
      blocks.push({ type: 'image', alt: img[1], src: img[2] });
      i++;
      continue;
    }
    const imgTag = IMG_TAG_RE.test(line.trim()) ? parseImgTag(line.trim()) : undefined;
    if (imgTag) {
      blocks.push(imgTag);
      i++;
      continue;
    }
    const pageBreak = parsePageBreakLine(line);
    if (pageBreak) {
      report(i, pageBreak.issues);
      blocks.push({ type: 'pageBreak' });
      i++;
      continue;
    }
    const wrapped = splitWrappedLine(line);
    if (wrapped) {
      report(i, [...wrapped.issues, ...inlineStyleIssues(wrapped.inner)]);
      const { markup } = wrapped;
      const css = Object.keys(markup.css).length ? markup.css : undefined;
      blocks.push(
        markup.heading
          ? { type: 'heading', level: markup.heading, text: wrapped.inner, css }
          : { type: 'paragraph', text: wrapped.inner, css, className: markup.className },
      );
      i++;
      continue;
    }
    const parsed = LIST_RE.test(line) ? parseListAt(lines, i) : parseSoftJoinedParagraphAt(lines, i);
    for (let n = i; n < parsed.next; n++) report(n, inlineStyleIssues(lines[n]));
    blocks.push(parsed.block);
    i = parsed.next;
  }
  if (issues.length) throw new StyleSyntaxError(issues);
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
}

export interface BuildOptions {
  /** clear the paragraph style the inserted text inherits from where it lands; for a wholesale replace. */
  resetParagraphStyles?: boolean;
  /** false when `startIndex` is inside a paragraph's text, so a page break first in the content follows that text instead of starting a paragraph. Default true. */
  startsParagraph?: boolean;
}

const RESET_PARAGRAPH_FIELDS = [
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
      if (namedStyleType || block.css) {
        paragraphOps.push({ start: abs(lineStart), end: abs(lineStart + plain.length + 1), namedStyleType: namedStyleType || undefined, css: block.css ?? {} });
      }
    } else if (block.type === 'pageBreak') {
      breakOffsets.push(abs(text.length));
    } else if (block.type === 'style') {
      styleRules.push(...block.rules);
    } else if (block.type === 'table') {
      tables.push({ index: addPlaceholderParagraph(), rows: block.rows, aligns: block.aligns });
    } else if (block.type === 'image') {
      images.push({ index: addPlaceholderParagraph(), alt: block.alt, src: block.src, width: block.width, height: block.height });
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
  requests.push({ insertText: { location: { index: startIndex, tabId, segmentId }, text } });
  requests.push(clearDirectRunStyling(startIndex, text.length, tabId, segmentId));
  if (opts.resetParagraphStyles) requests.push(clearDirectParagraphStyling(startIndex, text.length, tabId, segmentId));
  for (const op of paragraphOps) {
    const update = paragraphStyleUpdate(op.css);
    const fields = [...(op.namedStyleType ? ['namedStyleType'] : []), ...update.fields];
    if (!fields.length) continue;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: op.start, endIndex: op.end, tabId, segmentId },
        paragraphStyle: { ...update.style, ...(op.namedStyleType ? { namedStyleType: op.namedStyleType } : {}) },
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
