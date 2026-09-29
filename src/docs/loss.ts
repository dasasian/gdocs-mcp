import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { contentOf } from './structure.js';
import { parseSuggestions } from './suggestions.js';

export interface Loss {
  paragraphs: number;
  comments: number;
  suggestions: number;
  tabStops: number;
  tabStopLines: string[];
  people: number;
  dates: number;
  richLinks: number;
  bookmarkLinks: number;
}

type ParagraphElementWithDate = docs_v1.Schema$ParagraphElement & { dateElement?: object };

type Counted = Exclude<keyof Loss, 'tabStopLines'>;

const LABELS: { key: Counted; one: string; many: string }[] = [
  { key: 'paragraphs', one: 'paragraph', many: 'paragraphs' },
  { key: 'comments', one: 'comment', many: 'comments' },
  { key: 'suggestions', one: 'suggestion', many: 'suggestions' },
  { key: 'tabStops', one: 'tab stop', many: 'tab stops' },
  { key: 'people', one: 'person chip', many: 'person chips' },
  { key: 'dates', one: 'date chip', many: 'date chips' },
  { key: 'richLinks', one: 'link chip', many: 'link chips' },
  { key: 'bookmarkLinks', one: 'link to a bookmark or heading', many: 'links to a bookmark or heading' },
];

const TAB_STOP_LINES_SHOWN = 3;

function paragraphsIn(content: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$Paragraph[] {
  return content.flatMap((el) => {
    if (el.paragraph) return [el.paragraph];
    const cells = (el.table?.tableRows ?? []).flatMap((row) => row.tableCells ?? []);
    return cells.flatMap((cell) => paragraphsIn(cell.content ?? []));
  });
}

function textOf(paragraph: docs_v1.Schema$Paragraph): string {
  return (paragraph.elements ?? []).map((e) => e.textRun?.content ?? '').join('').trim();
}

function pointsAtBookmarkOrHeading(link: docs_v1.Schema$Link | null | undefined): boolean {
  return Boolean(link?.bookmarkId || link?.bookmark || link?.headingId || link?.heading);
}

/**
 * What replacing this tab's body would take with it that a markdown read cannot
 * carry. `doc` must come from a SUGGESTIONS_INLINE read, or suggestions are
 * invisible. `comments` is passed in because Drive holds them, not the doc.
 * A bookmark is not in the Docs API at all — only links that point at one are,
 * so a bookmark nothing links to is not counted.
 */
export function measureLoss(doc: docs_v1.Schema$Document, tabId: string | undefined, comments: number): Loss {
  const loss: Loss = { paragraphs: 0, comments, suggestions: parseSuggestions(doc, tabId).length, tabStops: 0, tabStopLines: [], people: 0, dates: 0, richLinks: 0, bookmarkLinks: 0 };
  for (const paragraph of paragraphsIn(contentOf(doc, tabId))) {
    const text = textOf(paragraph);
    if (text) loss.paragraphs += 1;
    const stops = paragraph.paragraphStyle?.tabStops?.length ?? 0;
    if (stops) {
      loss.tabStops += stops;
      loss.tabStopLines.push(text || '(empty line)');
    }
    for (const element of (paragraph.elements ?? []) as ParagraphElementWithDate[]) {
      if (element.person) loss.people += 1;
      if (element.dateElement) loss.dates += 1;
      if (element.richLink) loss.richLinks += 1;
      if (pointsAtBookmarkOrHeading(element.textRun?.textStyle?.link)) loss.bookmarkLinks += 1;
    }
  }
  return loss;
}

/** "42 paragraphs, 2 comments, 1 tab stop". Paragraphs are always listed; other items only when present. */
export function lossSummary(loss: Loss): string {
  return LABELS.filter(({ key }) => key === 'paragraphs' || loss[key] > 0)
    .map(({ key, one, many }) => `${loss[key]} ${loss[key] === 1 ? one : many}`)
    .join(', ');
}

/**
 * The string a caller must echo back as `confirmLoss`. It carries the doc's
 * revision as well as the counts, so any edit between the two calls — one that
 * changes no count included — makes it stop matching.
 */
export function confirmLossToken(loss: Loss, revisionId: string | null | undefined): string {
  return `${lossSummary(loss)} [revision ${revisionId ?? 'unknown'}]`;
}

export function lossDetails(loss: Loss, docHasSeveralTabs: boolean): string[] {
  const shown = loss.tabStopLines.slice(0, TAB_STOP_LINES_SHOWN).map((line) => `"${line.slice(0, 30)}"`);
  const more = loss.tabStopLines.length - shown.length;
  return [
    ...(loss.tabStops ? [`tab stops on ${loss.tabStopLines.length} line(s): ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}. The Docs API cannot write tab stops, so they cannot be put back.`] : []),
    ...(loss.comments && docHasSeveralTabs ? ['The comment count is for the whole doc: the Drive API does not say which tab a comment is anchored to.'] : []),
    ...(loss.bookmarkLinks ? ['A bookmark itself is invisible to the API; only links that point at one are counted, so a bookmark nothing links to is not in this list.'] : []),
  ];
}

export async function countComments(clients: GoogleClients, documentId: string): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const res = await clients.drive.comments.list({ fileId: documentId, fields: 'nextPageToken,comments(id,deleted)', pageSize: 100, pageToken });
    count += (res.data.comments ?? []).filter((c) => !c.deleted).length;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return count;
}
