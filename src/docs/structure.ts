import type { docs_v1 } from 'googleapis';

// Flatten the tab tree (depth-first), including nested child tabs.
export function flattenTabs(doc: docs_v1.Schema$Document): docs_v1.Schema$Tab[] {
  const out: docs_v1.Schema$Tab[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined): void => {
    for (const t of tabs ?? []) {
      out.push(t);
      walk(t.childTabs ?? undefined);
    }
  };
  walk(doc.tabs ?? undefined);
  return out;
}

export function findTab(doc: docs_v1.Schema$Document, tabId: string): docs_v1.Schema$Tab | undefined {
  return flattenTabs(doc).find((t) => t.tabProperties?.tabId === tabId);
}

// Resolve a user-supplied tab selector (tabId OR title) to a concrete tabId.
// undefined selector => undefined (caller uses the first tab / legacy body).
export function resolveTabId(doc: docs_v1.Schema$Document, tab?: string): string | undefined {
  if (!tab) return undefined;
  const tabs = flattenTabs(doc);
  const byId = tabs.find((t) => t.tabProperties?.tabId === tab);
  const match = byId ?? tabs.find((t) => t.tabProperties?.title === tab);
  if (!match?.tabProperties?.tabId) {
    const available = tabs.map((t) => t.tabProperties?.title).filter(Boolean).join(', ');
    throw new Error(`tab "${tab}" not found. Available: ${available || '(none)'}`);
  }
  return match.tabProperties.tabId;
}

// ---- Segments (#23) --------------------------------------------------------
//
// A doc is not just its body: headers and footers are parallel content trees,
// addressed in write requests by `segmentId` (the body's segmentId is empty).
// Everything that walks content takes an optional segmentId so read and write
// reach the same places.

export type SegmentKind = 'body' | 'header' | 'footer';
/** Which of the (up to) three headers/footers a doc can define. */
export type SegmentPage = 'default' | 'first' | 'even';

const ID_FIELD: Record<SegmentPage, { header: keyof docs_v1.Schema$DocumentStyle; footer: keyof docs_v1.Schema$DocumentStyle }> = {
  default: { header: 'defaultHeaderId', footer: 'defaultFooterId' },
  first: { header: 'firstPageHeaderId', footer: 'firstPageFooterId' },
  even: { header: 'evenPageHeaderId', footer: 'evenPageFooterId' },
};

export function documentStyleOf(doc: docs_v1.Schema$Document, tabId?: string): docs_v1.Schema$DocumentStyle {
  if (doc.tabs && doc.tabs.length) {
    const tab = tabId ? findTab(doc, tabId) : doc.tabs[0];
    return tab?.documentTab?.documentStyle ?? {};
  }
  return doc.documentStyle ?? {};
}

function segmentMap(
  doc: docs_v1.Schema$Document,
  kind: 'header' | 'footer',
  tabId?: string,
): Record<string, docs_v1.Schema$Header | docs_v1.Schema$Footer> {
  if (doc.tabs && doc.tabs.length) {
    const tab = tabId ? findTab(doc, tabId) : doc.tabs[0];
    return (kind === 'header' ? tab?.documentTab?.headers : tab?.documentTab?.footers) ?? {};
  }
  return (kind === 'header' ? doc.headers : doc.footers) ?? {};
}

export interface SegmentInfo {
  kind: 'header' | 'footer';
  page: SegmentPage;
  segmentId: string;
  paragraphs: number;
  images: number;
  /** first bit of text, so a read can show what's in there without a second call. */
  preview: string;
}

function summarize(content: docs_v1.Schema$StructuralElement[]): { paragraphs: number; images: number; preview: string } {
  let paragraphs = 0;
  let images = 0;
  let text = '';
  for (const el of content) {
    if (!el.paragraph) continue;
    paragraphs += 1;
    for (const pe of el.paragraph.elements ?? []) {
      if (pe.inlineObjectElement) images += 1;
      text += pe.textRun?.content ?? '';
    }
  }
  return { paragraphs, images, preview: text.replace(/\s+/g, ' ').trim().slice(0, 80) };
}

// Every header/footer this doc/tab actually defines. Drives read_doc's marker —
// a doc whose logo lives in the header must not read as empty (#23).
export function listSegments(doc: docs_v1.Schema$Document, tabId?: string): SegmentInfo[] {
  const style = documentStyleOf(doc, tabId);
  const out: SegmentInfo[] = [];
  for (const kind of ['header', 'footer'] as const) {
    const map = segmentMap(doc, kind, tabId);
    for (const page of ['default', 'first', 'even'] as SegmentPage[]) {
      const segmentId = style[ID_FIELD[page][kind]] as string | undefined;
      if (!segmentId) continue;
      const content = map[segmentId]?.content ?? [];
      out.push({ kind, page, segmentId, ...summarize(content) });
    }
  }
  return out;
}

// Resolve a (kind, page) selector to a concrete segmentId. `page` defaults to
// whichever exists, preferring default — a first-page-only letterhead header is
// the common case, so an unqualified "header" must still find it.
export function resolveSegmentId(
  doc: docs_v1.Schema$Document,
  kind: SegmentKind,
  page?: SegmentPage,
  tabId?: string,
): string | undefined {
  if (kind === 'body') return undefined;
  const segments = listSegments(doc, tabId).filter((s) => s.kind === kind);
  if (!segments.length) return undefined;
  if (page) return segments.find((s) => s.page === page)?.segmentId;
  const order: SegmentPage[] = ['default', 'first', 'even'];
  for (const p of order) {
    const hit = segments.find((s) => s.page === p);
    if (hit) return hit.segmentId;
  }
  return undefined;
}

// Content for a specific tab (by id), else the first tab, else the legacy body.
// With a segmentId, returns that header/footer's content instead of the body.
export function contentOf(
  doc: docs_v1.Schema$Document,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$StructuralElement[] {
  if (segmentId) {
    const fromHeader = segmentMap(doc, 'header', tabId)[segmentId];
    const fromFooter = segmentMap(doc, 'footer', tabId)[segmentId];
    return (fromHeader ?? fromFooter)?.content ?? [];
  }
  if (doc.tabs && doc.tabs.length) {
    const tab = tabId ? findTab(doc, tabId) : doc.tabs[0];
    return tab?.documentTab?.body?.content ?? [];
  }
  return doc.body?.content ?? [];
}

// The lists map (listId -> List) for the active tab / legacy body. Used to tell
// ordered lists from bullet lists when rendering.
export function listsOf(
  doc: docs_v1.Schema$Document,
  tabId?: string,
): Record<string, docs_v1.Schema$List> {
  if (doc.tabs && doc.tabs.length) {
    const tab = tabId ? findTab(doc, tabId) : doc.tabs[0];
    return tab?.documentTab?.lists ?? {};
  }
  return doc.lists ?? {};
}

// Named styles (NORMAL_TEXT, HEADING_1, …) for the active tab / legacy body.
// Paragraph/run styles inherit from these, so resolving effective style needs them.
export function namedStylesOf(
  doc: docs_v1.Schema$Document,
  tabId?: string,
): docs_v1.Schema$NamedStyle[] {
  if (doc.tabs && doc.tabs.length) {
    const tab = tabId ? findTab(doc, tabId) : doc.tabs[0];
    return tab?.documentTab?.namedStyles?.styles ?? doc.namedStyles?.styles ?? [];
  }
  return doc.namedStyles?.styles ?? [];
}

// The inlineObjects map (id -> InlineObject) for the active tab / legacy body.
export function inlineObjectsOf(
  doc: docs_v1.Schema$Document,
  tabId?: string,
): Record<string, docs_v1.Schema$InlineObject> {
  if (doc.tabs && doc.tabs.length) {
    const tab = tabId ? findTab(doc, tabId) : doc.tabs[0];
    return tab?.documentTab?.inlineObjects ?? {};
  }
  return doc.inlineObjects ?? {};
}
