import { describe, it, expect } from 'vitest';
import { stripMarkdown, locate } from '../src/docs/edit.js';
import { parseInline } from '../src/docs/inline.js';

describe('stripMarkdown', () => {
  it('strips heading prefixes', () => {
    expect(stripMarkdown('# Title')).toBe('Title');
    expect(stripMarkdown('### Deep')).toBe('Deep');
  });
  it('strips inline emphasis', () => {
    expect(stripMarkdown('**bold**')).toBe('bold');
    expect(stripMarkdown('*italic*')).toBe('italic');
    expect(stripMarkdown('~~struck~~')).toBe('struck');
    expect(stripMarkdown('`code`')).toBe('code');
  });
  it('reduces links to their text', () => {
    expect(stripMarkdown('[the plan](https://x.com)')).toBe('the plan');
  });
  it('strips inline html tags', () => {
    expect(stripMarkdown('<span style="color:red">x</span>')).toBe('x');
  });
  it('leaves plain text untouched', () => {
    expect(stripMarkdown('just words')).toBe('just words');
  });

  // #27: this used to run its own copy of the markdown grammar, which had
  // drifted from the writer's on `__` — no word-boundary guard, so it ate
  // underscore runs that parseInline (rightly) leaves alone.
  it('agrees with the writer on `__` (no intraword / underscore-run emphasis)', () => {
    expect(stripMarkdown('Signed: ____ ____')).toBe('Signed: ____ ____');
    expect(stripMarkdown('a__b__c')).toBe('a__b__c');
    expect(stripMarkdown('snake_case__name__here')).toBe('snake_case__name__here');
    // a genuine underscore-bold still strips
    expect(stripMarkdown('plain __bold__ text')).toBe('plain bold text');
  });

  it('matches the writer’s notion of markup for every input', () => {
    const writerPlain = (s: string) => parseInline(s).map((seg) => seg.text).join('');
    for (const s of ['Signed: ____ ____', 'a__b__c', '**b** and *i*', 'literal \\*star\\*', '50% * 2']) {
      expect(stripMarkdown(s)).toBe(writerPlain(s));
    }
  });

  // The reader wraps lines in constructs parseInline doesn't parse; they must
  // still come off, or a needle copied straight out of read_doc won't match.
  it('strips the wrappers read_doc emits', () => {
    expect(stripMarkdown('<p style="text-align:center">Centered</p>')).toBe('Centered');
    expect(stripMarkdown('<p style="text-align:right">**Bold** right</p>')).toBe('Bold right');
    expect(stripMarkdown('<ins data-sug="s1">added</ins>')).toBe('added');
    expect(stripMarkdown('<del data-sug="s2">removed</del>')).toBe('removed');
  });

  // read emits <br> for the in-paragraph line break; the doc's plain text holds
  // the raw vertical tab, so the needle has to map back to it.
  it('maps <br> back to the vertical tab the doc actually contains', () => {
    expect(stripMarkdown('line<br>break')).toBe('line\x0bbreak');
  });
});

describe('locate', () => {
  const text = 'The timeline is 3 weeks. The plan is set.';
  it('finds a unique exact match', () => {
    const r = locate(text, '3 weeks');
    expect(r.positions).toEqual([16]);
    expect(r.needle).toBe('3 weeks');
  });
  it('reports zero matches', () => {
    expect(locate(text, 'nonexistent').positions).toEqual([]);
  });
  it('finds all occurrences of a repeated needle', () => {
    expect(locate(text, 'is').positions.length).toBe(2);
  });
  it('falls back to markup-tolerant match', () => {
    const r = locate(text, '**3 weeks**');
    expect(r.positions).toEqual([16]);
    expect(r.needle).toBe('3 weeks');
  });
});

describe('a blank line in old_string matches a paragraph break (#60)', () => {
  const text = 'Scope\nThis project covers the work.\nTail';
  it('finds an anchor copied from the read across two paragraphs', () => {
    expect(locate(text, 'Scope\n\nThis project covers').positions).toEqual([0]);
  });
  it('composes with the markup-tolerant step', () => {
    const r = locate(text, '## Scope\n\nThis project covers');
    expect(r.positions).toEqual([0]);
    expect(r.needle).toBe('Scope\nThis project covers');
  });
  it('strips markup on every line, not only the first', () => {
    expect(locate('Scope\nSub heading', '## Scope\n\n### Sub heading').positions).toEqual([0]);
  });
  it('composes with a table anchor', () => {
    const r = locate('a\nb\n1\n2\nAfter', '| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter');
    expect(r.positions).toEqual([0]);
  });
  it('keeps the exact match first: a real empty paragraph still matches as written', () => {
    const r = locate('A\n\nB', 'A\n\nB');
    expect(r).toMatchObject({ needle: 'A\n\nB', positions: [0] });
  });
  it('does not add a second match where the exact one was already unique', () => {
    expect(locate('A\n\nB\nA\nB', 'A\n\nB').positions).toEqual([0]);
  });
});

// read_doc prints a list item with its marker (`- ` or `1. `, two spaces of indent per level), and the doc's plain text has none.
describe('a list marker copied from the read matches the item (#66)', () => {
  const text = 'Mon\nTue 19 (Playa): Tulum day trip\nWed\n- a real dash\nstay: 3 days';
  const at = (s: string): number => text.indexOf(s);
  it('a bullet marker', () => {
    const r = locate(text, '- **Tue 19 (Playa):** **Tulum day trip**');
    expect(r.positions).toEqual([at('Tue')]);
    expect(r.needle).toBe('Tue 19 (Playa): Tulum day trip');
  });
  it('an ordered marker', () => {
    expect(locate(text, '2. Wed').positions).toEqual([at('Wed')]);
  });
  it('a nested item, indented', () => {
    expect(locate(text, '    - Wed').positions).toEqual([at('Wed')]);
  });
  it('a marker on every line of several items', () => {
    expect(locate(text, '- Mon\n- Tue 19 (Playa): Tulum day trip').positions).toEqual([0]);
  });
  it('text that really starts with the marker still matches as written', () => {
    expect(locate(text, '- a real dash')).toMatchObject({ needle: '- a real dash', positions: [at('- a real dash')] });
  });
  it('a marker is only dropped at the start of a paragraph, not in the middle of one', () => {
    expect(locate(text, '- 3 days').positions).toEqual([]);
  });
});
