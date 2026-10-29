import type { docs_v1 } from 'googleapis';
import {
  TABLE_SIDES,
  BORDER_STYLE_BY_DASH,
  DASH_BY_BORDER_STYLE,
  ALIGNMENT_BY_VERTICAL_ALIGN,
  DOCS_DEFAULT_CELL_PADDING_PT,
  DOCS_DEFAULT_BORDER,
  type TableSide,
  type BorderStyle,
  type VerticalAlign,
} from './markdown-spec.js';
import { declarationsOf, parsePt } from './css.js';
import { hexToRgb, rgbToHex } from './color.js';

export type CellProperty = 'background' | 'vertical-align' | `padding-${TableSide}` | `border-${TableSide}`;

export const CELL_PROPERTIES: CellProperty[] = [
  'background',
  ...TABLE_SIDES.map((side) => `border-${side}` as const),
  ...TABLE_SIDES.map((side) => `padding-${side}` as const),
  'vertical-align',
];

/** Canonical strings by longhand property: `#rrggbb`, `0.5pt solid #cccccc`, `5pt`, `middle`. A background of `none` clears one set further out. */
export type CellCss = Partial<Record<CellProperty, string>>;

/** What a cell change is: a value to set, or `null` to put the Docs default back. */
export type CellPatch = Partial<Record<CellProperty, string | null>>;

export type TableElement = 'table' | 'col' | 'tr' | 'td';

export interface ElementCss {
  cell: CellCss;
  /** points; <col> only. */
  width?: number;
  /** points; <tr> only. */
  height?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pt = (n: number): string => `${round2(n)}pt`;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function colorOf(value: string): string | undefined {
  if (HEX.test(value)) return rgbToHex(hexToRgb(value));
  return undefined;
}

const BORDER_STYLES = Object.keys(DASH_BY_BORDER_STYLE);

function borderOf(value: string): string | { problem: string } {
  const tokens = value.trim().toLowerCase().split(/\s+/);
  let width = 1;
  let style: BorderStyle = 'solid';
  let color = '#000000';
  for (const token of tokens) {
    const length = parsePt(token);
    const asColor = colorOf(token);
    if (token === 'none') width = 0;
    else if (BORDER_STYLES.includes(token)) style = token as BorderStyle;
    else if (length !== undefined && length >= 0) width = length;
    else if (asColor) color = asColor;
    else return { problem: `${token} is not a width in pt, solid, dotted, dashed, none or a #rrggbb color` };
  }
  return `${pt(width)} ${style} ${color}`;
}

function paddingsOf(value: string): string[] | { problem: string } {
  const lengths = value.trim().split(/\s+/).map(parsePt);
  if (lengths.length > 4 || lengths.some((l) => l === undefined || l < 0)) return { problem: `${value} is not one to four lengths in pt` };
  const [top, right = top, bottom = top, left = right] = lengths as number[];
  return [top, right, bottom, left].map(pt);
}

const isProblem = (v: unknown): v is { problem: string } => typeof v === 'object' && v !== null && 'problem' in v;

const ALLOWED: Record<TableElement, string[]> = {
  table: [],
  td: [],
  tr: ['height'],
  col: ['width'],
};

/** Reads the style of a <table>, <col>, <tr> or <td>. Every problem is reported; nothing is thrown. */
export function parseElementCss(element: TableElement, body: string): { css: ElementCss; issues: string[] } {
  const css: ElementCss = { cell: {} };
  const issues: string[] = [];
  const declarations = declarationsOf(body);
  if (typeof declarations === 'string') return { css, issues: [declarations] };
  const fail = (property: string, problem: string): void => void issues.push(`<${element} style> ${property}: ${problem}`);
  for (const { property, value } of declarations) {
    const v = value.toLowerCase();
    const sideOf = /^(border|padding)-(top|right|bottom|left)$/.exec(property);
    if (property === 'background' || property === 'background-color') {
      const color = v === 'none' || v === 'transparent' ? 'none' : colorOf(v);
      if (color) css.cell.background = color;
      else fail(property, `${value} is not a #rrggbb color or none`);
    } else if (property === 'vertical-align') {
      if (Object.hasOwn(ALIGNMENT_BY_VERTICAL_ALIGN, v)) css.cell['vertical-align'] = v;
      else fail(property, `${value} is not top, middle or bottom`);
    } else if (property === 'border' || (sideOf && sideOf[1] === 'border')) {
      const border = borderOf(value);
      if (isProblem(border)) fail(property, border.problem);
      else for (const side of sideOf ? [sideOf[2] as TableSide] : TABLE_SIDES) css.cell[`border-${side}`] = border;
    } else if (property === 'padding') {
      const sides = paddingsOf(value);
      if (isProblem(sides)) fail(property, sides.problem);
      else TABLE_SIDES.forEach((side, k) => (css.cell[`padding-${side}`] = sides[k]));
    } else if (sideOf) {
      const length = parsePt(value);
      if (length === undefined || length < 0) fail(property, `${value} is not a length in pt`);
      else css.cell[`padding-${sideOf[2] as TableSide}`] = pt(length);
    } else if (ALLOWED[element].includes(property)) {
      const length = parsePt(value);
      if (length === undefined || length < 0) fail(property, `${value} is not a length in pt`);
      else if (property === 'width') css.width = length;
      else css.height = length;
    } else {
      fail(property, 'not supported here');
    }
  }
  return { css, issues };
}

function collapse(css: CellCss, prefix: 'border' | 'padding'): [string, string][] {
  const values = TABLE_SIDES.map((side) => css[`${prefix}-${side}` as CellProperty]);
  if (values.every((v) => v !== undefined && v === values[0])) return [[prefix, values[0] as string]];
  return TABLE_SIDES.flatMap((side, k) => (values[k] === undefined ? [] : [[`${prefix}-${side}`, values[k] as string] as [string, string]]));
}

/** The declarations in the order a reader sees them. Four equal sides read as the shorthand. */
export function elementDeclarations(css: ElementCss): [string, string][] {
  const out: [string, string][] = [];
  if (css.width !== undefined) out.push(['width', pt(css.width)]);
  if (css.height !== undefined) out.push(['height', pt(css.height)]);
  if (css.cell.background !== undefined) out.push(['background', css.cell.background]);
  out.push(...collapse(css.cell, 'border'), ...collapse(css.cell, 'padding'));
  if (css.cell['vertical-align'] !== undefined) out.push(['vertical-align', css.cell['vertical-align']]);
  return out;
}

export function isDefaultValue(property: CellProperty, value: string): boolean {
  if (property === 'background') return value === 'none';
  if (property === 'vertical-align') return value === 'top';
  if (property.startsWith('padding-')) return value === pt(DOCS_DEFAULT_CELL_PADDING_PT);
  return value === DOCS_DEFAULT_BORDER;
}

export function withoutDefaults(css: CellCss): CellCss {
  return Object.fromEntries(Object.entries(css).filter(([property, value]) => !isDefaultValue(property as CellProperty, value))) as CellCss;
}

const dimension = (n: number): docs_v1.Schema$Dimension => ({ magnitude: n, unit: 'PT' });

const FIELD_OF_PROPERTY = (property: CellProperty): string => {
  if (property === 'background') return 'backgroundColor';
  if (property === 'vertical-align') return 'contentAlignment';
  const [kind, side] = property.split('-');
  return `${kind}${side[0].toUpperCase()}${side.slice(1)}`;
};

function borderStyleOf(value: string): docs_v1.Schema$TableCellBorder {
  const [width, style, color] = value.split(' ');
  return { width: dimension(Number.parseFloat(width)), dashStyle: DASH_BY_BORDER_STYLE[style as BorderStyle], color: { color: { rgbColor: hexToRgb(color) } } };
}

/** The request body for a patch. A reset writes the Docs default out, so reading it back finds the default. */
export function cellStyleUpdate(patch: CellPatch): { style: docs_v1.Schema$TableCellStyle; fields: string[] } {
  const style: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const [key, change] of Object.entries(patch) as [CellProperty, string | null][]) {
    const field = FIELD_OF_PROPERTY(key);
    fields.push(field);
    const value = change ?? defaultOf(key);
    if (key === 'background') {
      if (value !== 'none') style[field] = { color: { rgbColor: hexToRgb(value) } };
    } else if (key === 'vertical-align') style[field] = ALIGNMENT_BY_VERTICAL_ALIGN[value as VerticalAlign];
    else if (key.startsWith('padding-')) style[field] = dimension(Number.parseFloat(value));
    else style[field] = borderStyleOf(value);
  }
  return { style: style as docs_v1.Schema$TableCellStyle, fields };
}

function defaultOf(property: CellProperty): string {
  if (property === 'background') return 'none';
  if (property === 'vertical-align') return 'top';
  if (property.startsWith('padding-')) return pt(DOCS_DEFAULT_CELL_PADDING_PT);
  return DOCS_DEFAULT_BORDER;
}

/** What it takes to turn a cell that looks like `before` into one that looks like `after`. Both are free of defaults. */
export function patchBetween(before: CellCss, after: CellCss): CellPatch {
  const patch: CellPatch = {};
  for (const property of CELL_PROPERTIES) {
    if (before[property] !== after[property]) patch[property] = after[property] ?? null;
  }
  return patch;
}

const ptOf = (d: docs_v1.Schema$Dimension | null | undefined): number | undefined => (d?.magnitude == null ? undefined : round2(d.magnitude));

function borderValueOf(border: docs_v1.Schema$TableCellBorder | null | undefined): string | undefined {
  if (!border || (border.width == null && border.color == null && border.dashStyle == null)) return undefined;
  const style = BORDER_STYLE_BY_DASH[border.dashStyle ?? 'SOLID'] ?? 'solid';
  const color = border.color ? (rgbToHex(border.color.color?.rgbColor ?? undefined) ?? '#000000') : '#000000';
  return `${pt(ptOf(border.width) ?? 0)} ${style} ${color}`;
}

/** The style Docs reports for a cell, as the declarations a reader sees. The Docs defaults, set or not, are left out. */
export function cellCssOfDocs(style: docs_v1.Schema$TableCellStyle | null | undefined): CellCss {
  const css: CellCss = {};
  if (!style) return css;
  const background = rgbToHex(style.backgroundColor?.color?.rgbColor ?? undefined);
  if (background) css.background = background;
  const alignment = Object.entries(ALIGNMENT_BY_VERTICAL_ALIGN).find(([, docs]) => docs === style.contentAlignment)?.[0];
  if (alignment) css['vertical-align'] = alignment;
  for (const side of TABLE_SIDES) {
    const border = borderValueOf(style[`border${side[0].toUpperCase()}${side.slice(1)}` as 'borderTop']);
    if (border) css[`border-${side}`] = border;
    const padding = ptOf(style[`padding${side[0].toUpperCase()}${side.slice(1)}` as 'paddingTop']);
    if (padding !== undefined) css[`padding-${side}`] = pt(padding);
  }
  return withoutDefaults(css);
}
