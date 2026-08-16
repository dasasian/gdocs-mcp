import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project } from './transformer.js';
import type { Projection } from './transformer.js';
import { resolveTabId, contentOf, writeControlFor, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { ALIGN_BY_CSS } from './markdown-spec.js';
import { locate, rangeFor, contextAround } from './edit.js';
import { hexToRgb } from './color.js';

export { hexToRgb } from './color.js';

// Style existing text in place, by string anchor — no content change (bet #2 write
// half). Markdown-expressible styling (bold/italic/links) can also be done via
// edit_doc; set_style is for styling text that's already there without re-typing,
// and for Docs-only styling markdown can't express (color, font, size, alignment).
// The target mirrors selecting in Docs: a `from`/`to` anchor pair (or a single
// `from` snippet), or the `whole` document/tab.

export interface FormatStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string; // hex, e.g. "#1a73e8"
  fontSize?: number; // points
  fontFamily?: string;
  link?: string; // url
  align?: 'left' | 'center' | 'right' | 'justify';
  spaceBefore?: number; // points of space above the paragraph
  spaceAfter?: number; // points of space below the paragraph
  lineSpacing?: number; // percent of single spacing (100 = single, 150 = 1.5x)
}

export interface FormatResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'empty' | 'no_segment';
  applied?: string[];
  matches?: { context: string }[];
  message?: string;
}

// Build the textStyle object + its fields mask from the requested style.
export function buildTextStyle(style: FormatStyle): { textStyle: docs_v1.Schema$TextStyle; fields: string[] } {
  const textStyle: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];
  if (style.bold !== undefined) (textStyle.bold = style.bold), fields.push('bold');
  if (style.italic !== undefined) (textStyle.italic = style.italic), fields.push('italic');
  if (style.underline !== undefined) (textStyle.underline = style.underline), fields.push('underline');
  if (style.strikethrough !== undefined) (textStyle.strikethrough = style.strikethrough), fields.push('strikethrough');
  if (style.color !== undefined) {
    textStyle.foregroundColor = { color: { rgbColor: hexToRgb(style.color) } };
    fields.push('foregroundColor');
  }
  if (style.fontSize !== undefined) {
    textStyle.fontSize = { magnitude: style.fontSize, unit: 'PT' };
    fields.push('fontSize');
  }
  if (style.fontFamily !== undefined) {
    textStyle.weightedFontFamily = { fontFamily: style.fontFamily };
    fields.push('weightedFontFamily');
  }
  if (style.link !== undefined) (textStyle.link = { url: style.link }), fields.push('link');
  return { textStyle, fields };
}

// What to style: the whole doc/tab, or a selection from the start of `from` to the
// end of `to` (a single `from` snippet when `to` is omitted).
export type StyleTarget = { whole: true } | { from: string; to?: string };

// Resolve a text anchor uniquely, or return the matching FormatResult error.
function locateUnique(
  proj: Projection,
  anchor: string,
): { start: number; end: number } | FormatResult {
  const { needle, positions } = locate(proj.text, anchor);
  if (positions.length === 0) return { status: 'not_found', message: `"${anchor}" not found.` };
  if (positions.length > 1) {
    return {
      status: 'ambiguous',
      message: `"${anchor}" — ${positions.length} matches; add surrounding context.`,
      matches: positions.map((p) => ({ context: contextAround(proj.text, p, p + needle.length) })),
    };
  }
  return { start: positions[0], end: positions[0] + needle.length };
}

// Resolve a StyleTarget to a plain-text [a,b) offset range, or a FormatResult error.
function resolveRange(proj: Projection, target: StyleTarget): { a: number; b: number } | FormatResult {
  if ('whole' in target) {
    if (proj.text.length === 0) return { status: 'empty', message: 'document has no text to style' };
    return { a: 0, b: proj.text.length };
  }
  const from = locateUnique(proj, target.from);
  if ('status' in from) return from;
  if (target.to === undefined) return { a: from.start, b: from.end };
  const to = locateUnique(proj, target.to);
  if ('status' in to) return to;
  if (to.end <= from.start) return { status: 'not_found', message: '`to` anchor must appear after `from`.' };
  return { a: from.start, b: to.end };
}

// Docs-index ranges of currently-bold text within [lo, hi), across paragraphs and
// table cells. Bold means the `bold` boolean or a heavy font weight (>=700).
function boldSpans(doc: docs_v1.Schema$Document, tabId: string | undefined, lo: number, hi: number, segmentId?: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const walk = (content: docs_v1.Schema$StructuralElement[] | undefined): void => {
    for (const el of content ?? []) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          const tr = pe.textRun;
          if (!tr?.content) continue;
          const weight = tr.textStyle?.weightedFontFamily?.weight ?? 0;
          if (tr.textStyle?.bold !== true && weight < 700) continue;
          const start = Math.max(pe.startIndex ?? 0, lo);
          const end = Math.min(pe.endIndex ?? 0, hi);
          if (end > start) spans.push({ start, end });
        }
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) walk(cell.content ?? undefined);
        }
      }
    }
  };
  walk(contentOf(doc, tabId, segmentId));
  return spans;
}

export async function setStyle(
  clients: GoogleClients,
  documentId: string,
  target: StyleTarget,
  style: FormatStyle,
  opts: { tab?: string; segment?: SegmentKind; page?: SegmentPage } = {},
): Promise<FormatResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const revisionId = res.data.revisionId ?? undefined;
  const tabId = resolveTabId(res.data, opts.tab);
  // With a segment target, `whole` means the whole header/footer, and every
  // range carries its segmentId (#23).
  const seg = await resolveSegmentTarget(clients, documentId, res.data, { segment: opts.segment, page: opts.page, tabId });
  if (seg.error) return { status: 'no_segment', message: seg.error };
  const segmentId = seg.segmentId;
  const proj = project(res.data, tabId, segmentId);

  const resolved = resolveRange(proj, target);
  if ('status' in resolved) return resolved;
  const range = { ...rangeFor(proj, resolved.a, resolved.b), tabId, segmentId };
  const requests: docs_v1.Schema$Request[] = [];
  const applied: string[] = [];

  const { textStyle, fields } = buildTextStyle(style);
  if (fields.length) {
    requests.push({ updateTextStyle: { range, textStyle, fields: fields.join(',') } });
    applied.push(...fields);
  }
  // Paragraph-level properties (alignment + spacing) share one updateParagraphStyle request.
  const paragraphStyle: docs_v1.Schema$ParagraphStyle = {};
  const pFields: string[] = [];
  if (style.align !== undefined) {
    paragraphStyle.alignment = ALIGN_BY_CSS[style.align];
    pFields.push('alignment');
    applied.push('alignment');
  }
  if (style.spaceBefore !== undefined) {
    paragraphStyle.spaceAbove = { magnitude: style.spaceBefore, unit: 'PT' };
    pFields.push('spaceAbove');
    applied.push('spaceBefore');
  }
  if (style.spaceAfter !== undefined) {
    paragraphStyle.spaceBelow = { magnitude: style.spaceAfter, unit: 'PT' };
    pFields.push('spaceBelow');
    applied.push('spaceAfter');
  }
  if (style.lineSpacing !== undefined) {
    paragraphStyle.lineSpacing = style.lineSpacing;
    pFields.push('lineSpacing');
    applied.push('lineSpacing');
  }
  if (pFields.length) {
    requests.push({ updateParagraphStyle: { range, paragraphStyle, fields: pFields.join(',') } });
  }

  // Setting weightedFontFamily clears the `bold` boolean (Docs writes weight:400 and
  // drops bold). When we change the font but the caller didn't ask to change bold,
  // re-assert bold over the spans that were bold, AFTER the font request, so bold
  // survives a font change (esp. whole-document "match the font throughout").
  if (style.fontFamily !== undefined && style.bold === undefined) {
    for (const span of boldSpans(res.data, tabId, range.startIndex!, range.endIndex!, segmentId)) {
      requests.push({ updateTextStyle: { range: { startIndex: span.start, endIndex: span.end, tabId, segmentId }, textStyle: { bold: true }, fields: 'bold' } });
    }
  }

  if (!requests.length) return { status: 'empty', message: 'no style fields provided' };

  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: { requests, writeControl: writeControlFor(revisionId) },
  });
  return { status: 'ok', applied };
}
