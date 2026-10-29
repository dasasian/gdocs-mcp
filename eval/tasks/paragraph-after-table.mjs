import { createDocFromMarkdown, describeBody, docUrl, emptyParagraphBesideTableFailures, fetchDoc, paymentAfterTableFailures } from '../lib.mjs';

export const name = 'paragraph-after-table';
export const tags = ['insert', 'tables'];

export const setup = async (clients, docName) => ({
  documentId: await createDocFromMarkdown(clients, docName,
    '# Quote for Acme\n\nThis quote covers the website rebuild.\n\n| Item | Price |\n|---|---|\n| Design | $1,200 |\n| Build | $3,000 |\n| Total | $4,200 |\n'),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, add a paragraph after the pricing table that says: Payment is due within 30 days of invoice.`;

export async function grade(clients, { documentId }) {
  const described = describeBody(await fetchDoc(clients, documentId));
  return [
    ...paymentAfterTableFailures(described, [['Item', 'Price'], ['Design', '$1,200'], ['Build', '$3,000'], ['Total', '$4,200']]),
    ...emptyParagraphBesideTableFailures(described),
  ];
}
