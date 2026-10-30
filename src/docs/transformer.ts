import type { docs_v1 } from 'googleapis';
import { contentOf, listsOf, inlineObjectsOf } from './structure.js';
import { LEVEL_BY_HEADING, CLASS_BY_NAMED_STYLE, CODE_FONT, PAGE_BREAK_LINE, type CssAlign } from './markdown-spec.js';
import { tableMarkup, tableLayoutOf, type CellReader } from './table-read.js';
import type { TableLayout } from './table-layout.js';
import { declarationsFor, styleAttribute } from './css.js';
import { paragraphCssOf, effectiveStylesFor, type EffectiveStyles } from './style-block.js';
import { rgbToHex } from './color.js';
import { literalTextEscaper, needsParagraphTag, needsQuotedParagraphTag, cellNeedsParagraphTag, type Escaper } from './literal-text.js';
import { hasQuoteBorder } from './quote.js';
import { unescapePipes } from './write.js';

const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN']);

function isOrderedBullet(
  bullet: docs_v1.Schema$Bullet,
  lists: Record<string, docs_v1.Schema$List>,
): boolean {
  const level = bullet.nestingLevel ?? 0;
  const glyph = bullet.listId ? lists[bullet.listId]?.listProperties?.nestingLevels?.[level]?.glyphType : undefined;
  return glyph ? ORDERED_GLYPHS.has(glyph) : false;
}

export interface Projection {
  text: string;
  /** map[i] = Docs index (UTF-16 units) of plain-text char i. */
  map: number[];
}

// Docs indices are UTF-16 code units and JS strings are UTF-16, so per-run
// offsets align directly with Docs indices. Descends into table cells so
// edit_doc can target (and surgically edit) cell text.
export function project(doc: docs_v1.Schema$Document, tabId?: string, segmentId?: string): Projection {
  const chars: string[] = [];
  const map: number[] = [];
  const pushText = (text: string, indexOfChar: (i: number) => number): void => {
    for (let i = 0; i < text.length; i++) {
      chars.push(text[i]);
      map.push(indexOfChar(i));
    }
  };
  const endsLine = (): boolean => chars.length === 0 || chars[chars.length - 1] === '\n';
  const projectParagraph = (paragraph: docs_v1.Schema$Paragraph): void => {
    let afterBreak = false;
    for (const pe of paragraph.elements ?? []) {
      const start = pe.startIndex ?? 0;
      if (pe.pageBreak) {
        if (!endsLine()) pushText('\n', () => start);
        pushText(PAGE_BREAK_LINE, () => start);
        afterBreak = true;
        continue;
      }
      const content = pe.textRun?.content;
      if (!content) continue;
      if (afterBreak && content !== '\n') pushText('\n', () => start - 1);
      afterBreak = false;
      pushText(content, (i) => start + i);
    }
  };
  const walk = (content: docs_v1.Schema$StructuralElement[] | undefined): void => {
    for (const el of content ?? []) {
      if (el.paragraph) {
        projectParagraph(el.paragraph);
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) {
            walk(cell.content ?? undefined);
          }
        }
      }
    }
  };
  walk(contentOf(doc, tabId, segmentId));
  return { text: chars.join(''), map };
}

export interface RenderOpts {
  /** tracked => wrap suggested runs in <ins>/<del> with their id. */
  tracked?: boolean;
  /** target a specific tab (by id); default first tab / legacy body. */
  tabId?: string;
  /** render a header/footer segment instead of the body (#23). */
  segmentId?: string;
}

interface ReadContext {
  doc: docs_v1.Schema$Document;
  opts: RenderOpts;
  lists: Record<string, docs_v1.Schema$List>;
  objects: Record<string, docs_v1.Schema$InlineObject>;
  inTableCell: boolean;
}

function readContextFor(doc: docs_v1.Schema$Document, opts: RenderOpts): ReadContext {
  return { doc, opts, lists: listsOf(doc, opts.tabId), objects: inlineObjectsOf(doc, opts.tabId), inTableCell: false };
}

export function renderMarkdown(doc: docs_v1.Schema$Document, opts: RenderOpts = {}): string {
  return renderBlocks(contentOf(doc, opts.tabId, opts.segmentId), readContextFor(doc, opts)).join('\n\n');
}

/** The markup of one table the way `renderMarkdown` reads it, for an edit that quotes it. */
export function renderTableMarkup(doc: docs_v1.Schema$Document, table: docs_v1.Schema$Table, opts: RenderOpts = {}): string {
  return tableMarkup(table, cellReaderFor(readContextFor(doc, opts)));
}

/** The same table as the HTML form spells it, whether or not it reads as a pipe table. */
export function readTableLayout(doc: docs_v1.Schema$Document, table: docs_v1.Schema$Table, opts: RenderOpts = {}): TableLayout {
  return tableLayoutOf(table, cellReaderFor(readContextFor(doc, opts)));
}

function renderBlocks(content: docs_v1.Schema$StructuralElement[], context: ReadContext): string[] {
  const { lists } = context;
  const blocks: string[] = [];
  let listBuf: string[] = [];
  let lastListId: string | null = null;
  let counters: Record<number, number> = {};
  let endsInQuote = false;
  const flushList = (): void => {
    if (listBuf.length) {
      blocks.push(listBuf.join('\n'));
      listBuf = [];
    }
    lastListId = null;
    counters = {};
  };

  const addParagraph = (para: docs_v1.Schema$Paragraph): void => {
    const line = renderParagraph(para, context);
    if (para.bullet) {
      endsInQuote = false;
      const listId = para.bullet.listId ?? null;
      const startsDistinctList = listBuf.length > 0 && listId !== lastListId;
      if (startsDistinctList) flushList();
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
      if (line === '') return;
      const isQuote = isQuoteParagraph(para, context);
      if (isQuote && endsInQuote) blocks[blocks.length - 1] += `\n>\n${line}`;
      else blocks.push(line);
      endsInQuote = isQuote;
    }
  };

  for (const el of content) {
    if (!el.paragraph) {
      flushList();
      endsInQuote = false;
      if (el.table && !context.inTableCell) blocks.push(renderTableMarkup(context.doc, el.table, context.opts));
      continue;
    }
    for (const piece of splitAtPageBreaks(el.paragraph)) {
      if (piece === PAGE_BREAK) {
        flushList();
        endsInQuote = false;
        blocks.push(PAGE_BREAK_LINE);
      } else {
        addParagraph(piece);
      }
    }
  }
  flushList();
  return blocks;
}

const PAGE_BREAK = Symbol('page break');

const holdsContent = (elements: docs_v1.Schema$ParagraphElement[]): boolean =>
  elements.some((pe) => (pe.textRun ? withoutParagraphMark(pe.textRun.content ?? '') !== '' : !pe.pageBreak));

function splitAtPageBreaks(para: docs_v1.Schema$Paragraph): (docs_v1.Schema$Paragraph | typeof PAGE_BREAK)[] {
  const elements = para.elements ?? [];
  if (!elements.some((pe) => pe.pageBreak)) return [para];
  const pieces: (docs_v1.Schema$Paragraph | typeof PAGE_BREAK)[] = [];
  let run: docs_v1.Schema$ParagraphElement[] = [];
  const closeRun = (): void => {
    if (holdsContent(run)) pieces.push({ ...para, elements: run });
    run = [];
  };
  for (const pe of elements) {
    if (pe.pageBreak) {
      closeRun();
      pieces.push(PAGE_BREAK);
    } else {
      run.push(pe);
    }
  }
  closeRun();
  return pieces;
}

function renderImage(objectId: string, objects: Record<string, docs_v1.Schema$InlineObject>): string {
  const eo = objects[objectId]?.inlineObjectProperties?.embeddedObject ?? {};
  const attrs = [`src="image:${objectId}"`];
  const alt = eo.title || eo.description;
  if (alt) attrs.push(`alt="${escapeAttr(alt)}"`);
  const w = eo.size?.width?.magnitude;
  const h = eo.size?.height?.magnitude;
  if (w) attrs.push(`width="${round2(w)}"`);
  if (h) attrs.push(`height="${round2(h)}"`);
  return `<img ${attrs.join(' ')}>`;
}

const DOCS_AUTOMATIC_LINK_COLOR = '#1155cc';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const withoutParagraphMark = (s: string): string => s.replace(/\n$/, '');
const lineBreaksAsBr = (s: string): string => s.replace(/\x0b/g, '<br>');

const DOCS_TABLE_CELL_LINE_SPACING = 100;

const inCellLineSpacing = (style: docs_v1.Schema$NamedStyle | undefined): docs_v1.Schema$NamedStyle | undefined =>
  style && { ...style, paragraphStyle: { ...style.paragraphStyle, lineSpacing: DOCS_TABLE_CELL_LINE_SPACING } };

function baselineStyles(context: ReadContext, namedStyleType: string): EffectiveStyles {
  const styles = effectiveStylesFor(context.doc, namedStyleType, context.opts.tabId);
  return context.inTableCell ? { named: inCellLineSpacing(styles.named), normal: inCellLineSpacing(styles.normal) } : styles;
}

const escapeTableTags =(text: string): string =>
  text.replace(/(\\*)<(?=\/?(?:table|thead|tbody|tr|td|th|col|p|h[1-6])\b)/gi, (whole, slashes: string) => (slashes.length % 2 === 1 ? whole : `${slashes}\\<`));

const PLAIN_CODE_RUN_FIELDS = ['bold', 'italic', 'underline', 'strikethrough', 'link', 'foregroundColor', 'backgroundColor', 'fontSize', 'baselineOffset', 'smallCaps'] as const;

const isPlainCodeRun = (run: docs_v1.Schema$TextRun): boolean => {
  const style = run.textStyle ?? {};
  return style.weightedFontFamily?.fontFamily === CODE_FONT && PLAIN_CODE_RUN_FIELDS.every((field) => !style[field]) && !run.suggestedInsertionIds?.length && !run.suggestedDeletionIds?.length;
};

const hasOnlyQuoteOverrides = (para: docs_v1.Schema$Paragraph, context: ReadContext): boolean => {
  const { marginLeft: _indent, textIndent: _firstLine, ...other } = paragraphCssOf(para.paragraphStyle, baselineStyles(context, 'NORMAL_TEXT'));
  return Object.keys(other).length === 0;
};

function isQuoteParagraph(para: docs_v1.Schema$Paragraph, context: ReadContext): boolean {
  const named = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  return !para.bullet && named === 'NORMAL_TEXT' && hasQuoteBorder(para.paragraphStyle) && hasOnlyQuoteOverrides(para, context);
}

/** The text of a paragraph that is Courier New throughout, line breaks as newlines. In a table cell only one with a line break counts, so a cell holding `code` stays inline. */
function codeParagraphText(para: docs_v1.Schema$Paragraph, context: ReadContext): string | undefined {
  const named = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const elements = para.elements ?? [];
  if (para.bullet || named !== 'NORMAL_TEXT' || elements.some((pe) => !pe.textRun) || hasQuoteBorder(para.paragraphStyle)) return undefined;
  if (Object.keys(paragraphCssOf(para.paragraphStyle, baselineStyles(context, named))).length > 0) return undefined;
  const runs = elements.flatMap((pe) => (pe.textRun ? [pe.textRun] : []));
  const text = runs.map((run) => run.content ?? '').join('').replace(/\n$/, '');
  const codeRuns = runs.filter((run) => withoutParagraphMark(run.content ?? '') !== '');
  if (text === '' || !codeRuns.every(isPlainCodeRun)) return undefined;
  if (context.inTableCell && (!text.includes('\x0b') || escapeTableTags(text) !== text)) return undefined;
  return text.replace(/\x0b/g, '\n');
}

function fencedCode(code: string): string {
  const longestBacktickRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${code}\n${fence}`;
}

function renderParagraph(para: docs_v1.Schema$Paragraph, context: ReadContext): string {
  const { opts, objects } = context;
  const code = codeParagraphText(para, context);
  if (code !== undefined) return fencedCode(code);
  const named = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const eff = baselineStyles(context, named);
  const paragraphFamily = eff.named?.textStyle?.weightedFontFamily?.fontFamily ?? eff.normal?.textStyle?.weightedFontFamily?.fontFamily ?? undefined;
  const inlineWith = (escape: Escaper): string => {
    const safe: Escaper = context.inTableCell ? (text) => escapeTableTags(escape(text)) : escape;
    let joined = '';
    for (const pe of para.elements ?? []) {
      if (pe.textRun) joined += renderRun(pe.textRun, opts, paragraphFamily, safe);
      else if (pe.inlineObjectElement?.inlineObjectId && !context.inTableCell) {
        joined += renderImage(pe.inlineObjectElement.inlineObjectId, objects);
      }
    }
    return lineBreaksAsBr(withoutParagraphMark(joined));
  };
  const literalText = (para.elements ?? []).map((pe) => pe.textRun?.content ?? '').join('');
  const inline = inlineWith(literalTextEscaper(literalText, inlineWith));
  if (para.bullet) return inline;
  const level = LEVEL_BY_HEADING[para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT'];
  if (inline === '') return level ? `${'#'.repeat(level)} ` : '';
  if (isQuoteParagraph(para, context)) return needsQuotedParagraphTag(inline) ? `> <p>${inline}</p>` : `> ${inline}`;

  const overrides = paragraphCssOf(para.paragraphStyle, eff);
  const style = styleAttribute(declarationsFor(overrides));
  const styleAttr = style ? ` style="${style}"` : '';
  if (level) return style ? `<h${level}${styleAttr}>${inline}</h${level}>` : `${'#'.repeat(level)} ${inline}`;
  const className = CLASS_BY_NAMED_STYLE[named as keyof typeof CLASS_BY_NAMED_STYLE];
  if (className) return `<p class="${className}"${styleAttr}>${inline}</p>`;
  const holdsImage = !context.inTableCell && (para.elements ?? []).some((pe) => pe.inlineObjectElement);
  if (style || (!holdsImage && needsParagraphTag(inline))) return `<p${styleAttr}>${inline}</p>`;
  return inline;
}

const textRunsOf = (cell: docs_v1.Schema$TableCell): docs_v1.Schema$TextRun[] =>
  (cell.content ?? []).flatMap((el) => el.paragraph?.elements ?? []).flatMap((pe) => (pe.textRun ? [pe.textRun] : []));

function plainAlignmentOf(cell: docs_v1.Schema$TableCell, context: ReadContext): CssAlign | null | undefined {
  const content = cell.content ?? [];
  const paragraphs = content.flatMap((el) => (el.paragraph ? [el.paragraph] : []));
  if (paragraphs.length !== 1 || content.some((el) => el.table)) return undefined;
  const [paragraph] = paragraphs;
  if (codeParagraphText(paragraph, context) !== undefined) return undefined;
  const named = paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  if (paragraph.bullet || named !== 'NORMAL_TEXT') return undefined;
  const { align, ...other } = paragraphCssOf(paragraph.paragraphStyle, baselineStyles(context, named));
  return Object.keys(other).length ? undefined : (align ?? null);
}

/** In a tracked read, an empty cell of a suggested row or column has no text to tag, so it is marked by its own suggestion. */
function trackedEmptyCell(cell: docs_v1.Schema$TableCell, context: ReadContext): string {
  const inserted = cell.suggestedInsertionIds?.[0];
  const deleted = cell.suggestedDeletionIds?.[0];
  if (!context.opts.tracked) return '';
  if (inserted) return `<ins data-sug="${inserted}"></ins>`;
  return deleted ? `<del data-sug="${deleted}"></del>` : '';
}

function pipeCellText(cell: docs_v1.Schema$TableCell, context: ReadContext): string {
  const runs = textRunsOf(cell);
  const inlineWith = (escape: Escaper): string => {
    const escapeWithPipes: Escaper = (text) => escape(text).replace(/\|/g, '\\|');
    return lineBreaksAsBr(withoutParagraphMark(runs.map((run) => renderRun(run, context.opts, undefined, escapeWithPipes)).join('')));
  };
  const literalText = runs.map((run) => run.content ?? '').join('').replace(/\|/g, '');
  const inline = inlineWith(literalTextEscaper(literalText, inlineWith, unescapePipes)) || trackedEmptyCell(cell, context);
  return cellNeedsParagraphTag(inline) ? `<p>${inline}</p>` : inline;
}

function htmlCellText(cell: docs_v1.Schema$TableCell, context: ReadContext): string {
  const runs = textRunsOf(cell);
  const inlineWith = (escape: Escaper): string =>
    lineBreaksAsBr(withoutParagraphMark(runs.map((run) => renderRun(run, context.opts, undefined, (text) => escapeTableTags(escape(text)))).join('')));
  const inline = inlineWith(literalTextEscaper(runs.map((run) => run.content ?? '').join(''), inlineWith)) || trackedEmptyCell(cell, context);
  return cellNeedsParagraphTag(inline) || inline.startsWith('>') ? `<p>${inline}</p>` : inline;
}

function cellReaderFor(context: ReadContext): CellReader {
  const inCell: ReadContext = { ...context, inTableCell: true };
  return {
    plainAlignment: (cell) => plainAlignmentOf(cell, inCell),
    inPipeRow: (cell) => pipeCellText(cell, context),
    inHtmlRow: (cell) => htmlCellText(cell, context),
    asBlocks: (cell) => renderBlocks(cell.content ?? [], inCell).join('\n\n'),
  };
}

function spanCssFor(s: docs_v1.Schema$TextStyle, isCode: boolean, paragraphFamily?: string): string[] {
  const css: string[] = [];
  const color = rgbToHex(s.foregroundColor?.color?.rgbColor ?? undefined);
  const isDefaultLinkBlue = !!s.link?.url && color === DOCS_AUTOMATIC_LINK_COLOR;
  if (color && !isDefaultLinkBlue) css.push(`color:${color}`);
  if (s.fontSize?.magnitude) css.push(`font-size:${s.fontSize.magnitude}pt`);
  const family = s.weightedFontFamily?.fontFamily ?? undefined;
  if (family && !isCode && family !== paragraphFamily) css.push(`font-family:${family}`);
  return css;
}

function wrapEmphasis(text: string, s: docs_v1.Schema$TextStyle, isCode: boolean): string {
  let out = text;
  if (isCode) out = `\`${out}\``;
  if (s.link?.url) out = `[${out}](${s.link.url})`;
  if (s.bold) out = `**${out}**`;
  if (s.italic) out = `*${out}*`;
  if (s.strikethrough) out = `~~${out}~~`;
  if (s.underline && !s.link) out = `<u>${out}</u>`;
  return out;
}

function renderRun(run: docs_v1.Schema$TextRun, opts: RenderOpts, paragraphFamily: string | undefined, escape: Escaper): string {
  let text = run.content ?? '';
  const trailingNl = text.endsWith('\n');
  if (trailingNl) text = text.slice(0, -1);
  if (text.length === 0) return trailingNl ? '\n' : '';

  const s = run.textStyle ?? {};
  const isCode = s.weightedFontFamily?.fontFamily === CODE_FONT;
  text = wrapEmphasis(escape(text), s, isCode);
  const css = spanCssFor(s, isCode, paragraphFamily);
  if (css.length) text = `<span style="${css.join(';')}">${text}</span>`;

  if (opts.tracked) {
    const ins = run.suggestedInsertionIds?.[0];
    const del = run.suggestedDeletionIds?.[0];
    if (ins) text = `<ins data-sug="${ins}">${text}</ins>`;
    else if (del) text = `<del data-sug="${del}">${text}</del>`;
  }

  return trailingNl ? `${text}\n` : text;
}
