import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { insertContent } from '../src/docs/document.js';

// The #20 repro shape: a doc whose last element is a table, followed only by the
// empty paragraph Docs always keeps at the end (no text to anchor an edit on).
function docEndingInTable(): docs_v1.Schema$Document {
  const cell = (t: string): docs_v1.Schema$TableCell => ({
    content: [{ paragraph: { elements: [{ textRun: { content: t } }] } }],
  });
  return {
    tabs: [
      {
        documentTab: {
          body: {
            content: [
              { startIndex: 1, endIndex: 8, paragraph: { elements: [{ startIndex: 1, textRun: { content: 'Log\n' } }] } },
              {
                startIndex: 8,
                endIndex: 24,
                table: { tableRows: [{ tableCells: [cell('Date'), cell('Miles')] }] },
              },
              { startIndex: 24, endIndex: 25, paragraph: { elements: [{ startIndex: 24, textRun: { content: '\n' } }] } },
            ],
          },
        },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

function clientsFor(doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({ data: {} })): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: {
      documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate },
    } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

const firstInsert = (b: ReturnType<typeof vi.fn>) =>
  (b.mock.calls[0][0].requestBody.requests as docs_v1.Schema$Request[]).find((r) => r.insertText)!.insertText!;

describe('insertContent (#20)', () => {
  it('defaults to the end of the doc — past the table, at the trailing paragraph', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await insertContent(clientsFor(docEndingInTable(), b), 'd', 'Parent/Guardian Signature ___');
    expect(r.status).toBe('ok');
    expect(r.index).toBe(24); // last element endIndex (25) - 1
    expect(firstInsert(b)).toMatchObject({ location: { index: 24 }, text: 'Parent/Guardian Signature ___\n' });
  });

  it('inserts at index 1 for at: "top"', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await insertContent(clientsFor(docEndingInTable(), b), 'd', 'Intro', { at: 'top' });
    expect(r.index).toBe(1);
    expect(firstInsert(b).location).toMatchObject({ index: 1 });
  });

  it('inserts right after a unique text anchor', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await insertContent(clientsFor(docEndingInTable(), b), 'd', 'after', { at: 'Log' });
    expect(r.status).toBe('ok');
    expect(firstInsert(b).location!.index).toBe(4); // end of "Log"
  });

  it('reports not_found and writes nothing when the anchor is missing', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await insertContent(clientsFor(docEndingInTable(), b), 'd', 'x', { at: 'nope' });
    expect(r.status).toBe('not_found');
    expect(b).not.toHaveBeenCalled();
  });

  it('reports ambiguous anchors with context instead of guessing', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await insertContent(clientsFor(docEndingInTable(), b), 'd', 'x', { at: 'e' });
    expect(r.status).toBe('ambiguous');
    expect(r.matches!.length).toBeGreaterThan(1);
    expect(b).not.toHaveBeenCalled();
  });
});
