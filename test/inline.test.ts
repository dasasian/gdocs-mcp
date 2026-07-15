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
  it('still bolds real __underscore__ emphasis', () => {
    expect(parseInline('a __bold__ b')).toEqual([{ text: 'a ' }, { text: 'bold', bold: true }, { text: ' b' }]);
  });
  it('treats underscore runs (signature blank lines) as literal, not bold', () => {
    // Two soft-joined signature lines become "____ ____" — must NOT bold the gap.
    expect(parseInline('____ ____')).toEqual([{ text: '____ ____' }]);
    expect(parseInline('Sign _______ here _______ now')).toEqual([{ text: 'Sign _______ here _______ now' }]);
    expect(parseInline('_______________________')).toEqual([{ text: '_______________________' }]);
  });
  it('does not treat intraword __ as bold (CommonMark)', () => {
    expect(parseInline('a__b__c')).toEqual([{ text: 'a__b__c' }]);
  });
  it('unescapes backslashed punctuation to literal chars', () => {
    expect(parseInline('\\_\\_ literal underscores')).toEqual([{ text: '__ literal underscores' }]);
    expect(parseInline('not \\*italic\\*')).toEqual([{ text: 'not *italic*' }]);
  });
  it('escaped delimiter does not open emphasis, real ones still do', () => {
    // The escaped * is literal; the outer *...* is a real italic span around it.
    expect(parseInline('*a\\*b*')).toEqual([{ text: 'a*b', italic: true }]);
  });
  it('leaves \\t literal (only punctuation is escapable per CommonMark)', () => {
    expect(parseInline('name\\tdate')).toEqual([{ text: 'name\\tdate' }]);
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
