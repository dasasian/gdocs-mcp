import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../google/clients.js';
import { tabContainer } from './structure.js';
import { creationIssue, parseElement, tokensIn, type DocumentTabWithElements, type Element, type DropdownDefinition } from './elements.js';

/** Thrown before any request is sent, when an element in the markdown cannot be made. */
export class ElementRefusal extends Error {
  constructor(readonly issues: string[]) {
    super(`Nothing was written: ${issues.length === 1 ? issues[0] : `${issues.length} elements cannot be made.\n${issues.map((issue) => `  ${issue}`).join('\n')}`}`);
    this.name = 'ElementRefusal';
  }
}

/** A `<datalist>` line: the list a dropdown picks from. */
export interface ListSpec {
  id: string;
  title: string;
  options: string[];
}

export interface ElementSite {
  tabId?: string;
  segmentId?: string;
}

export interface PlacedElement {
  /** where the element goes in the doc, once the text before it is in. */
  index: number;
  token: string;
}

const LIST_PREFIX = 'list:';

interface ResolvedList {
  id: string;
  options: { optionId: string; displayValue: string }[];
}

type FollowUp = (reply: docs_v1.Schema$Response | undefined, lists: Map<string, ResolvedList>) => docs_v1.Schema$Request[];

const followUpsOf = new WeakMap<docs_v1.Schema$Request, FollowUp>();
const listSpecOf = new WeakMap<docs_v1.Schema$Request, ListSpec>();

const NOTE_START = 1;

const DATE_FORMATS: { shape: RegExp; format: string }[] = [
  { shape: /^\d{4}-\d{2}-\d{2}$/, format: 'DATE_FORMAT_ISO8601' },
  { shape: /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/, format: 'DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED' },
  { shape: /^[A-Z][a-z]{2} \d{1,2}$/, format: 'DATE_FORMAT_MONTH_DAY_ABBREVIATED' },
  { shape: /^[A-Z][a-z]{3,8} \d{1,2}$/, format: 'DATE_FORMAT_MONTH_DAY_FULL' },
];

const DEFAULT_DATE_FORMAT = 'DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED';
const TIME_AT_END = /\s*(\d{1,2}):(\d{2})\s?([AP]M)(?:\s+(UTC))?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NOON = 12;

function timestampOf(datetime: string, time: { hour: number; minute: number } | undefined): string {
  if (!DATE_ONLY.test(datetime)) return new Date(datetime).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hour = time?.hour ?? NOON;
  return `${datetime}T${String(hour).padStart(2, '0')}:${String(time?.minute ?? 0).padStart(2, '0')}:00Z`;
}

/** The properties `insertDate` takes: the moment from `datetime`, the formats from the shape of the text. */
export function dateProperties(element: Extract<Element, { kind: 'date' }>): Record<string, unknown> {
  const time = TIME_AT_END.exec(element.text);
  const datePart = time ? element.text.slice(0, time.index) : element.text;
  const dateFormat = DATE_FORMATS.find(({ shape }) => shape.test(datePart))?.format ?? DEFAULT_DATE_FORMAT;
  const hour12 = time ? Number(time[1]) % 12 : 0;
  const clock = time ? { hour: hour12 + (time[3] === 'PM' ? 12 : 0), minute: Number(time[2]) } : undefined;
  const timeFormat = !time ? 'TIME_FORMAT_DISABLED' : time[4] ? 'TIME_FORMAT_HOUR_MINUTE_TIMEZONE' : 'TIME_FORMAT_HOUR_MINUTE';
  return {
    timestamp: timestampOf(element.datetime, clock),
    dateFormat,
    timeFormat,
    locale: element.lang ?? 'en',
    ...(time?.[4] ? { timeZoneId: time[4] } : {}),
  };
}

function footnoteRequests(label: string, notes: Map<string, string>, site: ElementSite): FollowUp {
  const note = notes.get(label) ?? '';
  return (reply) => {
    const footnoteId = reply?.createFootnote?.footnoteId;
    if (!footnoteId || !note) return [];
    return [{ insertText: { location: { index: NOTE_START, tabId: site.tabId, segmentId: footnoteId }, text: note } }];
  };
}

function dropdownFollowUp(element: Extract<Element, { kind: 'dropdown' }>, site: ElementSite): FollowUp {
  return (reply, lists) => {
    const dropdownId = (reply as { insertDropdown?: { dropdown?: { dropdownId?: string } } } | undefined)?.insertDropdown?.dropdown?.dropdownId;
    const options = lists.get(element.listId)?.options ?? [];
    const chosen = options.find((option) => option.displayValue === element.value);
    if (!dropdownId || !chosen || options[0]?.optionId === chosen.optionId) return [];
    return [{ updateDropdownProperties: { dropdownId, dropdownProperties: { selectedOptionId: chosen.optionId }, fields: 'selectedOptionId', tabId: site.tabId } } as docs_v1.Schema$Request];
  };
}

function creationOf(element: Element, index: number, site: ElementSite, context: { notes: Map<string, string>; lists: Map<string, ListSpec> }): docs_v1.Schema$Request {
  const location = { index, tabId: site.tabId, segmentId: site.segmentId };
  switch (element.kind) {
    case 'footnote': {
      const request: docs_v1.Schema$Request = { createFootnote: { location } };
      followUpsOf.set(request, footnoteRequests(element.label, context.notes, site));
      return request;
    }
    case 'date':
      return { insertDate: { location, dateElementProperties: dateProperties(element) } } as docs_v1.Schema$Request;
    case 'person':
      return { insertPerson: { location, personProperties: { email: element.email } } } as docs_v1.Schema$Request;
    case 'richLink':
      return { insertRichLink: { location, richLinkProperties: { uri: element.href } } } as docs_v1.Schema$Request;
    case 'dropdown': {
      const request = { insertDropdown: { location, dropdownDefinitionId: `${LIST_PREFIX}${element.listId}` } } as docs_v1.Schema$Request;
      followUpsOf.set(request, dropdownFollowUp(element, site));
      const spec = context.lists.get(element.listId);
      if (spec) listSpecOf.set(request, spec);
      return request;
    }
    default:
      throw new ElementRefusal([creationIssue(element, site.segmentId) ?? `${element.kind} cannot be made`]);
  }
}

/**
 * The requests that make these elements, in the order given (lowest index first, since each is one index wide and the
 * ones before it have moved it by then). Throws `ElementRefusal` for one the API cannot make.
 */
export function elementRequests(placed: PlacedElement[], site: ElementSite, context: { notes: Map<string, string>; lists: Map<string, ListSpec> }): docs_v1.Schema$Request[] {
  const issues = placed.flatMap(({ token }) => creationIssue(parseElement(token), site.segmentId) ?? []);
  if (issues.length) throw new ElementRefusal(issues);
  return placed.map(({ index, token }, k) => creationOf(parseElement(token), index + k, site, context));
}

/** The reasons any element in this markdown cannot be made, one per element, for a refusal before anything is sent. */
export function creationIssuesIn(markdown: string, segmentId?: string): string[] {
  return markdown.split('\n').flatMap((line, k) =>
    tokensIn(line).flatMap((token) => {
      const issue = creationIssue(parseElement(token), segmentId);
      return issue ? [`line ${k + 1}: ${issue}`] : [];
    }),
  );
}

interface DefinitionSite {
  documentId: string;
  tabId?: string;
}

const optionsOf = (definition: DropdownDefinition | undefined): { optionId: string; displayValue: string }[] =>
  (definition?.dropdownDefinitionProperties?.options ?? []).map((option) => ({ optionId: option.optionId ?? '', displayValue: option.displayValue ?? '' }));

type Documents = GoogleClients['docs']['documents'];

async function definitionsOf(documents: Documents, site: DefinitionSite): Promise<{ definitions: Record<string, DropdownDefinition>; revisionId?: string }> {
  const doc = (await documents.get({ documentId: site.documentId, includeTabsContent: true })).data;
  const container = tabContainer(doc, site.tabId) as DocumentTabWithElements | undefined;
  return { definitions: container?.dropdownDefinitions ?? {}, revisionId: doc.revisionId ?? undefined };
}

export function listRequest(spec: ListSpec, existing: DropdownDefinition | undefined): docs_v1.Schema$Request | undefined {
  const properties = existing?.dropdownDefinitionProperties;
  const oldOptions = properties?.options ?? [];
  const same = properties?.title === spec.title && oldOptions.length === spec.options.length && oldOptions.every((option, k) => option.displayValue === spec.options[k]);
  if (existing && same) return undefined;
  const options = spec.options.map((displayValue) => ({ displayValue, optionId: oldOptions.find((option) => option.displayValue === displayValue)?.optionId ?? undefined }));
  if (!existing) return { createDropdownDefinition: { dropdownDefinition: { dropdownDefinitionProperties: { title: spec.title, options: spec.options.map((displayValue) => ({ displayValue })) } } } } as docs_v1.Schema$Request;
  return { updateDropdownDefinitionProperties: { dropdownDefinitionId: existing.dropdownDefinitionId, dropdownDefinitionProperties: { title: spec.title, options }, fields: 'title,options' } } as docs_v1.Schema$Request;
}

/** Makes the lists the dropdowns in `requests` point at, and puts their real ids in the requests. Returns the lists as the doc now holds them. */
async function settleLists(
  clients: GoogleClients,
  site: DefinitionSite,
  requests: docs_v1.Schema$Request[],
  revisionId: string | undefined,
): Promise<{ lists: Map<string, ResolvedList>; revisionId: string | undefined }> {
  const dropdowns = requests.filter((request) => (request as { insertDropdown?: unknown }).insertDropdown);
  const lists = new Map<string, ResolvedList>();
  if (!dropdowns.length) return { lists, revisionId };
  const documents = clients.docs.documents;
  const { definitions, revisionId: current } = await definitionsOf(documents, site);
  if (revisionId && current !== revisionId) throw new Error('The doc changed since it was read, so nothing was written. Read it again and retry.');
  let wrote = false;
  const listIds = [...new Set(dropdowns.map((request) => (request as { insertDropdown: { dropdownDefinitionId: string } }).insertDropdown.dropdownDefinitionId.slice(LIST_PREFIX.length)))];
  const specFor = (id: string): ListSpec | undefined => dropdowns.map((request) => listSpecOf.get(request)).find((spec) => spec?.id === id);
  for (const id of listIds) {
    const existing = definitions[id];
    const spec = specFor(id);
    if (!existing && !spec) throw new ElementRefusal([`this doc has no dropdown list "${id}", and no <datalist id="${id}" title="…"><option>…</option></datalist> line gives one. Add that line to the markdown.`]);
    const request = spec ? listRequest(spec, existing) : undefined;
    if (request) {
      const reply = (await documents.batchUpdate({ documentId: site.documentId, requestBody: { requests: [request] } })).data.replies?.[0] as { createDropdownDefinition?: { dropdownDefinition?: DropdownDefinition } } | undefined;
      wrote = true;
      const made = reply?.createDropdownDefinition?.dropdownDefinition;
      const definition = made ?? (await definitionsOf(documents, site)).definitions[id];
      lists.set(id, { id: definition?.dropdownDefinitionId ?? id, options: optionsOf(definition) });
    } else {
      lists.set(id, { id: existing?.dropdownDefinitionId ?? id, options: optionsOf(existing) });
    }
  }
  for (const request of dropdowns) {
    const dropdown = (request as { insertDropdown: { dropdownDefinitionId: string } }).insertDropdown;
    dropdown.dropdownDefinitionId = lists.get(dropdown.dropdownDefinitionId.slice(LIST_PREFIX.length))!.id;
  }
  return { lists, revisionId: wrote ? (await definitionsOf(documents, site)).revisionId : revisionId };
}

/**
 * `documents.batchUpdate` for requests that may make elements. A new dropdown list is made first (its id comes back
 * in a reply the dropdown needs), and what an element needs once it exists (a footnote's note, a dropdown's choice)
 * is sent in a second batch, from the replies of the first.
 */
export async function batchUpdateWithElements(
  clients: GoogleClients,
  documentId: string,
  requests: docs_v1.Schema$Request[],
  writeControl: docs_v1.Schema$WriteControl | undefined,
  tabId?: string,
): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
  const settled = await settleLists(clients, { documentId, tabId }, requests, writeControl?.requiredRevisionId ?? undefined);
  const control = writeControl?.requiredRevisionId && settled.revisionId ? { ...writeControl, requiredRevisionId: settled.revisionId } : writeControl;
  const res = await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests, writeControl: control } });
  const afterwards = requests.flatMap((request, k) => followUpsOf.get(request)?.(res.data.replies?.[k], settled.lists) ?? []);
  if (afterwards.length) await clients.docs.documents.batchUpdate({ documentId, requestBody: { requests: afterwards } });
  return res.data;
}
