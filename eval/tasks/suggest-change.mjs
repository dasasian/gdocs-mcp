import { acceptedText, committedText, createDocFromMarkdown, docUrl, fetchReviewed } from '../lib.mjs';

export const name = 'suggest-change';
export const tags = ['suggestions'];

const ORIGINAL = 'Pay within 30 days of invoice.';

export const setup = async (clients, docName) => ({ documentId: await createDocFromMarkdown(clients, docName, `${ORIGINAL}\n`) });

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, change "30 days" to "45 days". I want to look at the change before it goes in, so leave the text as it is until I accept it.`;

export async function grade(clients, { documentId }) {
  const failures = [];
  const pending = ((await fetchReviewed(clients, documentId)).suggestions ?? []).filter((thread) => thread.status === 'OPEN');
  if (pending.length === 0) failures.push('no pending suggestion');
  const committed = await committedText(clients, documentId);
  if (committed !== ORIGINAL) failures.push(`committed text changed: ${JSON.stringify(committed)}`);
  const accepted = await acceptedText(clients, documentId);
  if (accepted !== 'Pay within 45 days of invoice.') failures.push(`text if accepted: ${JSON.stringify(accepted)}`);
  return failures;
}
