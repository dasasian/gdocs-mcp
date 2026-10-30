import { committedText, createDocFromMarkdown, docUrl, fetchReviewed, textInRange } from '../lib.mjs';

export const name = 'comment-on-text';
export const tags = ['comments'];

const PARAGRAPHS = ['Fees are due monthly.', 'The agreement renews each year unless either party gives written notice.'];
const QUOTED = 'renews each year';

export const setup = async (clients, docName) => ({ documentId: await createDocFromMarkdown(clients, docName, `${PARAGRAPHS.join('\n\n')}\n`) });

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, leave a comment on the words "${QUOTED}" asking whether the renewal can be cancelled. Don't change the text.`;

export async function grade(clients, { documentId }) {
  const failures = [];
  const reviewed = await fetchReviewed(clients, documentId);
  const comments = reviewed.comments ?? [];
  if (comments.length === 0) failures.push('no comment');
  const onQuoted = comments.filter((comment) => {
    const range = reviewed.tabs[0].documentTab.commentAnchors?.[comment.anchorId]?.ranges?.[0];
    return range && textInRange(reviewed, range) === QUOTED;
  });
  if (comments.length && onQuoted.length === 0) failures.push(`no comment is on "${QUOTED}": ${JSON.stringify(comments.map((comment) => comment.plainTextQuote ?? null))}`);
  if (onQuoted.length && !/\?|cancel/i.test(onQuoted[0].headPost?.content ?? '')) failures.push(`comment text: ${JSON.stringify(onQuoted[0].headPost?.content)}`);
  const committed = await committedText(clients, documentId);
  if (committed !== PARAGRAPHS.join('\n')) failures.push(`text changed: ${JSON.stringify(committed)}`);
  return failures;
}
