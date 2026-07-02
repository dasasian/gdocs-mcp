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
