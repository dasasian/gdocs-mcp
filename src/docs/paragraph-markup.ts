import {
  NAMED_STYLE_BY_CLASS,
  CLASS_BY_NAMED_STYLE,
  type ParagraphClass,
} from './markdown-spec.js';
import { parseParagraphCss, type ParagraphCss } from './css.js';

export interface ParagraphMarkup {
  /** 1-6 for an <hN> tag. */
  heading?: number;
  className?: ParagraphClass;
  css: ParagraphCss;
}

export interface ParagraphLine {
  markup?: ParagraphMarkup;
  issues: string[];
  /** the line with its wrapper tags removed. */
  inner: string;
}

export type WrappedLine = ParagraphLine & { markup: ParagraphMarkup };

const ATTR_RE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
const WRAPPED_LINE_RE = /^<(p|h[1-6])((?:\s[^>]*)?)>(.*)<\/\1\s*>$/i;
const OPEN_TAG_RE = /^\s*<(p|h[1-6])((?:\s[^>]*)?)>/i;
const CLOSE_TAG_RE = /<\/(?:p|h[1-6])\s*>\s*$/i;

function markupFor(tag: string, attrs: string): { markup: ParagraphMarkup; issues: string[] } {
  const name = tag.toLowerCase();
  const markup: ParagraphMarkup = { css: {} };
  const issues: string[] = [];
  if (name !== 'p') markup.heading = Number(name.slice(1));
  for (const [, attr, value] of attrs.matchAll(ATTR_RE)) {
    if (attr.toLowerCase() === 'style') {
      const parsed = parseParagraphCss(value);
      markup.css = parsed.css;
      issues.push(...parsed.issues.map((i) => `<${name} style> ${i}`));
    } else if (attr.toLowerCase() === 'class' && name === 'p' && Object.hasOwn(NAMED_STYLE_BY_CLASS, value)) {
      markup.className = value as ParagraphClass;
    } else if (attr.toLowerCase() === 'class') {
      const known = Object.values(CLASS_BY_NAMED_STYLE).join(', ');
      issues.push(`<${name} class="${value}"> is not supported (${name === 'p' ? `classes: ${known}` : 'headings take no class'})`);
    } else {
      issues.push(`<${name} ${attr}=…> is not supported (only style, and class on <p>)`);
    }
  }
  return { markup, issues };
}

/** A whole line that is one wrapped paragraph, the shape read_doc emits. */
export function splitWrappedLine(line: string): WrappedLine | undefined {
  const m = WRAPPED_LINE_RE.exec(line.trim());
  if (!m) return undefined;
  const { markup, issues } = markupFor(m[1], m[2]);
  return { markup, issues, inner: m[3] };
}

/** A line of an edit_doc string: the closing tag is optional, since an anchor can stop mid-paragraph. */
export function splitEditLine(line: string): ParagraphLine {
  const open = OPEN_TAG_RE.exec(line);
  if (!open) return { issues: [], inner: line.replace(CLOSE_TAG_RE, '') };
  const { markup, issues } = markupFor(open[1], open[2]);
  return { markup, issues, inner: line.slice(open[0].length).replace(CLOSE_TAG_RE, '') };
}
