import { describe, it, expect } from 'vitest';
import { parseInline, segmentTextStyle } from '../src/docs/inline.js';

describe('parseInline', () => {
  it('returns one plain segment for plain text', () => {
    expect(parseInline('just words')).toEqual([{ text: 'just words' }]);
  });
  it('splits around bold', () => {
    expect(parseInline('a **b** c')).toEqual([{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }]);
  });
  it('handles italic and code', () => {
    expect(parseInline('*i* and `c`')).toEqual([
      { text: 'i', italic: true },
      { text: ' and ' },
      { text: 'c', code: true },
    ]);
  });
  it('handles links', () => {
    expect(parseInline('see [the plan](https://x.com) ok')).toEqual([
      { text: 'see ' },
      { text: 'the plan', link: 'https://x.com' },
      { text: ' ok' },
    ]);
  });
  it('prefers ** over * (bold not double-italic)', () => {
    expect(parseInline('**bold**')).toEqual([{ text: 'bold', bold: true }]);
  });
  it('parses inline html tags', () => {
    expect(parseInline('<b>x</b>')).toEqual([{ text: 'x', bold: true }]);
    expect(parseInline('<u>y</u>')).toEqual([{ text: 'y', underline: true }]);
    expect(parseInline('<a href="u">t</a>')).toEqual([{ text: 't', link: 'u' }]);
  });
  it('parses span style attrs', () => {
    expect(parseInline('<span style="color:#ff0000;font-size:14pt">c</span>')).toEqual([
      { text: 'c', color: '#ff0000', fontSize: 14 },
    ]);
  });
  it('converts px font-size to pt', () => {
    expect(parseInline('<span style="font-size:16px">c</span>')).toEqual([{ text: 'c', fontSize: 12 }]);
  });
});

describe('segmentTextStyle', () => {
  it('maps flags to fields', () => {
    expect(segmentTextStyle({ text: 'x', bold: true, italic: true }).fields.sort()).toEqual(['bold', 'italic']);
  });
  it('maps code to a monospace font', () => {
    const { textStyle, fields } = segmentTextStyle({ text: 'x', code: true });
    expect(fields).toEqual(['weightedFontFamily']);
    expect(textStyle.weightedFontFamily?.fontFamily).toBe('Courier New');
  });
  it('maps link', () => {
    expect(segmentTextStyle({ text: 'x', link: 'u' }).textStyle.link?.url).toBe('u');
  });
});
