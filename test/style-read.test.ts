import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { renderMarkdown } from '../src/docs/transformer.js';
import { styleRulesOf, renderStyleBlock } from '../src/docs/style-block.js';
import { readDoc } from '../src/docs/read.js';

const pt = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

const NAMED_STYLES: docs_v1.Schema$NamedStyle[] = [
  {
    namedStyleType: 'NORMAL_TEXT',
    paragraphStyle: { alignment: 'START', lineSpacing: 115, spaceAbove: { unit: 'PT' }, spaceBelow: pt(8), indentStart: { unit: 'PT' }, indentFirstLine: { unit: 'PT' } },
    textStyle: { fontSize: pt(11), weightedFontFamily: { fontFamily: 'Arial', weight: 400 }, bold: false },
  },
  { namedStyleType: 'HEADING_1', paragraphStyle: { spaceAbove: pt(20), spaceBelow: pt(6) }, textStyle: { fontSize: pt(20) } },
  { namedStyleType: 'TITLE', textStyle: { fontSize: pt(26), bold: true } },
  { namedStyleType: 'SUBTITLE', textStyle: { fontSize: pt(15), italic: true, foregroundColor: { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } } } },
];

function docWith(paragraphs: docs_v1.Schema$Paragraph[], namedStyles = NAMED_STYLES): docs_v1.Schema$Document {
  let index = 1;
  const content = paragraphs.map((paragraph) => {
    const text = paragraph.elements?.[0]?.textRun?.content ?? '';
    const el = { startIndex: index, endIndex: index + text.length, paragraph };
    index += text.length;
    return el;
  });
  return { body: { content }, namedStyles: { styles: namedStyles } };
}

const para = (text: string, style: docs_v1.Schema$ParagraphStyle = {}, bullet?: docs_v1.Schema$Bullet): docs_v1.Schema$Paragraph => ({
  elements: [{ textRun: { content: `${text}\n`, textStyle: {} } }],
  paragraphStyle: { namedStyleType: 'NORMAL_TEXT', ...style },
  bullet,
});

const read = (p: docs_v1.Schema$Paragraph): string => renderMarkdown(docWith([p]));

describe('the <style> block', () => {
  it('has one rule per named style the doc defines, in a fixed order', () => {
    const block = renderStyleBlock(styleRulesOf(docWith([])));
    expect(block).toBe(
      [
        '<style>',
        'p { font-family: Arial; font-size: 11pt; text-align: left; line-height: 1.15; margin-top: 0pt; margin-bottom: 8pt }',
        'h1 { font-size: 20pt; margin-top: 20pt; margin-bottom: 6pt }',
        '.title { font-size: 26pt; font-weight: bold }',
        '.subtitle { font-size: 15pt; font-style: italic; color: #666666 }',
        '</style>',
      ].join('\n'),
    );
  });

  it('omits a false boolean and a zero indent, which are what an unset field means', () => {
    expect(renderStyleBlock(styleRulesOf(docWith([])))).not.toMatch(/font-weight: normal|margin-left|text-indent/);
  });

  it('is empty when the doc defines no named styles', () => {
    expect(renderStyleBlock(styleRulesOf(docWith([], [])))).toBe('');
  });

  it('opens read_doc, before the body', async () => {
    const clients = { docs: { documents: { get: vi.fn().mockResolvedValue({ data: docWith([para('Hello')]) }) } } } as unknown as GoogleClients;
    const { markdown } = await readDoc(clients, 'd');
    expect(markdown.startsWith('<style>\np { ')).toBe(true);
    expect(markdown.endsWith('</style>\n\nHello')).toBe(true);
  });
});

describe('paragraphs read as their named style, plus only what they override', () => {
  it('emits nothing for a paragraph that inherits everything', () => {
    expect(read(para('Plain'))).toBe('Plain');
  });

  it('emits nothing for a direct value equal to the rule', () => {
    expect(read(para('Plain', { spaceBelow: pt(8), lineSpacing: 115, alignment: 'START' }))).toBe('Plain');
  });

  it.each([
    ['text-align', { alignment: 'CENTER' }, 'text-align:center'],
    ['line-height', { lineSpacing: 150 }, 'line-height:1.5'],
    ['margin-top', { spaceAbove: pt(12) }, 'margin-top:12pt'],
    ['margin-bottom', { spaceBelow: pt(0) }, 'margin-bottom:0pt'],
    ['margin-right', { indentEnd: pt(18) }, 'margin-right:18pt'],
  ] as [string, docs_v1.Schema$ParagraphStyle, string][])('reads %s as a style attribute', (_property, style, css) => {
    expect(read(para('x', style))).toBe(`<p style="${css}">x</p>`);
  });

  it('reads a hanging indent as margin-left and a negative text-indent', () => {
    expect(read(para('4. Term', { indentStart: pt(36), indentFirstLine: pt(18) }))).toBe(
      '<p style="margin-left:36pt; text-indent:-18pt">4. Term</p>',
    );
  });

  it('reads a first-line indent from the margin as a bare text-indent', () => {
    expect(read(para('x', { indentFirstLine: pt(36) }))).toBe('<p style="text-indent:36pt">x</p>');
  });

  it('reads an unset first line as sitting at the page margin (Docs exports it as text-indent:-start)', () => {
    expect(read(para('x', { indentStart: pt(36) }))).toBe('<p style="margin-left:36pt; text-indent:-36pt">x</p>');
  });

  it('reads margin-left with no text-indent when the first line follows it', () => {
    expect(read(para('x', { indentStart: pt(36), indentFirstLine: pt(36) }))).toBe('<p style="margin-left:36pt">x</p>');
  });
});

describe('lists own their indent', () => {
  const bullet = (nestingLevel: number): docs_v1.Schema$Bullet => ({ listId: 'l', nestingLevel });

  it('emits no indent for a nested list item, whatever Docs stored', () => {
    const nested = para('Nested', { indentStart: pt(72), indentFirstLine: pt(54) }, bullet(1));
    const top = para('Top', { indentStart: pt(36), indentFirstLine: pt(18) }, bullet(0));
    const md = renderMarkdown(docWith([top, nested]));
    expect(md).toBe('- Top\n  - Nested');
    expect(md).not.toMatch(/margin-left|text-indent|style=/);
  });

  it('emits no style even for alignment on a list item', () => {
    expect(renderMarkdown(docWith([para('x', { alignment: 'CENTER' }, bullet(0))]))).toBe('- x');
  });
});

describe('named-style paragraphs', () => {
  it('reads Title and Subtitle as a class, since HTML has no tag for them', () => {
    expect(read(para('Operating Agreement', { namedStyleType: 'TITLE' }))).toBe('<p class="title">Operating Agreement</p>');
    expect(read(para('Draft', { namedStyleType: 'SUBTITLE' }))).toBe('<p class="subtitle">Draft</p>');
  });

  it('keeps the class beside an override', () => {
    expect(read(para('T', { namedStyleType: 'TITLE', alignment: 'CENTER' }))).toBe('<p class="title" style="text-align:center">T</p>');
  });

  it('reads a plain heading as # and an overridden heading as its tag', () => {
    expect(read(para('H', { namedStyleType: 'HEADING_1' }))).toBe('# H');
    expect(read(para('H', { namedStyleType: 'HEADING_1', alignment: 'CENTER' }))).toBe('<h1 style="text-align:center">H</h1>');
  });

  it('compares a heading against its own rule, not against Normal text', () => {
    expect(read(para('H', { namedStyleType: 'HEADING_1', spaceAbove: pt(20) }))).toBe('# H');
  });
});

describe('rules that carry more than the basics', () => {
  const rulesFor = (styles: docs_v1.Schema$NamedStyle[]): string => renderStyleBlock(styleRulesOf(docWith([], styles)));

  it('reads underline, strikethrough and both as text-decoration', () => {
    expect(rulesFor([{ namedStyleType: 'HEADING_1', textStyle: { underline: true } }])).toContain('h1 { text-decoration: underline }');
    expect(rulesFor([{ namedStyleType: 'HEADING_1', textStyle: { strikethrough: true } }])).toContain('h1 { text-decoration: line-through }');
    expect(rulesFor([{ namedStyleType: 'HEADING_1', textStyle: { underline: true, strikethrough: true } }])).toContain(
      'h1 { text-decoration: underline line-through }',
    );
  });

  it('reads a rule’s indent as margin-left, margin-right and text-indent', () => {
    const rule = rulesFor([
      { namedStyleType: 'NORMAL_TEXT', paragraphStyle: { indentStart: pt(36), indentFirstLine: pt(18), indentEnd: pt(9) } },
    ]);
    expect(rule).toContain('p { margin-left: 36pt; margin-right: 9pt; text-indent: -18pt }');
  });

  it('states a text-indent the paragraph shares with its rule once it moves margin-left, because the writer defaults it to 0', () => {
    const styles: docs_v1.Schema$NamedStyle[] = [
      { namedStyleType: 'NORMAL_TEXT', paragraphStyle: { indentStart: { unit: 'PT' }, indentFirstLine: pt(18) } },
    ];
    const md = renderMarkdown(docWith([para('x', { indentStart: pt(36), indentFirstLine: pt(54) })], styles));
    expect(md).toContain('<p style="margin-left:36pt; text-indent:18pt">x</p>');
  });
});
