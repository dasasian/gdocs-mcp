import { createDocFromMarkdown, docUrl, elementsOfBody, fetchTab, footnoteText, paragraphWithElements } from '../lib.mjs';

export const name = 'footnote-add';
export const tags = ['elements'];

const BODY = 'Payment is due within 30 days of invoice.';

export const setup = async (clients, docName) => ({ documentId: await createDocFromMarkdown(clients, docName, `${BODY}\n\nLate fees apply after that.`) });

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, add a footnote right after "30 days" that says "Business days only".`;

export async function grade(clients, { documentId }) {
  const failures = [];
  const tab = await fetchTab(clients, documentId);
  const references = elementsOfBody(tab).filter((element) => element.footnoteReference);
  if (references.length !== 1) failures.push(`expected one footnote, found ${references.length}`);
  const first = tab.body.content.find((block) => block.paragraph && /Payment is due/.test(paragraphWithElements(block.paragraph)));
  const line = first ? paragraphWithElements(first.paragraph) : '';
  if (!/^Payment is due within 30 days\[footnote:[^\]]+\] of invoice\.$/.test(line)) failures.push(`the sentence reads ${JSON.stringify(line)}`);
  const note = references[0] ? footnoteText(tab, references[0].footnoteReference.footnoteId) : '';
  if (!/business days only/i.test(note)) failures.push(`the footnote says ${JSON.stringify(note)}`);
  return failures;
}
