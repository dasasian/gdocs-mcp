import type { docs_v1 } from 'googleapis';
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
  pageNumberFields: number;
  sectionBreaks: number;
  columnBreaks: number;
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
  { key: 'pageNumberFields', one: 'page-number field', many: 'page-number fields' },
  { key: 'sectionBreaks', one: 'section break', many: 'section breaks' },
  { key: 'columnBreaks', one: 'column break', many: 'column breaks' },
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

const PAGE_NUMBER_FIELD_TYPES = ['PAGE_NUMBER', 'PAGE_COUNT'];

function isPageNumberField(element: docs_v1.Schema$ParagraphElement): boolean {
  return PAGE_NUMBER_FIELD_TYPES.includes(element.autoText?.type ?? '');
}

function pointsAtBookmarkOrHeading(link: docs_v1.Schema$Link | null | undefined): boolean {
  return Boolean(link?.bookmarkId || link?.bookmark || link?.headingId || link?.heading);
}

/**
 * What replacing this tab's body would take with it that a markdown read cannot
 * carry. `doc` must come from a SUGGESTIONS_INLINE read, or suggestions are
 * invisible. `comments` is passed in because Drive holds them, not the doc.
 * A body or tab replace counts only that body: it deletes the body's range and leaves the
 * headers and footers alone, so their page-number fields are counted only for a header or
 * footer write. For a header or footer (`segmentId`), comments and suggestions are not counted:
 * they cannot be anchored there. A bookmark is not in the Docs API at all — only links that point at one are,
 * so a bookmark nothing links to is not counted.
 */
export function measureLoss(doc: docs_v1.Schema$Document, tabId: string | undefined, comments: number, segmentId?: string): Loss {
  const loss: Loss = { paragraphs: 0, comments: segmentId ? 0 : comments, suggestions: segmentId ? 0 : parseSuggestions(doc, tabId).length, tabStops: 0, tabStopLines: [], people: 0, dates: 0, richLinks: 0, bookmarkLinks: 0, pageNumberFields: 0, sectionBreaks: 0, columnBreaks: 0 };
  const content = contentOf(doc, tabId, segmentId);
  loss.sectionBreaks = content.slice(1).filter((el) => el.sectionBreak).length;
  for (const paragraph of paragraphsIn(content)) {
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
      if (element.columnBreak) loss.columnBreaks += 1;
      if (isPageNumberField(element)) loss.pageNumberFields += 1;
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

/**
 * The string a caller must echo back as `confirmLoss` to move a row or column
 * whose text comments quote. Like `confirmLossToken` it carries the revision, so
 * any edit between the two calls makes it stop matching.
 */
export function movedCommentsToken(comments: number, revisionId: string | null | undefined): string {
  return `${comments} ${comments === 1 ? 'comment' : 'comments'} on text in a moved row or column [revision ${revisionId ?? 'unknown'}]`;
}

export function lossDetails(loss: Loss, docHasSeveralTabs: boolean): string[] {
  const shown = loss.tabStopLines.slice(0, TAB_STOP_LINES_SHOWN).map((line) => `"${line.slice(0, 30)}"`);
  const more = loss.tabStopLines.length - shown.length;
  return [
    ...(loss.tabStops ? [`tab stops on ${loss.tabStopLines.length} line(s): ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}. The Docs API cannot write tab stops, so they cannot be put back.`] : []),
    ...(loss.comments && docHasSeveralTabs ? ['The comment count is for the whole doc: the Drive API does not say which tab a comment is anchored to.'] : []),
    ...(loss.pageNumberFields ? ['The Docs API can read a page-number field but cannot create one, so it cannot be put back. To keep it, add it by hand in Docs after the write.'] : []),
    ...(loss.sectionBreaks ||loss.columnBreaks ? ['Section breaks and column breaks are not carried: a read does not show them, so a replace drops them, and the page setup and headers a section break holds go with it.'] : []),
    ...(loss.bookmarkLinks ? ['A bookmark itself is invisible to the API; only links that point at one are counted, so a bookmark nothing links to is not in this list.'] : []),
  ];
}
