import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { renderMarkdown } from '../src/docs/transformer.js';
import { styleRulesOf, renderStyleBlock } from '../src/docs/style-block.js';
import { parseBlocks, markdownToRequests } from '../src/docs/write.js';
import { writeDoc, insertContent } from '../src/docs/document.js';
import { StyleSyntaxError } from '../src/docs/css.js';

const pt = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

const NAMED_STYLES: docs_v1.Schema$NamedStyle[] = [
  {
    namedStyleType: 'NORMAL_TEXT',
    paragraphStyle: { alignment: 'START', lineSpacing: 115, spaceAbove: pt(0), spaceBelow: pt(8), indentStart: pt(0), indentFirstLine: pt(0) },
    textStyle: { fontSize: pt(11), weightedFontFamily: { fontFamily: 'Arial', weight: 400 } },
  },
  { namedStyleType: 'HEADING_1', paragraphStyle: { spaceAbove: pt(20), spaceBelow: pt(6) }, textStyle: { fontSize: pt(20) } },
  { namedStyleType: 'TITLE', textStyle: { fontSize: pt(26) } },
  { namedStyleType: 'SUBTITLE', textStyle: { fontSize: pt(15) } },
];

function docWith(paragraphs: docs_v1.Schema$Paragraph[]): docs_v1.Schema$Document {
  let index = 1;
  const content = paragraphs.map((paragraph) => {
    const text = paragraph.elements?.[0]?.textRun?.content ?? '';
    const el = { startIndex: index, endIndex: index + text.length, paragraph };
    index += text.length;
    return el;
  });
  return { body: { content }, namedStyles: { styles: NAMED_STYLES } };
}

const para = (text: string, style: docs_v1.Schema$ParagraphStyle = {}, bullet?: docs_v1.Schema$Bullet): docs_v1.Schema$Paragraph => ({
  elements: [{ textRun: { content: `${text}\n`, textStyle: {} } }],
  paragraphStyle: { namedStyleType: 'NORMAL_TEXT', ...style },
  bullet,
});

function writtenParagraphStyle(md: string): docs_v1.Schema$UpdateParagraphStyleRequest {
  const found = markdownToRequests(md, 1).requests.map((r) => r.updateParagraphStyle).filter(Boolean);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function roundTrip(style: docs_v1.Schema$ParagraphStyle, named = 'NORMAL_TEXT'): docs_v1.Schema$UpdateParagraphStyleRequest {
  return writtenParagraphStyle(renderMarkdown(docWith([para('x', { namedStyleType: named, ...style })])));
}

describe('a paragraph read from Docs writes back to the same style', () => {
  it.each([
    ['text-align', { alignment: 'CENTER' }, { alignment: 'CENTER' }, 'alignment'],
    ['line-height', { lineSpacing: 150 }, { lineSpacing: 150 }, 'lineSpacing'],
    ['margin-top', { spaceAbove: pt(12) }, { spaceAbove: pt(12) }, 'spaceAbove'],
    ['margin-bottom', { spaceBelow: pt(0) }, { spaceBelow: pt(0) }, 'spaceBelow'],
    ['margin-right', { indentEnd: pt(18) }, { indentEnd: pt(18) }, 'indentEnd'],
    ['margin-left', { indentStart: pt(36), indentFirstLine: pt(36) }, { indentStart: pt(36), indentFirstLine: pt(36) }, 'indentStart,indentFirstLine'],
    ['text-indent', { indentFirstLine: pt(36) }, { indentStart: pt(0), indentFirstLine: pt(36) }, 'indentStart,indentFirstLine'],
    ['hanging indent', { indentStart: pt(36), indentFirstLine: pt(18) }, { indentStart: pt(36), indentFirstLine: pt(18) }, 'indentStart,indentFirstLine'],
    ['unset first line', { indentStart: pt(36) }, { indentStart: pt(36), indentFirstLine: pt(0) }, 'indentStart,indentFirstLine'],
  ] as [string, docs_v1.Schema$ParagraphStyle, docs_v1.Schema$ParagraphStyle, string][])('%s', (_name, docsStyle, written, fields) => {
    const request = roundTrip(docsStyle);
    expect(request.paragraphStyle).toEqual(written);
    expect(request.fields).toBe(fields);
  });

  it('several properties at once', () => {
    const request = roundTrip({ alignment: 'JUSTIFIED', spaceAbove: pt(6), indentStart: pt(72), indentFirstLine: pt(54) });
    expect(request.paragraphStyle).toEqual({ alignment: 'JUSTIFIED', spaceAbove: pt(6), indentStart: pt(72), indentFirstLine: pt(54) });
  });

  it('Title and Subtitle', () => {
    expect(roundTrip({}, 'TITLE').paragraphStyle).toEqual({ namedStyleType: 'TITLE' });
    expect(roundTrip({}, 'SUBTITLE').paragraphStyle).toEqual({ namedStyleType: 'SUBTITLE' });
  });

  it('an overridden heading keeps its level and its override', () => {
    const request = roundTrip({ alignment: 'CENTER' }, 'HEADING_1');
    expect(request.paragraphStyle).toEqual({ namedStyleType: 'HEADING_1', alignment: 'CENTER' });
    expect(request.fields).toBe('namedStyleType,alignment');
  });

  it('a nested list item, read then written, gets its indent from its nesting alone', () => {
    const list = [
      para('Top', { indentStart: pt(36), indentFirstLine: pt(18) }, { listId: 'l', nestingLevel: 0 }),
      para('Nested', { indentStart: pt(72), indentFirstLine: pt(54) }, { listId: 'l', nestingLevel: 1 }),
    ];
    const { requests } = markdownToRequests(renderMarkdown(docWith(list)), 1);
    expect(requests.some((r) => r.updateParagraphStyle)).toBe(false);
    expect(requests.filter((r) => r.createParagraphBullets)).toHaveLength(1);
  });
});

describe('the <style> block writes back to the same named styles', () => {
  const written = (styles: docs_v1.Schema$NamedStyle[]): docs_v1.Schema$Request[] => {
    const doc = docWith([]);
    doc.namedStyles = { styles };
    return markdownToRequests(renderStyleBlock(styleRulesOf(doc)), 1).requests;
  };
  const rule = (requests: docs_v1.Schema$Request[], type: string) =>
    (requests as unknown as { updateNamedStyle: { namedStyle: docs_v1.Schema$NamedStyle; fields: string } }[])
      .map((r) => r.updateNamedStyle)
      .find((u) => u.namedStyle.namedStyleType === type)!;

  it('always lists namedStyleType in the field mask, which Docs rejects the request without', () => {
    const [request] = written([{ namedStyleType: 'HEADING_1', textStyle: { fontSize: pt(20) } }]);
    expect((request as unknown as { updateNamedStyle: { fields: string } }).updateNamedStyle.fields.split(',')).toContain('namedStyleType');
  });

  it.each([
    ['font-size', { fontSize: pt(12) }, 'textStyle.fontSize'],
    ['font-family', { weightedFontFamily: { fontFamily: 'Georgia' } }, 'textStyle.weightedFontFamily'],
    ['font-weight', { bold: true }, 'textStyle.bold'],
    ['font-style', { italic: true }, 'textStyle.italic'],
    ['text-decoration underline', { underline: true }, 'textStyle.underline'],
    ['text-decoration line-through', { strikethrough: true }, 'textStyle.strikethrough'],
    ['color', { foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } }, 'textStyle.foregroundColor'],
  ] as [string, docs_v1.Schema$TextStyle, string][])('%s', (_name, textStyle, field) => {
    const u = rule(written([{ namedStyleType: 'HEADING_2', textStyle }]), 'HEADING_2');
    expect(u.namedStyle.textStyle).toMatchObject(textStyle);
    expect(u.fields.split(',')).toContain(field);
  });

  it.each([
    ['text-align', { alignment: 'CENTER' }, 'paragraphStyle.alignment'],
    ['line-height', { lineSpacing: 150 }, 'paragraphStyle.lineSpacing'],
    ['margin-top', { spaceAbove: pt(9) }, 'paragraphStyle.spaceAbove'],
    ['margin-bottom', { spaceBelow: pt(9) }, 'paragraphStyle.spaceBelow'],
    ['margin-right', { indentEnd: pt(9) }, 'paragraphStyle.indentEnd'],
    ['margin-left with text-indent', { indentStart: pt(36), indentFirstLine: pt(18) }, 'paragraphStyle.indentFirstLine'],
  ] as [string, docs_v1.Schema$ParagraphStyle, string][])('%s', (_name, paragraphStyle, field) => {
    const u = rule(written([{ namedStyleType: 'HEADING_2', paragraphStyle }]), 'HEADING_2');
    expect(u.namedStyle.paragraphStyle).toMatchObject(paragraphStyle);
    expect(u.fields.split(',')).toContain(field);
  });

  it('the selector picks the named style', () => {
    const requests = written(NAMED_STYLES);
    for (const type of ['NORMAL_TEXT', 'HEADING_1', 'TITLE', 'SUBTITLE']) expect(rule(requests, type)).toBeDefined();
  });

  it('sends the rules before any text, so a create_doc styles the doc it fills', () => {
    const { requests } = markdownToRequests('<style>\np { font-size: 12pt }\n</style>\n\nHello', 1);
    expect(Object.keys(requests[0])).toEqual(['updateNamedStyle']);
    expect(requests.findIndex((r) => r.insertText)).toBeGreaterThan(0);
  });
});

describe('what the writer takes as CSS', () => {
  it('a hanging indent', () => {
    expect(writtenParagraphStyle('<p style="margin-left:36pt; text-indent:-18pt">4. Term</p>').paragraphStyle).toEqual({
      indentStart: pt(36),
      indentFirstLine: pt(18),
    });
  });

  it('margin-left alone puts the first line at the margin, as CSS does', () => {
    expect(writtenParagraphStyle('<p style="margin-left:36pt">x</p>').paragraphStyle).toEqual({ indentStart: pt(36), indentFirstLine: pt(36) });
  });

  it('text-indent alone is measured from margin 0', () => {
    expect(writtenParagraphStyle('<p style="text-indent:36pt">x</p>').paragraphStyle).toEqual({ indentStart: pt(0), indentFirstLine: pt(36) });
  });

  it('a bare <p> is a plain paragraph', () => {
    expect(parseBlocks('<p>Plain</p>')).toEqual([{ type: 'paragraph', text: 'Plain' }]);
  });

  it('a heading tag is a heading', () => {
    expect(writtenParagraphStyle('<h2 style="text-align:right">H</h2>').paragraphStyle).toEqual({ namedStyleType: 'HEADING_2', alignment: 'END' });
  });

  it('span styles reach the run', () => {
    const { requests } = markdownToRequests('<span style="font-size:14pt;color:#ff0000;font-weight:bold">c</span>', 1);
    const run = requests.find((r) => r.updateTextStyle?.textStyle?.fontSize)!.updateTextStyle!;
    expect(run.textStyle).toMatchObject({ bold: true, fontSize: pt(14) });
  });
});

describe('an unsupported style fails the whole write with every offending line', () => {
  const failure = (md: string): StyleSyntaxError => {
    try {
      parseBlocks(md);
    } catch (e) {
      return e as StyleSyntaxError;
    }
    throw new Error('expected parseBlocks to throw');
  };

  it('names both lines of <p style="border:1px"> and the supported set', () => {
    const error = failure('Intro\n\n<p style="border:1px">a</p>\n\nMiddle\n\n<p style="border:1px">b</p>');
    expect(error).toBeInstanceOf(StyleSyntaxError);
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain('line 3');
    expect(error.message).toContain('line 7');
    expect(error.message).toContain('border');
    for (const property of ['text-align', 'margin-left', 'text-indent', 'font-size', 'color']) expect(error.message).toContain(property);
  });

  it.each([
    ['a length in px', '<p style="margin-left:12px">x</p>'],
    ['a text property on a paragraph', '<p style="font-size:12pt">x</p>'],
    ['a paragraph property on a span', '<span style="margin-left:12pt">x</span>'],
    ['a bad color', '<span style="color:red">x</span>'],
    ['a span inside a wrapped paragraph', '<p style="text-align:center"><span style="float:left">x</span></p>'],
    ['a span inside a heading', '# <span style="float:left">x</span>'],
    ['a bad value', '<p style="text-align:middle">x</p>'],
    ['a declaration with no colon', '<p style="margin-left">x</p>'],
    ['an unknown class', '<p class="footnote">x</p>'],
    ['an unknown attribute', '<p id="a">x</p>'],
    ['a class on a heading', '<h1 class="title">x</h1>'],
    ['an unsupported selector', '<style>\nblockquote { margin-left: 9pt }\n</style>'],
    ['an unsupported rule property', '<style>\np { border: 1px }\n</style>'],
    ['an unclosed style block', '<style>\np { font-size: 9pt }'],
  ])('rejects %s', (_name, md) => {
    expect(() => parseBlocks(md)).toThrow(StyleSyntaxError);
  });

  it('collects problems from spans, lists and <style> rules in one error', () => {
    const error = failure('- item <span style="float:left">x</span>\n\n<style>\np { border: 1px }\n</style>\n\n<p style="z-index:1">y</p>');
    expect(error.issues).toHaveLength(3);
  });

  it('never writes into the document as visible characters', () => {
    expect(() => parseBlocks('<p style="border:1px">x</p>')).toThrow();
  });
});

describe('the whole write is refused before any request is sent', () => {
  const bad = '<p style="border:1px">a</p>\n\n<p style="float:left">b</p>';
  const clientsWith = (): { clients: GoogleClients; calls: ReturnType<typeof vi.fn>[] } => {
    const calls = [vi.fn().mockResolvedValue({ data: { id: 'x', documentId: 'x' } }), vi.fn().mockResolvedValue({ data: {} }), vi.fn().mockResolvedValue({ data: { body: { content: [{ endIndex: 2, paragraph: {} }] } } })];
    const clients = {
      docs: { documents: { create: calls[0], batchUpdate: calls[1], get: calls[2] } },
      drive: { files: { create: calls[0] }, comments: { list: vi.fn().mockResolvedValue({ data: {} }) } },
    } as unknown as GoogleClients;
    return { clients, calls };
  };

  it('write_doc does not even create the doc', async () => {
    const { clients, calls } = clientsWith();
    await expect(writeDoc(clients, '/Work/T', bad)).rejects.toThrow(StyleSyntaxError);
    expect(calls[0]).not.toHaveBeenCalled();
    expect(calls[1]).not.toHaveBeenCalled();
  });

  it('write_doc to an existing doc sends no batchUpdate', async () => {
    const { clients, calls } = clientsWith();
    await expect(writeDoc(clients, 'existing', bad)).rejects.toThrow(StyleSyntaxError);
    expect(calls[1]).not.toHaveBeenCalled();
  });

  it('insert_content sends no batchUpdate', async () => {
    const { clients, calls } = clientsWith();
    await expect(insertContent(clients, 'd', bad, {})).rejects.toThrow(StyleSyntaxError);
    expect(calls[1]).not.toHaveBeenCalled();
  });
});

describe('overwrite clears the paragraph style the new text would inherit', () => {
  it('only when asked, since insert_content must not touch its neighbours', () => {
    const plain = markdownToRequests('x', 1).requests;
    const reset = markdownToRequests('x', 1, undefined, undefined, { resetParagraphStyles: true }).requests;
    const clears = (rs: docs_v1.Schema$Request[]) => rs.filter((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT');
    expect(clears(plain)).toHaveLength(0);
    expect(clears(reset)).toHaveLength(1);
    expect(clears(reset)[0].updateParagraphStyle!.fields).toContain('indentFirstLine');
  });
});
