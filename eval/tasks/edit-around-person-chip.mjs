import { EVAL_ACCOUNT, createDocFromMarkdown, docUrl, elementsOfBody, fetchTab, paragraphWithElements } from '../lib.mjs';

export const name = 'edit-around-person-chip';
export const tags = ['elements'];

const MARKDOWN = `Owner: <a class="chip" href="mailto:${EVAL_ACCOUNT}">Damith</a>, due Friday. Review the draft before then.`;

export const setup = async (clients, docName) => ({ documentId: await createDocFromMarkdown(clients, docName, MARKDOWN) });

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, change "Owner" to "Task owner" and "Friday" to "Monday" in the first line. Leave the rest of the line as it is.`;

export async function grade(clients, { documentId }) {
  const failures = [];
  const tab = await fetchTab(clients, documentId);
  const people = elementsOfBody(tab).filter((element) => element.person);
  if (people.length !== 1) failures.push(`expected the person chip to survive, found ${people.length}`);
  else if (people[0].person.personProperties?.email !== EVAL_ACCOUNT) failures.push(`the chip points at ${people[0].person.personProperties?.email}`);
  const first = tab.body.content.find((block) => block.paragraph && /owner/i.test(paragraphWithElements(block.paragraph)));
  const line = first ? paragraphWithElements(first.paragraph) : '';
  if (line !== 'Task owner: [person], due Monday. Review the draft before then.') failures.push(`the line reads ${JSON.stringify(line)}`);
  return failures;
}
