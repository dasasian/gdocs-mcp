import { parseInline, inlineStyleIssues } from './inline.js';
import { parseBlocks, cellContent } from './write.js';
import { StyleSyntaxError } from './css.js';

export type Escaper = (text: string) => string;

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
const identity: Escaper = (text) => text;

const UNESCAPE_FIRST = ['>', ')', '(', ']'];
const UNESCAPE_LAST = ['[', '<', '\\'];

const escaperFor = (kinds: ReadonlySet<string>): Escaper => (text) =>
  text.replace(ASCII_PUNCTUATION, (c) => (kinds.has(c) ? `\\${c}` : c));

const meaningOf = (inline: string, readBack: Escaper): string | undefined => {
  const seen = readBack(inline);
  return inlineStyleIssues(seen).length ? undefined : JSON.stringify(parseInline(seen));
};

function unescapeOrder(kinds: ReadonlySet<string>): string[] {
  const rest = [...kinds].filter((k) => !UNESCAPE_FIRST.includes(k) && !UNESCAPE_LAST.includes(k));
  return [...UNESCAPE_FIRST, ...rest, ...UNESCAPE_LAST].filter((k) => kinds.has(k));
}

/**
 * The escaper that makes `renderInline` mean exactly its literal text: it
 * backslash-escapes the least punctuation that keeps the writer's own parser
 * (parseInline) from reading any of `literalText` as markup. Identity when the
 * text is already safe. `renderInline` must call the escaper on every piece of
 * document text it emits, and on nothing else. `readBack` is any step the writer
 * takes on the line before parseInline sees it (a table cell's pipes).
 */
export function literalTextEscaper(
  literalText: string,
  renderInline: (escape: Escaper) => string,
  readBack: Escaper = identity,
): Escaper {
  const punctuation = new Set(literalText.match(ASCII_PUNCTUATION) ?? []);
  if (punctuation.size === 0) return identity;
  const intended = meaningOf(renderInline(escaperFor(punctuation)), readBack);
  if (meaningOf(renderInline(identity), readBack) === intended) return identity;
  const kept = new Set(punctuation);
  for (const kind of unescapeOrder(punctuation)) {
    kept.delete(kind);
    if (meaningOf(renderInline(escaperFor(kept)), readBack) !== intended) kept.add(kind);
  }
  return escaperFor(kept);
}

/** True when the writer would read this table cell as anything but exactly these words. */
export const cellNeedsParagraphTag = (cell: string): boolean => cellContent(cell) !== cell;

/** True when the writer would read this line as anything but one plain paragraph of exactly these words. */
export function needsParagraphTag(line: string): boolean {
  try {
    const [only, ...more] = parseBlocks(line);
    return !(more.length === 0 && only?.type === 'paragraph' && !only.css && !only.className && only.text === line);
  } catch (error) {
    if (error instanceof StyleSyntaxError) return true;
    throw error;
  }
}
