import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId } from './structure.js';

// Spike-validated logic. Suggestions live in the Docs API only (no author/time —
// confirmed unavailable). We read in SUGGESTIONS_INLINE (the only mode whose
// indices are valid for a follow-up batchUpdate), group tagged runs by suggestion
// id, and emit before→after diffs.

export type SuggestionType = 'insertion' | 'deletion' | 'replacement' | 'style';

export interface Suggestion {
  id: string;
  type: SuggestionType;
  before: string;
  after: string;
  start: number;
  end: number;
  contiguous: boolean;
}

interface Span {
  start: number;
  end: number;
  text: string;
}

interface Group {
  id: string;
  insertions: Span[];
  deletions: Span[];
  styleOnly: boolean;
}

export async function getDocInline(
  clients: GoogleClients,
  documentId: string,
): Promise<docs_v1.Schema$Document> {
  const res = await clients.docs.documents.get({
    documentId,
    suggestionsViewMode: 'SUGGESTIONS_INLINE',
    includeTabsContent: true,
  });
  return res.data;
}

export function parseSuggestions(doc: docs_v1.Schema$Document, tabId?: string): Suggestion[] {
  const groups = new Map<string, Group>();
  const ensure = (id: string): Group => {
    let g = groups.get(id);
    if (!g) {
      g = { id, insertions: [], deletions: [], styleOnly: false };
      groups.set(id, g);
    }
    return g;
  };

  for (const el of contentOf(doc, tabId)) {
    const elements = el.paragraph?.elements;
    if (!elements) continue;
    for (const pe of elements) {
      const run = pe.textRun;
      if (!run) continue;
      const span: Span = { start: pe.startIndex ?? 0, end: pe.endIndex ?? 0, text: run.content ?? '' };
      for (const id of run.suggestedInsertionIds ?? []) ensure(id).insertions.push(span);
      for (const id of run.suggestedDeletionIds ?? []) ensure(id).deletions.push(span);
      const styleChanges = run.suggestedTextStyleChanges ?? {};
      for (const id of Object.keys(styleChanges)) ensure(id).styleOnly = true;
    }
  }

  return [...groups.values()].map((g) => {
    const all = [...g.insertions, ...g.deletions];
    const start = Math.min(...all.map((s) => s.start));
    const end = Math.max(...all.map((s) => s.end));
    const before = g.deletions.map((s) => s.text).join('');
    const after = g.insertions.map((s) => s.text).join('');
    let type: SuggestionType = 'style';
    if (g.insertions.length && g.deletions.length) type = 'replacement';
    else if (g.insertions.length) type = 'insertion';
    else if (g.deletions.length) type = 'deletion';
    return { id: g.id, type, before, after, start, end, contiguous: isContiguous(all) };
  });
}

function isContiguous(spans: Span[]): boolean {
  const s = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < s.length; i++) {
    if (s[i].start !== s[i - 1].end) return false;
  }
  return true;
}

// Short human-readable summary of a suggestion, independent of accept/reject.
// Callers echo this back into apply_suggestion (as `expectedChange`) so the
// permission prompt shows what's actually being resolved instead of a bare id,
// and so a stale/wrong id gets caught before anything is applied.
export function formatSuggestionPreview(s: Pick<Suggestion, 'type' | 'before' | 'after'>): string {
  const before = s.before.trim();
  const after = s.after.trim();
  if (s.type === 'insertion') return `insert: "${after}"`;
  if (s.type === 'deletion') return `delete: "${before}"`;
  if (s.type === 'replacement') return `"${before}" → "${after}"`;
  return '(style change)';
}

export async function listSuggestions(
  clients: GoogleClients,
  documentId: string,
  tab?: string,
): Promise<{ revisionId: string; title: string; suggestions: (Suggestion & { preview: string })[] }> {
  const doc = await getDocInline(clients, documentId);
  const tabId = resolveTabId(doc, tab);
  const suggestions = parseSuggestions(doc, tabId).map((s) => ({ ...s, preview: formatSuggestionPreview(s) }));
  return { revisionId: doc.revisionId ?? '', title: doc.title ?? '', suggestions };
}

// Resolve a suggestion by reconstructing its tagged span (spike-validated):
// accept => final text is `after`; reject => `before`. Delete the span, reinsert
// the chosen text as a direct edit — this strips the suggestion tag cleanly.
function buildResolveRequests(
  s: Suggestion,
  decision: 'accept' | 'reject',
  tabId?: string,
): docs_v1.Schema$Request[] {
  const finalText = decision === 'accept' ? s.after : s.before;
  const requests: docs_v1.Schema$Request[] = [
    { deleteContentRange: { range: { startIndex: s.start, endIndex: s.end, tabId } } },
  ];
  if (finalText) requests.push({ insertText: { location: { index: s.start, tabId }, text: finalText } });
  return requests;
}

export async function applySuggestion(
  clients: GoogleClients,
  documentId: string,
  suggestionId: string,
  decision: 'accept' | 'reject',
  expectedChange: string,
  tab?: string,
): Promise<{ status: 'ok' | 'not_found' | 'unsupported' | 'stale'; message?: string }> {
  const doc = await getDocInline(clients, documentId);
  const tabId = resolveTabId(doc, tab);
  const s = parseSuggestions(doc, tabId).find((x) => x.id === suggestionId);
  if (!s) return { status: 'not_found', message: `suggestion ${suggestionId} not found (may be already resolved)` };
  if (s.type === 'style') return { status: 'unsupported', message: 'style-only suggestions are not yet resolvable' };
  if (!s.contiguous) return { status: 'unsupported', message: 'non-contiguous suggestion span' };

  const actual = formatSuggestionPreview(s);
  if (actual !== expectedChange) {
    return {
      status: 'stale',
      message: `expectedChange did not match the live suggestion (expected "${expectedChange}", found "${actual}"). The doc may have changed since list_suggestions, or this id belongs to a different suggestion. Re-run list_suggestions and retry with the current preview.`,
    };
  }

  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: buildResolveRequests(s, decision, tabId),
      writeControl: doc.revisionId ? { requiredRevisionId: doc.revisionId } : undefined,
    },
  });
  return { status: 'ok' };
}
