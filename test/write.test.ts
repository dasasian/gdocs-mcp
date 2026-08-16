import { describe, it, expect } from 'vitest';
import { parseBlocks, markdownToRequests } from '../src/docs/write.js';

describe('parseBlocks', () => {
  it('parses headings with level', () => {
    expect(parseBlocks('# A\n\n### B')).toEqual([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'heading', level: 3, text: 'B' },
    ]);
  });

  it('soft-joins paragraph lines', () => {
    expect(parseBlocks('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', text: 'one two' },
      { type: 'paragraph', text: 'three' },
    ]);
  });

  it('parses read_doc aligned paragraphs (<p style="text-align:…">) back to align', () => {
    expect(parseBlocks('<p style="text-align:center">Landlord</p>')).toEqual([
      { type: 'paragraph', text: 'Landlord', align: 'center' },
    ]);
    expect(parseBlocks('<p style="text-align:right">x</p>')).toEqual([
      { type: 'paragraph', text: 'x', align: 'right' },
    ]);
  });

  it('emits an alignment updateParagraphStyle for an aligned paragraph', () => {
    const { requests } = markdownToRequests('<p style="text-align:center">Hi</p>', 1);
    const align = requests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.alignment === 'CENTER',
    );
    expect(align?.updateParagraphStyle?.fields).toBe('alignment');
  });

  it('converts <br> to an in-paragraph line break (U+000B) in the inserted text', () => {
    const { text } = markdownToRequests('a<br>b', 1);
    expect(text).toBe('a\x0bb\n');
  });

  it('groups a bullet list with nesting', () => {
    const blocks = parseBlocks('- a\n- b\n  - c');
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          { level: 0, text: 'a' },
          { level: 0, text: 'b' },
          { level: 1, text: 'c' },
        ],
      },
    ]);
  });

  it('detects ordered lists', () => {
    const blocks = parseBlocks('1. first\n2. second');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true });
    expect(blocks[0]).toHaveProperty('items.length', 2);
  });

  it('separates a bullet list from a following ordered list', () => {
    const blocks = parseBlocks('- a\n\n1. b');
    expect(blocks.map((b) => (b.type === 'list' ? b.ordered : b.type))).toEqual([false, true]);
  });

  it('keeps inline markup intact for later parsing', () => {
    expect(parseBlocks('A **b** c')).toEqual([{ type: 'paragraph', text: 'A **b** c' }]);
  });

  it('parses a table (consuming the separator row)', () => {
    const blocks = parseBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    expect(blocks).toEqual([
      {
        type: 'table',
        rows: [
          ['A', 'B'],
          ['1', '2'],
          ['3', '4'],
        ],
        aligns: [null, null],
      },
    ]);
  });

  it('captures column alignment from the separator', () => {
    const blocks = parseBlocks('| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |');
    expect(blocks[0]).toMatchObject({ aligns: ['left', 'center', 'right'] });
  });

  it('separates a table from surrounding paragraphs', () => {
    const blocks = parseBlocks('before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
  });

  it('unescapes pipes in cells', () => {
    const blocks = parseBlocks('| a \\| b | c |\n|---|---|\n| 1 | 2 |');
    expect(blocks[0]).toMatchObject({ rows: [['a | b', 'c'], ['1', '2']] });
  });

  it('parses a block image', () => {
    expect(parseBlocks('![a caption](path/to/img.png)')).toEqual([
      { type: 'image', alt: 'a caption', src: 'path/to/img.png' },
    ]);
  });

  it('separates an image from surrounding paragraphs', () => {
    const blocks = parseBlocks('intro\n\n![](x.png)\n\noutro');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph']);
  });

  it('ignores html comments (standalone and trailing on an image)', () => {
    expect(parseBlocks('<!-- gdocs doc=1abc -->\n\nHi.')).toEqual([{ type: 'paragraph', text: 'Hi.' }]);
    expect(parseBlocks('![a](p.png) <!-- gdocs img=kix.abc doc=abdd -->')).toEqual([
      { type: 'image', alt: 'a', src: 'p.png' },
    ]);
  });

  it('skips multi-line html comment blocks', () => {
    expect(parseBlocks('<!--\nmeta\nmeta2\n-->\nText.')).toEqual([{ type: 'paragraph', text: 'Text.' }]);
  });
});

// ---- #30: <img> is the escape hatch for image sizing -----------------------

describe('parseBlocks — <img> tags', () => {
  it('parses the shape read_doc emits, with size', () => {
    expect(parseBlocks('<img src="image:kix.a" width="48" height="48">')).toEqual([
      { type: 'image', alt: '', src: 'image:kix.a', width: 48, height: 48 },
    ]);
  });

  it('accepts attributes in any order and unescapes alt', () => {
    expect(parseBlocks('<img height="20" alt="say &quot;hi&quot; &amp; more" width="10" src="./a.png">')).toEqual([
      { type: 'image', alt: 'say "hi" & more', src: './a.png', width: 10, height: 20 },
    ]);
  });

  it('treats a size-less tag as an unsized image', () => {
    expect(parseBlocks('<img src="./a.png">')).toEqual([
      { type: 'image', alt: '', src: './a.png', width: undefined, height: undefined },
    ]);
  });

  it('ignores junk dimensions rather than sending them to the API', () => {
    expect(parseBlocks('<img src="./a.png" width="0" height="abc">')).toEqual([
      { type: 'image', alt: '', src: './a.png', width: undefined, height: undefined },
    ]);
  });

  it('still parses the plain markdown image form', () => {
    expect(parseBlocks('![alt text](./a.png)')).toEqual([{ type: 'image', alt: 'alt text', src: './a.png' }]);
  });

  it('leaves an <img> with no src as ordinary text', () => {
    expect(parseBlocks('<img width="10">')[0].type).toBe('paragraph');
  });
});

// ---- #32: inserted content must not inherit the styling it replaced --------

describe('markdownToRequests — style reset (#32)', () => {
  it('clears direct run styling over the inserted range, before applying its own', () => {
    const { requests, text } = markdownToRequests('plain **bold**', 1);
    const insertAt = requests.findIndex((r) => r.insertText);
    const resetAt = requests.findIndex(
      (r) => r.updateTextStyle && Object.keys(r.updateTextStyle.textStyle ?? {}).length === 0,
    );
    const boldAt = requests.findIndex((r) => r.updateTextStyle?.textStyle?.bold);

    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(resetAt).toBeGreaterThan(insertAt); // after the text exists
    expect(boldAt).toBeGreaterThan(resetAt); // and before what the markdown asked for

    const reset = requests[resetAt].updateTextStyle!;
    expect(reset.range).toMatchObject({ startIndex: 1, endIndex: 1 + text.length });
  });

  it('names every direct character field, so none can leak', () => {
    const { requests } = markdownToRequests('x', 1);
    const reset = requests.find((r) => r.updateTextStyle && Object.keys(r.updateTextStyle.textStyle ?? {}).length === 0)!;
    const fields = (reset.updateTextStyle!.fields ?? '').split(',');
    for (const f of [
      'bold', 'italic', 'underline', 'strikethrough', 'smallCaps',
      'backgroundColor', 'foregroundColor', 'fontSize', 'weightedFontFamily',
      'baselineOffset', 'link',
    ]) {
      expect(fields).toContain(f);
    }
  });

  it('carries tab and segment, so a header overwrite resets the header', () => {
    const { requests } = markdownToRequests('x', 1, 't.0', 'kix.h');
    const reset = requests.find((r) => r.updateTextStyle && Object.keys(r.updateTextStyle.textStyle ?? {}).length === 0)!;
    expect(reset.updateTextStyle!.range).toMatchObject({ tabId: 't.0', segmentId: 'kix.h' });
  });
});
