import type { docs_v1 } from 'googleapis';
import { parseInline, segmentTextStyle } from './inline.js';
import { HEADING_BY_LEVEL } from './markdown-spec.js';

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
  | { type: 'image'; alt: string; src: string };

// Docs paragraph alignment enum, keyed by the CSS value read (transformer.ts) emits.
const PARA_ALIGN: Record<ParaAlign, string> = { left: 'START', center: 'CENTER', right: 'END', justify: 'JUSTIFIED' };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
// A whole line that is just an image: ![alt](src), with an optional trailing
// HTML comment (e.g. gdocs tracking metadata) that we ignore.
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*(?:<!--.*?-->)?\s*$/;
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
    // Skip HTML comments (standalone line or block) — used for tracking metadata,
    // not document content, so they must not render into the Doc.
    if (line.trim().startsWith('<!--')) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++; // consume the closing line
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    // Table: a row line immediately followed by a separator line.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = parseAligns(lines[i + 1]);
      i += 2; // consume header + separator
      const body: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        body.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', rows: [header, ...body], aligns });
      continue;
    }
    const img = IMAGE_RE.exec(line.trim());
    if (img) {
      blocks.push({ type: 'image', alt: img[1], src: img[2] });
      i++;
      continue;
    }
    // Aligned paragraph (read_doc's <p style="text-align:…"> output) — matched
    // before the plain-paragraph fallback so it isn't treated as literal text.
    const ap = ALIGNED_P_RE.exec(line.trim());
    if (ap) {
      blocks.push({ type: 'paragraph', text: ap[2].trim(), align: ap[1] as ParaAlign });
      i++;
      continue;
    }
    if (LIST_RE.test(line)) {
      const first = LIST_RE.exec(line)!;
      const ordered = /\d/.test(first[2]);
      const items: { level: number; text: string }[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        const indent = m[1].replace(/\t/g, '  ').length;
        items.push({ level: Math.floor(indent / 2), text: m[3].trim() });
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    // paragraph: consecutive plain lines, soft-joined.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !HEADING_RE.test(lines[i]) && !LIST_RE.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.join(' ') });
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
}

export interface BuiltContent {
  requests: docs_v1.Schema$Request[];
  text: string;
  tables: TablePlacement[];
  images: ImagePlacement[];
}

// Build the requests to render `blocks` starting at `startIndex` (within `tabId`).
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
      // Placeholder paragraph where the table will be inserted; also serves as the
      // trailing paragraph a table needs.
      tables.push({ index: abs(text.length), rows: block.rows, aligns: block.aligns });
      text += '\n';
    } else if (block.type === 'image') {
      images.push({ index: abs(text.length), alt: block.alt, src: block.src });
      text += '\n';
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
        paragraphStyle: { alignment: PARA_ALIGN[a.align] },
        fields: 'alignment',
      },
    });
  }
  for (const o of inlineOps) {
    requests.push({ updateTextStyle: { range: { startIndex: o.start, endIndex: o.end, tabId, segmentId }, textStyle: o.textStyle, fields: o.fields.join(',') } });
  }
  // Bullets last, descending — they consume leading \t and shift later indices.
  for (const l of [...listOps].sort((a, b) => b.start - a.start)) {
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
