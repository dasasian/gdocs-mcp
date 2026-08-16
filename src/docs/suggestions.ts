import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, writeControlFor, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';

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

export function parseSuggestions(doc: docs_v1.Schema$Document, tabId?: string, segmentId?: string): Suggestion[] {
  const groups = new Map<string, Group>();
  const ensure = (id: string): Group => {
    let g = groups.get(id);
    if (!g) {
      g = { id, insertions: [], deletions: [], styleOnly: false };
      groups.set(id, g);
    }
    return g;
  };

  for (const el of contentOf(doc, tabId, segmentId)) {
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
// Callers echo this back into apply_suggestions (as `expectedChange`) so the
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
  opts: { segment?: SegmentKind; page?: SegmentPage } = {},
): Promise<{ revisionId: string; title: string; suggestions: (Suggestion & { preview: string })[]; message?: string }> {
  const doc = await getDocInline(clients, documentId);
  const tabId = resolveTabId(doc, tab);
  const seg = await resolveSegmentTarget(clients, documentId, doc, { segment: opts.segment, page: opts.page, tabId });
  if (seg.error) return { revisionId: doc.revisionId ?? '', title: doc.title ?? '', suggestions: [], message: seg.error };
  const suggestions = parseSuggestions(seg.doc, tabId, seg.segmentId).map((s) => ({ ...s, preview: formatSuggestionPreview(s) }));
  return { revisionId: doc.revisionId ?? '', title: doc.title ?? '', suggestions };
}

// ---- Cluster-aware resolution (fixes #7) ----
//
// The naive resolve (delete a suggestion's span, insert its chosen text) is only
// safe when that suggestion is ISOLATED. When suggestions overlap, abut, or
// interleave (a non-contiguous suggestion spans across its neighbours), resolving
// one at a time via separate batchUpdates shifts indices and merges/re-tags the
// neighbours — silently corrupting them while every call reports success.
//
// Fix: treat overlapping/touching suggestions as a CLUSTER that must be resolved
// together, atomically. For a cluster region we compute the final plain text from
// the raw runs + a decision per member (accept keeps insertions & drops deletions;
// reject the reverse; untagged text is kept), then delete the whole region and
// insert that text in one shot — no interleaving, no inheritance, no per-call drift.

export interface TaggedRun {
  start: number;
  end: number;
  text: string;
  insertionId?: string;
  deletionId?: string;
  styleIds?: string[];
}

export function collectRuns(doc: docs_v1.Schema$Document, tabId?: string, segmentId?: string): TaggedRun[] {
  const runs: TaggedRun[] = [];
  for (const el of contentOf(doc, tabId, segmentId)) {
    for (const pe of el.paragraph?.elements ?? []) {
      const run = pe.textRun;
      if (!run?.content) continue;
      // Google attaches suggestedTextStyleChanges to normal insertion/deletion runs
      // too; a *style-only* suggestion is a style change on a run that is NOT being
      // inserted or deleted. Only those count as style ids here.
      const isEdit = (run.suggestedInsertionIds?.length ?? 0) > 0 || (run.suggestedDeletionIds?.length ?? 0) > 0;
      const styleIds = isEdit ? [] : Object.keys(run.suggestedTextStyleChanges ?? {});
      runs.push({
        start: pe.startIndex ?? 0,
        end: pe.endIndex ?? 0,
        text: run.content,
        insertionId: run.suggestedInsertionIds?.[0],
        deletionId: run.suggestedDeletionIds?.[0],
        ...(styleIds.length ? { styleIds } : {}),
      });
    }
  }
  return runs;
}

export interface Cluster {
  ids: string[];
  start: number;
  end: number;
}

// Group suggestions whose spans overlap or touch. Style-only suggestions have no
// text span (excluded here; handled via regionHasStyleSuggestion).
export function clusterSuggestions(suggestions: Suggestion[]): Cluster[] {
  const spatial = suggestions.filter((s) => s.type !== 'style' && Number.isFinite(s.start));
  const sorted = [...spatial].sort((a, b) => a.start - b.start);
  const clusters: Cluster[] = [];
  for (const s of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      last.ids.push(s.id);
    } else {
      clusters.push({ ids: [s.id], start: s.start, end: s.end });
    }
  }
  return clusters;
}

// Final plain text for a region given a decision per suggestion.
export function resolveRegionText(
  runs: TaggedRun[],
  start: number,
  end: number,
  decisions: Map<string, 'accept' | 'reject'>,
): string {
  let text = '';
  for (const r of runs) {
    if (r.start < start || r.end > end) continue;
    if (r.insertionId) {
      if (decisions.get(r.insertionId) === 'accept') text += r.text;
    } else if (r.deletionId) {
      if (decisions.get(r.deletionId) === 'reject') text += r.text;
    } else {
      text += r.text;
    }
  }
  return text;
}

export interface Conflict {
  insertionId: string;
  deletionId: string;
  text: string;
}

// A true conflict: a run tagged as BOTH an accepted insertion and an accepted
// deletion (from two different suggestions) — one suggestion inserts text inside
// a region another suggestion deletes, and both are being accepted. That's
// contradictory; resolveRegionText keeps the inserted text (insertion-precedence),
// which is deterministic but not something to resolve silently (#11).
export function detectConflicts(
  runs: TaggedRun[],
  start: number,
  end: number,
  decisions: Map<string, 'accept' | 'reject'>,
): Conflict[] {
  const out: Conflict[] = [];
  for (const r of runs) {
    if (r.start < start || r.end > end) continue;
    if (
      r.insertionId &&
      r.deletionId &&
      r.insertionId !== r.deletionId &&
      decisions.get(r.insertionId) === 'accept' &&
      decisions.get(r.deletionId) === 'accept'
    ) {
      out.push({ insertionId: r.insertionId, deletionId: r.deletionId, text: r.text.trim() });
    }
  }
  return out;
}

// A region we're about to replace must not contain a style-only suggestion —
// a delete+insert would silently drop it.
function regionHasStyleSuggestion(runs: TaggedRun[], start: number, end: number): boolean {
  return runs.some((r) => r.start >= start && r.end <= end && (r.styleIds?.length ?? 0) > 0);
}

function regionRequests(
  runs: TaggedRun[],
  cluster: Cluster,
  decisions: Map<string, 'accept' | 'reject'>,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const finalText = resolveRegionText(runs, cluster.start, cluster.end, decisions);
  const requests: docs_v1.Schema$Request[] = [
    { deleteContentRange: { range: { startIndex: cluster.start, endIndex: cluster.end, tabId, segmentId } } },
  ];
  if (finalText) requests.push({ insertText: { location: { index: cluster.start, tabId, segmentId }, text: finalText } });
  return requests;
}

// Anchors a call to the document, not just the change (#9): a same-worded
// suggestion can exist in two near-identical documents, and expectedChange
// alone wouldn't catch approving it on the wrong one.
function checkDocumentTitle(doc: docs_v1.Schema$Document, documentTitle: string): string | undefined {
  const actual = doc.title ?? '';
  if (actual === documentTitle) return undefined;
  return `documentTitle did not match the live document (expected "${documentTitle}", found "${actual}"). This id may belong to a different, similarly-titled document — re-run list_suggestions on the intended document and retry.`;
}

export interface Resolution {
  suggestionId: string;
  decision: 'accept' | 'reject';
  expectedChange?: string;
}

export interface ApplyManyResult {
  status: 'ok' | 'error' | 'incomplete' | 'wrong_doc' | 'no_segment';
  resolved?: number;
  errors?: string[];
  /** Overlapping insert-inside-delete conflicts that were auto-resolved (insertion kept). */
  conflicts?: (Conflict & { note: string })[];
}

// Resolve several suggestions in ONE atomic batchUpdate. Required for clusters:
// any cluster touched by `resolutions` must be resolved in full (every member
// decided), or the call is refused — never a partial, corrupting resolution.
export async function applySuggestions(
  clients: GoogleClients,
  documentId: string,
  documentTitle: string,
  resolutions: Resolution[],
  tab?: string,
  opts: { segment?: SegmentKind; page?: SegmentPage } = {},
): Promise<ApplyManyResult> {
  const doc = await getDocInline(clients, documentId);
  const wrongDoc = checkDocumentTitle(doc, documentTitle);
  if (wrongDoc) return { status: 'wrong_doc', errors: [wrongDoc] };

  const tabId = resolveTabId(doc, tab);
  // Read and write must agree on the segment: indices are per-segment, so runs
  // collected from a header can only be written back with that header's id.
  const seg = await resolveSegmentTarget(clients, documentId, doc, { segment: opts.segment, page: opts.page, tabId });
  if (seg.error) return { status: 'no_segment', errors: [seg.error] };
  const segmentId = seg.segmentId;
  const suggestions = parseSuggestions(seg.doc, tabId, segmentId);
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const clusters = clusterSuggestions(suggestions);
  const runs = collectRuns(seg.doc, tabId, segmentId);

  const decisions = new Map<string, 'accept' | 'reject'>();
  const errors: string[] = [];
  for (const r of resolutions) {
    const s = byId.get(r.suggestionId);
    if (!s) {
      errors.push(`${r.suggestionId}: not found (may be already resolved)`);
      continue;
    }
    if (s.type === 'style') {
      errors.push(`${r.suggestionId}: style-only, not resolvable`);
      continue;
    }
    if (r.expectedChange !== undefined && formatSuggestionPreview(s) !== r.expectedChange) {
      errors.push(`${r.suggestionId}: expectedChange mismatch (found "${formatSuggestionPreview(s)}")`);
      continue;
    }
    decisions.set(r.suggestionId, r.decision);
  }
  if (errors.length) return { status: 'error', errors };

  const touched = clusters.filter((c) => c.ids.some((id) => decisions.has(id)));
  for (const c of touched) {
    const missing = c.ids.filter((id) => !decisions.has(id));
    if (missing.length) {
      errors.push(`cluster [${c.ids.join(', ')}] partially resolved — also decide ${missing.join(', ')} (resolving part of a cluster corrupts the rest)`);
    }
    if (regionHasStyleSuggestion(runs, c.start, c.end)) {
      errors.push(`cluster [${c.ids.join(', ')}] overlaps a style-only suggestion (not resolvable)`);
    }
  }
  if (errors.length) return { status: 'incomplete', errors };

  const requests: docs_v1.Schema$Request[] = [];
  const conflicts: (Conflict & { note: string })[] = [];
  for (const c of [...touched].sort((a, b) => b.start - a.start)) {
    for (const cf of detectConflicts(runs, c.start, c.end, decisions)) {
      conflicts.push({
        ...cf,
        note: `Insertion ${cf.insertionId} ("${cf.text}") sits inside deletion ${cf.deletionId}; accepting both is contradictory. Kept the inserted text (insertion-precedence). Flag this to the user — it is not a clean merge.`,
      });
    }
    requests.push(...regionRequests(runs, c, decisions, tabId, segmentId));
  }
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests,
      writeControl: writeControlFor(doc.revisionId),
    },
  });
  return { status: 'ok', resolved: decisions.size, ...(conflicts.length ? { conflicts } : {}) };
}
