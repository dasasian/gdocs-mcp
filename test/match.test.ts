import { describe, it, expect } from 'vitest';
import { stripMarkdown, locate } from '../src/docs/edit.js';

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
