import { describe, it, expect, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import type { docs_v1 } from 'googleapis';
import { renderMarkdown } from '../src/docs/transformer.js';
import { markdownToRequests, parseBlocks } from '../src/docs/write.js';
import { parseInline } from '../src/docs/inline.js';
import { locate, editDoc } from '../src/docs/edit.js';

const paragraphOf = (text: string, style?: docs_v1.Schema$ParagraphStyle): docs_v1.Schema$StructuralElement => ({
  paragraph: { elements: [{ startIndex: 1, textRun: { content: `${text}\n` } }], paragraphStyle: style },
});
const bodyOf = (text: string): docs_v1.Schema$Document => ({ body: { content: [paragraphOf(text)] } });

const GAINED_STRUCTURE = ['createParagraphBullets', 'updateParagraphStyle'];

function writtenFrom(markdown: string): { text: string; gained: string[] } {
  const { requests, text } = markdownToRequests(markdown, 1);
  const gained = requests.flatMap((r) => {
    const kinds = GAINED_STRUCTURE.filter((k) => k in r);
    const styledRun = r.updateTextStyle && Object.keys(r.updateTextStyle.textStyle ?? {}).length > 0;
    return styledRun ? [...kinds, 'styled run'] : kinds;
  });
  return { text, gained };
}

const NEEDS_TAG: [string, string][] = [
  ['ordered list marker', '4. Term. The Company shall…'],
  ['ordered paren marker', '1) First'],
  ['task list marker', '- [ ] item'],
  ['checked task marker', '- [x] done'],
  ['dash marker', '- item'],
  ['star marker', '* item'],
  ['plus marker', '+ item'],
  ['heading', '# Heading'],
  ['deep heading', '###### Heading'],
  ['bare style tag', '<style>'],
  ['img tag line', '<img src="image:kix.a">'],
  ['comment line', '<!-- note -->'],
  ['paragraph tag', '<p>x</p>'],
  ['heading tag', '<h1>x</h1>'],
  ['styled paragraph tag', '<p style="text-align:center">x</p>'],
];

const NEEDS_ESCAPE: [string, string, string][] = [
  ['image line', '![alt](pic.png)', '!\\[alt](pic.png)'],
  ['asterisks', 'Price is 5 * 3 * 2', 'Price is 5 \\* 3 \\* 2'],
  ['link lookalike', '[Company Name](the Company) agrees', '\\[Company Name](the Company) agrees'],
  ['strikethrough', '~~draft~~ text', '\\~\\~draft\\~\\~ text'],
  ['bold tag', 'literal <b>bold</b>', 'literal \\<b>bold\\</b>'],
  ['underline tag', '<u>this</u>', '\\<u>this\\</u>'],
  ['backslash before punctuation', 'a\\_b', 'a\\\\_b'],
  ['dunder', '__init__ here', '\\_\\_init\\_\\_ here'],
  ['code span', 'run `make` now', 'run \\`make\\` now'],
  ['br tag', 'line<br>break', 'line\\<br>break'],
  ['anchor tag', '<a href="x">y</a>', '\\<a href="x">y\\</a>'],
  ['span with unsupported style', '<span style="border:1px">x</span>', '\\<span style="border:1px">x\\</span>'],
];

const STAYS_CLEAN = [
  '________',
  'Signed: ____ Date: ____',
  'file_name_here',
  '<Client Name>',
  '---',
  '***',
  'AT&T and &copy;',
  '| a | b |',
  '```',
  'Exhibit A.*',
  '2 * 3',
  'C:\\Users\\me',
  'Section 4. Term',
  '4.5 percent',
  '-5 degrees',
  '#hashtag',
  '> quoted',
  '-',
];

describe('literal text round trip (#52)', () => {
  const lines = [...NEEDS_TAG.map(([, t]) => t), ...NEEDS_ESCAPE.map(([, t]) => t), ...STAYS_CLEAN];

  it.each(lines)('%s reads, writes and reads back unchanged', (text) => {
    const read = renderMarkdown(bodyOf(text));
    const { text: written, gained } = writtenFrom(read);
    expect(written).toBe(`${text}\n`);
    expect(gained).toEqual([]);
    expect(renderMarkdown(bodyOf(written.slice(0, -1)))).toBe(read);
  });

  it.each(NEEDS_TAG)('%s reads as a <p> paragraph', (_name, text) => {
    expect(renderMarkdown(bodyOf(text))).toBe(`<p>${text}</p>`);
  });

  it.each(NEEDS_ESCAPE)('%s reads with only the escape it needs', (_name, text, escaped) => {
    expect(renderMarkdown(bodyOf(text))).toBe(escaped);
  });

  it.each(STAYS_CLEAN)('%s reads with no escape and no <p>', (text) => {
    expect(renderMarkdown(bodyOf(text))).toBe(text);
  });
});

describe('literal text next to real formatting (#52)', () => {
  const bold = { bold: true };
  const runs = (parts: [string, docs_v1.Schema$TextStyle?][]): docs_v1.Schema$Document => ({
    body: {
      content: [
        {
          paragraph: {
            elements: parts.map(([content, textStyle], k) => ({ startIndex: 1 + k, textRun: { content: k === parts.length - 1 ? `${content}\n` : content, textStyle } })),
          },
        },
      ],
    },
  });

  it('escapes literal asterisks beside a real bold run and keeps the bold', () => {
    const read = renderMarkdown(runs([['a * b * c ', undefined], ['bold', bold]]));
    expect(parseInline(read)).toEqual([{ text: 'a * b * c ' }, { text: 'bold', bold: true }]);
  });

  it('does not let a trailing backslash swallow the bold marker', () => {
    const read = renderMarkdown(runs([['path\\', bold]]));
    expect(parseInline(read)).toEqual([{ text: 'path\\', bold: true }]);
  });

  it('puts one <p> tag on a styled paragraph whose words also spell a list', () => {
    const doc: docs_v1.Schema$Document = { body: { content: [paragraphOf('4. Term', { alignment: 'CENTER' })] } };
    const read = renderMarkdown(doc);
    expect(read).toBe('<p style="text-align:center">4. Term</p>');
    const [block] = parseBlocks(read);
    expect(block).toMatchObject({ type: 'paragraph', text: '4. Term', css: { align: 'center' } });
  });

  it('leaves a heading with list-looking words as a heading', () => {
    const doc: docs_v1.Schema$Document = { body: { content: [paragraphOf('4. Term', { namedStyleType: 'HEADING_2' })] } };
    expect(renderMarkdown(doc)).toBe('## 4. Term');
  });

  it('leaves a list item with list-looking words as one list item', () => {
    const doc: docs_v1.Schema$Document = { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: '4. Term\n' } }], bullet: { listId: 'l' } } }] } };
    expect(renderMarkdown(doc)).toBe('- 4. Term');
  });
});

describe('literal text in table cells and header segments (#52)', () => {
  const cellOf = (text: string): docs_v1.Schema$TableCell => ({ content: [paragraphOf(text)] });
  const tableDoc = (cells: string[]): docs_v1.Schema$Document => ({
    body: { content: [{ table: { tableRows: [{ tableCells: cells.map(cellOf) }] } }] },
  });

  const cellTexts = ['5 * 3 * 2', '4. Term', 'a|b', 'a\\|b', '[x](y)', 'plain', 'file_name', '~~x~~', 'a\\'];

  it.each(cellTexts)('cell %s reads back as the same words', (text) => {
    const read = renderMarkdown(tableDoc([text, 'other']));
    const table = parseBlocks(`${read}\n| x | y |`);
    const rows = table[0].type === 'table' ? table[0].rows : [];
    expect(parseInline(rows[0][0]).map((s) => s.text).join('')).toBe(text);
  });

  it('a cell of only 4. Term is not wrapped in <p>', () => {
    expect(renderMarkdown(tableDoc(['4. Term', 'x']))).toBe('| 4. Term | x |\n| --- | --- |');
  });

  it('marks the same text in a header segment as in the body', () => {
    const doc: docs_v1.Schema$Document = { headers: { h1: { headerId: 'h1', content: [paragraphOf('4. Term and 5 * 3 * 2')] } } };
    expect(renderMarkdown(doc, { segmentId: 'h1' })).toBe('<p>4. Term and 5 \\* 3 \\* 2</p>');
  });
});

describe('edit_doc finds literal text however it reads (#52)', () => {
  const docText = '4. Term. The Company shall pay 5 * 3 * 2 for a\\_b';
  it.each([
    ['plain words', '5 * 3'],
    ['the escape as read', '5 \\* 3'],
    ['a list-looking start', '4. Term'],
    ['the wrapper as read', '<p>4. Term. The Company shall'],
    ['a real backslash as read', 'a\\\\_b'],
  ])('%s', (_name, old) => {
    const { positions } = locate(docText, old);
    expect(positions).toHaveLength(1);
  });
});

describe('edge whitespace on a line (#54)', () => {
  const EDGE_WHITESPACE: [string, string][] = [
    ['leading tab', '\tIndented clause'],
    ['four leading spaces', '    Four spaces'],
    ['trailing tab', 'Trailing tab\t'],
    ['trailing spaces', 'Trailing spaces  '],
    ['leading and trailing tab', '\tBoth\t'],
    ['only a tab', '\t'],
  ];

  it.each(EDGE_WHITESPACE)('%s reads as a <p> paragraph', (_name, text) => {
    expect(renderMarkdown(bodyOf(text))).toBe(`<p>${text}</p>`);
  });

  it.each(EDGE_WHITESPACE)('%s reads, writes and reads back unchanged', (_name, text) => {
    const read = renderMarkdown(bodyOf(text));
    const { text: written, gained } = writtenFrom(read);
    expect(written).toBe(`${text}\n`);
    expect(gained).toEqual([]);
    expect(renderMarkdown(bodyOf(written.slice(0, -1)))).toBe(read);
  });

  it.each([
    ['<p>\tWrapped tab</p>', '\tWrapped tab'],
    ['<p>  spaced  </p>', '  spaced  '],
    ['<p style="text-align:center">\tCentered\t</p>', '\tCentered\t'],
    ['<p class="title">\tTitled</p>', '\tTitled'],
  ])('%s keeps every space and tab', (markdown, text) => {
    expect(writtenFrom(markdown).text).toBe(`${text}\n`);
  });

  it.each([
    ['\tIndented clause', 'Indented clause'],
    ['    Four spaces', 'Four spaces'],
    ['Trailing tab\t', 'Trailing tab'],
  ])('outside <p> %j is still trimmed', (markdown, text) => {
    expect(writtenFrom(markdown).text).toBe(`${text}\n`);
  });

  it('keeps a tab in the middle of a line with no mark', () => {
    expect(renderMarkdown(bodyOf('Name:\tSmith'))).toBe('Name:\tSmith');
    expect(writtenFrom('Name:\tSmith').text).toBe('Name:\tSmith\n');
  });

  it('does not wrap ordinary text', () => {
    expect(renderMarkdown(bodyOf('Plain sentence.'))).toBe('Plain sentence.');
  });

  it('keeps edge whitespace on a wrapped line inside a list-looking paragraph', () => {
    expect(writtenFrom('<p>\t4. Term</p>').text).toBe('\t4. Term\n');
  });
});

describe('edge whitespace through edit_doc (#54)', () => {
  const docWith = (text: string): docs_v1.Schema$Document => ({
    revisionId: 'r1',
    body: { content: [{ startIndex: 1, endIndex: text.length + 2, ...paragraphOf(text) }] },
  });
  const clientsFor = (doc: docs_v1.Schema$Document, batchUpdate: ReturnType<typeof vi.fn>): GoogleClients =>
    ({
      auth: {},
      docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } },
      drive: {},
    }) as unknown as GoogleClients;
  const insertedText = (batchUpdate: ReturnType<typeof vi.fn>): string[] =>
    batchUpdate.mock.calls.flatMap((c) => c[0].requestBody.requests.flatMap((r: docs_v1.Schema$Request) => (r.insertText ? [r.insertText.text] : [])));

  it('inserts a tab typed inside <p>', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docWith('Clause'), batchUpdate), 'd', 'Clause', '<p>\tIndented clause</p>');
    expect(insertedText(batchUpdate)).toEqual(['\tIndented clause']);
  });

  it('reports what an anchor with four spaces finds where the doc has a tab', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const result = await editDoc(clientsFor(docWith('\tIndented clause'), batchUpdate), 'd', '    Indented clause', 'X');
    console.log('TAB-VS-SPACES', JSON.stringify(result));
  });
});

describe('edge whitespace in a table cell (#54)', () => {
  const tableOf = (cells: string[]): docs_v1.Schema$Document => ({
    body: {
      content: [
        {
          table: {
            tableRows: [
              { tableCells: cells.map(() => ({ content: [paragraphOf('h')] })) },
              { tableCells: cells.map((text) => ({ content: [paragraphOf(text)] })) },
            ],
          },
        },
      ],
    },
  });
  const cellsWritten = (markdown: string): string[][] => {
    const [table] = parseBlocks(markdown);
    return table.type === 'table' ? table.rows : [];
  };

  it.each([['\tIndented'], ['Signature:\t'], ['  padded  '], ['<p>x</p>'], ['plain']])('%j reads, writes and reads back unchanged', (text) => {
    const read = renderMarkdown(tableOf([text]));
    expect(cellsWritten(read)[1]).toEqual([text]);
    expect(renderMarkdown(tableOf([cellsWritten(read)[1][0]]))).toBe(read);
  });

  it('wraps only the cell with edge whitespace', () => {
    expect(renderMarkdown(tableOf(['a', '\tb']))).toBe('| h | h |\n| --- | --- |\n| a | <p>\tb</p> |');
  });

  it('trims a cell outside <p>', () => {
    expect(cellsWritten('| h |\n| --- |\n|   plain \t|')[1]).toEqual(['plain']);
  });
});
