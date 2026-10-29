import { createHash } from 'node:crypto';
import { CONTRACT_PARAGRAPHS, contractIndentFailures, createEmptyDoc, docUrl, fetchDoc, lookFailures, paragraphText, textParagraphsOf } from '../lib.mjs';

export const name = 'edit-existing-style';
export const tags = ['style'];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export async function setup(clients, docName) {
  const documentId = await createEmptyDoc(clients, docName);
  const termStart = CONTRACT_PARAGRAPHS[0].length + 2;
  const termEnd = termStart + CONTRACT_PARAGRAPHS[1].length;
  await clients.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        { insertText: { location: { index: 1 }, text: CONTRACT_PARAGRAPHS.join('\n') } },
        {
          updateNamedStyle: {
            namedStyle: {
              namedStyleType: 'NORMAL_TEXT',
              textStyle: { weightedFontFamily: { fontFamily: 'Georgia' }, fontSize: { magnitude: 12, unit: 'PT' } },
            },
            fields: 'namedStyleType,textStyle.weightedFontFamily,textStyle.fontSize',
          },
        },
        {
          updateParagraphStyle: {
            range: { startIndex: termStart, endIndex: termEnd },
            paragraphStyle: { indentStart: { magnitude: 36, unit: 'PT' }, indentFirstLine: { magnitude: 0, unit: 'PT' } },
            fields: 'indentStart,indentFirstLine',
          },
        },
      ],
    },
  });
  const seeded = await fetchDoc(clients, documentId);
  return { documentId, textHashes: textParagraphsOf(seeded).map((paragraph) => sha256(paragraphText(paragraph))) };
}

export const prompt = ({ documentId }) =>
  `In the Google Doc ${docUrl(documentId)}, change Term's hanging indent to 1 inch and make the whole doc 11pt. Don't change any wording.`;

export async function grade(clients, { documentId, textHashes }) {
  const doc = await fetchDoc(clients, documentId);
  const failures = [...contractIndentFailures(doc, { hangingPoints: 72 }), ...lookFailures(doc, { font: 'Georgia', size: 11 })];
  const nowHashes = textParagraphsOf(doc).map((paragraph) => sha256(paragraphText(paragraph)));
  if (JSON.stringify(nowHashes) !== JSON.stringify(textHashes)) failures.push('paragraph text changed');
  return failures;
}
