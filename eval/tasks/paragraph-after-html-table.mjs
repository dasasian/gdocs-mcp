import { createDocFromMarkdown, describeBody, docUrl, emptyParagraphBesideTableFailures, fetchDoc, isLightGray, paymentAfterTableFailures } from '../lib.mjs';

export const name = 'paragraph-after-html-table';
export const tags = ['insert', 'tables', 'style'];

export const setup = async (clients, docName) => ({
  documentId: await createDocFromMarkdown(clients, docName,
    '# Quote for Acme\n\nThis quote covers the website rebuild.\n\n<table>\n<thead>\n<tr style="background:#eeeeee"><th>Item</th><th>Price</th></tr>\n</thead>\n<tr><td>Design</td><td>$1,200</td></tr>\n<tr><td>Total</td><td>$4,200</td></tr>\n</table>\n'),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, add a paragraph after the pricing table that says: Payment is due within 30 days of invoice.`;

export async function grade(clients, { documentId }) {
  const described = describeBody(await fetchDoc(clients, documentId));
  const failures = [
    ...paymentAfterTableFailures(described, [['Item', 'Price'], ['Design', '$1,200'], ['Total', '$4,200']]),
    ...emptyParagraphBesideTableFailures(described),
  ];
  const table = described.find((block) => block.table);
  if (table && !table.backgrounds[0].every(isLightGray)) failures.push(`header shading lost ${JSON.stringify(table.backgrounds[0])}`);
  return failures;
}
