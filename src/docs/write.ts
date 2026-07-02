import type { docs_v1 } from 'googleapis';
import { parseInline, segmentTextStyle } from './inline.js';
import { HEADING_BY_LEVEL } from './markdown-spec.js';

// markdown -> Docs block requests (the inverse of transformer.ts's reader, sharing
// markdown-spec constants). The hard part is sequencing: the Docs API is
// imperative for writes, so we assemble the full plain text, then apply paragraph
// styles + inline styles by absolute index, and createParagraphBullets LAST in
// descending order (it consumes the leading \t used for nesting, which shifts
// indices after it). Tier 1: headings, paragraphs, inline, bullet/ordered lists.

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: { level: number; text: string }[] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

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
    const h = HEADING_RE.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
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

// Build the requests to render `blocks` starting at `startIndex` (within `tabId`).
export function buildContentRequests(
  blocks: Block[],
  startIndex: number,
  tabId?: string,
): { requests: docs_v1.Schema$Request[]; text: string } {
  let text = '';
  const headingOps: { start: number; end: number; level: number }[] = [];
  const inlineOps: InlineOp[] = [];
  const listOps: { start: number; end: number; ordered: boolean }[] = [];
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
      }
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
  if (!text) return { requests, text };
  requests.push({ insertText: { location: { index: startIndex, tabId }, text } });
  for (const h of headingOps) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: h.start, endIndex: h.end, tabId },
        paragraphStyle: { namedStyleType: HEADING_BY_LEVEL[h.level] },
        fields: 'namedStyleType',
      },
    });
  }
  for (const o of inlineOps) {
    requests.push({ updateTextStyle: { range: { startIndex: o.start, endIndex: o.end, tabId }, textStyle: o.textStyle, fields: o.fields.join(',') } });
  }
  // Bullets last, descending — they consume leading \t and shift later indices.
  for (const l of [...listOps].sort((a, b) => b.start - a.start)) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: l.start, endIndex: l.end, tabId },
        bulletPreset: l.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  return { requests, text };
}

export function markdownToRequests(
  markdown: string,
  startIndex: number,
  tabId?: string,
): { requests: docs_v1.Schema$Request[]; text: string } {
  return buildContentRequests(parseBlocks(markdown), startIndex, tabId);
}
