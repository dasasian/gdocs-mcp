import type { docs_v1 } from 'googleapis';
import { COLUMN_BREAK_SPAN, EQUATION_TITLE, PAGE_NUMBER_TITLE, RULE_LINE } from './markdown-spec.js';

// The elements a paragraph holds besides text (DESIGN.md §2f): how each reads,
// how a token is found in markup, and what a token means. The reader and the
// writer both work from here so the two directions cannot drift.

export interface DateElementProperties {
  timestamp?: string | null;
  timeZoneId?: string | null;
  locale?: string | null;
  dateFormat?: string | null;
  timeFormat?: string | null;
  displayText?: string | null;
}

export interface DropdownProperties {
  dropdownDefinitionId?: string | null;
  selectedOptionId?: string | null;
  displayValue?: string | null;
}

export interface DropdownOption {
  optionId?: string | null;
  displayValue?: string | null;
}

export interface DropdownDefinition {
  dropdownDefinitionId?: string | null;
  dropdownDefinitionProperties?: { title?: string | null; options?: DropdownOption[] | null } | null;
}

interface SuggestedElement {
  suggestedInsertionIds?: string[] | null;
  suggestedDeletionIds?: string[] | null;
}

/** The generated Docs types do not know dates and dropdowns yet. */
export type ParagraphElement = docs_v1.Schema$ParagraphElement & {
  dateElement?: SuggestedElement & { dateElementProperties?: DateElementProperties | null };
  dropdown?: SuggestedElement & { dropdownId?: string | null; dropdownProperties?: DropdownProperties | null };
};

export type DocumentTabWithElements = docs_v1.Schema$DocumentTab & { dropdownDefinitions?: Record<string, DropdownDefinition> | null };

export type Element =
  | { kind: 'footnote'; label: string }
  | { kind: 'date'; datetime: string; lang?: string; text: string }
  | { kind: 'person'; email: string; text: string }
  | { kind: 'richLink'; href: string; text: string }
  | { kind: 'dropdown'; listId: string; value: string }
  | { kind: 'columnBreak' }
  | { kind: 'equation' }
  | { kind: 'pageNumber' }
  | { kind: 'rule' };

export type ElementKind = Element['kind'];

export const escapeAttribute = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const unescapeAttribute = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const DATE_ONLY_TIME_FORMATS = new Set([undefined, null, '', 'TIME_FORMAT_DISABLED', 'TIME_FORMAT_UNSPECIFIED']);

function datetimeOf(properties: DateElementProperties): string {
  const iso = properties.timestamp ? new Date(properties.timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
  return DATE_ONLY_TIME_FORMATS.has(properties.timeFormat) ? iso.slice(0, 10) : iso;
}

function dateToken(properties: DateElementProperties): string {
  const lang = properties.locale && properties.locale !== 'en' ? ` lang="${escapeAttribute(properties.locale)}"` : '';
  return `<time datetime="${datetimeOf(properties)}"${lang}>${escapeAttribute(properties.displayText ?? '')}</time>`;
}

const chipToken = (href: string, text: string): string => `<a class="chip" href="${escapeAttribute(href)}">${escapeAttribute(text)}</a>`;

/** How a paragraph element reads, or undefined when it is not one of these elements (text, an image, a page break, a rule). */
export function elementTokenOf(element: ParagraphElement): string | undefined {
  if (element.footnoteReference) return `[^${element.footnoteReference.footnoteNumber ?? ''}]`;
  if (element.dateElement) return dateToken(element.dateElement.dateElementProperties ?? {});
  if (element.person) {
    const { email, name } = element.person.personProperties ?? {};
    return chipToken(`mailto:${email ?? ''}`, name ?? email ?? '');
  }
  if (element.richLink) {
    const { uri, title } = element.richLink.richLinkProperties ?? {};
    return chipToken(uri ?? '', title ?? uri ?? '');
  }
  if (element.dropdown) {
    const { dropdownDefinitionId, displayValue } = element.dropdown.dropdownProperties ?? {};
    return `<input class="chip" list="${escapeAttribute(dropdownDefinitionId ?? '')}" value="${escapeAttribute(displayValue ?? '')}">`;
  }
  if (element.columnBreak) return COLUMN_BREAK_SPAN;
  if (element.equation) return `<span class="equation" title="${EQUATION_TITLE}"></span>`;
  if (element.autoText) return `<span class="page-number" title="${PAGE_NUMBER_TITLE}"></span>`;
  return undefined;
}

export const isRuleElement = (element: ParagraphElement): boolean => Boolean(element.horizontalRule);

/** The ids of the suggestions that inserted or deleted this element, for a tracked read. */
export function suggestionIdsOf(element: ParagraphElement): { inserted?: string; deleted?: string } {
  const payload = (element.footnoteReference ?? element.dateElement ?? element.person ?? element.richLink ?? element.dropdown ?? element.columnBreak ?? element.equation ?? element.autoText ?? element.horizontalRule) as SuggestedElement | null | undefined;
  return { inserted: payload?.suggestedInsertionIds?.[0], deleted: payload?.suggestedDeletionIds?.[0] };
}

const INLINE_TOKEN_SOURCES = [
  String.raw`(?<!\\)\[\^[^\]\s]+\](?!:)`,
  String.raw`<time\b[^>]*>[^<]*<\/time>`,
  String.raw`<a\b[^>]*\bclass="chip"[^>]*>[^<]*<\/a>`,
  String.raw`<input\b[^>]*\bclass="chip"[^>]*>`,
  String.raw`<span\b[^>]*style="break-after:column"[^>]*><\/span>`,
  String.raw`<span\b[^>]*class="(?:equation|page-number)"[^>]*><\/span>`,
];

const RULE_SOURCE = `^${RULE_LINE}[ \\t]*$`;

/** `withRule`: a line of `---` is a token too, which it is only where lines are blocks, as in an edit's old_string and new_string. */
const tokenPattern = (withRule = false): RegExp => new RegExp([...INLINE_TOKEN_SOURCES, ...(withRule ? [RULE_SOURCE] : [])].join('|'), 'gm');

/** Text that would be read as an element if it were written as it is, backslash-escaped so it stays text. */
export function escapeElementLookalikes(text: string): string {
  return text.replace(/(?<!\\)(\[\^|<(?=time\b|input\b|(?:span|a)\b[^>]*(?:break-after:column|class="(?:chip|equation|page-number)")))/g, '\\$1');
}

/** The text with its element tokens taken out, for a check that is about the text around them. */
export const withoutElementTokens = (markup: string): string => markup.replace(tokenPattern(), '');

export const tokensIn = (markup: string): string[] => markup.match(tokenPattern()) ?? [];

const FIRST_PLACEHOLDER = 0xe100;
const LAST_PLACEHOLDER = 0xf8ff;

/**
 * Each distinct token string stands for one private-use character, so a token is
 * one character in the text an edit matches (the width of the one index it takes
 * in the doc) and identical tokens are the same character.
 */
export class TokenTable {
  private readonly charByToken = new Map<string, string>();
  private readonly tokenByChar = new Map<string, string>();

  charFor(token: string): string {
    const known = this.charByToken.get(token);
    if (known) return known;
    const code = FIRST_PLACEHOLDER + this.charByToken.size;
    if (code > LAST_PLACEHOLDER) throw new Error('Too many different elements in one edit.');
    const char = String.fromCharCode(code);
    this.charByToken.set(token, char);
    this.tokenByChar.set(char, token);
    return char;
  }

  tokenOf(char: string): string | undefined {
    return this.tokenByChar.get(char);
  }

  isPlaceholder(char: string): boolean {
    return this.tokenByChar.has(char);
  }

  encode(markup: string, withRule = false): string {
    return markup.replace(tokenPattern(withRule), (token) => this.charFor(token));
  }

  decode(text: string): string {
    return [...text].map((char) => this.tokenByChar.get(char) ?? char).join('');
  }
}

function attribute(token: string, name: string): string {
  return unescapeAttribute(new RegExp(`\\b${name}="([^"]*)"`).exec(token)?.[1] ?? '');
}

const innerText = (token: string): string => unescapeAttribute(/>([^<]*)</.exec(token)?.[1] ?? '');

/** What a token means. The token must be one `elementTokenOf` or the writer's patterns found. */
export function parseElement(token: string): Element {
  if (token === RULE_LINE || token.startsWith(RULE_LINE)) return { kind: 'rule' };
  if (token.startsWith('[^')) return { kind: 'footnote', label: token.slice(2, -1) };
  if (token.startsWith('<time')) {
    const lang = attribute(token, 'lang');
    return { kind: 'date', datetime: attribute(token, 'datetime'), ...(lang ? { lang } : {}), text: innerText(token) };
  }
  if (token.startsWith('<a')) {
    const href = attribute(token, 'href');
    return href.startsWith('mailto:') ? { kind: 'person', email: href.slice('mailto:'.length), text: innerText(token) } : { kind: 'richLink', href, text: innerText(token) };
  }
  if (token.startsWith('<input')) return { kind: 'dropdown', listId: attribute(token, 'list'), value: attribute(token, 'value') };
  if (token.includes('break-after:column')) return { kind: 'columnBreak' };
  return token.includes('class="equation"') ? { kind: 'equation' } : { kind: 'pageNumber' };
}

const DRIVE_FILE_URL = /^https:\/\/(?:docs|drive)\.google\.com\/(?:[a-z]+\/)*(?:d\/[\w-]+|open\?id=[\w-]+)/;

export const isDriveFileUrl = (url: string): boolean => DRIVE_FILE_URL.test(url);

const ASK_THE_USER = 'ask the user to insert it in Google Docs';

/** Why an element cannot be created, or undefined when it can. `segmentId` is set for a header, footer or note. */
export function creationIssue(element: Element, segmentId: string | undefined): string | undefined {
  switch (element.kind) {
    case 'columnBreak':
      return `a column break cannot be made: the Docs API has no request for it. Leave it out, or ${ASK_THE_USER}.`;
    case 'equation':
      return `an equation cannot be made: the Docs API has no request for it. Leave it out, or ${ASK_THE_USER}.`;
    case 'pageNumber':
      return `a page-number field cannot be made: the Docs API has no request for it. Leave it out, or ${ASK_THE_USER}.`;
    case 'richLink':
      return isDriveFileUrl(element.href)
        ? undefined
        : `a link chip can be made only for a Google Drive file, and Google refuses ${element.href}. Write the plain link instead: [${element.text || 'text'}](${element.href})`;
    case 'person':
      return element.email ? undefined : 'a person chip needs an email in its href: <a class="chip" href="mailto:jane@example.com">';
    case 'footnote':
      return segmentId ? 'a footnote cannot go in a header, a footer or another footnote: the Docs API refuses it.' : undefined;
    case 'date':
      return Number.isNaN(Date.parse(element.datetime)) ? `a date needs a datetime like 2026-11-15, not "${element.datetime}"` : undefined;
    case 'dropdown':
      return element.listId ? undefined : 'a dropdown needs list="…" naming its <datalist>';
    case 'rule':
      return undefined;
  }
}

/** The text of a chip that is the same chip (same href) with other words, which Docs does not allow: a chip's text is Google's. */
export function chipTextChange(before: Element, after: Element): string | undefined {
  if (before.kind === 'person' && after.kind === 'person' && before.email === after.email && before.text !== after.text) {
    return `a person chip's text is the person's name in their Google account, so "${before.text}" cannot be changed to "${after.text}". To point at another person, change the email in href.`;
  }
  if (before.kind === 'richLink' && after.kind === 'richLink' && before.href === after.href && before.text !== after.text) {
    return `a link chip's text is the file's title, so "${before.text}" cannot be changed to "${after.text}". To rename the file, use drive mv.`;
  }
  return undefined;
}
