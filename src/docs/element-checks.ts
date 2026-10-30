import type { docs_v1 } from 'googleapis';
import { tabContainer } from './structure.js';
import { creationIssue, parseElement, tokensIn, chipTextChange, elementTokenOf, type DocumentTabWithElements, type ParagraphElement } from './elements.js';
import { creationIssuesIn, ElementRefusal } from './element-write.js';
import { listSpecOfLine } from './write.js';

function paragraphsOf(content: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$Paragraph[] {
  return content.flatMap((el) => (el.paragraph ? [el.paragraph] : (el.table?.tableRows ?? []).flatMap((row) => (row.tableCells ?? []).flatMap((cell) => paragraphsOf(cell.content ?? [])))));
}

function tokensOfDoc(doc: docs_v1.Schema$Document, tabId: string | undefined): string[] {
  const container = tabContainer(doc, tabId);
  const segments = [container?.body?.content ?? [], ...Object.values(container?.headers ?? {}).map((h) => h.content ?? []), ...Object.values(container?.footers ?? {}).map((f) => f.content ?? [])];
  return segments.flatMap(paragraphsOf).flatMap((paragraph) =>
    (paragraph.elements ?? []).flatMap((pe) => {
      const token = elementTokenOf(pe as ParagraphElement);
      return token === undefined ? [] : [token];
    }),
  );
}

/** A write that gives a chip of the doc other words with the same href: a chip's text is Google's, so it is refused. */
export function chipTextIssues(markdown: string, doc: docs_v1.Schema$Document, tabId: string | undefined): string[] {
  const writtenTokens = new Set(tokensIn(markdown));
  const dropped = tokensOfDoc(doc, tabId).filter((token) => !writtenTokens.has(token)).map(parseElement);
  return tokensIn(markdown).flatMap((token) => {
    const written = parseElement(token);
    const change = dropped.map((chip) => chipTextChange(chip, written)).find((issue) => issue !== undefined);
    return change ? [change] : [];
  });
}

/**
 * What a dropdown in this markdown needs that Docs cannot suggest: a list the doc does not have, a list that differs
 * from the doc's, or a choice other than the list's first (a new dropdown starts on the first, and changing it is a
 * request Docs cannot suggest).
 */
export function unsuggestableDropdownIssues(markdown: string, doc: docs_v1.Schema$Document, tabId: string | undefined): string[] {
  const definitions = (tabContainer(doc, tabId) as DocumentTabWithElements | undefined)?.dropdownDefinitions ?? {};
  const written = new Map(
    markdown.split('\n').flatMap((line) => {
      const spec = listSpecOfLine(line);
      return spec ? [[spec.id, spec] as const] : [];
    }),
  );
  const dropdowns = tokensIn(markdown)
    .map(parseElement)
    .flatMap((element) => (element.kind === 'dropdown' ? [element] : []));
  const lists = [...new Set([...written.keys(), ...dropdowns.map((dropdown) => dropdown.listId)])];
  const listIssues = lists.flatMap((id) => {
    const spec = written.get(id);
    const existing = definitions[id]?.dropdownDefinitionProperties;
    if (!existing) return spec ? [`the dropdown list "${id}" is new, and Docs cannot suggest making a list (createDropdownDefinition)`] : [];
    const same = !spec || (spec.title === existing.title && spec.options.join('\n') === (existing.options ?? []).map((option) => option.displayValue).join('\n'));
    return same ? [] : [`changing the dropdown list "${id}" is something Docs cannot suggest (updateDropdownDefinitionProperties)`];
  });
  const valueIssues = dropdowns.flatMap((dropdown) => {
    const options = written.get(dropdown.listId)?.options ?? (definitions[dropdown.listId]?.dropdownDefinitionProperties?.options ?? []).map((option) => option.displayValue);
    return dropdown.value && dropdown.value !== options[0] ? [`choosing "${dropdown.value}" in a dropdown that starts on "${options[0]}" is something Docs cannot suggest (updateDropdownProperties)`] : [];
  });
  return [...listIssues, ...valueIssues];
}

/** Throws `ElementRefusal` when anything in `markdown` cannot be written to this doc, before a request is sent. */
export function refuseUnwritableElements(markdown: string, doc: docs_v1.Schema$Document | undefined, opts: { tabId?: string; segmentId?: string; suggest?: boolean }): void {
  const issues = [
    ...creationIssuesIn(markdown, opts.segmentId),
    ...(doc ? chipTextIssues(markdown, doc, opts.tabId) : []),
    ...(doc && opts.suggest ? unsuggestableDropdownIssues(markdown, doc, opts.tabId).map((issue) => `Docs cannot suggest this: ${issue}`) : []),
  ];
  if (issues.length) throw new ElementRefusal(issues);
}

/**
 * Refuses, before the first request of a table edit, an element the edit would make that cannot be made, a chip given
 * other words, a dropdown whose list the doc does not have and the edit does not define, or a change Docs cannot suggest.
 * A table edit sends its row and column changes before it types the cells, so a refusal found later is too late.
 */
export function refuseUnwritableTableEdit(oldString: string, newString: string, doc: docs_v1.Schema$Document, opts: { tabId?: string; segmentId?: string; suggest?: boolean }): void {
  const was = new Set(tokensIn(oldString));
  const made = [...new Set(tokensIn(newString))].filter((token) => !was.has(token));
  const definitions = (tabContainer(doc, opts.tabId) as DocumentTabWithElements | undefined)?.dropdownDefinitions ?? {};
  const lists = newString.split('\n').filter((line) => listSpecOfLine(line) !== undefined);
  const issues = [
    ...made.flatMap((token) => creationIssue(parseElement(token), opts.segmentId) ?? []),
    ...made.flatMap((token) => [...was].filter((before) => !tokensIn(newString).includes(before)).flatMap((before) => chipTextChange(parseElement(before), parseElement(token)) ?? [])),
    ...made.flatMap((token) => {
      const element = parseElement(token);
      return element.kind === 'dropdown' && !definitions[element.listId] ? [`this doc has no dropdown list "${element.listId}". Define it first with an edit_doc whose new_string holds its <datalist> line, or use a list the doc has.`] : [];
    }),
    ...(opts.suggest ? unsuggestableDropdownIssues([...made, ...lists].join('\n'), doc, opts.tabId).map((issue) => `Docs cannot suggest this: ${issue}`) : []),
  ];
  if (issues.length) throw new ElementRefusal(issues);
}
