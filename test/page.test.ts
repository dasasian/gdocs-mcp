import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { setPageSetup, getPageSetup } from '../src/docs/page.js';

// A doc whose current page size is portrait A4-ish (595 x 842), one tab.
function docWith(pageSize?: docs_v1.Schema$Size): docs_v1.Schema$Document {
  return {
    tabs: [{ documentTab: { documentStyle: pageSize ? { pageSize } : {}, body: { content: [] } } }],
  } as unknown as docs_v1.Schema$Document;
}

function clientsFor(doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({})): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

const reqOf = (batchUpdate: ReturnType<typeof vi.fn>) =>
  batchUpdate.mock.calls[0][0].requestBody.requests[0].updateDocumentStyle;

describe('setPageSetup', () => {
  it('sets margins in points with the right fields mask', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const r = await setPageSetup(clientsFor(docWith(), batchUpdate), 'd', { marginTop: 72, marginLeft: 36 });
    expect(r.status).toBe('ok');
    expect(r.applied).toEqual(['marginTop', 'marginLeft']);
    const u = reqOf(batchUpdate);
    expect(u.documentStyle.marginTop).toEqual({ magnitude: 72, unit: 'PT' });
    expect(u.documentStyle.marginLeft).toEqual({ magnitude: 36, unit: 'PT' });
    expect(u.fields.split(',').sort()).toEqual(['marginLeft', 'marginTop']);
  });

  it('resolves a preset + landscape to width > height', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    await setPageSetup(clientsFor(docWith(), batchUpdate), 'd', { pageSize: 'letter', orientation: 'landscape' });
    const u = reqOf(batchUpdate);
    // Letter is 612 x 792 portrait; landscape swaps to 792 x 612.
    expect(u.documentStyle.pageSize.width.magnitude).toBe(792);
    expect(u.documentStyle.pageSize.height.magnitude).toBe(612);
  });

  it('orientation-only reads the current page size and swaps it', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const current = { width: { magnitude: 595, unit: 'PT' }, height: { magnitude: 842, unit: 'PT' } };
    const r = await setPageSetup(clientsFor(docWith(current), batchUpdate), 'd', { orientation: 'landscape' });
    expect(r.applied).toEqual(['orientation']);
    const u = reqOf(batchUpdate);
    expect(u.documentStyle.pageSize.width.magnitude).toBe(842);
    expect(u.documentStyle.pageSize.height.magnitude).toBe(595);
  });

  it('leaves an already-correct orientation unchanged', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const current = { width: { magnitude: 595, unit: 'PT' }, height: { magnitude: 842, unit: 'PT' } };
    await setPageSetup(clientsFor(docWith(current), batchUpdate), 'd', { orientation: 'portrait' });
    const u = reqOf(batchUpdate);
    expect(u.documentStyle.pageSize.width.magnitude).toBe(595);
    expect(u.documentStyle.pageSize.height.magnitude).toBe(842);
  });

  it('returns empty when nothing is provided', async () => {
    const batchUpdate = vi.fn().mockResolvedValue({});
    const r = await setPageSetup(clientsFor(docWith(), batchUpdate), 'd', {});
    expect(r.status).toBe('empty');
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});

describe('getPageSetup', () => {
  function docWithFull(): docs_v1.Schema$Document {
    return {
      tabs: [{ documentTab: { documentStyle: {
        marginTop: { magnitude: 72, unit: 'PT' },
        marginBottom: { magnitude: 72, unit: 'PT' },
        marginLeft: { magnitude: 90, unit: 'PT' },
        marginRight: { magnitude: 90, unit: 'PT' },
        pageSize: { width: { magnitude: 792, unit: 'PT' }, height: { magnitude: 612, unit: 'PT' } },
      }, body: { content: [] } } }],
    } as unknown as docs_v1.Schema$Document;
  }

  it('reads margins, size, orientation, and a matching preset name', async () => {
    const info = await getPageSetup(clientsFor(docWithFull()), 'd');
    expect(info.marginTop).toBe(72);
    expect(info.marginLeft).toBe(90);
    expect(info.pageWidth).toBe(792);
    expect(info.pageHeight).toBe(612);
    // 792x612 is Letter rotated -> landscape, preset "letter".
    expect(info.orientation).toBe('landscape');
    expect(info.pageSizeName).toBe('letter');
  });

  it('reports portrait and no preset for a custom size', async () => {
    const info = await getPageSetup(clientsFor(docWith({ width: { magnitude: 500, unit: 'PT' }, height: { magnitude: 700, unit: 'PT' } })), 'd');
    expect(info.orientation).toBe('portrait');
    expect(info.pageSizeName).toBeUndefined();
  });
});
