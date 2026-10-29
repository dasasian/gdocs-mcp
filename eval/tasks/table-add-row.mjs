import { STANDARD_QUOTE_ROWS, createPricingQuote, docUrl, fetchDoc, pricingTableFailures } from '../lib.mjs';

export const name = 'table-add-row';
export const tags = ['tables'];

export const setup = async (clients, docName) => ({
  documentId: await createPricingQuote(clients, docName, STANDARD_QUOTE_ROWS),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, add a row to the pricing table for Hosting at $300, just before the Total row.`;

export async function grade(clients, { documentId }) {
  return pricingTableFailures(await fetchDoc(clients, documentId),
    [['Item', 'Price'], ['Design', '$1,200'], ['Build', '$3,000'], ['Hosting', '$300'], ['Total', '$4,200']], { totalMayChange: true });
}
