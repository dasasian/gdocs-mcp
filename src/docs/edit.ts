import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project, type Projection } from './transformer.js';
import { resolveTabId } from './structure.js';
import { parseInline, segmentTextStyle } from './inline.js';

// String-anchored editing (bet #3). The agent quotes a unique slice of text;
// we locate it in the plain-text projection, map to Docs indices, and emit a
// delete+insert batchUpdate. Indices are never exposed.
//
// v1 scope: new_string is inserted as PLAIN text (markdown/HTML interpretation of
// new_string is the next increment). Matching is exact, with a markup-tolerant
// fallback (so "# Title" or "**x**" copied from a read still resolves).

export interface EditResult {
  status: 'ok' | 'not_found' | 'ambiguous';
  replaced?: number;
  matches?: { context: string }[];
  message?: string;
}

const CONTEXT = 30;

// Conservatively strip markdown so a needle copied from a rendered read still
// matches the doc's plain text.
export function stripMarkdown(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '');
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

export async function editDoc(
  clients: GoogleClients,
  documentId: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean; tab?: string } = {},
): Promise<EditResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const revisionId = res.data.revisionId ?? undefined;
  const tabId = resolveTabId(res.data, opts.tab);
  const proj = project(res.data, tabId);

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

  // new_string is interpreted as inline markdown (bold/italic/code/link). Insert
  // the plain text, then style each parsed segment over its inserted range.
  const segments = parseInline(newString);
  const plain = segments.map((s) => s.text).join('');

  // Apply highest-index first so earlier ranges stay valid (see suggestion spike).
  const targets = (opts.replaceAll ? positions : [positions[0]]).sort((x, y) => y - x);
  const requests: docs_v1.Schema$Request[] = [];
  for (const a of targets) {
    const { startIndex, endIndex } = rangeFor(proj, a, a + needle.length);
    requests.push({ deleteContentRange: { range: { startIndex, endIndex, tabId } } });
    if (!plain) continue;
    requests.push({ insertText: { location: { index: startIndex, tabId }, text: plain } });
    // insertText inherits the style at the insertion point, so reset the whole
    // inserted range to plain first; segment styles below then re-apply intent.
    requests.push({
      updateTextStyle: {
        range: { startIndex, endIndex: startIndex + plain.length, tabId },
        textStyle: { bold: false, italic: false, underline: false, strikethrough: false },
        fields: 'bold,italic,underline,strikethrough',
      },
    });
    // Style segments. Indices are absolute and valid right after this insert
    // (descending target order means lower-index targets aren't shifted yet).
    let offset = 0;
    for (const seg of segments) {
      const segStart = startIndex + offset;
      offset += seg.text.length;
      const { textStyle, fields } = segmentTextStyle(seg);
      if (fields.length) {
        requests.push({
          updateTextStyle: { range: { startIndex: segStart, endIndex: segStart + seg.text.length, tabId }, textStyle, fields: fields.join(',') },
        });
      }
    }
  }

  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: { requests, writeControl: revisionId ? { requiredRevisionId: revisionId } : undefined },
  });

  return { status: 'ok', replaced: targets.length };
}
