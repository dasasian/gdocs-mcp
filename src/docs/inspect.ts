import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { project } from './transformer.js';
import { contentOf, namedStylesOf, resolveTabId } from './structure.js';
import { locate, rangeFor, contextAround } from './edit.js';
import { rgbToHex } from './color.js';

// Read-only computed style at a text anchor (#5). read_doc -> markdown can only
// express content, not paragraph spacing / colors / fonts — so an agent asked to
// "remove the gap between these paragraphs" had no way to see that the gap is
// spacing, not a blank line. inspect_style resolves the *effective* style
// (direct paragraph/run style layered over the inherited named style) so the
// cause is diagnosable, and set_style's spaceBefore/spaceAfter can then fix it.

export interface ParagraphStyleInfo {
  namedStyleType?: string;
  alignment?: string;
  spaceBeforePt: number;
  spaceAfterPt: number;
  lineSpacingPct: number;
  /** true when the spacing comes from the named style, not set on the paragraph itself. */
  spacingInherited: boolean;
}

export interface TextStyleInfo {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontSizePt?: number;
  fontFamily?: string;
  color?: string; // hex
  link?: string;
}

export interface InspectResult {
  status: 'ok' | 'not_found' | 'ambiguous';
  message?: string;
  matches?: { context: string }[];
  matched?: { text: string; paragraph: string };
  paragraph?: ParagraphStyleInfo;
  text?: TextStyleInfo;
}

// Find the paragraph (and the run within it) whose range contains a Docs index,
// descending into table cells to match project()'s traversal.
function locateElements(
  content: docs_v1.Schema$StructuralElement[],
  docIndex: number,
): { paragraph?: docs_v1.Schema$Paragraph; run?: docs_v1.Schema$TextStyle } {
  for (const el of content) {
    if (el.paragraph) {
      const start = el.startIndex ?? 0;
      const end = el.endIndex ?? 0;
      if (docIndex >= start && docIndex < end) {
        let run: docs_v1.Schema$TextStyle | undefined;
        for (const pe of el.paragraph.elements ?? []) {
          if (docIndex >= (pe.startIndex ?? 0) && docIndex < (pe.endIndex ?? 0)) {
            run = pe.textRun?.textStyle ?? undefined;
            break;
          }
        }
        return { paragraph: el.paragraph, run };
      }
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          const hit = locateElements(cell.content ?? [], docIndex);
          if (hit.paragraph) return hit;
        }
      }
    }
  }
  return {};
}

const paragraphText = (p: docs_v1.Schema$Paragraph): string =>
  (p.elements ?? [])
    .map((e) => e.textRun?.content ?? '')
    .join('')
    .trim();

export async function inspectStyle(
  clients: GoogleClients,
  documentId: string,
  targetString: string,
  opts: { tab?: string } = {},
): Promise<InspectResult> {
  const res = await clients.docs.documents.get({ documentId, includeTabsContent: true });
  const tabId = resolveTabId(res.data, opts.tab);
  const proj = project(res.data, tabId);

  const { needle, positions } = locate(proj.text, targetString);
  if (positions.length === 0) return { status: 'not_found', message: `"${targetString}" not found.` };
  if (positions.length > 1) {
    return {
      status: 'ambiguous',
      message: `${positions.length} matches — add surrounding context.`,
      matches: positions.map((p) => ({ context: contextAround(proj.text, p, p + needle.length) })),
    };
  }

  const a = positions[0];
  const { startIndex } = rangeFor(proj, a, a + needle.length);
  const { paragraph, run } = locateElements(contentOf(res.data, tabId), startIndex);
  if (!paragraph) return { status: 'not_found', message: 'matched text but could not resolve its paragraph.' };

  const pStyle = paragraph.paragraphStyle ?? {};
  const namedStyleType = pStyle.namedStyleType ?? 'NORMAL_TEXT';
  const named = namedStylesOf(res.data, tabId).find((s) => s.namedStyleType === namedStyleType);
  const nPStyle = named?.paragraphStyle ?? {};
  const nTStyle = named?.textStyle ?? {};

  const mag = (d: docs_v1.Schema$Dimension | undefined): number | undefined => d?.magnitude ?? undefined;
  const spaceBeforePt = mag(pStyle.spaceAbove) ?? mag(nPStyle.spaceAbove) ?? 0;
  const spaceAfterPt = mag(pStyle.spaceBelow) ?? mag(nPStyle.spaceBelow) ?? 0;
  const spacingInherited = mag(pStyle.spaceAbove) === undefined && mag(pStyle.spaceBelow) === undefined;

  const ts = run ?? {};
  const rgb = ts.foregroundColor?.color?.rgbColor ?? nTStyle.foregroundColor?.color?.rgbColor ?? undefined;

  return {
    status: 'ok',
    matched: { text: needle, paragraph: paragraphText(paragraph) },
    paragraph: {
      namedStyleType,
      alignment: pStyle.alignment ?? nPStyle.alignment ?? undefined,
      spaceBeforePt,
      spaceAfterPt,
      lineSpacingPct: pStyle.lineSpacing ?? nPStyle.lineSpacing ?? 100,
      spacingInherited,
    },
    text: {
      bold: ts.bold ?? nTStyle.bold ?? false,
      italic: ts.italic ?? nTStyle.italic ?? false,
      underline: ts.underline ?? nTStyle.underline ?? false,
      strikethrough: ts.strikethrough ?? nTStyle.strikethrough ?? false,
      fontSizePt: mag(ts.fontSize) ?? mag(nTStyle.fontSize) ?? undefined,
      fontFamily: ts.weightedFontFamily?.fontFamily ?? nTStyle.weightedFontFamily?.fontFamily ?? undefined,
      color: rgbToHex(rgb ?? undefined),
      link: ts.link?.url ?? undefined,
    },
  };
}
