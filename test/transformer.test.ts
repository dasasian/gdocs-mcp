import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { project, renderMarkdown } from '../src/docs/transformer.js';

// Minimal doc builders.
function para(elements: docs_v1.Schema$ParagraphElement[], style?: docs_v1.Schema$ParagraphStyle, bullet?: docs_v1.Schema$Bullet): docs_v1.Schema$StructuralElement {
  return { paragraph: { elements, paragraphStyle: style, bullet } };
}
function run(content: string, start: number, textStyle?: docs_v1.Schema$TextStyle, extra?: Partial<docs_v1.Schema$ParagraphElement>): docs_v1.Schema$ParagraphElement {
  return { startIndex: start, endIndex: start + content.length, textRun: { content, textStyle }, ...extra };
}
function doc(content: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$Document {
  return { body: { content } };
}

describe('project', () => {
  it('maps each plain char to its Docs index', () => {
    const d = doc([para([run('abc', 5)])]);
    const p = project(d);
    expect(p.text).toBe('abc');
    expect(p.map).toEqual([5, 6, 7]);
  });
  it('concatenates runs and preserves per-run indices (gaps ok)', () => {
    const d = doc([para([run('ab', 5), run('cd', 10)])]);
    const p = project(d);
    expect(p.text).toBe('abcd');
    expect(p.map).toEqual([5, 6, 10, 11]);
  });

  it('descends into table cells (so edit_doc can target them)', () => {
    const cell = (content: string, start: number): docs_v1.Schema$TableCell => ({
      content: [para([run(content, start)])],
    });
    const d: docs_v1.Schema$Document = {
      body: {
        content: [
          para([run('intro ', 1)]),
          { table: { tableRows: [{ tableCells: [cell('A', 10), cell('B', 20)] }] } },
        ],
      },
    };
    const p = project(d);
    expect(p.text).toBe('intro AB');
    expect(p.map).toEqual([1, 2, 3, 4, 5, 6, 10, 20]);
  });
});

describe('renderMarkdown', () => {
  it('renders headings', () => {
    const d = doc([para([run('Title\n', 1)], { namedStyleType: 'HEADING_1' })]);
    expect(renderMarkdown(d)).toBe('# Title');
  });
  it('renders inline emphasis', () => {
    const d = doc([para([run('hi ', 1), run('bold', 4, { bold: true }), run(' ', 8), run('it', 9, { italic: true })])]);
    expect(renderMarkdown(d)).toBe('hi **bold** *it*');
  });
  it('renders links', () => {
    const d = doc([para([run('see ', 1), run('here', 5, { link: { url: 'https://x.com' } })])]);
    expect(renderMarkdown(d)).toBe('see [here](https://x.com)');
  });
  it('renders bullet lists', () => {
    const d = doc([
      para([run('one\n', 1)], undefined, { nestingLevel: 0 }),
      para([run('two\n', 5)], undefined, { nestingLevel: 1 }),
    ]);
    expect(renderMarkdown(d)).toBe('- one\n  - two');
  });
  it('renders non-default alignment as html', () => {
    const d = doc([para([run('centered\n', 1)], { alignment: 'CENTER' })]);
    expect(renderMarkdown(d)).toBe('<p style="text-align:center">centered</p>');
  });
  it('renders in-paragraph line breaks (U+000B) as <br>', () => {
    const d = doc([para([run('line1\x0bline2\n', 1)])]);
    expect(renderMarkdown(d)).toBe('line1<br>line2');
  });
  it('wraps suggestions in <ins>/<del> in tracked mode', () => {
    const d = doc([
      para([
        run('new', 1, undefined, { textRun: { content: 'new', suggestedInsertionIds: ['s1'] } }),
        run('old', 4, undefined, { textRun: { content: 'old', suggestedDeletionIds: ['s1'] } }),
      ]),
    ]);
    expect(renderMarkdown(d, { tracked: true })).toBe('<ins data-sug="s1">new</ins><del data-sug="s1">old</del>');
  });
});

// ---- #30: color/size/font must be visible in the read ----------------------
//
// DESIGN.md §2 makes inline HTML the escape hatch for formatting markdown can't
// express, and requires it be "visible in the read" so an agent can verify its
// own style changes. The writer parsed <span style="…"> all along; the reader
// never produced it, so a set_style colour change was invisible on re-read.

const md = (content: docs_v1.Schema$StructuralElement[]) => renderMarkdown(doc(content));

describe('renderRun — Docs-only formatting (#30)', () => {
  it('emits color, font-size and font-family as the span the writer parses', () => {
    expect(md([para([run('red', 1, { foregroundColor: { color: { rgbColor: { red: 1 } } } })])])).toBe(
      '<span style="color:#ff0000">red</span>',
    );
    expect(md([para([run('big', 1, { fontSize: { magnitude: 18, unit: 'PT' } })])])).toBe(
      '<span style="font-size:18pt">big</span>',
    );
    expect(md([para([run('serif', 1, { weightedFontFamily: { fontFamily: 'Georgia' } })])])).toBe(
      '<span style="font-family:Georgia">serif</span>',
    );
  });

  it('combines several into one span, in the order inline.ts reads back', () => {
    expect(
      md([para([run('x', 1, { foregroundColor: { color: { rgbColor: {} } } , fontSize: { magnitude: 9, unit: 'PT' } })])]),
    ).toBe('<span style="color:#000000;font-size:9pt">x</span>');
  });

  // The reason #31 had to land first: this shape was unparseable before.
  it('nests markdown emphasis inside the span', () => {
    expect(md([para([run('b', 1, { bold: true, foregroundColor: { color: { rgbColor: { blue: 1 } } } })])])).toBe(
      '<span style="color:#0000ff">**b**</span>',
    );
  });

  it('stays silent on runs that inherit their style', () => {
    expect(md([para([run('plain', 1)])])).toBe('plain');
    expect(md([para([run('styled but not in these fields', 1, { bold: true })])])).toBe(
      '**styled but not in these fields**',
    );
  });

  // Docs has no inline-code style — the writer maps `code` to a monospace font,
  // so the reader maps it back. Before this, backticks were silently dropped.
  it('renders the code font back to a code span, not a font-family span', () => {
    expect(md([para([run('x', 1, { weightedFontFamily: { fontFamily: 'Courier New' } })])])).toBe('`x`');
    // and other styles still wrap around it
    expect(md([para([run('x', 1, { weightedFontFamily: { fontFamily: 'Courier New' }, bold: true })])])).toBe('**`x`**');
  });

  it('ignores a theme color it cannot express as hex', () => {
    expect(md([para([run('t', 1, { foregroundColor: { color: {} } })])])).toBe('t');
  });
});

// ---- #30: embedded images carry their size ---------------------------------
//
// Docs keeps the embedded bytes, not the source URL, so `image:<objectId>` stays
// the durable handle (download_images resolves it). Size is the part markdown
// can't express, so it goes through the <img> escape hatch (DESIGN.md §2).

function imageDoc(size?: docs_v1.Schema$Size, title?: string): docs_v1.Schema$Document {
  return {
    body: { content: [{ paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'kix.a' } }] } }] },
    inlineObjects: { 'kix.a': { inlineObjectProperties: { embeddedObject: { size, title } } } },
  } as unknown as docs_v1.Schema$Document;
}
const pt = (n: number) => ({ magnitude: n, unit: 'PT' });

describe('renderImage (#30)', () => {
  it('emits the object marker with width and height in points', () => {
    expect(renderMarkdown(imageDoc({ width: pt(48), height: pt(48) }))).toBe(
      '<img src="image:kix.a" width="48" height="48">',
    );
  });

  it('includes alt when the document has one', () => {
    expect(renderMarkdown(imageDoc({ width: pt(10), height: pt(20) }, 'a chart'))).toBe(
      '<img src="image:kix.a" alt="a chart" width="10" height="20">',
    );
  });

  it('escapes quotes in alt so the tag stays parseable', () => {
    expect(renderMarkdown(imageDoc(undefined, 'say "hi" & <b>'))).toBe(
      '<img src="image:kix.a" alt="say &quot;hi&quot; &amp; &lt;b>">',
    );
  });

  it('omits dimensions it does not have', () => {
    expect(renderMarkdown(imageDoc())).toBe('<img src="image:kix.a">');
  });

  it('rounds fractional points rather than emitting full float noise', () => {
    expect(renderMarkdown(imageDoc({ width: pt(95.99999), height: pt(12.3456) }))).toBe(
      '<img src="image:kix.a" width="96" height="12.35">',
    );
  });
});

describe('renderRun — Docs’ automatic link colour (#32)', () => {
  const linked = (color: docs_v1.Schema$RgbColor) =>
    md([para([run('x', 1, { link: { url: 'http://x' }, foregroundColor: { color: { rgbColor: color } } })])]);

  it('suppresses the default link blue, which Docs writes in by itself', () => {
    expect(linked({ red: 0.06666667, green: 0.33333334, blue: 0.8 })).toBe('[x](http://x)');
  });

  it('still shows a deliberately different link colour', () => {
    expect(linked({ red: 1 })).toBe('<span style="color:#ff0000">[x](http://x)</span>');
  });
});
