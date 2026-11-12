import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { editDoc } from '../src/docs/edit.js';
import { renderMarkdown, project } from '../src/docs/transformer.js';
import { ElementRefusal } from '../src/docs/element-write.js';

// An image read_doc shows is an element an edit can keep: quoted as read in
// old_string and new_string, it is left alone. The repro is a live doc where
// the read showed the tag below and edit_doc returned not_found for it.

type Piece = string | { image: string } | (string | { image: string })[];

function docOf(paragraphs: Piece[]): docs_v1.Schema$Document {
  let index = 1;
  const content = paragraphs.map((piece): docs_v1.Schema$StructuralElement => {
    const parts = Array.isArray(piece) ? piece : [piece];
    const startIndex = index;
    const elements: docs_v1.Schema$ParagraphElement[] = parts.map((part) => {
      const start = index;
      if (typeof part === 'string') {
        index += part.length;
        return { startIndex: start, endIndex: index, textRun: { content: part } };
      }
      index += 1;
      return { startIndex: start, endIndex: index, inlineObjectElement: { inlineObjectId: part.image } };
    });
    const last = elements[elements.length - 1];
    if (last.textRun) last.textRun.content += '\n';
    else elements.push({ startIndex: index, endIndex: index + 1, textRun: { content: '\n' } });
    index += 1;
    if (last.textRun) last.endIndex = index;
    return { startIndex, endIndex: index, paragraph: { elements, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } };
  });
  return {
    revisionId: 'r1',
    body: { content },
    inlineObjects: {
      'i.2': { inlineObjectProperties: { embeddedObject: { title: 'essay judge panel (#226) · result 1', size: { width: { magnitude: 432 }, height: { magnitude: 281.5669 } } } } },
      'i.9': { inlineObjectProperties: { embeddedObject: { description: 'a dot', size: { width: { magnitude: 12 }, height: { magnitude: 12 } } } } },
    },
  };
}

const CAPTION = 'essay judge panel (#226) · result 2';
const IMG = '<img src="image:i.2" alt="essay judge panel (#226) · result 1" width="432" height="281.57">';
const DOT = '<img src="image:i.9" alt="a dot" width="12" height="12">';

// "Before" 1–8, the image at 8 and its paragraph mark at 9, the caption 10–46, "see " 46–50, the dot at 50, " here" to 56.
const IMAGE_AT = 8;
const DOT_AT = 50;
const doc = docOf(['Before', { image: 'i.2' }, CAPTION, ['see ', { image: 'i.9' }, ' here']]);

function clientsFor(document: docs_v1.Schema$Document) {
  const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [] } });
  const clients: GoogleClients = {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockResolvedValue({ data: document }), batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
  return { clients, batchUpdate };
}

const requestsOf = (batchUpdate: ReturnType<typeof vi.fn>): docs_v1.Schema$Request[] => batchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests);
const covers = (requests: docs_v1.Schema$Request[], at: number): boolean =>
  requests.some((r) => r.deleteContentRange && r.deleteContentRange.range!.startIndex! <= at && at < r.deleteContentRange.range!.endIndex!);
const kinds = (requests: docs_v1.Schema$Request[]): string[] => requests.map((r) => Object.keys(r)[0]);

describe('an image the read shows is kept when an edit quotes it as read', () => {
  it('the read shows the tags these tests quote', () => {
    expect(renderMarkdown(doc)).toBe(`Before\n\n${IMG}\n\n${CAPTION}\n\nsee ${DOT} here`);
  });

  it('finds the image with its caption, and changes only the caption', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await editDoc(clients, 'd', `${IMG}\n\n${CAPTION}`, `${IMG}\n\n${CAPTION} (x)`);
    expect(result.status).toBe('ok');
    const requests = requestsOf(batchUpdate);
    expect(covers(requests, IMAGE_AT)).toBe(false);
    expect(kinds(requests)).not.toContain('insertInlineImage');
    // the changed line is retyped, as any changed line is; the image's paragraph is not touched
    expect(requests.flatMap((r) => (r.deleteContentRange ? [r.deleteContentRange.range] : []))).toEqual([{ startIndex: 10, endIndex: 45 }]);
    expect(requests.flatMap((r) => (r.insertText ? [r.insertText.text] : []))).toEqual([`${CAPTION} (x)`]);
  });

  it('finds the image alone', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await editDoc(clients, 'd', IMG, `${IMG}\n\nA new caption`);
    expect(result.status).toBe('ok');
    const requests = requestsOf(batchUpdate);
    expect(covers(requests, IMAGE_AT)).toBe(false);
    expect(kinds(requests)).not.toContain('insertInlineImage');
  });

  it('keeps an image inside a sentence it rewords', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await editDoc(clients, 'd', `see ${DOT} here`, `look at ${DOT} there`);
    expect(result.status).toBe('ok');
    const requests = requestsOf(batchUpdate);
    expect(covers(requests, DOT_AT)).toBe(false);
    expect(requests.flatMap((r) => (r.insertText ? [r.insertText.text] : []))).toEqual(expect.arrayContaining(['look at ']));
  });

  it('deletes an image new_string leaves out', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    const result = await editDoc(clients, 'd', `see ${DOT} here`, 'see here');
    expect(result.status).toBe('ok');
    expect(covers(requestsOf(batchUpdate), DOT_AT)).toBe(true);
  });

  it('finds a centered image in the wrapper the read puts it in', async () => {
    const centered = docOf([{ image: 'i.9' }, 'Caption']);
    centered.body!.content![0].paragraph!.paragraphStyle = { namedStyleType: 'NORMAL_TEXT', alignment: 'CENTER' };
    const line = `<p style="text-align:center">${DOT}</p>`;
    expect(renderMarkdown(centered)).toBe(`${line}\n\nCaption`);
    const { clients, batchUpdate } = clientsFor(centered);
    expect((await editDoc(clients, 'd', `${line}\n\nCaption`, `${line}\n\nCaption two`)).status).toBe('ok');
    expect(covers(requestsOf(batchUpdate), 1)).toBe(false);
  });

  it('does not find an image by its alt text', async () => {
    const { clients } = clientsFor(doc);
    expect((await editDoc(clients, 'd', 'result 1', 'result 9')).status).toBe('not_found');
  });
});

describe('an image attribute the API cannot write is refused before anything is sent', () => {
  it('refuses a changed alt with where to change it, instead of not_found', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    const edit = editDoc(clients, 'd', IMG, IMG.replace('result 1', 'result 2'));
    await expect(edit).rejects.toThrow(ElementRefusal);
    await expect(editDoc(clients, 'd', IMG, IMG.replace('result 1', 'result 2'))).rejects.toThrow(/alt text can't be changed through the API.*right-click > Alt text/s);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses an alt added to an image that has none', async () => {
    const plain = docOf([{ image: 'i.0' }, 'Caption']);
    plain.inlineObjects = { 'i.0': { inlineObjectProperties: { embeddedObject: {} } } };
    const { clients, batchUpdate } = clientsFor(plain);
    await expect(editDoc(clients, 'd', '<img src="image:i.0">', '<img src="image:i.0" alt="a chart">')).rejects.toThrow(/alt text can't be changed/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses a changed size, and does not delete the image', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    await expect(editDoc(clients, 'd', `${IMG}\n\n${CAPTION}`, `${IMG.replace('width="432"', 'width="200"')}\n\n${CAPTION}`)).rejects.toThrow(/size can't be changed through the API/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses copying an image already in the doc, which the API cannot re-embed', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    await expect(editDoc(clients, 'd', `${IMG}\n\n${CAPTION}`, `${IMG}\n\n${CAPTION}\n\n${IMG}`)).rejects.toThrow(/already embedded/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses swapping two images, which would have to insert one of them again', async () => {
    const twoImages = docOf([['a ', { image: 'i.9' }, ' b ', { image: 'i.2' }, ' c']]);
    const { clients, batchUpdate } = clientsFor(twoImages);
    await expect(editDoc(clients, 'd', `a ${DOT} b ${IMG} c`, `a ${IMG} b ${DOT} c`)).rejects.toThrow(/is already in the doc/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses an image: src that old_string does not quote, before deleting anything', async () => {
    const { clients, batchUpdate } = clientsFor(doc);
    await expect(editDoc(clients, 'd', 'Before', DOT)).rejects.toThrow(/already embedded/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe('the text an edit matches holds each image the read shows', () => {
  it('an image in a table cell, which the read leaves out, is left out of the match too', () => {
    const cell = docOf([['in ', { image: 'i.9' }, 'cell']]).body!.content!;
    const inTable = { revisionId: 'r1', body: { content: [{ table: { rows: 1, columns: 1, tableRows: [{ tableCells: [{ content: cell }] }] } }] }, inlineObjects: doc.inlineObjects };
    expect(project(inTable).text).toBe('in cell\n');
    expect(project(docOf([['in ', { image: 'i.9' }, 'text']])).text).toMatch(/^in [\ue100-\uf8ff]text\n$/);
  });
});
