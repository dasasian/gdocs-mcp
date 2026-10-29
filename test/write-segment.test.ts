import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { writeDoc } from '../src/docs/document.js';

const DOC_MIME = 'application/vnd.google-apps.document';

const emptyParagraph = (): docs_v1.Schema$StructuralElement => ({ startIndex: 0, endIndex: 1, paragraph: { elements: [{ textRun: { content: '\n' } }] } });
const paragraph = (text: string): docs_v1.Schema$StructuralElement => ({ startIndex: 1, endIndex: text.length + 2, paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } });

interface Fixture {
  body?: string;
  footer?: string | null;
  firstPageFooter?: boolean;
}

function docOf({ body, footer, firstPageFooter }: Fixture): docs_v1.Schema$Document {
  const footers: Record<string, docs_v1.Schema$Footer> = {};
  const documentStyle: docs_v1.Schema$DocumentStyle = {};
  if (footer !== undefined && footer !== null) {
    documentStyle.defaultFooterId = 'f1';
    footers.f1 = { footerId: 'f1', content: [footer === '' ? emptyParagraph() : paragraph(footer)] };
  }
  if (firstPageFooter) {
    documentStyle.firstPageFooterId = 'f2';
    footers.f2 = { footerId: 'f2', content: [paragraph('first page')] };
  }
  return {
    title: 'Memo',
    revisionId: 'rev-1',
    tabs: [
      {
        tabProperties: { tabId: 't.0', title: 'Tab 1', index: 0 },
        documentTab: { body: { content: [{ sectionBreak: {} }, body ? { ...paragraph(body), startIndex: 1 } : { ...emptyParagraph(), startIndex: 1, endIndex: 2 }] }, documentStyle, footers },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

function clientsFor(initial: docs_v1.Schema$Document) {
  let doc = initial;
  const sent: docs_v1.Schema$Request[][] = [];
  const batchUpdate = vi.fn().mockImplementation(async (p: { requestBody: { requests: docs_v1.Schema$Request[] } }) => {
    sent.push(p.requestBody.requests);
    if (p.requestBody.requests.some((r) => r.createFooter)) {
      const tab = doc.tabs![0].documentTab!;
      doc = { ...doc, tabs: [{ ...doc.tabs![0], documentTab: { ...tab, documentStyle: { ...tab.documentStyle, defaultFooterId: 'f1' }, footers: { f1: { footerId: 'f1', content: [emptyParagraph()] } } } }] };
    }
    return { data: { replies: [] } };
  });
  const clients: GoogleClients = {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockImplementation(async () => ({ data: doc })), batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {
      files: { get: vi.fn().mockResolvedValue({ data: { id: 'memo', name: 'Memo', mimeType: DOC_MIME } }) },
      comments: { list: vi.fn().mockResolvedValue({ data: { comments: [] } }) },
    } as unknown as GoogleClients['drive'],
  };
  return { clients, sent, batchUpdate };
}

describe('write_doc with segment (#60 rule 5)', () => {
  it('creates a missing default footer and writes into it', async () => {
    const { clients, sent } = clientsFor(docOf({ body: 'Hello' }));
    const result = await writeDoc(clients, 'memo', 'Page footer', { segment: 'footer' });
    expect(result).toMatchObject({ status: 'replaced', createdSegment: 'footer' });
    expect(sent[0]).toEqual([{ createFooter: { type: 'DEFAULT' } }]);
    const insert = sent[1].find((r) => r.insertText)!.insertText!;
    expect(insert).toMatchObject({ location: { index: 0, segmentId: 'f1' }, text: 'Page footer\n' });
  });

  it('refuses a missing first-page footer and sends nothing', async () => {
    const { clients, batchUpdate } = clientsFor(docOf({ body: 'Hello' }));
    const result = await writeDoc(clients, 'memo', 'x', { segment: 'footer', page: 'first' });
    expect(result).toEqual({ status: 'not_written', message: 'Turn on Different first page in Docs (Format → Headers & footers), then retry.' });
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('asks once, with confirmLoss, before replacing a footer that has content', async () => {
    const { clients, sent } = clientsFor(docOf({ body: 'Hello', footer: 'Old footer' }));
    const first = await writeDoc(clients, 'memo', 'New footer', { segment: 'footer' });
    expect(first.status).toBe('confirm_required');
    expect(sent).toEqual([]);
    if (first.status !== 'confirm_required') return;
    const second = await writeDoc(clients, 'memo', 'New footer', { segment: 'footer', confirmLoss: first.confirmLoss });
    expect(second.status).toBe('replaced');
    expect(sent[0].find((r) => r.deleteContentRange)!.deleteContentRange!.range).toMatchObject({ segmentId: 'f1' });
  });
});

describe('ask only when there is something to lose (#60 rule 6)', () => {
  it('an empty doc is written without the confirmLoss refusal', async () => {
    const { clients, sent } = clientsFor(docOf({}));
    const result = await writeDoc(clients, 'memo', 'First words');
    expect(result.status).toBe('replaced');
    expect(sent[0].some((r) => r.deleteContentRange)).toBe(false);
    expect(sent[0].find((r) => r.insertText)!.insertText!.text).toBe('First words\n');
  });

  it('an empty footer is written without asking', async () => {
    const { clients } = clientsFor(docOf({ body: 'Hello', footer: '' }));
    const result = await writeDoc(clients, 'memo', 'Footer text', { segment: 'footer' });
    expect(result.status).toBe('replaced');
  });

  it('a doc with text still asks', async () => {
    const { clients } = clientsFor(docOf({ body: 'Hello' }));
    expect((await writeDoc(clients, 'memo', 'x')).status).toBe('confirm_required');
  });
});
