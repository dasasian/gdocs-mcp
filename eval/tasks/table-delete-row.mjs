import { STANDARD_QUOTE_ROWS, createPricingQuote, docUrl, fetchDoc, pricingTableFailures } from '../lib.mjs';

export const name = 'table-delete-row';
export const tags = ['tables'];

export const setup = async (clients, docName) => ({
  documentId: await createPricingQuote(clients, docName, STANDARD_QUOTE_ROWS),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, delete the Build row from the pricing table.`;

export async function grade(clients, { documentId }) {
  return pricingTableFailures(await fetchDoc(clients, documentId), [['Item', 'Price'], ['Design', '$1,200'], ['Total', '$4,200']]);
}
