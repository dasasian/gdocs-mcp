import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { editDoc } from '../src/docs/edit.js';
import { renderMarkdown } from '../src/docs/transformer.js';
import { markdownToRequests } from '../src/docs/write.js';

type Piece =
  | { text: string; namedStyleType?: string; bullet?: boolean }
  | { table: string[][] };

function bodyOf(pieces: Piece[]): docs_v1.Schema$StructuralElement[] {
  let index = 1;
  const paragraphAt = (text: string, extra: docs_v1.Schema$Paragraph = {}): docs_v1.Schema$StructuralElement => {
    const startIndex = index;
    index += text.length + 1;
    return { startIndex, endIndex: index, paragraph: { elements: [{ startIndex, endIndex: index, textRun: { content: `${text}\n` } }], ...extra } };
  };
  return pieces.map((piece) => {
    if ('text' in piece) {
      return paragraphAt(piece.text, {
        paragraphStyle: { namedStyleType: piece.namedStyleType ?? 'NORMAL_TEXT' },
        ...(piece.bullet ? { bullet: { listId: 'l1' } } : {}),
      });
    }
    const startIndex = index;
    index += 1;
    const tableRows = piece.table.map((row) => {
      index += 1;
      const tableCells = row.map((cell) => {
        index += 1;
        return { content: [paragraphAt(cell)] };
      });
      return { tableCells };
    });
    return { startIndex, endIndex: index, table: { rows: piece.table.length, columns: piece.table[0].length, tableRows } };
  });
}

function docOf(pieces: Piece[]): docs_v1.Schema$Document {
  return { revisionId: 'r1', body: { content: bodyOf(pieces) } };
}

function clientsFor(doc: docs_v1.Schema$Document) {
  const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [] } });
  const clients: GoogleClients = {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
  return { clients, batchUpdate };
}

const requestsOf = (batchUpdate: ReturnType<typeof vi.fn>, call = 0): docs_v1.Schema$Request[] => batchUpdate.mock.calls[call][0].requestBody.requests;
const inserted = (requests: docs_v1.Schema$Request[]) => requests.flatMap((r) => (r.insertText ? [r.insertText] : []));

const PRICING_ROW = '| Total | $4,200 |';

describe('what comes back unchanged is kept (#60 rule 1)', () => {
  const endingInTable = (): Piece[] => [{ text: 'Pricing' }, { table: [['Total', '$4,200']] }, { text: '' }];

  it('a match that ends in a table keeps the table and adds the paragraph after it', async () => {
    const { clients, batchUpdate } = clientsFor(docOf(endingInTable()));
    const result = await editDoc(clients, 'd', PRICING_ROW, `${PRICING_ROW}\n\nPayment due within 30 days.`);
    expect(result.status).toBe('ok');
    const requests = requestsOf(batchUpdate);
    expect(requests.some((r) => r.deleteContentRange)).toBe(false);
    expect(inserted(requests).map((i) => i.text)).toEqual(['Payment due within 30 days.']);
    const table = bodyOf(endingInTable())[1];
    expect(inserted(requests)[0].location!.index).toBe(table.endIndex);
  });

  it('text that reappears at the start of new_string is not deleted and typed again', async () => {
    const { clients, batchUpdate } = clientsFor(docOf([{ text: 'Scope' }, { text: 'Body' }]));
    await editDoc(clients, 'd', 'Body', 'Body\n\nMore');
    const requests = requestsOf(batchUpdate);
    expect(requests.some((r) => r.deleteContentRange)).toBe(false);
    expect(inserted(requests).map((i) => i.text).join('')).not.toContain('Body');
  });

  it('text that reappears at the end of new_string stays, and the blocks go before it', async () => {
    const { clients, batchUpdate } = clientsFor(docOf([{ text: 'Scope' }, { text: 'Body' }]));
    await editDoc(clients, 'd', 'Body', 'Intro\n\nBody');
    const requests = requestsOf(batchUpdate);
    expect(requests.some((r) => r.deleteContentRange)).toBe(false);
    expect(inserted(requests)[0]).toMatchObject({ location: { index: 7 }, text: 'Intro\n' });
  });
});

describe('a new block carries its own style, not its anchor’s (#60 rule 2)', () => {
  const normalTextOver = (requests: docs_v1.Schema$Request[], startIndex: number) =>
    requests.find((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT' && r.updateParagraphStyle.range!.startIndex === startIndex);
  const bulletsRemovedOver = (requests: docs_v1.Schema$Request[], startIndex: number) =>
    requests.find((r) => r.deleteParagraphBullets && r.deleteParagraphBullets.range!.startIndex === startIndex);

  it.each([
    ['a Heading 1', 'HEADING_1', false],
    ['a Title', 'TITLE', false],
    ['a list item', 'NORMAL_TEXT', true],
  ])('a paragraph added after %s is Normal text with no bullet', async (_name, namedStyleType, bullet) => {
    const { clients, batchUpdate } = clientsFor(docOf([{ text: 'Scope', namedStyleType, bullet }, { text: 'Later' }]));
    await editDoc(clients, 'd', 'Scope', 'Scope\n\nNew paragraph');
    const requests = requestsOf(batchUpdate);
    expect(normalTextOver(requests, 7)).toBeDefined();
    expect(bulletsRemovedOver(requests, 7)).toBeDefined();
  });

  it('text added inside an existing paragraph keeps that paragraph’s style', async () => {
    const { clients, batchUpdate } = clientsFor(docOf([{ text: 'Scope', namedStyleType: 'HEADING_1' }]));
    await editDoc(clients, 'd', 'Scope', 'Scope of work');
    const requests = requestsOf(batchUpdate);
    expect(requests.some((r) => r.updateParagraphStyle)).toBe(false);
  });
});

describe('an anchor mid-paragraph splits it (#60 rule 3)', () => {
  it('ends the paragraph at the anchor, puts the table next, leaves the rest as its own paragraph', async () => {
    const sentence = 'We pay within 30 days of receipt.';
    const { clients, batchUpdate } = clientsFor(docOf([{ text: sentence }]));
    await editDoc(clients, 'd', 'within 30 days', 'within 30 days\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    const anchorEnd = 1 + sentence.indexOf(' of receipt.');
    const first = requestsOf(batchUpdate);
    expect(first.some((r) => r.deleteContentRange)).toBe(false);
    expect(inserted(first)[0]).toEqual({ location: { index: anchorEnd }, text: '\n' });
    expect(inserted(first)[1]).toMatchObject({ location: { index: anchorEnd + 1 }, text: '\n' });
    const tableCall = batchUpdate.mock.calls.map((c) => c[0].requestBody.requests as docs_v1.Schema$Request[]).find((rs) => rs.some((r) => r.insertTable));
    expect(tableCall![0].insertTable!.location!.index).toBe(anchorEnd + 1);
  });

  it('at the end of a paragraph there is no empty paragraph left behind', async () => {
    const { clients, batchUpdate } = clientsFor(docOf([{ text: 'Scope' }]));
    await editDoc(clients, 'd', 'Scope', 'Scope\n\nNext');
    expect(inserted(requestsOf(batchUpdate)).map((i) => i.text)).toEqual(['\n', 'Next']);
  });
});

describe('a centered image is a centered paragraph holding an <img> (#60 rule 4)', () => {
  const centeredImageDoc: docs_v1.Schema$Document = {
    body: {
      content: [
        {
          paragraph: {
            elements: [{ inlineObjectElement: { inlineObjectId: 'kix.logo' } }, { textRun: { content: '\n' } }],
            paragraphStyle: { namedStyleType: 'NORMAL_TEXT', alignment: 'CENTER' },
          },
        },
      ],
    },
    inlineObjects: { 'kix.logo': { inlineObjectProperties: { embeddedObject: { size: { width: { magnitude: 120 }, height: { magnitude: 40 } } } } } },
  };
  const CENTERED_LINE = '<p style="text-align:center"><img src="image:kix.logo" width="120" height="40"></p>';

  it('the reader emits that exact form', () => {
    expect(renderMarkdown(centeredImageDoc)).toBe(CENTERED_LINE);
  });

  it('the writer accepts it: an image placed, its paragraph centered', () => {
    const { requests, images } = markdownToRequests('<p style="text-align:center"><img src="logo.png" width="120" height="40"></p>', 1);
    expect(images).toMatchObject([{ src: 'logo.png', width: 120, height: 40 }]);
    expect(requests.find((r) => r.updateParagraphStyle)?.updateParagraphStyle).toMatchObject({ paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' });
  });

  it('a paragraph whose text is the literal tag, with no style, stays text', () => {
    const { images, text } = markdownToRequests('<p><img src="a.png"></p>', 1);
    expect(images).toEqual([]);
    expect(text).toBe('<img src="a.png">\n');
  });
});

describe('an empty doc has no anchor (#60 rule 7)', () => {
  it('edit_doc on an empty doc says to use write_doc and sends nothing', async () => {
    const { clients, batchUpdate } = clientsFor(docOf([{ text: '' }]));
    await expect(editDoc(clients, 'd', 'anything', 'something')).rejects.toThrow(/write_doc/);
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('an empty header says so too', async () => {
    const doc: docs_v1.Schema$Document = {
      body: { content: bodyOf([{ text: 'Body' }]) },
      documentStyle: { defaultHeaderId: 'h1' },
      headers: { h1: { headerId: 'h1', content: [{ startIndex: 0, endIndex: 1, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } },
    };
    const { clients } = clientsFor(doc);
    await expect(editDoc(clients, 'd', 'x', 'y', { segment: 'header' })).rejects.toThrow(/write_doc/);
  });
});
