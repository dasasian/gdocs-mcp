import { RULE_LINE } from './markdown-spec.js';
import type { TokenTable } from './elements.js';

/** One stretch between kept elements: what it held, and what it becomes. */
export interface Gap {
  /** the old string's markup for this stretch. */
  oldMarkup: string;
  /** the stretch of the doc's plain text, as offsets into the span that was matched. */
  plainFrom: number;
  plainTo: number;
  /** the new string's markup for this stretch. */
  written: string;
  /** true when an element that is kept sits just before this stretch. */
  followsKept: boolean;
}

const positionsOfElements = (text: string, tokens: TokenTable): number[] => [...text].flatMap((char, at) => (tokens.isPlaceholder(char) ? [at] : []));

/**
 * Splits an edit at the elements it gives back: an element that is in both the old and the new text is kept, so the
 * edit is the stretches between them. Elements are paired in order, by being the same token. Without any, the one
 * gap is the whole edit. `oldPlain` is the doc's text for the span (one character per element) and `oldMarkup` the
 * old string's: they hold the same elements in the same order, or nothing is kept.
 */
export function splitAtKeptElements(oldMarkup: string, oldPlain: string, written: string, tokens: TokenTable): Gap[] {
  const whole: Gap = { oldMarkup, plainFrom: 0, plainTo: oldPlain.length, written, followsKept: false };
  const inMarkup = positionsOfElements(oldMarkup, tokens);
  const inPlain = positionsOfElements(oldPlain, tokens);
  if (inMarkup.length === 0 || inMarkup.length !== inPlain.length) return [whole];

  let newCursor = 0;
  const kept: { markup: number; plain: number; written: number }[] = [];
  inMarkup.forEach((markupAt, k) => {
    const at = written.indexOf(oldMarkup[markupAt], newCursor);
    if (at < 0) return;
    kept.push({ markup: markupAt, plain: inPlain[k], written: at });
    newCursor = at + 1;
  });
  if (kept.length === 0) return [whole];

  const edges = [{ markup: -1, plain: -1, written: -1 }, ...kept];
  const gaps = edges.map((edge, k): Gap => {
    const next = kept[k];
    return {
      oldMarkup: oldMarkup.slice(edge.markup + 1, next?.markup ?? oldMarkup.length),
      plainFrom: edge.plain + 1,
      plainTo: next?.plain ?? oldPlain.length,
      written: written.slice(edge.written + 1, next?.written ?? written.length),
      followsKept: k > 0,
    };
  });
  return keepLineBreaksAroundKeptRules(gaps, kept.map((edge) => tokens.tokenOf(oldMarkup[edge.markup])), oldPlain);
}

/** A kept rule is a line of its own: the line break on each side of it is not part of the stretches that touch it. */
function keepLineBreaksAroundKeptRules(gaps: Gap[], keptTokens: (string | undefined)[], oldPlain: string): Gap[] {
  const out = gaps.map((gap) => ({ ...gap }));
  keptTokens.forEach((token, k) => {
    if (token !== RULE_LINE) return;
    const before = out[k];
    const after = out[k + 1];
    if (before.plainTo > before.plainFrom && oldPlain[before.plainTo - 1] === '\n' && before.written.endsWith('\n')) {
      before.plainTo -= 1;
      before.written = before.written.slice(0, -1);
      before.oldMarkup = before.oldMarkup.endsWith('\n') ? before.oldMarkup.slice(0, -1) : before.oldMarkup;
    }
    if (after.plainTo > after.plainFrom && oldPlain[after.plainFrom] === '\n' && after.written.startsWith('\n')) {
      after.plainFrom += 1;
      after.written = after.written.slice(1);
      after.oldMarkup = after.oldMarkup.startsWith('\n') ? after.oldMarkup.slice(1) : after.oldMarkup;
    }
  });
  return out.filter((gap) => gap.oldMarkup !== '' || gap.plainTo > gap.plainFrom || gap.written !== '');
}
