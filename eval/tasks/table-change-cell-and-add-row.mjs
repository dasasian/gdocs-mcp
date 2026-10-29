import { STANDARD_QUOTE_ROWS, createPricingQuote, docUrl, fetchDoc, pricingTableFailures } from '../lib.mjs';

export const name = 'table-change-cell-and-add-row';
export const tags = ['tables'];

export const setup = async (clients, docName) => ({
  documentId: await createPricingQuote(clients, docName, STANDARD_QUOTE_ROWS),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, in the pricing table change Build to $3,500 and add a Hosting row at $300 right after Build.`;

export async function grade(clients, { documentId }) {
  return pricingTableFailures(await fetchDoc(clients, documentId),
    [['Item', 'Price'], ['Design', '$1,200'], ['Build', '$3,500'], ['Hosting', '$300'], ['Total', '$4,200']], { totalMayChange: true });
}
