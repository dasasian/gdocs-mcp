import { createDocFromMarkdown, describeBody, docUrl, emptyParagraphBesideTableFailures, fetchDoc } from '../lib.mjs';

export const name = 'table-after-heading';
export const tags = ['insert', 'tables'];

export const setup = async (clients, docName) => ({
  documentId: await createDocFromMarkdown(clients, docName,
    '# Project plan\n\n## Scope\n\nThis project covers the website rebuild for Acme.\n\n## Timeline\n\nWork starts in November.\n'),
});

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, add a table right after the Scope heading, before its paragraph, with columns Phase and Weeks and rows Design 2 and Build 6.`;

export async function grade(clients, { documentId }) {
  const described = describeBody(await fetchDoc(clients, documentId));
  const failures = [...emptyParagraphBesideTableFailures(described)];
  const scopeIndex = described.findIndex((block) => block.text === 'Scope');
  if (scopeIndex < 0 || described[scopeIndex].style !== 'HEADING_2') failures.push(`Scope heading lost: ${JSON.stringify(described[scopeIndex])}`);
  const next = described.slice(scopeIndex + 1).find((block) => block.table || block.text);
  if (!next?.table) failures.push(`next after Scope is not a table: ${JSON.stringify(next)}`);
  else if (JSON.stringify(next.table) !== JSON.stringify([['Phase', 'Weeks'], ['Design', '2'], ['Build', '6']])) failures.push(`table cells ${JSON.stringify(next.table)}`);
  const tableIndex = described.findIndex((block) => block.table);
  const scopeParagraph = described.find((block) => block.text?.startsWith('This project covers'));
  if (!scopeParagraph || scopeParagraph.style !== 'NORMAL_TEXT') failures.push(`scope paragraph ${JSON.stringify(scopeParagraph)}`);
  if (tableIndex < 0 || !described.slice(tableIndex + 1).some((block) => block.text?.startsWith('This project'))) failures.push('paragraph not after table');
  if (described.find((block) => block.text === 'Timeline')?.style !== 'HEADING_2') failures.push('Timeline heading lost');
  return failures;
}
