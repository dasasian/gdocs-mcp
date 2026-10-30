import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { INLINE_READ, tableInsertedAt, writeControlFor } from './structure.js';
import { markdownToRequests, type ImagePlacement, type TablePlacement } from './write.js';
import { placeCells } from './table-layout.js';
import { insertTableRequests, mergeRequests, lookRequests, lookOf, plainLook, rowsTouchedByMerges, fillLayoutRequests } from './table-write.js';
import { uploadImageForInsert, resolveImageSource } from '../drive/images.js';
import { fillCellRequests, columnAlignRequests } from './objects.js';

async function insertImagePlacement(
  clients: GoogleClients,
  documentId: string,
  index: number,
  src: string,
  baseDir: string | undefined,
  tabId?: string,
  segmentId?: string,
  size?: { width?: number; height?: number },
): Promise<{ objectId?: string; warning?: string }> {
  const objectSize =
    size?.width || size?.height
      ? {
          width: size.width ? { magnitude: size.width, unit: 'PT' } : undefined,
          height: size.height ? { magnitude: size.height, unit: 'PT' } : undefined,
        }
      : undefined;
  const embed = async (uri: string): Promise<string | undefined> => {
    const r = await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertInlineImage: { location: { index, tabId, segmentId }, uri, objectSize } }] },
    });
    const reply = r.data.replies?.[0] as { insertInlineImage?: { objectId?: string } } | undefined;
    return reply?.insertInlineImage?.objectId ?? undefined;
  };

  const source = resolveImageSource(src, baseDir);
  if ('error' in source) return { warning: `${source.error}; skipped` };
  if (source.kind === 'url') return { objectId: await embed(source.uri) };

  const { uri, cleanup } = await uploadImageForInsert(clients, source.path);
  try {
    return { objectId: await embed(uri) };
  } finally {
    await cleanup();
  }
}

async function insertTableAt(clients: GoogleClients, documentId: string, table: TablePlacement, tabId?: string, segmentId?: string): Promise<void> {
  const { index, rows, aligns, layout } = table;
  const placement = layout && placeCells(layout);
  const R = placement?.rowCount ?? rows.length;
  const C = placement?.columnCount ?? Math.max(...rows.map((r) => r.length));
  if (R === 0 || C === 0) return;
  const before = (await clients.docs.documents.get({ documentId, ...INLINE_READ })).data;
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: insertTableRequests(before, index, R, C, tabId, segmentId) } });
  const after = (await clients.docs.documents.get({ documentId, ...INLINE_READ })).data;
  const tableEl = tableInsertedAt(after, index, tabId, segmentId);
  if (!tableEl?.table?.tableRows) return;

  if (layout && placement) {
    const site = { tableStart: tableEl.startIndex ?? index, tabId, segmentId };
    const requests = [
      ...mergeRequests(placement, site),
      ...lookRequests(plainLook(R, C, rowsTouchedByMerges(placement)), lookOf(layout, placement), site),
      ...fillLayoutRequests(tableEl.table, placement, tabId, segmentId),
    ];
    if (requests.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests } });
    return;
  }

  const requests = fillCellRequests(tableEl, rows, { tabId, segmentId });
  if (requests.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests } });

  if (aligns.some((a) => a && a !== 'left')) {
    const aligned = (await clients.docs.documents.get({ documentId, ...INLINE_READ })).data;
    const alignReqs = columnAlignRequests(tableInsertedAt(aligned, index, tabId, segmentId), aligns, { tabId, segmentId });
    if (alignReqs.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: alignReqs } });
  }
}

export interface RenderIntoOptions {
  tabId?: string;
  segmentId?: string;
  preRequests?: docs_v1.Schema$Request[];
  requiredRevisionId?: string;
  baseDir?: string;
  startIndex?: number;
  resetParagraphStyles?: boolean;
  startsParagraph?: boolean;
  endsInExistingParagraphMark?: boolean;
}

export interface RenderPlan {
  requests: docs_v1.Schema$Request[];
  tables: TablePlacement[];
  images: ImagePlacement[];
}

/** The requests that write the markdown's text, and the tables and images that go in afterward, which need the doc read again. */
export function planMarkdownRender(markdown: string, opts: RenderIntoOptions = {}): RenderPlan {
  const { requests, tables, images } = markdownToRequests(markdown, opts.startIndex ?? 1, opts.tabId, opts.segmentId, { resetParagraphStyles: opts.resetParagraphStyles, startsParagraph: opts.startsParagraph, endsInExistingParagraphMark: opts.endsInExistingParagraphMark });
  return { requests: [...(opts.preRequests ?? []), ...requests], tables, images };
}

export async function renderMarkdownInto(
  clients: GoogleClients,
  documentId: string,
  markdown: string,
  opts: RenderIntoOptions = {},
): Promise<{ warnings: string[]; images: { src: string; objectId: string }[] }> {
  const { requests: all, tables, images } = planMarkdownRender(markdown, opts);
  if (all.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: all, writeControl: writeControlFor(opts.requiredRevisionId) },
    });
  }
  const warnings: string[] = [];
  const imageMap: { src: string; objectId: string }[] = [];
  const placements: { index: number; run: () => Promise<void> }[] = [
    ...tables.map((t) => ({ index: t.index, run: () => insertTableAt(clients, documentId, t, opts.tabId, opts.segmentId) })),
    ...images.map((im) => ({
      index: im.index,
      run: async () => {
        const res = await insertImagePlacement(clients, documentId, im.index, im.src, opts.baseDir, opts.tabId, opts.segmentId, { width: im.width, height: im.height });
        if (res.warning) warnings.push(res.warning);
        if (res.objectId) imageMap.push({ src: im.src, objectId: res.objectId });
      },
    })),
  ].sort((a, b) => b.index - a.index);
  for (const p of placements) await p.run();
  return { warnings, images: imageMap };
}
