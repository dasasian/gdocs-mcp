import type { docs_v1 } from 'googleapis';
import { declarationsFor, paragraphCssChange, styleAttribute, type ParagraphCss, type TextCss } from './css.js';
import { paragraphCssOf, type EffectiveStyles } from './style-block.js';
import { rgbToHex } from './color.js';

// A suggested format change ("Format: …" in Docs) changes no text, so it has no
// <ins>/<del>. Docs returns it beside the current style: `suggestedTextStyleChanges`
// on a run and `suggestedParagraphStyleChanges` on a paragraph, each keyed by
// suggestion id, holding a proposed style and a `<field>Suggested` flag for every field
// the suggestion sets. A flagged field the proposed style leaves out is one it clears
// (checked live). A tracked read shows each one as the CSS accepting it would set,
// in the vocabulary `style="…"` uses, with `inherit` for a value it clears back to
// the named style's.

const SUGGESTED_FLAG = /^(.+)Suggested$/;

/** The style as it would be if the suggestion were accepted on its own: each flagged field taken from the proposed style. */
function withSuggestion<S extends object>(current: S, proposed: S | undefined, state: object | undefined): S {
  const out = { ...current } as Record<string, unknown>;
  for (const [flag, on] of Object.entries(state ?? {})) {
    const field = SUGGESTED_FLAG.exec(flag)?.[1];
    if (!on || !field) continue;
    const value = (proposed as Record<string, unknown> | undefined)?.[field];
    if (value === undefined || value === null) delete out[field];
    else out[field] = value;
  }
  return out as S;
}

const textCssOf = (s: docs_v1.Schema$TextStyle): TextCss => ({
  bold: !!s.bold,
  italic: !!s.italic,
  underline: !!s.underline,
  strikethrough: !!s.strikethrough,
  color: rgbToHex(s.foregroundColor?.color?.rgbColor ?? undefined),
  fontSize: s.fontSize?.magnitude ?? undefined,
  fontFamily: s.weightedFontFamily?.fontFamily ?? undefined,
});

const DECORATION: (keyof TextCss)[] = ['underline', 'strikethrough'];

/** The CSS property each key is written as, in the order `declarationsFor` writes them. */
const PROPERTY_OF_KEY: Record<keyof TextCss | keyof ParagraphCss, string> = {
  fontFamily: 'font-family',
  fontSize: 'font-size',
  bold: 'font-weight',
  italic: 'font-style',
  underline: 'text-decoration',
  strikethrough: 'text-decoration',
  color: 'color',
  align: 'text-align',
  lineHeight: 'line-height',
  marginTop: 'margin-top',
  marginBottom: 'margin-bottom',
  marginLeft: 'margin-left',
  marginRight: 'margin-right',
  textIndent: 'text-indent',
};
const PROPERTY_ORDER = Object.values(PROPERTY_OF_KEY);

function cssText(declarations: [string, string][], cleared: (keyof TextCss | keyof ParagraphCss)[]): string {
  const all: [string, string][] = [...declarations, ...cleared.map((key): [string, string] => [PROPERTY_OF_KEY[key], 'inherit'])];
  all.sort(([a], [b]) => PROPERTY_ORDER.indexOf(a) - PROPERTY_ORDER.indexOf(b));
  return styleAttribute(all);
}

/** The CSS accepting one suggested text style change would set on a run, `` when it changes nothing the read shows. */
export function suggestedTextCss(current: docs_v1.Schema$TextStyle, change: docs_v1.Schema$SuggestedTextStyle): string {
  const before = textCssOf(current);
  const after = textCssOf(withSuggestion(current, change.textStyle ?? undefined, change.textStyleSuggestionState ?? undefined));
  const set: TextCss = {};
  const cleared: (keyof TextCss)[] = [];
  for (const key of Object.keys(after) as (keyof TextCss)[]) {
    if (after[key] === before[key]) continue;
    if (after[key] === undefined) cleared.push(key);
    else Object.assign(set, { [key]: after[key] });
  }
  // text-decoration is one property for two fields: when one changes, say both.
  if (DECORATION.some((key) => key in set)) for (const key of DECORATION) Object.assign(set, { [key]: after[key] });
  return cssText(declarationsFor({}, set), cleared);
}

/** The CSS accepting one suggested paragraph style change would set on a paragraph, against the named style it has now. */
export function suggestedParagraphCss(current: docs_v1.Schema$ParagraphStyle | undefined, change: docs_v1.Schema$SuggestedParagraphStyle, eff: EffectiveStyles): string {
  const now = current ?? {};
  const before = paragraphCssOf(now, eff);
  const after = paragraphCssOf(withSuggestion(now, change.paragraphStyle ?? undefined, change.paragraphStyleSuggestionState ?? undefined), eff);
  const { set, cleared } = paragraphCssChange(before, after);
  return cssText(declarationsFor(set), cleared);
}
