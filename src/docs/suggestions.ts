import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf, resolveTabId, tabContainer, writeControlFor, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { asRequest, getDocForReview, type ReviewedDocument } from './comments.js';

const SUGGESTED_FIELD = /^suggested[A-Z]/;
const CONTEXT_REACH = 40;
const CHANGE_REACH = 80;

type Holder = { kind: 'paragraph'; paragraph: docs_v1.Schema$Paragraph } | { kind: 'row'; row: docs_v1.Schema$TableRow } | { kind: 'nothing' };

function idsNamedBy(node: object): string[] {
  return Object.entries(node).flatMap(([field, value]) => {
    if (!SUGGESTED_FIELD.test(field) || value === null || typeof value !== 'object') return [];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : Object.keys(value);
  });
}

function holderFor(node: object, inherited: Holder): Holder {
  const { paragraph, tableCells } = node as { paragraph?: docs_v1.Schema$Paragraph; tableCells?: unknown };
  if (paragraph) return { kind: 'paragraph', paragraph };
  if (Array.isArray(tableCells)) return { kind: 'row', row: node as docs_v1.Schema$TableRow };
  return inherited;
}

function collectIds(node: unknown, inherited: Holder, found: Map<string, Holder>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => collectIds(child, inherited, found));
    return;
  }
  const holder = holderFor(node, inherited);
  for (const id of idsNamedBy(node)) if (!found.has(id)) found.set(id, holder);
  Object.values(node).forEach((child) => collectIds(child, holder, found));
}

function suggestionHolders(roots: unknown[]): Map<string, Holder> {
  const found = new Map<string, Holder>();
  roots.forEach((root) => collectIds(root, { kind: 'nothing' }, found));
  return found;
}

function segmentRoot(doc: ReviewedDocument, tabId: string | undefined, segmentId: string): unknown {
  const container = tabContainer(doc, tabId);
  return container?.headers?.[segmentId] ?? container?.footers?.[segmentId];
}

function rootsFor(doc: ReviewedDocument, tabId: string | undefined, segmentId: string | undefined): unknown[] {
  if (segmentId) return [segmentRoot(doc, tabId, segmentId)];
  const container = tabContainer(doc, tabId);
  return [contentOf(doc, tabId), container?.documentStyle, container?.namedStyles];
}

function rootsOfWholeDoc(doc: ReviewedDocument): unknown[] {
  if (doc.tabs?.length) return [doc.tabs];
  return [doc.body, doc.headers, doc.footers, doc.documentStyle, doc.namedStyles];
}

/** How many suggestions touch the content of a tab's body, or of its header or footer (`segmentId`). */
export function countSuggestions(doc: ReviewedDocument, tabId: string | undefined, segmentId?: string): number {
  return suggestionHolders([contentOf(doc, tabId, segmentId)]).size;
}

const clipped = (text: string, reach: number): string => (text.length > reach ? `${text.slice(0, reach)}…` : text);
const lineBreaksShown = (text: string): string => text.replace(/\n/g, '⏎');

function textUnder(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textUnder).join('');
  const { textRun } = node as { textRun?: docs_v1.Schema$TextRun };
  if (textRun) return textRun.content ?? '';
  return Object.values(node).map(textUnder).join('');
}

const withoutParagraphMark = (text: string): string => text.replace(/\n$/, '');

function paragraphContext(paragraph: docs_v1.Schema$Paragraph, id: string): string {
  let before = '';
  let after = '';
  let deleted = '';
  let inserted = '';
  let atChange = false;
  for (const element of paragraph.elements ?? []) {
    const run = element.textRun;
    const content = run?.content ?? '';
    if (run?.suggestedInsertionIds?.includes(id)) {
      atChange = true;
      inserted += content;
    } else if (run?.suggestedDeletionIds?.includes(id)) {
      atChange = true;
      deleted += content;
    } else if (run?.suggestedDeletionIds?.length) {
      continue;
    } else if (atChange) {
      after += content;
    } else {
      before += content;
    }
  }
  if (!atChange) return clipped(withoutParagraphMark(before), CONTEXT_REACH * 2);
  const change = `[${lineBreaksShown(clipped(deleted, CHANGE_REACH))}→${lineBreaksShown(clipped(inserted, CHANGE_REACH))}]`;
  const lead = before.length > CONTEXT_REACH ? `…${before.slice(-CONTEXT_REACH)}` : before;
  const trail = withoutParagraphMark(after);
  return `${lead}${change}${trail.length > CONTEXT_REACH ? `${trail.slice(0, CONTEXT_REACH)}…` : trail}`;
}

function contextFor(holder: Holder, id: string): string | undefined {
  if (holder.kind === 'paragraph') return paragraphContext(holder.paragraph, id);
  if (holder.kind === 'row') return clipped(textUnder(holder.row).replace(/\s+/g, ' ').trim(), CONTEXT_REACH * 2);
  return undefined;
}

export interface ListedSuggestion {
  id: string;
  summary: string;
  context: string;
  author: string | null;
  time: string | null;
}

/**
 * The pending suggestions on a tab's body (with its document and named styles), or on one header or footer, in document order.
 * Docs does not mark a suggestion to a named style anywhere in the content; those are listed after the others, from the doc's SuggestionThreads.
 * `summary` is Docs' own words for the change; `context` is the change in its sentence, `[deleted→inserted]`, and is what
 * `apply_suggestions` checks. `doc` must come from `getDocForReview`.
 */
export function readSuggestions(doc: ReviewedDocument, tabId: string | undefined, segmentId?: string): ListedSuggestion[] {
  const threads = new Map((doc.suggestions ?? []).map((thread) => [thread.suggestionId, thread]));
  const here = suggestionHolders(rootsFor(doc, tabId, segmentId));
  const placedAnywhere = suggestionHolders(rootsOfWholeDoc(doc));
  const unplaced = segmentId ? [] : [...threads.values()].filter((thread) => thread.status === 'OPEN' && !placedAnywhere.has(thread.suggestionId)).map((thread) => thread.suggestionId);
  return [...here.keys(), ...unplaced].map((id) => {
    const thread = threads.get(id);
    const summary = thread?.summaryText ?? '';
    const holder = here.get(id);
    return {
      id,
      summary,
      context: (holder && contextFor(holder, id)) || summary,
      author: thread?.headPost?.author?.displayName ?? null,
      time: thread?.headPost?.createTime ?? null,
    };
  });
}

export async function listSuggestions(
  clients: GoogleClients,
  documentId: string,
  requestedTabId?: string,
  opts: { segment?: SegmentKind; page?: SegmentPage } = {},
): Promise<{ revisionId: string; title: string; suggestions: ListedSuggestion[]; message?: string }> {
  const doc = await getDocForReview(clients, documentId);
  const tabId = resolveTabId(doc, requestedTabId);
  const target = resolveSegmentTarget(doc, { segment: opts.segment, page: opts.page, tabId });
  const header = { revisionId: doc.revisionId ?? '', title: doc.title ?? '' };
  if (target.error) return { ...header, suggestions: [], message: target.error };
  return { ...header, suggestions: readSuggestions(doc, tabId, target.segmentId) };
}

export interface Resolution {
  suggestionId: string;
  decision: 'accept' | 'reject';
  expectContext: string;
}

export interface ApplyResult {
  status: 'ok' | 'error' | 'wrong_doc' | 'no_segment';
  resolved?: number;
  errors?: string[];
}

function refusalFor(resolution: Resolution, listed: Map<string, ListedSuggestion>): string | undefined {
  const suggestion = listed.get(resolution.suggestionId);
  if (!suggestion) return `${resolution.suggestionId}: not found (it may be already resolved, or in another tab, header or footer)`;
  if (suggestion.context !== resolution.expectContext) return `${resolution.suggestionId}: expectContext mismatch (found "${suggestion.context}")`;
  return undefined;
}

/**
 * Accepts or rejects each suggestion on its own, as clicking the check or the cross in Docs does, in one batch after
 * `expectTitle` and every `expectContext` match the live doc. Nothing is sent if any of them does not.
 */
export async function applySuggestions(
  clients: GoogleClients,
  documentId: string,
  expectTitle: string,
  resolutions: Resolution[],
  requestedTabId?: string,
  opts: { segment?: SegmentKind; page?: SegmentPage } = {},
): Promise<ApplyResult> {
  const doc = await getDocForReview(clients, documentId);
  const title = doc.title ?? '';
  if (title !== expectTitle) {
    return { status: 'wrong_doc', errors: [`expectTitle did not match the live document (expected "${expectTitle}", found "${title}"). This id may belong to a different, similarly-titled document — run list_suggestions on the intended document and retry.`] };
  }
  const tabId = resolveTabId(doc, requestedTabId);
  const target = resolveSegmentTarget(doc, { segment: opts.segment, page: opts.page, tabId });
  if (target.error) return { status: 'no_segment', errors: [target.error] };
  const listed = new Map(readSuggestions(doc, tabId, target.segmentId).map((suggestion) => [suggestion.id, suggestion]));
  const duplicates = resolutions.filter((resolution, i) => resolutions.findIndex((other) => other.suggestionId === resolution.suggestionId) !== i);
  const errors = [
    ...duplicates.map((resolution) => `${resolution.suggestionId}: given more than once`),
    ...resolutions.flatMap((resolution) => refusalFor(resolution, listed) ?? []),
  ];
  if (errors.length) return { status: 'error', errors };
  const requests = resolutions.map(({ suggestionId, decision }) => asRequest(decision === 'accept' ? { acceptSuggestion: { suggestionId } } : { rejectSuggestion: { suggestionId } }));
  await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests, writeControl: writeControlFor(doc.revisionId) } });
  return { status: 'ok', resolved: resolutions.length };
}
