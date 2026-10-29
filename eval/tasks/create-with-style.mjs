import { CONTRACT_PARAGRAPHS, contractIndentFailures, createEmptyDoc, docUrl, fetchDoc, lookFailures } from '../lib.mjs';

export const name = 'create-with-style';
export const tags = ['write', 'style'];

export const setup = async (clients, docName) => ({ documentId: await createEmptyDoc(clients, docName) });

export const prompt = ({ documentId }) =>
  `The Google Doc ${docUrl(documentId)} is empty. Put these three paragraphs in it, give Term a 0.5 inch hanging indent, and make the whole doc Georgia 12pt.\n\n${CONTRACT_PARAGRAPHS.join('\n\n')}`;

export async function grade(clients, { documentId }) {
  const doc = await fetchDoc(clients, documentId);
  return [...contractIndentFailures(doc, { hangingPoints: 36 }), ...lookFailures(doc, { font: 'Georgia', size: 12 })];
}
