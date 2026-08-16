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
