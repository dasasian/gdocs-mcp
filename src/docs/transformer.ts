import type { docs_v1 } from 'googleapis';
import { contentOf, listsOf } from './structure.js';
import { LEVEL_BY_HEADING } from './markdown-spec.js';

const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN']);

function isOrderedBullet(
  bullet: docs_v1.Schema$Bullet,
  lists: Record<string, docs_v1.Schema$List>,
): boolean {
  const level = bullet.nestingLevel ?? 0;
  const glyph = bullet.listId ? lists[bullet.listId]?.listProperties?.nestingLevels?.[level]?.glyphType : undefined;
  return glyph ? ORDERED_GLYPHS.has(glyph) : false;
}

// Two outputs from the Docs JSON:
//   1. project()        -> plain text + an index map (plain offset -> Docs index),
//                          the foundation of string-anchored editing (bet #3).
//   2. renderMarkdown() -> markdown + inline HTML for reading (bet #2).
//
// They are intentionally separate: editing matches against clean plain text;
// rendering is for the agent's eyes. Coverage of renderMarkdown is incremental —
// the common cases are handled correctly; tables/images/ordered-lists/color are
// noted TODOs rather than wrong output.

export interface Projection {
  text: string;
  /** map[i] = Docs index (UTF-16 units) of plain-text char i. */
  map: number[];
}

// Docs indices are UTF-16 code units and JS strings are UTF-16, so per-run
// offsets align directly with Docs indices.
export function project(doc: docs_v1.Schema$Document, tabId?: string): Projection {
  let text = '';
  const map: number[] = [];
  for (const el of contentOf(doc, tabId)) {
    for (const pe of el.paragraph?.elements ?? []) {
      const content = pe.textRun?.content;
      if (!content) continue;
      const start = pe.startIndex ?? 0;
      for (let i = 0; i < content.length; i++) {
        text += content[i];
        map.push(start + i);
      }
    }
  }
  return { text, map };
}

export interface RenderOpts {
  /** tracked => wrap suggested runs in <ins>/<del> with their id. */
  tracked?: boolean;
  /** target a specific tab (by id); default first tab / legacy body. */
  tabId?: string;
}

export function renderMarkdown(doc: docs_v1.Schema$Document, opts: RenderOpts = {}): string {
  const lists = listsOf(doc, opts.tabId);
  const blocks: string[] = [];
  let listBuf: string[] = [];
  let lastListId: string | null = null;
  let counters: Record<number, number> = {};
  const flushList = (): void => {
    if (listBuf.length) {
      blocks.push(listBuf.join('\n'));
      listBuf = [];
    }
    lastListId = null;
    counters = {};
  };

  for (const el of contentOf(doc, opts.tabId)) {
    const para = el.paragraph;
    if (!para) {
      flushList();
      if (el.table) blocks.push('<!-- [table omitted — not yet supported] -->');
      continue;
    }
    const line = renderParagraph(para, opts);
    if (para.bullet) {
      const listId = para.bullet.listId ?? null;
      if (listBuf.length && listId !== lastListId) flushList(); // distinct list -> blank line
      lastListId = listId;
      const level = para.bullet.nestingLevel ?? 0;
      const indent = '  '.repeat(level);
      let marker = '-';
      if (isOrderedBullet(para.bullet, lists)) {
        counters[level] = (counters[level] ?? 0) + 1;
        for (const k of Object.keys(counters)) if (Number(k) > level) delete counters[Number(k)];
        marker = `${counters[level]}.`;
      }
      listBuf.push(`${indent}${marker} ${line}`);
    } else {
      flushList();
      blocks.push(line);
    }
  }
  flushList();
  return blocks.join('\n\n');
}

function renderParagraph(para: docs_v1.Schema$Paragraph, opts: RenderOpts): string {
  let inline = '';
  for (const pe of para.elements ?? []) {
    if (pe.textRun) inline += renderRun(pe.textRun, opts);
  }
  inline = inline.replace(/\n$/, ''); // drop the paragraph-mark newline

  const named = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const level = LEVEL_BY_HEADING[named];
  if (level && !para.bullet) {
    return `${'#'.repeat(level)} ${inline}`;
  }

  // Non-default alignment on a normal paragraph -> HTML wrapper (markdown can't).
  const align = para.paragraphStyle?.alignment;
  if (!para.bullet && align && align !== 'START' && align !== 'ALIGNMENT_UNSPECIFIED') {
    const css = align === 'CENTER' ? 'center' : align === 'END' ? 'right' : 'justify';
    return `<p style="text-align:${css}">${inline}</p>`;
  }
  return inline;
}

function renderRun(run: docs_v1.Schema$TextRun, opts: RenderOpts): string {
  let text = run.content ?? '';
  // Preserve a trailing newline through styling by stripping then re-adding.
  const trailingNl = text.endsWith('\n');
  if (trailingNl) text = text.slice(0, -1);
  if (text.length === 0) return trailingNl ? '\n' : '';

  const s = run.textStyle ?? {};
  if (s.link?.url) text = `[${text}](${s.link.url})`;
  if (s.bold) text = `**${text}**`;
  if (s.italic) text = `*${text}*`;
  if (s.strikethrough) text = `~~${text}~~`;
  if (s.underline && !s.link) text = `<u>${text}</u>`;

  if (opts.tracked) {
    const ins = run.suggestedInsertionIds?.[0];
    const del = run.suggestedDeletionIds?.[0];
    if (ins) text = `<ins data-sug="${ins}">${text}</ins>`;
    else if (del) text = `<del data-sug="${del}">${text}</del>`;
  }

  return trailingNl ? `${text}\n` : text;
}
