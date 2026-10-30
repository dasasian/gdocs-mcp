import { createDocFromMarkdown, docUrl, fetchTab } from '../lib.mjs';

export const name = 'dropdown-change-in-table';
export const tags = ['elements', 'tables'];

const MARKDOWN = `<datalist id="status" title="Status"><option>Draft</option><option>In review</option><option>Final</option></datalist>

| Task | Status |
| --- | --- |
| Q3 Spec | <input class="chip" list="status" value="Draft"> |
| Budget | <input class="chip" list="status" value="Final"> |`;

export const setup = async (clients, docName) => ({ documentId: await createDocFromMarkdown(clients, docName, MARKDOWN) });

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, the tracker table has a Status dropdown on each row. Change the status of the Q3 Spec row to In review. Leave the Budget row as it is.`;

const dropdownsIn = (content) =>
  (content ?? []).flatMap((block) => [
    ...(block.paragraph?.elements ?? []).filter((element) => element.dropdown).map((element) => element.dropdown.dropdownProperties?.displayValue),
    ...(block.table?.tableRows ?? []).flatMap((row) => row.tableCells.flatMap((cell) => dropdownsIn(cell.content))),
  ]);

export async function grade(clients, { documentId }) {
  const tab = await fetchTab(clients, documentId);
  const shown = dropdownsIn(tab.body.content);
  return JSON.stringify(shown) === JSON.stringify(['In review', 'Final']) ? [] : [`the dropdowns show ${JSON.stringify(shown)}, wanted ["In review","Final"]`];
}
