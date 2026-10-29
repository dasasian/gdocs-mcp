import { createPricingQuote, docUrl, fetchDoc, pricingTableFailures } from '../lib.mjs';

export const name = 'table-move-row';
export const tags = ['tables'];

export const setup = async (clients, docName) => ({
  documentId: await createPricingQuote(clients, docName,
    [['Design', '$1,200'], ['Build', '$3,000'], ['Hosting', '$300'], ['Total', '$4,500']]),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, move the Hosting row of the pricing table so it is directly above Design.`;

export async function grade(clients, { documentId }) {
  return pricingTableFailures(await fetchDoc(clients, documentId),
    [['Item', 'Price'], ['Hosting', '$300'], ['Design', '$1,200'], ['Build', '$3,000'], ['Total', '$4,500']]);
}
