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

// Body content for a specific tab (by id), else the first tab, else the legacy body.
export function contentOf(
  doc: docs_v1.Schema$Document,
  tabId?: string,
): docs_v1.Schema$StructuralElement[] {
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
