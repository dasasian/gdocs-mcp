import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { inspectStyle } from '../src/docs/inspect.js';

// A one-paragraph tabbed doc with a NORMAL_TEXT named style, so we can assert
// that inspect resolves effective style by layering direct over inherited.
function docWith(
  paragraphStyle: docs_v1.Schema$ParagraphStyle,
  runStyle: docs_v1.Schema$TextStyle,
  text = 'Hello world\n',
): docs_v1.Schema$Document {
  const start = 1;
  return {
    tabs: [
      {
        documentTab: {
          namedStyles: {
            styles: [
              {
                namedStyleType: 'NORMAL_TEXT',
                paragraphStyle: {
                  alignment: 'START',
                  spaceAbove: { unit: 'PT' }, // no magnitude => 0pt
                  spaceBelow: { unit: 'PT' },
                  lineSpacing: 115,
                },
                textStyle: {
                  fontSize: { magnitude: 11, unit: 'PT' },
                  weightedFontFamily: { fontFamily: 'Arial' },
                  foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
                },
              },
            ],
          },
          body: {
            content: [
              {
                startIndex: start,
                endIndex: start + text.length,
                paragraph: {
                  paragraphStyle: { namedStyleType: 'NORMAL_TEXT', ...paragraphStyle },
                  elements: [
                    { startIndex: start, endIndex: start + text.length, textRun: { content: text, textStyle: runStyle } },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

function clientsFor(doc: docs_v1.Schema$Document): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }) } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

describe('inspectStyle', () => {
  it('resolves inherited spacing/fonts when nothing is set directly', async () => {
    const r = await inspectStyle(clientsFor(docWith({}, {})), 'd', 'Hello');
    expect(r.status).toBe('ok');
    expect(r.paragraph).toMatchObject({
      namedStyleType: 'NORMAL_TEXT',
      alignment: 'START',
      spaceBeforePt: 0,
      spaceAfterPt: 0,
      lineSpacingPct: 115,
      spacingInherited: true,
    });
    expect(r.text).toMatchObject({ bold: false, fontSizePt: 11, fontFamily: 'Arial', color: '#000000' });
  });

  it('reports direct spacing as not inherited', async () => {
    const r = await inspectStyle(clientsFor(docWith({ spaceBelow: { magnitude: 18, unit: 'PT' } }, {})), 'd', 'Hello');
    expect(r.paragraph?.spaceAfterPt).toBe(18);
    expect(r.paragraph?.spacingInherited).toBe(false);
  });

  it('lets a direct run style override the inherited one', async () => {
    const r = await inspectStyle(
      clientsFor(docWith({}, { bold: true, fontSize: { magnitude: 20, unit: 'PT' }, foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } })),
      'd',
      'Hello',
    );
    expect(r.text).toMatchObject({ bold: true, fontSizePt: 20, color: '#ff0000' });
  });

  it('reports not_found for a missing anchor', async () => {
    expect((await inspectStyle(clientsFor(docWith({}, {})), 'd', 'nope')).status).toBe('not_found');
  });

  it('reports ambiguous for a repeated anchor', async () => {
    const r = await inspectStyle(clientsFor(docWith({}, {}, 'ab ab\n')), 'd', 'ab');
    expect(r.status).toBe('ambiguous');
  });
});
