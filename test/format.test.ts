import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { hexToRgb, buildTextStyle, formatDoc } from '../src/docs/format.js';

function oneParaDoc(text = 'Hello world\n'): docs_v1.Schema$Document {
  return {
    tabs: [
      {
        documentTab: {
          body: {
            content: [
              {
                startIndex: 1,
                endIndex: 1 + text.length,
                paragraph: {
                  paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
                  elements: [{ startIndex: 1, endIndex: 1 + text.length, textRun: { content: text } }],
                },
              },
            ],
          },
        },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

function clientsFor(doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: {
      documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate },
    } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

describe('hexToRgb', () => {
  it('parses black and white', () => {
    expect(hexToRgb('#000000')).toEqual({ red: 0, green: 0, blue: 0 });
    expect(hexToRgb('#ffffff')).toEqual({ red: 1, green: 1, blue: 1 });
  });
  it('parses a mid color', () => {
    const c = hexToRgb('#1a73e8');
    expect(c.red).toBeCloseTo(0x1a / 255);
    expect(c.green).toBeCloseTo(0x73 / 255);
    expect(c.blue).toBeCloseTo(0xe8 / 255);
  });
  it('expands 3-digit hex', () => {
    expect(hexToRgb('#fff')).toEqual({ red: 1, green: 1, blue: 1 });
  });
});

describe('buildTextStyle', () => {
  it('emits only the requested fields', () => {
    const { textStyle, fields } = buildTextStyle({ bold: true, color: '#ff0000' });
    expect(fields.sort()).toEqual(['bold', 'foregroundColor']);
    expect(textStyle.bold).toBe(true);
    expect(textStyle.foregroundColor?.color?.rgbColor).toEqual({ red: 1, green: 0, blue: 0 });
  });
  it('maps fontSize and fontFamily', () => {
    const { textStyle, fields } = buildTextStyle({ fontSize: 14, fontFamily: 'Georgia' });
    expect(fields.sort()).toEqual(['fontSize', 'weightedFontFamily']);
    expect(textStyle.fontSize).toEqual({ magnitude: 14, unit: 'PT' });
    expect(textStyle.weightedFontFamily?.fontFamily).toBe('Georgia');
  });
  it('supports unsetting (bold:false)', () => {
    const { textStyle, fields } = buildTextStyle({ bold: false });
    expect(fields).toEqual(['bold']);
    expect(textStyle.bold).toBe(false);
  });
  it('is empty for no styles', () => {
    expect(buildTextStyle({}).fields).toEqual([]);
  });
});

describe('formatDoc paragraph spacing', () => {
  const paragraphReq = (batchUpdate: ReturnType<typeof vi.fn>) =>
    batchUpdate.mock.calls[0][0].requestBody.requests.find(
      (r: docs_v1.Schema$Request) => r.updateParagraphStyle,
    )?.updateParagraphStyle;

  it('emits spaceAbove/spaceBelow/lineSpacing with the right fields mask', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const r = await formatDoc(clientsFor(oneParaDoc(), batchUpdate), 'd', 'Hello', {
      spaceBefore: 6,
      spaceAfter: 18,
      lineSpacing: 150,
    });
    expect(r.status).toBe('ok');
    expect(r.applied?.sort()).toEqual(['lineSpacing', 'spaceAfter', 'spaceBefore']);
    const ups = paragraphReq(batchUpdate);
    expect(ups.paragraphStyle.spaceAbove).toEqual({ magnitude: 6, unit: 'PT' });
    expect(ups.paragraphStyle.spaceBelow).toEqual({ magnitude: 18, unit: 'PT' });
    expect(ups.paragraphStyle.lineSpacing).toBe(150);
    expect(ups.fields.split(',').sort()).toEqual(['lineSpacing', 'spaceAbove', 'spaceBelow']);
  });

  it('combines alignment and spacing into a single updateParagraphStyle', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    await formatDoc(clientsFor(oneParaDoc(), batchUpdate), 'd', 'Hello', { align: 'center', spaceAfter: 12 });
    const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
    const paraReqs = requests.filter((r: docs_v1.Schema$Request) => r.updateParagraphStyle);
    expect(paraReqs).toHaveLength(1);
    expect(paraReqs[0].updateParagraphStyle.fields.split(',').sort()).toEqual(['alignment', 'spaceBelow']);
  });
});
