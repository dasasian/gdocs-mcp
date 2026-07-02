import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project } from './transformer.js';
import { resolveTabId } from './structure.js';
import { locate, rangeFor, contextAround } from './edit.js';
import { hexToRgb } from './color.js';

export { hexToRgb } from './color.js';

// Style existing text in place, by string anchor — no content change (bet #2 write
// half). Markdown-expressible styling (bold/italic/links) can also be done via
// edit_doc; format_doc is for styling text that's already there without re-typing,
// and for Docs-only styling markdown can't express (color, font, size, alignment).

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
  status: 'ok' | 'not_found' | 'ambiguous' | 'empty';
  applied?: string[];
  matches?: { context: string }[];
  message?: string;
}

const ALIGN: Record<NonNullable<FormatStyle['align']>, string> = {
  left: 'START',
  center: 'CENTER',
  right: 'END',
  justify: 'JUSTIFIED',
};

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

export async function formatDoc(
  clients: GoogleClients,
  documentId: string,
  targetString: string,
  style: FormatStyle,
  opts: { tab?: string } = {},
): Promise<FormatResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const revisionId = res.data.revisionId ?? undefined;
  const tabId = resolveTabId(res.data, opts.tab);
  const proj = project(res.data, tabId);

  const { needle, positions } = locate(proj.text, targetString);
  if (positions.length === 0) return { status: 'not_found', message: `"${targetString}" not found.` };
  if (positions.length > 1) {
    return {
      status: 'ambiguous',
      message: `${positions.length} matches — add surrounding context.`,
      matches: positions.map((p) => ({ context: contextAround(proj.text, p, p + needle.length) })),
    };
  }

  const a = positions[0];
  const range = { ...rangeFor(proj, a, a + needle.length), tabId };
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
    paragraphStyle.alignment = ALIGN[style.align];
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

  if (!requests.length) return { status: 'empty', message: 'no style fields provided' };

  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: { requests, writeControl: revisionId ? { requiredRevisionId: revisionId } : undefined },
  });
  return { status: 'ok', applied };
}
