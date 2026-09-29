import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { editDoc } from '../src/docs/edit.js';
import { StyleSyntaxError } from '../src/docs/css.js';

const pt = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

const NAMED_STYLES: docs_v1.Schema$NamedStyle[] = [
  {
    namedStyleType: 'NORMAL_TEXT',
    paragraphStyle: { alignment: 'START', lineSpacing: 115, spaceAbove: pt(0), spaceBelow: pt(8) },
    textStyle: { fontSize: pt(11), weightedFontFamily: { fontFamily: 'Arial', weight: 400 } },
  },
  { namedStyleType: 'HEADING_1', paragraphStyle: { spaceAbove: pt(20) }, textStyle: { fontSize: pt(20), bold: true } },
];

function docOf(paragraphs: { text: string; style?: docs_v1.Schema$ParagraphStyle }[]): docs_v1.Schema$Document {
  let index = 1;
  const content = paragraphs.map(({ text, style }) => {
    const startIndex = index;
    index += text.length + 1;
    return {
      startIndex,
      endIndex: index,
      paragraph: {
        elements: [{ startIndex, endIndex: index, textRun: { content: `${text}\n`, textStyle: {} } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT', ...style },
      },
    };
  });
  return { revisionId: 'r1', body: { content }, namedStyles: { styles: NAMED_STYLES } };
}

function clientsFor(doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

const sent = (batchUpdate: ReturnType<typeof vi.fn>): docs_v1.Schema$Request[] => batchUpdate.mock.calls[0][0].requestBody.requests;

const LONG = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');

describe('same words in, same words out: a style-only edit', () => {
  it('indents a 300-word paragraph from a short anchor, and sends no text at all', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const doc = docOf([{ text: `4. Term ${LONG}` }, { text: 'Other' }]);
    const r = await editDoc(clientsFor(doc, batch), 'd', '<p>4. Term', '<p style="margin-left:36pt; text-indent:-18pt">4. Term');
    expect(r).toMatchObject({ status: 'ok', replaced: 1 });
    const requests = sent(batch);
    expect(requests).toHaveLength(1);
    expect(requests[0].updateParagraphStyle).toMatchObject({
      paragraphStyle: { indentStart: pt(36), indentFirstLine: pt(18) },
      fields: 'indentStart,indentFirstLine',
      range: { startIndex: 1, endIndex: 8 },
    });
    expect(JSON.stringify(requests)).not.toContain('word');
    expect(requests.some((q) => q.deleteContentRange || q.insertText)).toBe(false);
  });

  it('never builds a delete or an insert, whatever the markup change', async () => {
    const cases: [string, string][] = [
      ['Hello world', '<p style="text-align:center">Hello world</p>'],
      ['Hello world', '**Hello** world'],
      ['Hello world', '<span style="color:#ff0000">Hello</span> world'],
      ['<p style="text-align:center">Hello world</p>', 'Hello world'],
      ['Hello world', '<p class="title">Hello world'],
    ];
    for (const [before, after] of cases) {
      const batch = vi.fn().mockResolvedValue({});
      await editDoc(clientsFor(docOf([{ text: 'Hello world' }]), batch), 'd', before, after);
      const requests = batch.mock.calls.length ? sent(batch) : [];
      expect(requests.every((q) => q.updateParagraphStyle || q.updateTextStyle)).toBe(true);
    }
  });

  it('sends nothing when the markup does not change either', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const r = await editDoc(clientsFor(docOf([{ text: 'Hello world' }]), batch), 'd', 'Hello', 'Hello');
    expect(r.status).toBe('ok');
    expect(batch).not.toHaveBeenCalled();
  });

  it('rewrites both indent fields when only one of margin-left and text-indent changed', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const style = { indentStart: pt(36), indentFirstLine: pt(18) };
    await editDoc(
      clientsFor(docOf([{ text: 'Hello', style }]), batch),
      'd',
      '<p style="margin-left:36pt; text-indent:-18pt">Hello',
      '<p style="margin-left:72pt; text-indent:-18pt">Hello',
    );
    expect(sent(batch)[0].updateParagraphStyle).toMatchObject({ paragraphStyle: { indentStart: pt(72), indentFirstLine: pt(54) } });
  });

  it('clears what the new markup no longer says', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'Hello' }]), batch), 'd', '<p style="text-align:center; margin-top:6pt">Hello', '<p style="margin-top:6pt">Hello');
    expect(sent(batch)[0].updateParagraphStyle).toMatchObject({ paragraphStyle: {}, fields: 'alignment' });
  });

  it('changes Title back to Normal text when the class is dropped', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'Hello', style: { namedStyleType: 'TITLE' } }]), batch), 'd', '<p class="title">Hello', '<p>Hello');
    expect(sent(batch)[0].updateParagraphStyle).toMatchObject({ paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' });
  });

  it('makes a paragraph the Title with a class', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'Hello' }]), batch), 'd', 'Hello', '<p class="title">Hello');
    expect(sent(batch)[0].updateParagraphStyle).toMatchObject({ paragraphStyle: { namedStyleType: 'TITLE' } });
  });

  it('restyles runs only when the inline markup changed, and clears the old direct styling first', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'Hello world' }]), batch), 'd', 'Hello world', '**Hello** world');
    const requests = sent(batch);
    expect(requests[0].updateTextStyle!.fields).toContain('weightedFontFamily');
    expect(requests[1].updateTextStyle).toMatchObject({ textStyle: { bold: true }, range: { startIndex: 1, endIndex: 6 } });
  });

  it('leaves the runs alone when only the paragraph wrapper changed', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'Hello world' }]), batch), 'd', 'Hello', '<p style="text-align:right">Hello');
    expect(sent(batch).every((q) => q.updateParagraphStyle)).toBe(true);
  });
});

describe('a text-changing edit still takes a paragraph wrapper', () => {
  it('styles the paragraph it wrote', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'Hello world' }]), batch), 'd', 'world', '<p style="text-align:center">planet</p>');
    const requests = sent(batch);
    expect(requests.some((q) => q.deleteContentRange)).toBe(true);
    expect(requests.find((q) => q.insertText)!.insertText!.text).toBe('planet');
    expect(requests.find((q) => q.updateParagraphStyle)!.updateParagraphStyle).toMatchObject({ paragraphStyle: { alignment: 'CENTER' } });
  });
});

describe('editing a <style> rule', () => {
  it('is one updateNamedStyle, with namedStyleType in the field mask', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const r = await editDoc(clientsFor(docOf([{ text: 'x' }]), batch), 'd', 'font-size: 11pt', 'font-size: 12pt');
    expect(r).toMatchObject({ status: 'ok', replaced: 1 });
    const requests = sent(batch) as unknown as { updateNamedStyle: { namedStyle: docs_v1.Schema$NamedStyle; fields: string } }[];
    expect(requests).toHaveLength(1);
    expect(requests[0].updateNamedStyle.namedStyle).toMatchObject({ namedStyleType: 'NORMAL_TEXT', textStyle: { fontSize: pt(12) } });
    expect(requests[0].updateNamedStyle.fields).toBe('namedStyleType,textStyle.fontSize');
  });

  it('takes a whole-block rewrite and touches only the rules that changed', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(
      clientsFor(docOf([{ text: 'x' }]), batch),
      'd',
      'h1 { font-size: 20pt; font-weight: bold; margin-top: 20pt }',
      'h1 { font-size: 22pt; font-weight: bold; margin-top: 20pt }',
    );
    const requests = sent(batch) as unknown as { updateNamedStyle: { namedStyle: { namedStyleType: string }; fields: string } }[];
    expect(requests).toHaveLength(1);
    expect(requests[0].updateNamedStyle.namedStyle.namedStyleType).toBe('HEADING_1');
    expect(requests[0].updateNamedStyle.fields).toBe('namedStyleType,textStyle.fontSize');
  });

  it('clears a property the new rule no longer has', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'x' }]), batch), 'd', ' font-weight: bold;', '');
    expect(sent(batch)).toHaveLength(0 + 1);
    expect((sent(batch)[0] as unknown as { updateNamedStyle: { fields: string } }).updateNamedStyle.fields).toBe('namedStyleType,textStyle.bold');
  });

  it('does not send a request for a rule that did not change', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const r = await editDoc(clientsFor(docOf([{ text: 'x' }]), batch), 'd', 'font-size: 11pt', 'font-size: 11pt');
    expect(r).toMatchObject({ status: 'ok', replaced: 0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it('reports an old_string that is not in the block, and shows the block', async () => {
    const batch = vi.fn();
    const r = await editDoc(clientsFor(docOf([{ text: 'x' }]), batch), 'd', '<style>\nh9 { }', 'x');
    expect(r.status).toBe('not_found');
    expect(r.message).toContain('h1 {');
    expect(batch).not.toHaveBeenCalled();
  });

  it('prefers the document text when old_string is there', async () => {
    const batch = vi.fn().mockResolvedValue({});
    await editDoc(clientsFor(docOf([{ text: 'font-size: 11pt is a rule' }]), batch), 'd', 'font-size: 11pt', 'font-size: 12pt');
    expect(sent(batch).some((q) => q.deleteContentRange)).toBe(true);
  });
});

describe('unsupported CSS in new_string', () => {
  it.each([
    ['a paragraph property', 'Hello', '<p style="border:1px">Hello</p>'],
    ['a span property', 'Hello', '<span style="float:left">Hello</span>'],
    ['a rule property', 'p { font-family: Arial', 'p { border: 1px; font-family: Arial'],
  ])('refuses %s before any request', async (_name, before, after) => {
    const batch = vi.fn();
    await expect(editDoc(clientsFor(docOf([{ text: 'Hello world' }]), batch), 'd', before, after)).rejects.toThrow(StyleSyntaxError);
    expect(batch).not.toHaveBeenCalled();
  });

  it('names every offending line', async () => {
    const batch = vi.fn();
    const error = await editDoc(clientsFor(docOf([{ text: 'a' }, { text: 'b' }]), batch), 'd', 'a', '<p style="border:1px">a</p>\n<p style="float:left">b</p>').catch((e) => e as StyleSyntaxError);
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain('line 1');
    expect(error.message).toContain('line 2');
  });
});
