import type { docs_v1 } from 'googleapis';
import { parseInline, segmentTextStyle } from './inline.js';
import { HEADING_BY_LEVEL, ALIGN_BY_CSS } from './markdown-spec.js';

// markdown -> Docs block requests (the inverse of transformer.ts's reader, sharing
// markdown-spec constants). The hard part is sequencing: the Docs API is
// imperative for writes, so we assemble the full plain text, then apply paragraph
// styles + inline styles by absolute index, and createParagraphBullets LAST in
// descending order (it consumes the leading \t used for nesting, which shifts
// indices after it). Tier 1: headings, paragraphs, inline, bullet/ordered lists.

export type CellAlign = 'left' | 'center' | 'right';
export type ParaAlign = 'left' | 'center' | 'right' | 'justify';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string; align?: ParaAlign }
  | { type: 'list'; ordered: boolean; items: { level: number; text: string }[] }
  | { type: 'table'; rows: string[][]; aligns: (CellAlign | null)[] }
  | { type: 'image'; alt: string; src: string; width?: number; height?: number };

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
// A whole line that is a single aligned paragraph, the exact shape read_doc emits
// for non-default alignment: <p style="text-align:center|right|justify">…</p>.
// Parsed back so read->write round-trips (write's counterpart to transformer.ts).
const ALIGNED_P_RE = /^<p style="text-align:(left|center|right|justify)">(.*)<\/p>$/;

const isTableRow = (l: string): boolean => l.trim().startsWith('|');
// A separator line is only dashes/colons/pipes/spaces, with at least one dash.
const isTableSep = (l: string): boolean => l.includes('-') && /^[\s|:-]+$/.test(l.trim());

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
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
  while (i < lines.length && lines[i].trim() !== '' && !HEADING_RE.test(lines[i]) && !LIST_RE.test(lines[i])) {
    para.push(lines[i].trim());
    i++;
  }
  return { block: { type: 'paragraph', text: para.join(' ') }, next: i };
}

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
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
    const h = HEADING_RE.exec(line);
    if (h) {
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
    const ap = ALIGNED_P_RE.exec(line.trim());
    if (ap) {
      blocks.push({ type: 'paragraph', text: ap[2].trim(), align: ap[1] as ParaAlign });
      i++;
      continue;
    }
    const parsed = LIST_RE.test(line) ? parseListAt(lines, i) : parseSoftJoinedParagraphAt(lines, i);
    blocks.push(parsed.block);
    i = parsed.next;
  }
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

const clearDirectRunStyling = (startIndex: number, length: number, tabId?: string, segmentId?: string): docs_v1.Schema$Request => ({
  updateTextStyle: {
    range: { startIndex, endIndex: startIndex + length, tabId, segmentId },
    textStyle: {},
    fields: RESET_TEXT_FIELDS,
  },
});

export function buildContentRequests(blocks: Block[], startIndex: number, tabId?: string, segmentId?: string): BuiltContent {
  let text = '';
  const headingOps: { start: number; end: number; level: number }[] = [];
  const alignOps: { start: number; end: number; align: ParaAlign }[] = [];
  const inlineOps: InlineOp[] = [];
  const listOps: { start: number; end: number; ordered: boolean }[] = [];
  const tables: TablePlacement[] = [];
  const images: ImagePlacement[] = [];
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
      if (block.type === 'heading') {
        headingOps.push({ start: abs(lineStart), end: abs(lineStart + plain.length + 1), level: block.level });
      } else if (block.align) {
        alignOps.push({ start: abs(lineStart), end: abs(lineStart + plain.length + 1), align: block.align });
      }
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

  const requests: docs_v1.Schema$Request[] = [];
  if (!text) return { requests, text, tables, images };
  requests.push({ insertText: { location: { index: startIndex, tabId, segmentId }, text } });
  requests.push(clearDirectRunStyling(startIndex, text.length, tabId, segmentId));
  for (const h of headingOps) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: h.start, endIndex: h.end, tabId, segmentId },
        paragraphStyle: { namedStyleType: HEADING_BY_LEVEL[h.level] },
        fields: 'namedStyleType',
      },
    });
  }
  for (const a of alignOps) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: a.start, endIndex: a.end, tabId, segmentId },
        paragraphStyle: { alignment: ALIGN_BY_CSS[a.align] },
        fields: 'alignment',
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
  return { requests, text, tables, images };
}

export function markdownToRequests(markdown: string, startIndex: number, tabId?: string, segmentId?: string): BuiltContent {
  return buildContentRequests(parseBlocks(markdown), startIndex, tabId, segmentId);
}
