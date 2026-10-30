import { createDocFromMarkdown, docUrl, elementsOfBody, fetchTab } from '../lib.mjs';

export const name = 'dropdown-change';
export const tags = ['elements'];

const MARKDOWN = `<datalist id="status" title="Status"><option>Draft</option><option>In review</option><option>Final</option></datalist>

Contract status: <input class="chip" list="status" value="Draft">

Signed copies are filed with legal.`;

export const setup = async (clients, docName) => ({ documentId: await createDocFromMarkdown(clients, docName, MARKDOWN) });

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, the contract status is a dropdown. Change it to Final.`;

export async function grade(clients, { documentId }) {
  const failures = [];
  const tab = await fetchTab(clients, documentId);
  const dropdowns = elementsOfBody(tab).filter((element) => element.dropdown);
  if (dropdowns.length !== 1) failures.push(`expected one dropdown, found ${dropdowns.length}`);
  const shown = dropdowns[0]?.dropdown.dropdownProperties?.displayValue;
  if (shown !== 'Final') failures.push(`the dropdown shows ${JSON.stringify(shown)}`);
  const lists = Object.values(tab.dropdownDefinitions ?? {}).filter((list) => list.dropdownDefinitionProperties?.title === 'Status');
  const options = lists.flatMap((list) => list.dropdownDefinitionProperties.options.map((option) => option.displayValue));
  if (!['Draft', 'In review', 'Final'].every((option) => options.includes(option))) failures.push(`the list lost an option: ${JSON.stringify(options)}`);
  return failures;
}
