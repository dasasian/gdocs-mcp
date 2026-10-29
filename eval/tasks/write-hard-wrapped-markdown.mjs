import { createEmptyDoc, docUrl, fetchDoc, paragraphText } from '../lib.mjs';

export const name = 'write-hard-wrapped-markdown';
export const tags = ['write'];

const NOTES_MARKDOWN = `# Orchard notes

The orchard survey covers the north block this season. Counts were taken on
dry mornings so the canopy would not hide fruit, and every tree was tagged.

- 9-tree sample: group trees heavy / medium / light, pick 3 of each, count
  one side of the canopy x 2.
- Set up the Cull Sack before picking starts, so damaged fruit never reaches
  the bins.
- Weigh each bin.

> Pick only when the dew has gone.
>
> Wet fruit bruises in the bin and
> spoils within a week.

\`\`\`
Tier 1   3,000 x 20  =  60,000
Tier 2   2,000 x 45  =  90,000
\`\`\`

That is the whole plan for this season.`;

export const setup = async (clients, docName) => ({ documentId: await createEmptyDoc(clients, docName) });

export const prompt = ({ documentId }) =>
  `Write this markdown file into the Google Doc ${docUrl(documentId)} (it is empty). The file starts on the line after <<< and ends on the line before >>>.\n<<<\n${NOTES_MARKDOWN}\n>>>`;

export async function grade(clients, { documentId }) {
  const doc = await fetchDoc(clients, documentId);
  const paragraphs = doc.body.content.filter((element) => element.paragraph).map((element) => element.paragraph);
  const nonEmpty = paragraphs.filter((paragraph) => paragraphText(paragraph).trim());
  const failures = [];
  const items = nonEmpty.filter((paragraph) => paragraph.bullet);
  if (items.length !== 3) failures.push(`list items ${items.length}`);
  if (!items[0] || !paragraphText(items[0]).includes('count one side of the canopy')) failures.push(`item 1 split: ${items[0] && paragraphText(items[0])}`);
  const intro = nonEmpty.find((paragraph) => paragraphText(paragraph).startsWith('The orchard survey'));
  if (!intro || !paragraphText(intro).includes('north block this season. Counts were')) failures.push('intro not joined');
  const quotes = nonEmpty.filter((paragraph) => paragraph.paragraphStyle?.borderLeft?.width?.magnitude);
  if (quotes.length !== 2) failures.push(`quote paragraphs ${quotes.length}`);
  if (quotes[1] && !paragraphText(quotes[1]).includes('bin and spoils')) failures.push(`quote 2 not joined: ${paragraphText(quotes[1])}`);
  if (nonEmpty.some((paragraph) => /^>|> >/.test(paragraphText(paragraph)))) failures.push('literal > in text');
  const code = nonEmpty.find((paragraph) => paragraphText(paragraph).includes('Tier 1'));
  if (!code || !paragraphText(code).includes('60,000\u000bTier 2   2,000')) failures.push(`fence lines: ${JSON.stringify(code && paragraphText(code))}`);
  const codeRuns = code?.elements.filter((element) => element.textRun) ?? [];
  if (!codeRuns.every((element) => element.textRun.textStyle?.weightedFontFamily?.fontFamily === 'Courier New')) failures.push('fence not Courier');
  return failures;
}
