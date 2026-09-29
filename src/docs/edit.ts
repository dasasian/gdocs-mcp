import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project, type Projection } from './transformer.js';
import { resolveTabId, writeControlFor, type SegmentKind, type SegmentPage } from './structure.js';
import { resolveSegmentTarget } from './segments.js';
import { parseInline, segmentTextStyle, type Segment } from './inline.js';

// String-anchored editing (bet #3). The agent quotes a unique slice of text;
// we locate it in the plain-text projection, map to Docs indices, and emit a
// delete+insert batchUpdate. Indices are never exposed.
//
// v1 scope: new_string is inserted as PLAIN text (markdown/HTML interpretation of
// new_string is the next increment). Matching is exact, with a markup-tolerant
// fallback (so "# Title" or "**x**" copied from a read still resolves).

export interface EditResult {
  status: 'ok' | 'not_found' | 'ambiguous' | 'no_segment';
  replaced?: number;
  matches?: { context: string }[];
  message?: string;
}

const CONTEXT = 30;

// Block- and annotation-level wrappers the reader (transformer.ts) puts around a
// line: the alignment wrapper, and the suggestion markers. They carry no text of
// their own, and parseInline deliberately doesn't know them (it handles inline
// runs only), so they come off before the inline grammar runs.
const READER_WRAPPERS = /<\/?(?:p|ins|del)\b[^>]*>/gi;

// Strip markup so a needle copied from a rendered read still matches the doc's
// plain text. This MUST agree with the writer about what counts as markup, so it
// runs the writer's own parser (parseInline) rather than a second hand-rolled
// grammar — a private copy had already drifted on `__` (#27), breaking matches
// for signature lines (`____ ____`) and intraword underscores (`a__b__c`).
export function stripMarkdown(s: string): string {
  const unwrapped = s.replace(/^#{1,6}\s+/, '').replace(READER_WRAPPERS, '');
  return parseInline(unwrapped)
    .map((seg) => seg.text)
    .join('');
}

function findAll(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + needle.length;
  }
  return out;
}

// Resolve old_string to its match positions, trying exact then markup-tolerant.
export function locate(text: string, oldString: string): { needle: string; positions: number[] } {
  let positions = findAll(text, oldString);
  if (positions.length) return { needle: oldString, positions };
  const stripped = stripMarkdown(oldString);
  if (stripped !== oldString) {
    positions = findAll(text, stripped);
    if (positions.length) return { needle: stripped, positions };
  }
  return { needle: oldString, positions: [] };
}

export function contextAround(text: string, start: number, end: number): string {
  const pre = text.slice(Math.max(0, start - CONTEXT), start);
  const hit = text.slice(start, end);
  const post = text.slice(end, end + CONTEXT);
  return `…${pre}⟦${hit}⟧${post}…`.replace(/\n/g, '⏎');
}

// Docs range [startIndex, endIndex) for a plain-text [a, b) match.
export function rangeFor(proj: Projection, a: number, b: number): { startIndex: number; endIndex: number } {
  return { startIndex: proj.map[a], endIndex: proj.map[b - 1] + 1 };
}

const RESET_EMPHASIS_FIELDS = 'bold,italic,underline,strikethrough';

function insertedTextRequests(
  segments: Segment[],
  plain: string,
  startIndex: number,
  tabId?: string,
  segmentId?: string,
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [
    { insertText: { location: { index: startIndex, tabId, segmentId }, text: plain } },
    {
      updateTextStyle: {
        range: { startIndex, endIndex: startIndex + plain.length, tabId, segmentId },
        textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
        fields: RESET_EMPHASIS_FIELDS,
      },
    },
  ];
  let offset = 0;
  for (const seg of segments) {
    const segStart = startIndex + offset;
    offset += seg.text.length;
    const { textStyle, fields } = segmentTextStyle(seg);
    if (fields.length) {
      requests.push({
        updateTextStyle: { range: { startIndex: segStart, endIndex: segStart + seg.text.length, tabId, segmentId }, textStyle, fields: fields.join(',') },
      });
    }
  }
  return requests;
}

export async function editDoc(
  clients: GoogleClients,
  documentId: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean; tab?: string; segment?: SegmentKind; page?: SegmentPage } = {},
): Promise<EditResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const revisionId = res.data.revisionId ?? undefined;
  const tabId = resolveTabId(res.data, opts.tab);
  const target = await resolveSegmentTarget(clients, documentId, res.data, { segment: opts.segment, page: opts.page, tabId });
  if (target.error) return { status: 'no_segment', message: target.error };
  const segmentId = target.segmentId;
  const proj = project(res.data, tabId, segmentId);

  const { needle, positions } = locate(proj.text, oldString);
  if (positions.length === 0) {
    return { status: 'not_found', message: `"${oldString}" not found.` };
  }
  if (positions.length > 1 && !opts.replaceAll) {
    return {
      status: 'ambiguous',
      message: `${positions.length} matches — add surrounding context, or set replace_all.`,
      matches: positions.map((p) => ({ context: contextAround(proj.text, p, p + needle.length) })),
    };
  }

  const segments = parseInline(newString);
  const plain = segments.map((s) => s.text).join('');

  const highestIndexFirst = (opts.replaceAll ? positions : [positions[0]]).sort((x, y) => y - x);
  const requests: docs_v1.Schema$Request[] = [];
  for (const a of highestIndexFirst) {
    const { startIndex, endIndex } = rangeFor(proj, a, a + needle.length);
    requests.push({ deleteContentRange: { range: { startIndex, endIndex, tabId, segmentId } } });
    if (plain) requests.push(...insertedTextRequests(segments, plain, startIndex, tabId, segmentId));
  }

  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: { requests, writeControl: writeControlFor(revisionId) },
  });

  return { status: 'ok', replaced: highestIndexFirst.length };
}
