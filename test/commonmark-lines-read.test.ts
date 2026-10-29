import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { renderMarkdown, readTableLayout } from '../src/docs/transformer.js';
import { parseBlocks, markdownToRequests, buildContentRequests, cellBlocksOf } from '../src/docs/write.js';
import { placeCells } from '../src/docs/table-layout.js';
import { QUOTE_PARAGRAPH_STYLE } from '../src/docs/quote.js';
import { bodyDocument, paragraphsFromRequests, tableWithCell } from './doc-from-requests.js';

const COURIER: docs_v1.Schema$TextStyle = { weightedFontFamily: { fontFamily: 'Courier New', weight: 400 } };

const paragraph = (content: string, textStyle?: docs_v1.Schema$TextStyle, paragraphStyle?: docs_v1.Schema$ParagraphStyle, startIndex = 1): docs_v1.Schema$StructuralElement => ({
  startIndex,
  endIndex: startIndex + content.length + 1,
  paragraph: { elements: [{ startIndex, textRun: { content: `${content}\n`, textStyle } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT', ...paragraphStyle } },
});

const codeParagraph = (content: string): docs_v1.Schema$StructuralElement => paragraph(content, COURIER);
const quoteParagraph = (content: string): docs_v1.Schema$StructuralElement => paragraph(content, undefined, QUOTE_PARAGRAPH_STYLE);

const LEDGER = 'Tier 1   3,000 × 20  =  60,000\v  Tier 2   2,000 × 45  =  90,000\v\vTotal              150,000';
const LEDGER_FENCE = '```\nTier 1   3,000 × 20  =  60,000\n  Tier 2   2,000 × 45  =  90,000\n\nTotal              150,000\n```';

function readBackFromWrite(markdown: string): string {
  const built = markdownToRequests(markdown, 1);
  return renderMarkdown(bodyDocument(paragraphsFromRequests(built.requests, built.text)));
}

function cellReadBackFromWrite(tableMarkup: string): string {
  const [table] = parseBlocks(tableMarkup);
  if (table.type !== 'table' || !table.layout) throw new Error('expected an HTML table');
  const { cell } = placeCells(table.layout).cells[0];
  const built = buildContentRequests(cellBlocksOf(cell).blocks, 1, undefined, undefined, { startsParagraph: true, endsInExistingParagraphMark: true });
  return renderMarkdown(bodyDocument([tableWithCell(paragraphsFromRequests(built.requests, built.text))]));
}

describe('a paragraph that is Courier New throughout reads as a fence (#59 rule 2)', () => {
  it('keeps the line breaks and every space', () => {
    expect(renderMarkdown(bodyDocument([codeParagraph(LEDGER)]))).toBe(LEDGER_FENCE);
  });

  it('reads two code paragraphs in a row as two fences', () => {
    expect(renderMarkdown(bodyDocument([codeParagraph('one'), codeParagraph('two')]))).toBe('```\none\n```\n\n```\ntwo\n```');
  });

  it('opens with a longer fence when the code holds a fence', () => {
    expect(renderMarkdown(bodyDocument([codeParagraph('```\vx\v```')]))).toBe('````\n```\nx\n```\n````');
  });

  it('does not read markup inside the fence as markup', () => {
    expect(renderMarkdown(bodyDocument([codeParagraph('# a\v**b** <br>')]))).toBe('```\n# a\n**b** <br>\n```');
  });

  it('keeps a code span for code inside a paragraph of other text', () => {
    const doc = bodyDocument([{ startIndex: 1, endIndex: 9, paragraph: { elements: [{ startIndex: 1, textRun: { content: 'say ' } }, { startIndex: 5, textRun: { content: 'x\n', textStyle: COURIER } }] } }]);
    expect(renderMarkdown(doc)).toBe('say `x`');
  });

  it('keeps the span when the code run is bold or sized, so the styling is not lost', () => {
    expect(renderMarkdown(bodyDocument([paragraph('x', { ...COURIER, bold: true })]))).toBe('**`x`**');
    expect(renderMarkdown(bodyDocument([paragraph('x', { ...COURIER, fontSize: { magnitude: 9, unit: 'PT' } })]))).toBe('<span style="font-size:9pt">`x`</span>');
  });

  it('keeps the paragraph tag for code in a styled paragraph', () => {
    expect(renderMarkdown(bodyDocument([paragraph('x', COURIER, { alignment: 'CENTER' })]))).toBe('<p style="text-align:center">`x`</p>');
  });

  it('reads back as the same fence after the writer has made it', () => {
    expect(readBackFromWrite(LEDGER_FENCE)).toBe(LEDGER_FENCE);
  });

  it('reads back the same from code indented four spaces, as a fence', () => {
    expect(readBackFromWrite('    Tier 1   3,000\n      two\n\n    Total')).toBe('```\nTier 1   3,000\n  two\n\nTotal\n```');
  });
});

describe('a left border reads as a quote (#59 rule 3)', () => {
  it('reads one paragraph as > text, without its indent as CSS', () => {
    expect(renderMarkdown(bodyDocument([quoteParagraph('A quote.')]))).toBe('> A quote.');
  });

  it('reads three quoted paragraphs as one quote with bare > lines between', () => {
    const doc = bodyDocument([quoteParagraph('First.'), quoteParagraph('Second.'), quoteParagraph('Third.')]);
    expect(renderMarkdown(doc)).toBe('> First.\n>\n> Second.\n>\n> Third.');
  });

  it('starts a new quote after a plain paragraph', () => {
    const doc = bodyDocument([quoteParagraph('One.'), paragraph('Between.'), quoteParagraph('Two.')]);
    expect(renderMarkdown(doc)).toBe('> One.\n\nBetween.\n\n> Two.');
  });

  it('writes the quote’s other styling as CSS and drops the quote when a paragraph carries more than the quote', () => {
    const centered = paragraph('Centered.', undefined, { ...QUOTE_PARAGRAPH_STYLE, alignment: 'CENTER' });
    expect(renderMarkdown(bodyDocument([centered]))).toBe('<p style="text-align:center; margin-left:36pt">Centered.</p>');
  });

  it('does not read another border as a quote', () => {
    const other = paragraph('Boxed.', undefined, { borderLeft: { ...QUOTE_PARAGRAPH_STYLE.borderLeft, width: { magnitude: 3, unit: 'PT' } } });
    expect(renderMarkdown(bodyDocument([other]))).toBe('Boxed.');
  });

  it('marks quoted words the writer would read as a block, so they stay words', () => {
    expect(renderMarkdown(bodyDocument([quoteParagraph('# not a heading')]))).toBe('> <p># not a heading</p>');
    expect(readBackFromWrite('> <p># not a heading</p>')).toBe('> <p># not a heading</p>');
  });

  it('marks quoted words that would lose their spaces, so they stay as written', () => {
    expect(renderMarkdown(bodyDocument([quoteParagraph(' spaced out ')]))).toBe('> <p> spaced out </p>');
    expect(readBackFromWrite('> <p> spaced out </p>')).toBe('> <p> spaced out </p>');
  });

  it('reads back as the same quote after the writer has made it', () => {
    const quote = '> First paragraph.\n>\n> Second paragraph.\n>\n> Third paragraph.';
    expect(readBackFromWrite(quote)).toBe(quote);
  });

  it('marks a paragraph of text that starts with > as literal, and the writer makes it a plain paragraph again', () => {
    const doc = bodyDocument([paragraph('> not a quote')]);
    expect(renderMarkdown(doc)).toBe('<p>> not a quote</p>');
    expect(readBackFromWrite('<p>> not a quote</p>')).toBe('<p>> not a quote</p>');
  });
});

describe('read, write, read is identical (#59 rule 5)', () => {
  const docs: [string, docs_v1.Schema$StructuralElement[]][] = [
    ['a code block', [codeParagraph(LEDGER)]],
    ['two code blocks', [codeParagraph('one\vtwo'), codeParagraph('three')]],
    ['a quote of three paragraphs', [quoteParagraph('First.'), quoteParagraph('Second.'), quoteParagraph('Third.')]],
    ['all of them with plain text between', [paragraph('Intro.'), codeParagraph(LEDGER), paragraph('Between.'), quoteParagraph('Said.'), quoteParagraph('More.'), paragraph('End.')]],
  ];

  it.each(docs)('in the body: %s', (_name, content) => {
    const first = renderMarkdown(bodyDocument(content));
    expect(readBackFromWrite(first)).toBe(first);
  });

  it.each([
    ['a code block', [codeParagraph(LEDGER)]],
    ['a quote of one line', [quoteParagraph('Said.')]],
    ['a quote of two paragraphs', [quoteParagraph('First.'), quoteParagraph('Second.')]],
    ['text, a code block and a quote', [paragraph('Intro.'), codeParagraph('a  b\vc'), quoteParagraph('Said.')]],
  ])('in a table cell: %s', (_name, content) => {
    const first = renderMarkdown(bodyDocument([tableWithCell(content)]));
    expect(first).toMatch(/^<table>/);
    expect(cellReadBackFromWrite(first)).toBe(first);
  });

  it('reads a one-line quote cell as a block cell, so an edit compares it with the table it will write', () => {
    const doc = bodyDocument([tableWithCell([quoteParagraph('Said.')])]);
    const layout = readTableLayout(doc, doc.body!.content![0].table!);
    const cell = layout.rows[0].cells[0];
    expect(cell.asBlocks).toBe(true);
    expect(cellBlocksOf(cell).blocks).toEqual([{ type: 'paragraph', text: 'Said.', quote: true }]);
  });

  it('keeps a single-line code cell as an inline code span, so a plain table stays a pipe table', () => {
    expect(renderMarkdown(bodyDocument([tableWithCell([codeParagraph('npm test')])]))).toContain('`npm test`');
  });

  it('wraps a table cell’s text that starts with > so the writer keeps it as text', () => {
    const shaded = { backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 0 } } } };
    const first = renderMarkdown(bodyDocument([tableWithCell([paragraph('>= 5 items')], shaded)]));
    expect(first).toContain('<p>>= 5 items</p>');
    const [table] = parseBlocks(first);
    if (table.type !== 'table' || !table.layout) throw new Error('expected an HTML table');
    expect(cellBlocksOf(placeCells(table.layout).cells[0].cell).blocks).toEqual([{ type: 'paragraph', text: '>= 5 items' }]);
  });
});

describe('a line that starts with spaces is still wrapped in <p> (#54)', () => {
  it('keeps four leading spaces as text, not as code', () => {
    const read = renderMarkdown(bodyDocument([paragraph('    four spaces in')]));
    expect(read).toBe('<p>    four spaces in</p>');
    expect(readBackFromWrite(read)).toBe(read);
  });
});
