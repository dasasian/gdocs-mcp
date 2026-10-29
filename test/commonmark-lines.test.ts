import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { parseBlocks, markdownToRequests } from '../src/docs/write.js';
import { StyleSyntaxError } from '../src/docs/css.js';

const LEDGER = ['Tier 1   3,000 × 20  =  60,000', 'Tier 2   2,000 × 45  =  90,000', '', 'Total              150,000'];

const refusalOf = (markdown: string): string[] => {
  try {
    parseBlocks(markdown);
  } catch (error) {
    if (error instanceof StyleSyntaxError) return error.issues;
    throw error;
  }
  return [];
};

const requestsFor = (markdown: string): docs_v1.Schema$Request[] => markdownToRequests(markdown, 1).requests;
const paragraphStyles = (requests: docs_v1.Schema$Request[]) => requests.flatMap((r) => (r.updateParagraphStyle ? [r.updateParagraphStyle] : []));
const fontRanges = (requests: docs_v1.Schema$Request[]) =>
  requests.flatMap((r) => (r.updateTextStyle?.textStyle?.weightedFontFamily ? [{ ...r.updateTextStyle.range!, family: r.updateTextStyle.textStyle.weightedFontFamily.fontFamily }] : []));

describe('a single newline is a space (#59 rule 1)', () => {
  it('joins the lines of a hard-wrapped paragraph', () => {
    expect(parseBlocks('This quote covers the website\nrebuild for Acme.')).toEqual([{ type: 'paragraph', text: 'This quote covers the website rebuild for Acme.' }]);
  });

  it('keeps a wrapped list item as one item, indented or not, and the list as one list', () => {
    const blocks = parseBlocks('- 9-tree sample: group trees heavy / medium / light, pick 3 of each, count\n  one side of the canopy × 2.\n- Set up the Cull Sack.\n- Third\nitem wraps flush left.');
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          { level: 0, text: '9-tree sample: group trees heavy / medium / light, pick 3 of each, count one side of the canopy × 2.' },
          { level: 0, text: 'Set up the Cull Sack.' },
          { level: 0, text: 'Third item wraps flush left.' },
        ],
      },
    ]);
  });

  it('ends a list at a blank line, a heading or a fence, not at a wrapped line', () => {
    const blocks = parseBlocks('1. one\n   wrapped\n\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['list', 'paragraph']);
  });

  it('<br> still forces a line break', () => {
    const { text } = markdownToRequests('first<br>second', 1);
    expect(text).toBe('first\vsecond\n');
  });
});

describe('fenced and indented code is one Courier New paragraph (#59 rule 2)', () => {
  it('keeps every line, every space and the blank line of a fence', () => {
    const [block] = parseBlocks(['```', ...LEDGER, '```'].join('\n'));
    expect(block).toEqual({ type: 'code', text: LEDGER.join('\n') });
  });

  it('writes the lines as vertical-tab line breaks in one paragraph, Courier New over the text and not the mark', () => {
    const built = markdownToRequests(['```', ...LEDGER, '```'].join('\n'), 1);
    expect(built.text).toBe(`${LEDGER.join('\v')}\n`);
    const text = LEDGER.join('\v');
    expect(fontRanges(built.requests)).toEqual([{ startIndex: 1, endIndex: 1 + text.length, family: 'Courier New' }]);
  });

  it('drops the language tag', () => {
    expect(parseBlocks('```ts\nconst x = 1;\n```')).toEqual([{ type: 'code', text: 'const x = 1;' }]);
  });

  it('closes a ~~~ fence with ~~~ and a long fence only with one as long', () => {
    expect(parseBlocks('~~~\na\n~~~')).toEqual([{ type: 'code', text: 'a' }]);
    expect(parseBlocks('````\n```\ninner\n```\n````')).toEqual([{ type: 'code', text: '```\ninner\n```' }]);
  });

  it('takes an indented fence’s indent off its lines', () => {
    expect(parseBlocks('  ```\n  a\n    b\n  ```')).toEqual([{ type: 'code', text: 'a\n  b' }]);
  });

  it('reads code indented four spaces, with its blank line, and drops trailing blank lines', () => {
    expect(parseBlocks('    Tier 1   3,000\n\n    Total     150\n\nafter')).toEqual([
      { type: 'code', text: 'Tier 1   3,000\n\nTotal     150' },
      { type: 'paragraph', text: 'after' },
    ]);
  });

  it('makes two code blocks in a row two paragraphs', () => {
    const built = markdownToRequests('```\none\n```\n\n```\ntwo\n```', 1);
    expect(built.text).toBe('one\ntwo\n');
    expect(fontRanges(built.requests).map((r) => [r.startIndex, r.endIndex])).toEqual([
      [1, 4],
      [5, 8],
    ]);
  });

  it('does not read markup inside a fence', () => {
    const built = markdownToRequests('```\n# not a heading\n**not bold** <br>\n```', 1);
    expect(built.text).toBe('# not a heading\v**not bold** <br>\n');
  });

  it('ends a paragraph at a fence', () => {
    expect(parseBlocks('before\n```\ncode\n```').map((b) => b.type)).toEqual(['paragraph', 'code']);
  });

  it('refuses a fence that is never closed, naming its line', () => {
    expect(refusalOf('text\n\n```\ncode')).toEqual(['line 3: code fence ``` is never closed']);
  });
});

describe('a blockquote is an indented paragraph with a left border (#59 rule 3)', () => {
  it('writes the indent and the border the Docs API accepts, with padding and dash style', () => {
    const requests = requestsFor('> A quote.');
    const [quote] = paragraphStyles(requests);
    expect(quote.range).toMatchObject({ startIndex: 1, endIndex: 10 });
    expect(quote.fields!.split(',').sort()).toEqual(['borderLeft', 'indentFirstLine', 'indentStart']);
    expect(quote.paragraphStyle).toEqual({
      indentStart: { magnitude: 36, unit: 'PT' },
      indentFirstLine: { magnitude: 36, unit: 'PT' },
      borderLeft: {
        color: { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } },
        width: { magnitude: 1.5, unit: 'PT' },
        padding: { magnitude: 0, unit: 'PT' },
        dashStyle: 'SOLID',
      },
    });
  });

  it('keeps a bare > line as the separator between the paragraphs of one quote', () => {
    expect(parseBlocks('> First paragraph.\n>\n> Second paragraph.\n>\n> Third.')).toEqual([
      { type: 'paragraph', text: 'First paragraph.', quote: true },
      { type: 'paragraph', text: 'Second paragraph.', quote: true },
      { type: 'paragraph', text: 'Third.', quote: true },
    ]);
  });

  it('joins a hard-wrapped quoted paragraph, with or without the > on the next line', () => {
    expect(parseBlocks('> This quote covers the website\n> rebuild for Acme\nand the shop.')).toEqual([
      { type: 'paragraph', text: 'This quote covers the website rebuild for Acme and the shop.', quote: true },
    ]);
  });

  it('ends at a blank line, and a quote after a blank line is another paragraph', () => {
    expect(parseBlocks('> one\n\n> two\n\nplain')).toEqual([
      { type: 'paragraph', text: 'one', quote: true },
      { type: 'paragraph', text: 'two', quote: true },
      { type: 'paragraph', text: 'plain' },
    ]);
  });

  it('reads inline styling inside the quote', () => {
    const built = markdownToRequests('> some **bold** words', 1);
    expect(built.requests.some((r) => r.updateTextStyle?.textStyle?.bold)).toBe(true);
    expect(built.text).toBe('some bold words\n');
  });

  it('clears a quote’s border from what is written after it', () => {
    const { requests } = markdownToRequests('plain', 1, undefined, undefined, { resetParagraphStyles: true });
    expect(paragraphStyles(requests)[0].fields).toContain('borderLeft');
  });
});

describe('a quote inside a quote, and a list or code block inside one, are refused (#59 rule 4)', () => {
  it.each([
    ['a quote inside a quote', '> one\n>\n>> nested', 'line 3: a quote inside a quote (>>) is not supported'],
    ['a spaced quote inside a quote', '> one\n> > nested', 'line 2: a quote inside a quote (>>) is not supported'],
    ['a list', '> intro\n>\n> - item', 'line 3: a list inside a quote is not supported'],
    ['an ordered list', '> 1. item', 'line 1: a list inside a quote is not supported'],
    ['a fenced code block', '> text\n>\n> ```\n> code\n> ```', 'line 3: a code block inside a quote is not supported'],
    ['an indented code block', '>\n>     code', 'line 2: a code block inside a quote is not supported'],
    ['a heading', '> # Title', 'line 1: a heading inside a quote is not supported'],
  ])('refuses %s, naming the line', (_name, markdown, expected) => {
    expect(refusalOf(markdown)).toContain(expected);
  });
});
