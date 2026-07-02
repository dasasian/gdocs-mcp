import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId } from './structure.js';
import { project } from './transformer.js';
import { locate, rangeFor, contextAround } from './edit.js';
import { hexToRgb } from './color.js';

// Objects markdown can't size/place: images (and tables). Position is `top`,
// `end`, or a unique text anchor (insert right after the matched text).

function tabEndIndex(doc: docs_v1.Schema$Document, tabId?: string): number {
  const content = contentOf(doc, tabId);
  const last = content[content.length - 1];
  return last?.endIndex ?? 2;
}

export interface InsertResult {
  status: 'ok' | 'not_found' | 'ambiguous';
  objectId?: string;
  message?: string;
  matches?: { context: string }[];
}

// Resolve an `at` selector to a Docs insertion index.
function resolveIndex(
  doc: docs_v1.Schema$Document,
  tabId: string | undefined,
  at: string,
): { index: number } | { error: InsertResult } {
  if (at === 'top') return { index: 1 };
  if (at === 'end') return { index: tabEndIndex(doc, tabId) - 1 };
  const proj = project(doc, tabId);
  const { needle, positions } = locate(proj.text, at);
  if (positions.length === 0) return { error: { status: 'not_found', message: `anchor "${at}" not found` } };
  if (positions.length > 1) {
    return {
      error: {
        status: 'ambiguous',
        message: `${positions.length} matches for anchor — add context.`,
        matches: positions.map((p) => ({ context: contextAround(proj.text, p, p + needle.length) })),
      },
    };
  }
  const p = positions[0];
  return { index: rangeFor(proj, p, p + needle.length).endIndex };
}

const ALIGN: Record<'left' | 'center' | 'right', string> = { left: 'START', center: 'CENTER', right: 'END' };

export async function insertImage(
  clients: GoogleClients,
  documentId: string,
  uri: string,
  opts: { at?: string; width?: number; height?: number; align?: 'left' | 'center' | 'right'; tab?: string } = {},
): Promise<InsertResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tab);
  const resolved = resolveIndex(res.data, tabId, opts.at ?? 'top');
  if ('error' in resolved) return resolved.error;
  const index = resolved.index;

  const objectSize =
    opts.width || opts.height
      ? {
          width: opts.width ? { magnitude: opts.width, unit: 'PT' } : undefined,
          height: opts.height ? { magnitude: opts.height, unit: 'PT' } : undefined,
        }
      : undefined;

  const requests: docs_v1.Schema$Request[] = [
    { insertInlineImage: { location: { index, tabId }, uri, objectSize } },
  ];
  // To align, isolate the image on its own paragraph (newline after it) and set
  // that paragraph's alignment. The image occupies one index unit at `index`.
  if (opts.align) {
    requests.push({ insertText: { location: { index: index + 1, tabId }, text: '\n' } });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: index, endIndex: index + 1, tabId },
        paragraphStyle: { alignment: ALIGN[opts.align] },
        fields: 'alignment',
      },
    });
  }

  const r = await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests,
      writeControl: res.data.revisionId ? { requiredRevisionId: res.data.revisionId } : undefined,
    },
  });
  const reply = r.data.replies?.[0] as { insertInlineImage?: { objectId?: string } } | undefined;
  return { status: 'ok', objectId: reply?.insertInlineImage?.objectId };
}

export interface TableOptions {
  at?: string;
  tab?: string;
  data?: string[][];
  columnWidths?: number[]; // points per column
  headerShade?: string; // hex bg color for row 0, e.g. "#f1f3f4"
}

export async function insertTable(
  clients: GoogleClients,
  documentId: string,
  rows: number,
  columns: number,
  opts: TableOptions = {},
): Promise<InsertResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tab);
  const resolved = resolveIndex(res.data, tabId, opts.at ?? 'end');
  if ('error' in resolved) return resolved.error;
  const insertIndex = resolved.index;

  // 1. Insert the empty table.
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ insertTable: { location: { index: insertIndex, tabId }, rows, columns } }],
      writeControl: res.data.revisionId ? { requiredRevisionId: res.data.revisionId } : undefined,
    },
  });

  const needsPass2 = opts.data || opts.columnWidths || opts.headerShade;
  if (!needsPass2) return { status: 'ok' };

  // 2. Re-fetch (the table now exists) and fill data + styling. Cell text inserts
  // go descending so earlier inserts don't shift later cell indices; width/shade
  // use logical table locations (stable regardless of text).
  const after = (await clients.docs.documents.get({ documentId, includeTabsContent: true })).data;
  const tables = contentOf(after, tabId).filter((e) => e.table && (e.startIndex ?? 0) >= insertIndex);
  const tableEl = tables.sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0))[0];
  const tableStart = tableEl?.startIndex;
  if (!tableEl?.table?.tableRows || tableStart == null) return { status: 'ok' };

  const requests: docs_v1.Schema$Request[] = [];

  if (opts.data) {
    const inserts: { index: number; text: string }[] = [];
    tableEl.table.tableRows.forEach((row, r) => {
      row.tableCells?.forEach((cell, c) => {
        const text = opts.data?.[r]?.[c];
        const idx = cell.content?.[0]?.startIndex;
        if (text && idx != null) inserts.push({ index: idx, text });
      });
    });
    inserts.sort((a, b) => b.index - a.index);
    for (const i of inserts) requests.push({ insertText: { location: { index: i.index, tabId }, text: i.text } });
  }

  if (opts.columnWidths) {
    opts.columnWidths.forEach((w, i) => {
      if (i < columns) {
        requests.push({
          updateTableColumnProperties: {
            tableStartLocation: { index: tableStart, tabId },
            columnIndices: [i],
            tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: w, unit: 'PT' } },
            fields: 'width,widthType',
          },
        });
      }
    });
  }

  if (opts.headerShade) {
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: { tableStartLocation: { index: tableStart, tabId }, rowIndex: 0, columnIndex: 0 },
          rowSpan: 1,
          columnSpan: columns,
        },
        tableCellStyle: { backgroundColor: { color: { rgbColor: hexToRgb(opts.headerShade) } } },
        fields: 'backgroundColor',
      },
    });
  }

  if (requests.length) {
    await clients.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: after.revisionId ? { requiredRevisionId: after.revisionId } : undefined,
      },
    });
  }
  return { status: 'ok' };
}
