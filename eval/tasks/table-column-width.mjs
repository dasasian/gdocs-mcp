import { createDocFromMarkdown, describeBody, docUrl, emptyParagraphBesideTableFailures, fetchDoc } from '../lib.mjs';

export const name = 'table-column-width';
export const tags = ['style', 'tables'];

export const setup = async (clients, docName) => ({
  documentId: await createDocFromMarkdown(clients, docName,
    '# Quote for Acme\n\n| Item | Price | Notes |\n|---|---|---|\n| Design | $1,200 | Fixed fee |\n| Build | $3,000 | Hourly |\n\nPrices exclude tax.\n'),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, make the Notes column of the table 200pt wide.`;

export async function grade(clients, { documentId }) {
  const described = describeBody(await fetchDoc(clients, documentId));
  const failures = [...emptyParagraphBesideTableFailures(described)];
  const table = described.find((block) => block.table);
  if (!table) return [...failures, 'no table'];
  if (JSON.stringify(table.table) !== JSON.stringify([['Item', 'Price', 'Notes'], ['Design', '$1,200', 'Fixed fee'], ['Build', '$3,000', 'Hourly']])) failures.push(`cells changed ${JSON.stringify(table.table)}`);
  if (table.fixedWidths[2] !== 200) failures.push(`Notes width ${JSON.stringify(table.fixedWidths)}`);
  return failures;
}
