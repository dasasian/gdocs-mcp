import type { docs_v1 } from 'googleapis';
import {
  ALIGN_BY_CSS,
  PARAGRAPH_CSS_PROPERTIES,
  TEXT_CSS_PROPERTIES,
  NAMED_STYLE_BY_SELECTOR,
  PAGE_BREAK_LINE,
  type CssAlign,
} from './markdown-spec.js';
import { hexToRgb } from './color.js';

export interface ParagraphCss {
  align?: CssAlign;
  /** line-height as a unitless multiple: 1.15 is Docs' 115%. */
  lineHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  /** relative to marginLeft, as in CSS. Docs measures its first-line indent from the page margin. */
  textIndent?: number;
}

export interface TextCss {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
}

export type ParagraphKey = keyof ParagraphCss;
export type TextKey = keyof TextCss;

export interface Parsed<T> {
  css: T;
  issues: string[];
}

export type CssContext = 'paragraph' | 'text' | 'rule';

/** Thrown before any request is sent; `issues` holds one entry per offending line. */
export class StyleSyntaxError extends Error {
  constructor(readonly issues: string[]) {
    super(styleSyntaxMessage(issues));
    this.name = 'StyleSyntaxError';
  }
}

function styleSyntaxMessage(issues: string[]): string {
  const list = issues.map((i) => `  ${i}`).join('\n');
  return [
    `Nothing was written: ${issues.length} style problem${issues.length === 1 ? '' : 's'}.`,
    list,
    `Supported in <p style> and <hN style>: ${PARAGRAPH_CSS_PROPERTIES.join(', ')}.`,
    `Supported in <span style>: ${TEXT_CSS_PROPERTIES.join(', ')}.`,
    `A <style> rule takes both, on the selectors ${Object.keys(NAMED_STYLE_BY_SELECTOR).join(', ')}.`,
    'Lengths are in pt; line-height is a plain number (1.15); colors are #rrggbb.',
    `A <div> or <hr> on its own line is a page break, and only that: ${PAGE_BREAK_LINE}`,
  ].join('\n');
}

const PT = /^(-?\d+(?:\.\d+)?|-?\.\d+)pt$/i;
const PX = /^(-?\d+(?:\.\d+)?)px$/i;
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/i;

const parsePt = (v: string): number | undefined => {
  if (v === '0') return 0;
  const m = PT.exec(v);
  return m ? Number(m[1]) : undefined;
};

type Assign<T> = (value: string, out: T) => string | undefined;

const lengthInto =
  (key: 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight' | 'textIndent'): Assign<ParagraphCss> =>
  (value, out) => {
    const pt = parsePt(value);
    if (pt === undefined) return `${value} is not a length in pt`;
    out[key] = pt;
    return undefined;
  };

const PARAGRAPH_ASSIGN: Record<string, Assign<ParagraphCss>> = {
  'text-align': (value, out) => {
    const v = value.toLowerCase();
    if (!Object.hasOwn(ALIGN_BY_CSS, v)) return `${value} is not left, center, right or justify`;
    out.align = v as CssAlign;
    return undefined;
  },
  'line-height': (value, out) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return `${value} is not a plain number such as 1.15`;
    out.lineHeight = n;
    return undefined;
  },
  'margin-top': lengthInto('marginTop'),
  'margin-bottom': lengthInto('marginBottom'),
  'margin-left': lengthInto('marginLeft'),
  'margin-right': lengthInto('marginRight'),
  'text-indent': lengthInto('textIndent'),
};

const TEXT_ASSIGN: Record<string, Assign<TextCss>> = {
  'font-family': (value, out) => {
    if (value.includes(',')) return 'one font family only';
    out.fontFamily = value.replace(/['"]/g, '').trim();
    return undefined;
  },
  'font-size': (value, out) => {
    const px = PX.exec(value);
    const pt = px ? Math.round(Number(px[1]) * 0.75) : parsePt(value);
    if (pt === undefined) return `${value} is not a length in pt`;
    out.fontSize = pt;
    return undefined;
  },
  'font-weight': (value, out) => {
    const v = value.toLowerCase();
    const weight = v === 'bold' ? 700 : v === 'normal' ? 400 : Number(v);
    if (!Number.isFinite(weight)) return `${value} is not bold, normal or a number`;
    out.bold = weight >= 600;
    return undefined;
  },
  'font-style': (value, out) => {
    const v = value.toLowerCase();
    if (v !== 'italic' && v !== 'normal') return `${value} is not italic or normal`;
    out.italic = v === 'italic';
    return undefined;
  },
  'text-decoration': (value, out) => {
    const tokens = value.toLowerCase().split(/\s+/);
    const known = tokens.every((t) => t === 'none' || t === 'underline' || t === 'line-through');
    if (!known) return `${value} is not none, underline or line-through`;
    out.underline = tokens.includes('underline');
    out.strikethrough = tokens.includes('line-through');
    return undefined;
  },
  color: (value, out) => {
    out.color = value;
    return HEX_COLOR.test(value) || RGB_COLOR.test(value) ? undefined : `${value} is not a #rrggbb color`;
  },
};

function declarationsOf(body: string): { property: string; value: string }[] | string {
  const out: { property: string; value: string }[] = [];
  for (const piece of body.split(';')) {
    const text = piece.trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    if (colon <= 0) return `"${text}" is not a declaration`;
    out.push({ property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim() });
  }
  return out;
}

function parseInto(
  body: string,
  context: CssContext,
  paragraph: ParagraphCss,
  text: TextCss,
): string[] {
  const issues: string[] = [];
  const declarations = declarationsOf(body);
  if (typeof declarations === 'string') return [declarations];
  for (const { property, value } of declarations) {
    const forParagraph = context !== 'text' && Object.hasOwn(PARAGRAPH_ASSIGN, property) ? PARAGRAPH_ASSIGN[property] : undefined;
    const forText = context !== 'paragraph' && Object.hasOwn(TEXT_ASSIGN, property) ? TEXT_ASSIGN[property] : undefined;
    const problem = forParagraph
      ? forParagraph(value, paragraph)
      : forText
        ? forText(value, text)
        : 'not supported here';
    if (problem) issues.push(`${property}: ${problem}`);
  }
  return issues;
}

export function parseParagraphCss(body: string): Parsed<ParagraphCss> {
  const css: ParagraphCss = {};
  return { css, issues: parseInto(body, 'paragraph', css, {}) };
}

export function parseTextCss(body: string): Parsed<TextCss> {
  const css: TextCss = {};
  return { css, issues: parseInto(body, 'text', {}, css) };
}

export function parseRuleCss(body: string): Parsed<{ paragraph: ParagraphCss; text: TextCss }> {
  const paragraph: ParagraphCss = {};
  const text: TextCss = {};
  return { css: { paragraph, text }, issues: parseInto(body, 'rule', paragraph, text) };
}

export function diffCss<T extends object>(before: T, after: T): { set: Partial<T>; cleared: (keyof T)[] } {
  const set: Partial<T> = {};
  const cleared: (keyof T)[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>) {
    if (after[key] === undefined) cleared.push(key);
    else if (before[key] !== after[key]) set[key] = after[key];
  }
  return { set, cleared };
}

const dimension = (pt: number): docs_v1.Schema$Dimension => ({ magnitude: pt, unit: 'PT' });

interface StyleUpdate<S> {
  style: S;
  /** field names relative to the style object; a cleared field is listed without a value. */
  fields: string[];
}

const FIELDS_OF_PARAGRAPH_KEY: Record<ParagraphKey, string[]> = {
  align: ['alignment'],
  lineHeight: ['lineSpacing'],
  marginTop: ['spaceAbove'],
  marginBottom: ['spaceBelow'],
  marginRight: ['indentEnd'],
  marginLeft: ['indentStart', 'indentFirstLine'],
  textIndent: ['indentStart', 'indentFirstLine'],
};

const FIELD_OF_TEXT_KEY: Record<TextKey, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strikethrough',
  color: 'foregroundColor',
  fontSize: 'fontSize',
  fontFamily: 'weightedFontFamily',
};

/**
 * `set` must hold BOTH marginLeft and textIndent whenever either one changed,
 * because Docs stores the pair as indentStart and indentFirstLine and each is
 * written from both. A pair with neither in `set` but one in `cleared` clears both.
 */
export function paragraphStyleUpdate(set: ParagraphCss, cleared: ParagraphKey[] = []): StyleUpdate<docs_v1.Schema$ParagraphStyle> {
  const style: docs_v1.Schema$ParagraphStyle = {};
  const fields: string[] = [];
  if (set.align !== undefined) (style.alignment = ALIGN_BY_CSS[set.align]), fields.push('alignment');
  if (set.lineHeight !== undefined) (style.lineSpacing = Math.round(set.lineHeight * 100)), fields.push('lineSpacing');
  if (set.marginTop !== undefined) (style.spaceAbove = dimension(set.marginTop)), fields.push('spaceAbove');
  if (set.marginBottom !== undefined) (style.spaceBelow = dimension(set.marginBottom)), fields.push('spaceBelow');
  if (set.marginRight !== undefined) (style.indentEnd = dimension(set.marginRight)), fields.push('indentEnd');
  if (set.marginLeft !== undefined || set.textIndent !== undefined) {
    const start = set.marginLeft ?? 0;
    style.indentStart = dimension(start);
    style.indentFirstLine = dimension(start + (set.textIndent ?? 0));
    fields.push('indentStart', 'indentFirstLine');
  }
  for (const key of cleared) {
    for (const field of FIELDS_OF_PARAGRAPH_KEY[key]) if (!fields.includes(field)) fields.push(field);
  }
  return { style, fields };
}

export function textStyleUpdate(set: TextCss, cleared: TextKey[] = []): StyleUpdate<docs_v1.Schema$TextStyle> {
  const style: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];
  if (set.bold !== undefined) (style.bold = set.bold), fields.push('bold');
  if (set.italic !== undefined) (style.italic = set.italic), fields.push('italic');
  if (set.underline !== undefined) (style.underline = set.underline), fields.push('underline');
  if (set.strikethrough !== undefined) (style.strikethrough = set.strikethrough), fields.push('strikethrough');
  if (set.color !== undefined) {
    style.foregroundColor = { color: { rgbColor: hexToRgb(set.color) } };
    fields.push('foregroundColor');
  }
  if (set.fontSize !== undefined) (style.fontSize = dimension(set.fontSize)), fields.push('fontSize');
  if (set.fontFamily !== undefined) {
    style.weightedFontFamily = { fontFamily: set.fontFamily };
    fields.push('weightedFontFamily');
  }
  for (const key of cleared) if (!fields.includes(FIELD_OF_TEXT_KEY[key])) fields.push(FIELD_OF_TEXT_KEY[key]);
  return { style, fields };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pt = (n: number): string => `${round2(n)}pt`;

/** The declarations in the order a reader sees them; `value` never carries the property. */
export function declarationsFor(paragraph: ParagraphCss, text: TextCss = {}): [string, string][] {
  const out: [string, string][] = [];
  if (text.fontFamily !== undefined) out.push(['font-family', text.fontFamily]);
  if (text.fontSize !== undefined) out.push(['font-size', pt(text.fontSize)]);
  if (text.bold !== undefined) out.push(['font-weight', text.bold ? 'bold' : 'normal']);
  if (text.italic !== undefined) out.push(['font-style', text.italic ? 'italic' : 'normal']);
  if (text.underline !== undefined || text.strikethrough !== undefined) {
    const tokens = [text.underline ? 'underline' : '', text.strikethrough ? 'line-through' : ''].filter(Boolean);
    out.push(['text-decoration', tokens.length ? tokens.join(' ') : 'none']);
  }
  if (text.color !== undefined) out.push(['color', text.color]);
  if (paragraph.align !== undefined) out.push(['text-align', paragraph.align]);
  if (paragraph.lineHeight !== undefined) out.push(['line-height', String(round2(paragraph.lineHeight))]);
  if (paragraph.marginTop !== undefined) out.push(['margin-top', pt(paragraph.marginTop)]);
  if (paragraph.marginBottom !== undefined) out.push(['margin-bottom', pt(paragraph.marginBottom)]);
  if (paragraph.marginLeft !== undefined) out.push(['margin-left', pt(paragraph.marginLeft)]);
  if (paragraph.marginRight !== undefined) out.push(['margin-right', pt(paragraph.marginRight)]);
  if (paragraph.textIndent !== undefined) out.push(['text-indent', pt(paragraph.textIndent)]);
  return out;
}

export const styleAttribute = (declarations: [string, string][]): string =>
  declarations.map(([p, v]) => `${p}:${v}`).join('; ');

export const ruleBody = (declarations: [string, string][]): string =>
  declarations.map(([p, v]) => `${p}: ${v}`).join('; ');

const INDENT_PAIR: ParagraphKey[] = ['marginLeft', 'textIndent'];

/** Like diffCss for paragraphs, but keeps marginLeft and textIndent together, which Docs needs. */
export function paragraphCssChange(before: ParagraphCss, after: ParagraphCss): { set: ParagraphCss; cleared: ParagraphKey[] } {
  const { set, cleared } = diffCss(before, after);
  const pairChanged = INDENT_PAIR.some((k) => k in set || cleared.includes(k));
  const pairStillSet = INDENT_PAIR.some((k) => after[k] !== undefined);
  if (!pairChanged || !pairStillSet) return { set, cleared };
  Object.assign(set, Object.fromEntries(INDENT_PAIR.filter((k) => after[k] !== undefined).map((k) => [k, after[k]])));
  return { set, cleared };
}

export function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
