import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { renderMarkdown, project } from '../src/docs/transformer.js';
import { markdownToRequests, parseBlocks } from '../src/docs/write.js';
import { editDoc } from '../src/docs/edit.js';
import { measureLoss, lossSummary } from '../src/docs/loss.js';
import { StyleSyntaxError } from '../src/docs/css.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDoc = JSON.parse(readFileSync(path.join(here, 'fixtures', 'page-breaks-doc.json'), 'utf8')) as docs_v1.Schema$Document;

const BREAK = '<div style="page-break-after:always"></div>';

const READ_OF_API_DOC = ['Title page', BREAK, 'Body one', BREAK, 'Second', 'Third', BREAK, 'tail', 'Fourth'].join('\n\n');

const PAGE_BREAK_MARK = '\u0001';

function applyToText(markdown: string): string {
  let doc = '\n';
  for (const request of markdownToRequests(markdown, 1).requests) {
    if (request.insertText) {
      const at = request.insertText.location!.index! - 1;
      doc = doc.slice(0, at) + request.insertText.text + doc.slice(at);
    } else if (request.insertPageBreak) {
      const at = request.insertPageBreak.location!.index! - 1;
      doc = doc.slice(0, at) + PAGE_BREAK_MARK + '\n' + doc.slice(at);
    }
  }
  return doc;
}

function docFromText(text: string): docs_v1.Schema$Document {
  const paragraphs = text.split('\n').slice(0, -1);
  return {
    body: {
      content: paragraphs.map((line) => ({
        paragraph: {
          elements: [
            ...line.split(PAGE_BREAK_MARK).flatMap((chunk, k) => [...(k > 0 ? [{ pageBreak: {} }] : []), ...(chunk ? [{ textRun: { content: chunk } }] : [])]),
            { textRun: { content: '\n' } },
          ],
        },
      })),
    },
  };
}

describe('a page break reads as a CSS break on its own line (#48)', () => {
  it('reads every shape the API gives: after text, alone, with text after it, and skips the empty paragraph Google adds', () => {
    expect(renderMarkdown(apiDoc)).toBe(READ_OF_API_DOC);
  });

  it('reads a section break as nothing', () => {
    expect(renderMarkdown(apiDoc)).not.toMatch(/section/i);
  });
});

describe('a page break writes as insertPageBreak (#48)', () => {
  it('sends the break at the start of the paragraph that follows it, after the text', () => {
    const { requests, text } = markdownToRequests(`Title page\n\n${BREAK}\n\nBody`, 1);
    expect(text).toBe('Title page\nBody\n');
    const kinds = requests.map((r) => Object.keys(r)[0]);
    expect(kinds.indexOf('insertText')).toBeLessThan(kinds.indexOf('insertPageBreak'));
    expect(requests.find((r) => r.insertPageBreak)?.insertPageBreak?.location?.index).toBe(12);
  });

  it('puts a break in Normal text with no bullet, wherever the paragraph after it is a heading or a list item', () => {
    const { requests } = markdownToRequests(`${BREAK}\n\n# Heading\n\n${BREAK}\n\n- item`, 1);
    const after = requests.slice(requests.findIndex((r) => r.insertPageBreak));
    expect(after.filter((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT')).toHaveLength(2);
    expect(after.filter((r) => r.deleteParagraphBullets)).toHaveLength(2);
  });

  it('inserts breaks from the highest index down, so each index is still true when it is used', () => {
    const { requests } = markdownToRequests(`A\n\n${BREAK}\n\nB\n\n${BREAK}\n\nC`, 1);
    expect(requests.filter((r) => r.insertPageBreak).map((r) => r.insertPageBreak!.location!.index)).toEqual([5, 3]);
  });

  it('moves a table or image placement past the breaks before it', () => {
    const { tables } = markdownToRequests(`${BREAK}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |`, 1);
    expect(tables[0].index).toBe(3);
  });

  it('refuses a break in a header or footer, which the API refuses too', () => {
    expect(() => markdownToRequests(`A\n\n${BREAK}`, 1, undefined, 'kix.header')).toThrow(/header or footer/);
  });

  it('a break that follows text in its paragraph leaves that paragraph alone', () => {
    const { requests } = markdownToRequests(BREAK, 5, undefined, undefined, { startsParagraph: false });
    expect(requests.map((r) => Object.keys(r)[0])).toEqual(['insertPageBreak']);
  });

  it('a break alone still sends insertText only for the words', () => {
    const { requests, text } = markdownToRequests(BREAK, 1);
    expect(text).toBe('');
    expect(requests.map((r) => Object.keys(r)[0])[0]).toBe('insertPageBreak');
  });
});

describe('read → write → read is identical (#48)', () => {
  it('for the API doc', () => {
    const written = applyToText(READ_OF_API_DOC);
    expect(renderMarkdown(docFromText(written))).toBe(READ_OF_API_DOC);
  });

  it('a break at the very start and the very end', () => {
    const markdown = [BREAK, 'Only text', BREAK].join('\n\n');
    expect(renderMarkdown(docFromText(applyToText(markdown)))).toBe(markdown);
  });

  it('two breaks in a row', () => {
    const markdown = ['A', BREAK, BREAK, 'B'].join('\n\n');
    expect(renderMarkdown(docFromText(applyToText(markdown)))).toBe(markdown);
  });
});

const SPELLINGS: [string, string][] = [
  ['the read form', BREAK],
  ['page-break-before on a div', '<div style="page-break-before:always"></div>'],
  ['spaces and case', '<DIV style="Page-Break-After: always;"></DIV>'],
  ['break-after: page', '<div style="break-after: page"></div>'],
  ['break-before: page', '<div style="break-before:page"></div>'],
  ["Google's HTML export", '<hr style="page-break-before:always;display:none;">'],
  ['a self-closed hr', '<hr style="page-break-after:always"/>'],
];

describe('each accepted spelling writes a page break (#48)', () => {
  it.each(SPELLINGS)('%s', (_name, line) => {
    const { requests } = markdownToRequests(`A\n\n${line}\n\nB`, 1);
    expect(requests.filter((r) => r.insertPageBreak)).toHaveLength(1);
  });

  it('lines with no blank line between them are still three blocks', () => {
    expect(parseBlocks(`A\n${BREAK}\nB`).map((b) => b.type)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
  });
});

const REFUSED: [string, string][] = [
  ['a div with another style', '<div style="color:red"></div>'],
  ['a div with a break and another style', '<div style="page-break-after:always;color:red"></div>'],
  ['a div with no style', '<div></div>'],
  ['a div with a class', '<div class="pb"></div>'],
  ['an hr with no style', '<hr>'],
  ['an hr with another style', '<hr style="border:1px solid">'],
  ['a break value that is not a break', '<div style="page-break-after:avoid"></div>'],
];

describe('any other div or hr is refused before a request is sent (#48)', () => {
  it.each(REFUSED)('%s', (_name, line) => {
    expect(() => markdownToRequests(`A\n\n${line}\n\nB`, 1)).toThrow(StyleSyntaxError);
  });

  it('names the line and what is accepted', () => {
    try {
      markdownToRequests(`A\n\n<div style="color:red"></div>`, 1);
      expect.unreachable();
    } catch (error) {
      expect((error as StyleSyntaxError).message).toMatch(/line 3/);
      expect((error as StyleSyntaxError).message).toContain('page-break-after:always');
    }
  });

  it('text that merely contains a div is text', () => {
    const { requests } = markdownToRequests('see <div> here', 1);
    expect(requests.filter((r) => r.insertPageBreak)).toHaveLength(0);
  });
});

describe('text that spells the break reads as text (#48, §2b)', () => {
  const literal: docs_v1.Schema$Document = {
    body: { content: [{ paragraph: { elements: [{ textRun: { content: `${BREAK}\n` } }] } }] },
  };

  it('is wrapped in <p>, which the writer keeps as words', () => {
    expect(renderMarkdown(literal)).toBe(`<p>${BREAK}</p>`);
  });

  it('writes back as a paragraph, with no break', () => {
    const { requests, text } = markdownToRequests(renderMarkdown(literal), 1);
    expect(text).toBe(`${BREAK}\n`);
    expect(requests.filter((r) => r.insertPageBreak)).toHaveLength(0);
  });

  it('a real break beside it reads bare', () => {
    const both: docs_v1.Schema$Document = {
      body: { content: [...literal.body!.content!, { paragraph: { elements: [{ pageBreak: {} }, { textRun: { content: '\n' } }] } }] },
    };
    expect(renderMarkdown(both)).toBe(`<p>${BREAK}</p>\n\n${BREAK}`);
  });

  it.each([['a bare hr', '<hr>'], ['Google hr', '<hr style="page-break-before:always;display:none;">']])('%s as document text', (_name, line) => {
    const doc: docs_v1.Schema$Document = { body: { content: [{ paragraph: { elements: [{ textRun: { content: `${line}\n` } }] } }] } };
    const markdown = renderMarkdown(doc);
    expect(markdown).toBe(`<p>${line}</p>`);
    expect(markdownToRequests(markdown, 1).text).toBe(`${line}\n`);
  });
});

const clientsFor = (doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients => ({
  auth: {} as GoogleClients['auth'],
  docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } } as unknown as GoogleClients['docs'],
  drive: {} as GoogleClients['drive'],
});

const sentBy = (batchUpdate: ReturnType<typeof vi.fn>): docs_v1.Schema$Request[] => batchUpdate.mock.calls[0][0].requestBody.requests;

const plainDoc: docs_v1.Schema$Document = {
  revisionId: 'r1',
  body: {
    content: [
      { startIndex: 1, endIndex: 12, paragraph: { elements: [{ startIndex: 1, endIndex: 12, textRun: { content: 'Title page\n' } }], paragraphStyle: { namedStyleType: 'TITLE' } } },
      { startIndex: 12, endIndex: 29, paragraph: { elements: [{ startIndex: 12, endIndex: 29, textRun: { content: 'Body starts here\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } },
    ],
  },
};

describe('edit_doc and page breaks (#48)', () => {
  it('projects a break as its own line, the same one the read shows', () => {
    const { text } = project(apiDoc);
    expect(text.startsWith(`Title page\n${BREAK}\n`)).toBe(true);
    expect(text).toContain(`Body one\n${BREAK}\nSecond\n`);
    expect(text).toContain(`Third\n${BREAK}\ntail\n`);
  });

  it('inserts a break after the anchor', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const result = await editDoc(clientsFor(plainDoc, batch), 'd', 'Title page', `Title page\n${BREAK}`);
    expect(result.status).toBe('ok');
    const requests = sentBy(batch);
    expect(requests.find((r) => r.insertText)?.insertText).toMatchObject({ text: 'Title page', location: { index: 1 } });
    expect(requests.find((r) => r.insertPageBreak)?.insertPageBreak?.location?.index).toBe(11);
  });

  it('inserts a break between two paragraphs, at the start of the second', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(plainDoc, batch), 'd', 'Body starts', `${BREAK}\nBody starts`);
    const requests = sentBy(batch);
    expect(requests.find((r) => r.insertText)?.insertText?.text).toBe('Body starts');
    expect(requests.find((r) => r.insertPageBreak)?.insertPageBreak?.location?.index).toBe(12);
  });

  it('keeps the title style of the paragraph the break follows', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(plainDoc, batch), 'd', '<p class="title">Title page</p>', `<p class="title">Title page</p>\n${BREAK}`);
    const requests = sentBy(batch);
    expect(requests.filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType)).toEqual(['TITLE']);
    expect(requests.filter((r) => r.deleteParagraphBullets)).toHaveLength(0);
  });

  it('resets the paragraph a break makes of its own, wherever the anchor starts a paragraph', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(plainDoc, batch), 'd', 'Body starts', `${BREAK}\nBody starts`);
    expect(sentBy(batch).filter((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT')).toHaveLength(1);
  });

  it('leaves a paragraph alone when the anchor is in the middle of it', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(plainDoc, batch), 'd', 'starts here', `${BREAK}\nstarts here`);
    expect(sentBy(batch).filter((r) => r.updateParagraphStyle)).toHaveLength(0);
    expect(sentBy(batch).filter((r) => r.insertPageBreak)).toHaveLength(1);
  });

  it('takes any accepted spelling in new_string', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(plainDoc, batch), 'd', 'Title page', 'Title page\n<hr style="page-break-before:always;display:none;">');
    expect(sentBy(batch).filter((r) => r.insertPageBreak)).toHaveLength(1);
  });

  it('refuses any other div in new_string, and sends nothing', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await expect(editDoc(clientsFor(plainDoc, batch), 'd', 'Title page', 'Title page\n<div style="color:red"></div>')).rejects.toThrow(StyleSyntaxError);
    expect(batch).not.toHaveBeenCalled();
  });

  it('an anchor can span a break', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const result = await editDoc(clientsFor(apiDoc, batch), 'd', `Body one\n${BREAK}\nSecond`, 'Body one and second');
    expect(result.status).toBe('ok');
    const requests = sentBy(batch);
    expect(requests[0].deleteContentRange?.range).toMatchObject({ startIndex: 14, endIndex: 31 });
    expect(requests.find((r) => r.insertText)?.insertText?.text).toBe('Body one and second');
  });

  it('an anchor that ends on the break leaves the paragraph mark, and takes the break with it', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(apiDoc, batch), 'd', `Title page\n${BREAK}`, 'Title page');
    expect(sentBy(batch)[0].deleteContentRange?.range).toMatchObject({ startIndex: 1, endIndex: 12 });
    expect(sentBy(batch).filter((r) => r.insertPageBreak)).toHaveLength(0);
  });

  it('a break removed by editing does not come back: the words alone are the whole edit', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(apiDoc, batch), 'd', `${BREAK}\nSecond`, 'Second');
    const requests = sentBy(batch);
    expect(requests[0].deleteContentRange?.range).toMatchObject({ startIndex: 23, endIndex: 31 });
    expect(requests.filter((r) => r.insertPageBreak)).toHaveLength(0);
  });
});

describe('the loss summary counts section breaks and column breaks (#48)', () => {
  const withColumnBreak = (() => {
    const copy = JSON.parse(JSON.stringify(apiDoc)) as docs_v1.Schema$Document;
    const fourth = copy.tabs![0].documentTab!.body!.content!.find((e) => e.paragraph?.elements?.[0]?.textRun?.content === 'Fourth\n')!;
    fourth.paragraph!.elements!.splice(0, 0, { startIndex: 46, endIndex: 47, columnBreak: { textStyle: {} } } as docs_v1.Schema$ParagraphElement);
    return copy;
  })();

  it('counts the one section break the API doc holds, and not the section every doc starts with', () => {
    expect(measureLoss(apiDoc, 't.0', 0)).toMatchObject({ sectionBreaks: 1, columnBreaks: 0 });
  });

  it('counts a column break', () => {
    expect(measureLoss(withColumnBreak, 't.0', 0)).toMatchObject({ sectionBreaks: 1, columnBreaks: 1 });
  });

  it('says so in the summary, and page breaks are not in it, since they are carried', () => {
    expect(lossSummary(measureLoss(withColumnBreak, 't.0', 0))).toMatch(/1 section break, 1 column break$/);
    expect(lossSummary(measureLoss(withColumnBreak, 't.0', 0))).not.toMatch(/page break/);
  });

  it('a doc with neither says nothing about them', () => {
    expect(lossSummary(measureLoss(plainDoc, undefined, 0))).toBe('2 paragraphs');
  });
});
