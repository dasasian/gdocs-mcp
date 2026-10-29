import { createDocFromMarkdown, describeBody, docUrl, emptyParagraphBesideTableFailures, fetchDoc, isLightGray } from '../lib.mjs';

export const name = 'table-header-shading';
export const tags = ['style', 'tables'];

export const setup = async (clients, docName) => ({
  documentId: await createDocFromMarkdown(clients, docName,
    '# Quote for Acme\n\n| Item | Price |\n|---|---|\n| Design | $1,200 |\n| Build | $3,000 |\n\nPrices exclude tax.\n'),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, shade the header row of the pricing table light gray.`;

export async function grade(clients, { documentId }) {
  const described = describeBody(await fetchDoc(clients, documentId));
  const failures = [...emptyParagraphBesideTableFailures(described)];
  const table = described.find((block) => block.table);
  if (!table) return [...failures, 'no table'];
  if (JSON.stringify(table.table) !== JSON.stringify([['Item', 'Price'], ['Design', '$1,200'], ['Build', '$3,000']])) failures.push(`cells changed ${JSON.stringify(table.table)}`);
  if (!table.backgrounds[0].every(isLightGray)) failures.push(`header not light gray ${JSON.stringify(table.backgrounds[0])}`);
  if (table.backgrounds.slice(1).flat().some(Boolean)) failures.push('body rows shaded');
  if (!described.some((block) => block.text === 'Prices exclude tax.')) failures.push('paragraph lost');
  return failures;
}
