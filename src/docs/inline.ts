import type { docs_v1 } from 'googleapis';
import { hexToRgb } from './color.js';
import { CODE_FONT } from './markdown-spec.js';

// Parse inline markdown AND inline HTML into styled segments, so edit_doc's
// new_string can carry **bold** / *italic* / ~~strike~~ / `code` / [text](url)
// and <b>/<i>/<u>/<code>/<a href>/<span style="color:…;font-size:…">.
// Containers nest: `<u>**x**</u>` is underlined and bold, because the reader
// emits styles in layers and a round-trip has to survive them (#31). Code spans
// are the exception — their contents are literal by definition. Block
// constructs still go through other tools.

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
  /**
   * Capture group holding markup that may itself be styled, e.g. the `**AAA**`
   * inside `<u>**AAA**</u>`. Those groups are re-parsed and the container's own
   * styles layered on (#31). Omit for a pattern whose content is literal by
   * definition — code spans — or that captures nothing.
   */
  inner?: number;
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
  { re: /\[([^\]]+)\]\(([^)]+)\)/, make: (m) => ({ text: m[1], link: m[2] }), inner: 1 },
  { re: /\*\*([^*]+)\*\*/, make: (m) => ({ text: m[1], bold: true }), inner: 1 },
  // Underscore-bold with CommonMark word-boundary guards: `\w` (which includes `_`)
  // on either side blocks both intraword emphasis (a__b__c) and long underscore
  // runs used as signature blank lines (____ ____ from soft-joined lines).
  { re: /(?<!\w)__([^_]+)__(?!\w)/, make: (m) => ({ text: m[1], bold: true }), inner: 1 },
  { re: /~~([^~]+)~~/, make: (m) => ({ text: m[1], strikethrough: true }), inner: 1 },
  { re: /\*([^*]+)\*/, make: (m) => ({ text: m[1], italic: true }), inner: 1 },
  { re: /`([^`]+)`/, make: (m) => ({ text: m[1], code: true }) },
  // inline html
  { re: /<(?:b|strong)>(.*?)<\/(?:b|strong)>/i, make: (m) => ({ text: m[1], bold: true }), inner: 1 },
  { re: /<(?:i|em)>(.*?)<\/(?:i|em)>/i, make: (m) => ({ text: m[1], italic: true }), inner: 1 },
  { re: /<u>(.*?)<\/u>/i, make: (m) => ({ text: m[1], underline: true }), inner: 1 },
  { re: /<(?:s|del|strike)>(.*?)<\/(?:s|del|strike)>/i, make: (m) => ({ text: m[1], strikethrough: true }), inner: 1 },
  { re: /<code>(.*?)<\/code>/i, make: (m) => ({ text: m[1], code: true }) },
  // <br> -> an in-paragraph line break (Docs vertical tab U+000B), the write-side
  // counterpart to read emitting <br> for the same char (transformer.ts).
  { re: /<br\s*\/?>/i, make: () => ({ text: '\v' }) },
  { re: /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/i, make: (m) => ({ text: m[2], link: m[1] }), inner: 2 },
  { re: /<span\s+[^>]*style="([^"]*)"[^>]*>(.*?)<\/span>/i, make: (m) => ({ text: m[2], ...parseStyleAttr(m[1]) }), inner: 2 },
];

// The walk itself, over already-escape-encoded text. Kept separate from
// parseInline so the recursive step can't re-encode or decode early.
function parseEncoded(input: string): Segment[] {
  const segments: Segment[] = [];
  let rest = input;
  while (rest.length) {
    // Find the earliest-starting marker across all patterns.
    let best: { index: number; len: number; seg: Segment; inner?: string } | null = null;
    for (const { re, make, inner } of PATTERNS) {
      const m = new RegExp(re).exec(rest);
      if (m && (best === null || m.index < best.index)) {
        best = { index: m.index, len: m[0].length, seg: make(m), inner: inner === undefined ? undefined : m[inner] };
      }
    }
    if (!best) {
      segments.push({ text: rest });
      break;
    }
    if (best.index > 0) segments.push({ text: rest.slice(0, best.index) });
    if (best.inner === undefined) {
      segments.push(best.seg);
    } else {
      // A container: re-parse its contents and layer this container's styles
      // underneath each child, so `<u>**AAA**</u>` is underlined AND bold rather
      // than an underlined literal `**AAA**` (#31). The inner match is always
      // shorter than the whole match, so this terminates.
      const { text: _outerText, ...styles } = best.seg;
      for (const child of parseEncoded(best.inner)) segments.push({ ...styles, ...child });
    }
    rest = rest.slice(best.index + best.len);
  }
  return segments;
}

export function parseInline(input: string): Segment[] {
  const segments = parseEncoded(encodeEscapes(input));
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
    textStyle.weightedFontFamily = { fontFamily: seg.fontFamily ?? CODE_FONT };
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
