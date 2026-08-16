import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { resolveTabId, documentStyleOf, writeControlFor } from './structure.js';

// Document-level page setup via updateDocumentStyle: margins, page size, orientation.
// All dimensions are points (72 pt = 1 inch), consistent with set_style's pt units.
// Google Docs has no "orientation" field — landscape/portrait is just the ordering
// of pageSize width/height, so we resolve a size then order it.

// Named page sizes in points (portrait: width x height).
const PAGE_PRESETS: Record<string, [number, number]> = {
  letter: [612, 792],
  legal: [612, 1008],
  a4: [595.28, 841.89],
  tabloid: [792, 1224],
};

export type PageSize = 'letter' | 'legal' | 'a4' | 'tabloid' | { width: number; height: number };

export interface PageSetup {
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  pageSize?: PageSize;
  orientation?: 'portrait' | 'landscape';
}

export interface PageSetupResult {
  status: 'ok' | 'empty';
  applied?: string[];
  message?: string;
}

const pt = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

export interface PageSetupInfo {
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  pageWidth?: number;
  pageHeight?: number;
  pageSizeName?: string; // a matching preset name, if the dimensions match one
  orientation?: 'portrait' | 'landscape';
}

// Read the current page setup (margins/size/orientation) of a doc or tab — the
// read counterpart to setPageSetup, for mirroring another document's layout.
export async function getPageSetup(
  clients: GoogleClients,
  documentId: string,
  opts: { tab?: string } = {},
): Promise<PageSetupInfo> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tab);
  const ds = documentStyleOf(res.data, tabId);
  const mag = (d: docs_v1.Schema$Dimension | undefined): number | undefined => d?.magnitude ?? undefined;

  const info: PageSetupInfo = {
    marginTop: mag(ds.marginTop),
    marginBottom: mag(ds.marginBottom),
    marginLeft: mag(ds.marginLeft),
    marginRight: mag(ds.marginRight),
    pageWidth: mag(ds.pageSize?.width),
    pageHeight: mag(ds.pageSize?.height),
  };
  if (info.pageWidth !== undefined && info.pageHeight !== undefined) {
    info.orientation = info.pageWidth > info.pageHeight ? 'landscape' : 'portrait';
    const lo = Math.min(info.pageWidth, info.pageHeight);
    const hi = Math.max(info.pageWidth, info.pageHeight);
    for (const [name, [pw, ph]] of Object.entries(PAGE_PRESETS)) {
      if (Math.abs(lo - Math.min(pw, ph)) < 1.5 && Math.abs(hi - Math.max(pw, ph)) < 1.5) {
        info.pageSizeName = name;
        break;
      }
    }
  }
  return info;
}

export async function setPageSetup(
  clients: GoogleClients,
  documentId: string,
  setup: PageSetup,
  opts: { tab?: string } = {},
): Promise<PageSetupResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const revisionId = res.data.revisionId ?? undefined;
  const tabId = resolveTabId(res.data, opts.tab);

  const documentStyle: docs_v1.Schema$DocumentStyle = {};
  const fields: string[] = [];
  const applied: string[] = [];

  const margins: [keyof PageSetup, keyof docs_v1.Schema$DocumentStyle][] = [
    ['marginTop', 'marginTop'],
    ['marginBottom', 'marginBottom'],
    ['marginLeft', 'marginLeft'],
    ['marginRight', 'marginRight'],
  ];
  for (const [key, field] of margins) {
    const v = setup[key] as number | undefined;
    if (v !== undefined) {
      (documentStyle as Record<string, unknown>)[field] = pt(v);
      fields.push(field);
      applied.push(field);
    }
  }

  if (setup.pageSize !== undefined || setup.orientation !== undefined) {
    let w: number;
    let h: number;
    if (setup.pageSize && typeof setup.pageSize === 'object') {
      ({ width: w, height: h } = setup.pageSize);
    } else if (typeof setup.pageSize === 'string') {
      [w, h] = PAGE_PRESETS[setup.pageSize];
    } else {
      // orientation-only: start from the current page size (fallback US Letter).
      const cur = documentStyleOf(res.data, tabId).pageSize;
      w = cur?.width?.magnitude ?? 612;
      h = cur?.height?.magnitude ?? 792;
    }
    // Orientation is width/height ordering: portrait w<=h, landscape w>=h.
    if (setup.orientation === 'landscape' && w < h) [w, h] = [h, w];
    if (setup.orientation === 'portrait' && w > h) [w, h] = [h, w];
    documentStyle.pageSize = { width: pt(w), height: pt(h) };
    fields.push('pageSize');
    if (setup.pageSize !== undefined) applied.push('pageSize');
    if (setup.orientation !== undefined) applied.push('orientation');
  }

  if (!fields.length) return { status: 'empty', message: 'no page-setup fields provided' };

  // tabId on updateDocumentStyle is valid in the live API but lags in googleapis@144 types.
  const updateDocumentStyle = { documentStyle, fields: fields.join(','), ...(tabId ? { tabId } : {}) };
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ updateDocumentStyle } as docs_v1.Schema$Request],
      writeControl: writeControlFor(revisionId),
    },
  });
  return { status: 'ok', applied };
}
