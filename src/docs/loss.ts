import type { docs_v1 } from 'googleapis';
import { contentOf } from './structure.js';
import { countSuggestions } from './suggestions.js';
import { commentCounts, type ReviewedDocument } from './comments.js';
import { isDriveFileUrl, type ParagraphElement } from './elements.js';

export interface Loss {
  paragraphs: number;
  comments: number;
  commentsWithoutRange: number;
  suggestions: number;
  tabStops: number;
  tabStopLines: string[];
  customFormatDates: number;
  otherLinkChips: number;
  equations: number;
  tablesOfContents: number;
  bookmarkLinks: number;
  pageNumberFields: number;
  sectionBreaks: number;
  columnBreaks: number;
}

type Counted = Exclude<keyof Loss, 'tabStopLines' | 'commentsWithoutRange'>;

const LABELS: { key: Counted; one: string; many: string }[] = [
  { key: 'paragraphs', one: 'paragraph', many: 'paragraphs' },
  { key: 'comments', one: 'comment', many: 'comments' },
  { key: 'suggestions', one: 'suggestion', many: 'suggestions' },
  { key: 'tabStops', one: 'tab stop', many: 'tab stops' },
  { key: 'customFormatDates', one: 'date in a format the API can only read', many: 'dates in a format the API can only read' },
  { key: 'otherLinkChips', one: 'link chip to something that is not a Drive file', many: 'link chips to something that is not a Drive file' },
  { key: 'equations', one: 'equation', many: 'equations' },
  { key: 'tablesOfContents', one: 'table of contents', many: 'tables of contents' },
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

const CUSTOM_DATE_FORMATS = new Set(['DATE_FORMAT_CUSTOM', 'DATE_FORMAT_UNSPECIFIED']);

const PAGE_NUMBER_FIELD_TYPES = ['PAGE_NUMBER', 'PAGE_COUNT'];

function isPageNumberField(element: docs_v1.Schema$ParagraphElement): boolean {
  return PAGE_NUMBER_FIELD_TYPES.includes(element.autoText?.type ?? '');
}

function pointsAtBookmarkOrHeading(link: docs_v1.Schema$Link | null | undefined): boolean {
  return Boolean(link?.bookmarkId || link?.bookmark || link?.headingId || link?.heading);
}

/**
 * What replacing this tab's body would take with it that a markdown read cannot
 * carry. `doc` must come from a read with suggestions inline and comments
 * included (`getDocForReview`), or they are invisible. A body or tab replace
 * counts only that body: it deletes the body's range and leaves the headers and
 * footers alone, so their page-number fields are counted only for a header or
 * footer write. Comments are counted by the range they sit on, in the body or
 * in the header or footer (`segmentId`) being written; a comment with no range
 * (made in Drive) is counted for a body write, for the whole doc. Suggestions
 * are not counted for a header or footer. A bookmark is not in the Docs API at
 * all, only links that point at one are, so a bookmark nothing links to is not
 * counted.
 */
export function measureLoss(doc: ReviewedDocument, tabId: string | undefined, segmentId?: string): Loss {
  const comments = commentCounts(doc, tabId, segmentId);
  const loss: Loss = { paragraphs: 0, comments: comments.withRange + (segmentId ? 0 : comments.withoutRange), commentsWithoutRange: segmentId ? 0 : comments.withoutRange, suggestions: segmentId ? 0 : countSuggestions(doc, tabId), tabStops: 0, tabStopLines: [], customFormatDates: 0, otherLinkChips: 0, equations: 0, tablesOfContents: 0, bookmarkLinks: 0, pageNumberFields: 0, sectionBreaks: 0, columnBreaks: 0 };
  const content = contentOf(doc, tabId, segmentId);
  loss.sectionBreaks = content.slice(1).filter((el) => el.sectionBreak).length;
  loss.tablesOfContents = content.filter((el) => el.tableOfContents).length;
  for (const paragraph of paragraphsIn(content)) {
    const text = textOf(paragraph);
    if (text) loss.paragraphs += 1;
    const stops = paragraph.paragraphStyle?.tabStops?.length ?? 0;
    if (stops) {
      loss.tabStops += stops;
      loss.tabStopLines.push(text || '(empty line)');
    }
    for (const element of (paragraph.elements ?? []) as ParagraphElement[]) {
      if (element.dateElement && CUSTOM_DATE_FORMATS.has(element.dateElement.dateElementProperties?.dateFormat ?? '')) loss.customFormatDates += 1;
      if (element.richLink && !isDriveFileUrl(element.richLink.richLinkProperties?.uri ?? '')) loss.otherLinkChips += 1;
      if (element.equation) loss.equations += 1;
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
    ...(loss.commentsWithoutRange && docHasSeveralTabs ? [`${loss.commentsWithoutRange} of the comments have no range (they were made in Drive), so they are counted for the whole doc, not for this tab.`] : []),
    ...(loss.pageNumberFields ? ['The Docs API can read a page-number field but cannot create one, so it cannot be put back. To keep it, add it by hand in Docs after the write.'] : []),
    ...(loss.sectionBreaks || loss.columnBreaks ? ['Section breaks and column breaks are not carried: a replace drops them, and the page setup and headers a section break holds go with it.'] : []),
    ...(loss.equations ? ['The Docs API does not expose an equation and cannot create one, so it cannot be put back. To keep it, edit around it with edit_doc instead.'] : []),
    ...(loss.tablesOfContents ? ['A table of contents is not read and cannot be created, so a replace drops it. Insert one again in Docs (Insert → Table of contents) after the write.'] : []),
    ...(loss.otherLinkChips || loss.customFormatDates ? ['A link chip to something that is not a Drive file, and a date in a format the API can only read, cannot be made again; they come back as plain text or as a date in the default format.'] : []),
    ...(loss.bookmarkLinks ? ['A bookmark itself is invisible to the API; only links that point at one are counted, so a bookmark nothing links to is not in this list.'] : []),
  ];
}
