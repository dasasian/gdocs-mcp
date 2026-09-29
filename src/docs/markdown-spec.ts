// Shared mapping constants for the markdown<->Docs pair. Both the reader
// (transformer.ts, Docs->md) and the writer (write.ts, md->Docs) import these so
// the two directions can't drift. Round-trip tests are the other half of the
// guarantee. (We deliberately do NOT build a bidirectional "spec engine" — the
// two directions have different mechanics; sharing the small tables is enough.)

// level (1..6) -> Docs named style. Index 0 unused.
export const HEADING_BY_LEVEL = [
  '',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
] as const;

// Docs named style -> markdown heading level. TITLE and SUBTITLE are not here:
// HTML has no tag for them, so they read as <p class="title"> (CLASS_BY_NAMED_STYLE).
export const LEVEL_BY_HEADING: Record<string, number> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

// The two named styles HTML has no tag for, and the class that stands for each.
export const CLASS_BY_NAMED_STYLE = {
  TITLE: 'title',
  SUBTITLE: 'subtitle',
} as const;

export type ParagraphClass = (typeof CLASS_BY_NAMED_STYLE)[keyof typeof CLASS_BY_NAMED_STYLE];

export const NAMED_STYLE_BY_CLASS: Record<ParagraphClass, 'TITLE' | 'SUBTITLE'> = {
  title: 'TITLE',
  subtitle: 'SUBTITLE',
};

// CSS selector in the <style> block -> the Docs named style it edits, in the
// order the block lists them.
export const NAMED_STYLE_BY_SELECTOR = {
  p: 'NORMAL_TEXT',
  h1: 'HEADING_1',
  h2: 'HEADING_2',
  h3: 'HEADING_3',
  h4: 'HEADING_4',
  h5: 'HEADING_5',
  h6: 'HEADING_6',
  '.title': 'TITLE',
  '.subtitle': 'SUBTITLE',
} as const;

export type RuleSelector = keyof typeof NAMED_STYLE_BY_SELECTOR;

// The whole CSS vocabulary, and the only place it is listed. Reader and writer
// both work from these, and an unsupported property is an error that names them.
// Lengths are pt. text-indent is relative to margin-left, as in CSS.
export const PARAGRAPH_CSS_PROPERTIES = [
  'text-align',
  'line-height',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'text-indent',
] as const;

export const TEXT_CSS_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'color',
] as const;

// CSS text-align value (what the reader emits and the writer parses) -> Docs
// paragraph alignment enum. Every caller that needs a subset just indexes in.
export const ALIGN_BY_CSS = {
  left: 'START',
  center: 'CENTER',
  right: 'END',
  justify: 'JUSTIFIED',
} as const;

export type CssAlign = keyof typeof ALIGN_BY_CSS;

// Docs paragraph alignment enum -> CSS value. START is the default and is
// deliberately absent, so the reader can skip emitting a wrapper for it.
export const CSS_BY_ALIGN: Record<string, CssAlign> = {
  CENTER: 'center',
  END: 'right',
  JUSTIFIED: 'justify',
};

// Docs has no inline-code style, so `code` maps to a monospace font. The reader
// maps it back, which is what makes `` `x` `` survive a round-trip — keep the
// two directions on this one constant.
export const CODE_FONT = 'Courier New';
