import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { listSegments, resolveSegmentId, contentOf } from '../src/docs/structure.js';
import { resolveSegmentTarget } from '../src/docs/segments.js';
import { readDoc } from '../src/docs/read.js';
import { editDoc } from '../src/docs/edit.js';
import { insertImage } from '../src/docs/objects.js';
import { setStyle } from '../src/docs/format.js';

const para = (text: string): docs_v1.Schema$StructuralElement => ({
  paragraph: { elements: [{ textRun: { content: `${text}\n` } }] },
});
const imagePara = (): docs_v1.Schema$StructuralElement => ({
  paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'kix.logo' } }] },
});

// A letterhead: the logo lives in the header, so the body has no image at all.
function letterhead(opts: { header?: boolean; footer?: boolean; firstPageOnly?: boolean } = { header: true }): docs_v1.Schema$Document {
  const headerId = opts.firstPageOnly ? 'hFirst' : 'hDefault';
  return {
    title: 'Pour5 Letterhead',
    tabs: [
      {
        documentTab: {
          body: { content: [para('Dear team,')] },
          documentStyle: {
            ...(opts.header ? (opts.firstPageOnly ? { firstPageHeaderId: headerId } : { defaultHeaderId: headerId }) : {}),
            ...(opts.footer ? { defaultFooterId: 'fDefault' } : {}),
          },
          headers: opts.header ? { [headerId]: { headerId, content: [imagePara(), para('Pour5 Inc.')] } } : {},
          footers: opts.footer ? { fDefault: { footerId: 'fDefault', content: [para('page 1')] } } : {},
        },
      },
    ],
  } as unknown as docs_v1.Schema$Document;
}

function clientsFor(doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({ data: {} })): GoogleClients {
  return {
    auth: {} as GoogleClients['auth'],
    docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } } as unknown as GoogleClients['docs'],
    drive: {} as GoogleClients['drive'],
  };
}

describe('segment discovery (#23)', () => {
  it('lists each header/footer with a content summary', () => {
    const segs = listSegments(letterhead({ header: true, footer: true }));
    expect(segs).toEqual([
      { kind: 'header', page: 'default', segmentId: 'hDefault', paragraphs: 2, images: 1, preview: 'Pour5 Inc.' },
      { kind: 'footer', page: 'default', segmentId: 'fDefault', paragraphs: 1, images: 0, preview: 'page 1' },
    ]);
  });

  it('finds a first-page-only header when no page is specified', () => {
    const doc = letterhead({ header: true, firstPageOnly: true });
    expect(resolveSegmentId(doc, 'header')).toBe('hFirst');
    expect(resolveSegmentId(doc, 'header', 'first')).toBe('hFirst');
    expect(resolveSegmentId(doc, 'header', 'default')).toBeUndefined();
  });

  it('returns the segment content tree, not the body', () => {
    const doc = letterhead();
    expect(contentOf(doc)).toHaveLength(1);
    expect(contentOf(doc, undefined, 'hDefault')).toHaveLength(2);
  });

  it('treats body as no segment', () => {
    expect(resolveSegmentId(letterhead(), 'body')).toBeUndefined();
  });
});

describe('readDoc segments (#23)', () => {
  it('never reads as silently empty — a body read reports the header it skipped', async () => {
    const r = await readDoc(clientsFor(letterhead()), 'd');
    expect(r.markdown).toBe('Dear team,');
    expect(r.note).toContain('header (2 para, 1 image)');
    expect(r.segments).toHaveLength(1);
  });

  it('adds no note when the doc has no headers or footers', async () => {
    const r = await readDoc(clientsFor(letterhead({ header: false })), 'd');
    expect(r.note).toBeUndefined();
    expect(r.segments).toBeUndefined();
  });

  it('renders the header content, image marker included, for segment: header', async () => {
    const r = await readDoc(clientsFor(letterhead()), 'd', 'clean', undefined, { segment: 'header' });
    expect(r.markdown).toContain('![](image:kix.logo)');
    expect(r.markdown).toContain('Pour5 Inc.');
  });

  it('labels every tree for segment: all', async () => {
    const r = await readDoc(clientsFor(letterhead({ header: true, footer: true })), 'd', 'clean', undefined, { segment: 'all' });
    expect(r.markdown).toContain('<!-- segment: body -->');
    expect(r.markdown).toContain('<!-- segment: header -->');
    expect(r.markdown).toContain('<!-- segment: footer -->');
  });

  it('says so, rather than returning empty, when the requested segment is missing', async () => {
    const r = await readDoc(clientsFor(letterhead({ header: false })), 'd', 'clean', undefined, { segment: 'footer' });
    expect(r.markdown).toBe('');
    expect(r.note).toContain('no footer');
  });
});

describe('resolveSegmentTarget (#23)', () => {
  it('resolves an existing header without writing anything', async () => {
    const b = vi.fn();
    const doc = letterhead();
    const t = await resolveSegmentTarget(clientsFor(doc, b), 'd', doc, { segment: 'header' });
    expect(t).toMatchObject({ segmentId: 'hDefault', created: false });
    expect(b).not.toHaveBeenCalled();
  });

  it('errors (and creates nothing) when the segment is missing and create is not set', async () => {
    const b = vi.fn();
    const doc = letterhead({ header: false });
    const t = await resolveSegmentTarget(clientsFor(doc, b), 'd', doc, { segment: 'header' });
    expect(t.error).toContain('create:true');
    expect(b).not.toHaveBeenCalled();
  });

  it('creates the default header on demand and re-fetches the doc', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const before = letterhead({ header: false });
    const clients = {
      auth: {} as GoogleClients['auth'],
      docs: {
        documents: { get: vi.fn().mockResolvedValue({ data: letterhead() }), batchUpdate: b },
      } as unknown as GoogleClients['docs'],
      drive: {} as GoogleClients['drive'],
    } as GoogleClients;
    const t = await resolveSegmentTarget(clients, 'd', before, { segment: 'header', create: true });
    expect(b.mock.calls[0][0].requestBody.requests[0]).toEqual({ createHeader: { type: 'DEFAULT' } });
    expect(t).toMatchObject({ segmentId: 'hDefault', created: true });
  });

  it('refuses to create a first-page header (the API cannot)', async () => {
    const b = vi.fn();
    const doc = letterhead({ header: false });
    const t = await resolveSegmentTarget(clientsFor(doc, b), 'd', doc, { segment: 'header', page: 'first', create: true });
    expect(t.error).toContain('only create the default header');
    expect(b).not.toHaveBeenCalled();
  });

  it('is a no-op for the body', async () => {
    const b = vi.fn();
    const doc = letterhead();
    expect(await resolveSegmentTarget(clientsFor(doc, b), 'd', doc, {})).toMatchObject({ segmentId: undefined, created: false });
  });
});

describe('writes into a segment carry segmentId (#23)', () => {
  const reqs = (b: ReturnType<typeof vi.fn>) => b.mock.calls.at(-1)![0].requestBody.requests as docs_v1.Schema$Request[];

  it('edit_doc targets the header content tree, not the body', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await editDoc(clientsFor(letterhead(), b), 'd', 'Pour5 Inc.', 'Pour5 Ltd.', { segment: 'header' });
    expect(r.status).toBe('ok');
    for (const req of reqs(b)) {
      const seg = req.deleteContentRange?.range?.segmentId ?? req.insertText?.location?.segmentId ?? req.updateTextStyle?.range?.segmentId;
      expect(seg).toBe('hDefault');
    }
  });

  it('edit_doc cannot see header text from a body edit', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await editDoc(clientsFor(letterhead(), b), 'd', 'Pour5 Inc.', 'x');
    expect(r.status).toBe('not_found');
    expect(b).not.toHaveBeenCalled();
  });

  it('reports no_segment instead of writing to the body by mistake', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await editDoc(clientsFor(letterhead({ header: false }), b), 'd', 'Dear team,', 'Hi', { segment: 'header' });
    expect(r.status).toBe('no_segment');
    expect(b).not.toHaveBeenCalled();
  });

  it('insert_image places a logo in the header at index 0', async () => {
    const b = vi.fn().mockResolvedValue({ data: { replies: [{ insertInlineImage: { objectId: 'kix.new' } }] } });
    const r = await insertImage(clientsFor(letterhead(), b), 'd', 'https://x/logo.png', { segment: 'header', width: 120 });
    expect(r.status).toBe('ok');
    const img = reqs(b)[0].insertInlineImage!;
    expect(img.location).toMatchObject({ index: 0, segmentId: 'hDefault' });
    expect(img.objectSize!.width).toEqual({ magnitude: 120, unit: 'PT' });
  });

  it('set_style whole_document means the whole header when a segment is targeted', async () => {
    const b = vi.fn().mockResolvedValue({ data: {} });
    const r = await setStyle(clientsFor(letterhead(), b), 'd', { whole: true }, { fontSize: 9 }, { segment: 'header' });
    expect(r.status).toBe('ok');
    expect(reqs(b)[0].updateTextStyle!.range!.segmentId).toBe('hDefault');
  });
});
