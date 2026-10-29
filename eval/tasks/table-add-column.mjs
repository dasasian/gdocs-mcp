import { STANDARD_QUOTE_ROWS, createPricingQuote, docUrl, fetchDoc, pricingTableFailures } from '../lib.mjs';

export const name = 'table-add-column';
export const tags = ['tables'];

export const setup = async (clients, docName) => ({
  documentId: await createPricingQuote(clients, docName, STANDARD_QUOTE_ROWS),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, add a Qty column to the pricing table right after Item. Design and Build are 1; leave Total's Qty empty.`;

export async function grade(clients, { documentId }) {
  return pricingTableFailures(await fetchDoc(clients, documentId),
    [['Item', 'Qty', 'Price'], ['Design', '1', '$1,200'], ['Build', '1', '$3,000'], ['Total', '', '$4,200']]);
}
