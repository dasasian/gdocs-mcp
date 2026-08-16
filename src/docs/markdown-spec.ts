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

// Docs named style -> markdown heading level (TITLE renders as H1).
export const LEVEL_BY_HEADING: Record<string, number> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
  TITLE: 1,
};

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
