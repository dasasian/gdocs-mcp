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

// ---- #31: nested inline styles ---------------------------------------------
//
// The reader emits styles in layers (`<u>**AAA**</u>` for a bold+underlined
// run). A one-level parser turned the inner markup into literal characters, so
// read -> write lost the inner style AND baked its markers into the text; each
// cycle added another layer (`<u>****AAA****</u>`).

describe('parseInline — nested containers (#31)', () => {
  it('keeps both styles for markup inside an HTML container', () => {
    expect(parseInline('<u>**bold underlined**</u>')).toEqual([
      { text: 'bold underlined', underline: true, bold: true },
    ]);
  });

  it('keeps both styles for an HTML container inside markdown', () => {
    expect(parseInline('**<u>bold underlined</u>**')).toEqual([
      { text: 'bold underlined', bold: true, underline: true },
    ]);
  });

  it('keeps a link nested inside bold — the shape read_doc emits', () => {
    expect(parseInline('**[bold link](http://x)**')).toEqual([
      { text: 'bold link', bold: true, link: 'http://x' },
    ]);
  });

  it('carries a span’s styles onto nested markup', () => {
    expect(parseInline('<span style="color:red">**b**</span>')).toEqual([
      { text: 'b', color: 'red', bold: true },
    ]);
  });

  it('nests more than two deep', () => {
    expect(parseInline('<u><span style="color:red">**deep**</span></u>')).toEqual([
      { text: 'deep', underline: true, color: 'red', bold: true },
    ]);
    expect(parseInline('<u>~~*CCC*~~</u>')).toEqual([
      { text: 'CCC', underline: true, strikethrough: true, italic: true },
    ]);
  });

  it('lets the inner style win when both set the same property', () => {
    expect(parseInline('[<a href="http://inner">x</a>](http://outer)')).toEqual([
      { text: 'x', link: 'http://inner' },
    ]);
  });

  // Known limitation: two containers of the SAME tag can't nest, because the
  // non-greedy pattern closes the outer one on the inner one's end tag. The
  // reader never emits that shape (it puts every style of a run in one span),
  // and the workaround is one span carrying both properties.
  it('does not support same-tag nesting (documented limitation)', () => {
    const out = parseInline('<span style="color:red"><span style="color:blue">x</span></span>');
    expect(out).not.toEqual([{ text: 'x', color: 'blue' }]);
    // the supported spelling:
    expect(parseInline('<span style="color:blue;font-size:14pt">x</span>')).toEqual([
      { text: 'x', color: 'blue', fontSize: 14 },
    ]);
  });

  // Code spans are literal by definition — markup inside them is content.
  it('does NOT parse inside code spans', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ text: '**not bold**', code: true }]);
    expect(parseInline('<code>**not bold**</code>')).toEqual([{ text: '**not bold**', code: true }]);
  });

  it('leaves escapes, empty containers and unclosed markers alone', () => {
    expect(parseInline('*a\\*b*')).toEqual([{ text: 'a*b', italic: true }]);
    expect(parseInline('<u></u>')).toEqual([]);
    expect(parseInline('**unclosed')).toEqual([{ text: '**unclosed' }]);
  });
});
