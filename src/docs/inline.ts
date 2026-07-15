import type { docs_v1 } from 'googleapis';
import { hexToRgb } from './color.js';

// Parse a single level of inline markdown AND inline HTML into styled segments,
// so edit_doc's new_string can carry **bold** / *italic* / ~~strike~~ / `code` /
// [text](url) and <b>/<i>/<u>/<code>/<a href>/<span style="color:…;font-size:…">.
// Non-nested (one level) — good enough for inline content; block constructs go
// through other tools.

export interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  link?: string;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
}

interface Pattern {
  re: RegExp;
  make: (m: RegExpExecArray) => Segment;
}

// Parse a CSS style attribute into the styles we support.
function parseStyleAttr(css: string): Partial<Segment> {
  const out: Partial<Segment> = {};
  const color = /color\s*:\s*([^;]+)/i.exec(css);
  if (color) out.color = color[1].trim();
  const size = /font-size\s*:\s*([\d.]+)\s*(pt|px)?/i.exec(css);
  if (size) out.fontSize = size[2] === 'px' ? Math.round(+size[1] * 0.75) : +size[1];
  const family = /font-family\s*:\s*([^;]+)/i.exec(css);
  if (family) out.fontFamily = family[1].trim().replace(/['"]/g, '');
  return out;
}

// Backslash escapes (CommonMark): a backslash before ASCII punctuation makes that
// char literal; before anything else (e.g. \t) the backslash is literal too. We
// neutralize escapes BEFORE emphasis parsing — position-based interleaving is wrong
// (in `*a\*b*` the italic run starts before the escape, so an escaped `*` would
// still be swallowed). Each `\<punct>` becomes a single private-use sentinel that
// no emphasis pattern can match; decodeEscapes() restores the literal char after.
const ESCAPE_RE = /\\([!-/:-@[-`{-~])/g;
const SENTINEL_LO = 0xe000;
const encodeEscapes = (s: string): string =>
  s.replace(ESCAPE_RE, (_m, c: string) => String.fromCharCode(SENTINEL_LO + c.charCodeAt(0)));
const decodeEscapes = (s: string): string =>
  s.replace(/[\uE000-\uE0FF]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - SENTINEL_LO));

// Order matters: links/HTML and double-markers before single-markers.
const PATTERNS: Pattern[] = [
  // markdown
  { re: /\[([^\]]+)\]\(([^)]+)\)/, make: (m) => ({ text: m[1], link: m[2] }) },
  { re: /\*\*([^*]+)\*\*/, make: (m) => ({ text: m[1], bold: true }) },
  // Underscore-bold with CommonMark word-boundary guards: `\w` (which includes `_`)
  // on either side blocks both intraword emphasis (a__b__c) and long underscore
  // runs used as signature blank lines (____ ____ from soft-joined lines).
  { re: /(?<!\w)__([^_]+)__(?!\w)/, make: (m) => ({ text: m[1], bold: true }) },
  { re: /~~([^~]+)~~/, make: (m) => ({ text: m[1], strikethrough: true }) },
  { re: /\*([^*]+)\*/, make: (m) => ({ text: m[1], italic: true }) },
  { re: /`([^`]+)`/, make: (m) => ({ text: m[1], code: true }) },
  // inline html
  { re: /<(?:b|strong)>(.*?)<\/(?:b|strong)>/i, make: (m) => ({ text: m[1], bold: true }) },
  { re: /<(?:i|em)>(.*?)<\/(?:i|em)>/i, make: (m) => ({ text: m[1], italic: true }) },
  { re: /<u>(.*?)<\/u>/i, make: (m) => ({ text: m[1], underline: true }) },
  { re: /<(?:s|del|strike)>(.*?)<\/(?:s|del|strike)>/i, make: (m) => ({ text: m[1], strikethrough: true }) },
  { re: /<code>(.*?)<\/code>/i, make: (m) => ({ text: m[1], code: true }) },
  // <br> -> an in-paragraph line break (Docs vertical tab U+000B), the write-side
  // counterpart to read emitting <br> for the same char (transformer.ts).
  { re: /<br\s*\/?>/i, make: () => ({ text: '\v' }) },
  { re: /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/i, make: (m) => ({ text: m[2], link: m[1] }) },
  { re: /<span\s+[^>]*style="([^"]*)"[^>]*>(.*?)<\/span>/i, make: (m) => ({ text: m[2], ...parseStyleAttr(m[1]) }) },
];

export function parseInline(input: string): Segment[] {
  const segments: Segment[] = [];
  let rest = encodeEscapes(input);
  while (rest.length) {
    // Find the earliest-starting marker across all patterns.
    let best: { index: number; len: number; seg: Segment } | null = null;
    for (const { re, make } of PATTERNS) {
      const m = new RegExp(re).exec(rest);
      if (m && (best === null || m.index < best.index)) {
        best = { index: m.index, len: m[0].length, seg: make(m) };
      }
    }
    if (!best) {
      segments.push({ text: rest });
      break;
    }
    if (best.index > 0) segments.push({ text: rest.slice(0, best.index) });
    segments.push(best.seg);
    rest = rest.slice(best.index + best.len);
  }
  // Restore escaped punctuation (sentinels) to literal chars in text (and any link url).
  for (const s of segments) {
    s.text = decodeEscapes(s.text);
    if (s.link) s.link = decodeEscapes(s.link);
  }
  return segments.filter((s) => s.text.length > 0);
}

// A segment's textStyle + fields mask. `code` maps to a monospace font (Docs has
// no dedicated inline-code style).
export function segmentTextStyle(seg: Segment): { textStyle: docs_v1.Schema$TextStyle; fields: string[] } {
  const textStyle: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];
  if (seg.bold) (textStyle.bold = true), fields.push('bold');
  if (seg.italic) (textStyle.italic = true), fields.push('italic');
  if (seg.underline) (textStyle.underline = true), fields.push('underline');
  if (seg.strikethrough) (textStyle.strikethrough = true), fields.push('strikethrough');
  if (seg.code || seg.fontFamily) {
    textStyle.weightedFontFamily = { fontFamily: seg.fontFamily ?? 'Courier New' };
    fields.push('weightedFontFamily');
  }
  if (seg.color) {
    textStyle.foregroundColor = { color: { rgbColor: hexToRgb(seg.color) } };
    fields.push('foregroundColor');
  }
  if (seg.fontSize) {
    textStyle.fontSize = { magnitude: seg.fontSize, unit: 'PT' };
    fields.push('fontSize');
  }
  if (seg.link) (textStyle.link = { url: seg.link }), fields.push('link');
  return { textStyle, fields };
}
