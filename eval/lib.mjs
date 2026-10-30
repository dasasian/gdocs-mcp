import { clientsForAccount } from '../dist/google/clients.js';
import { renderMarkdownInto } from '../dist/docs/render.js';

export const EVAL_ACCOUNT = 'damith@dasasian.com';
export const DOC_NAME_PREFIX = 'eval ';
export const DOCS_MIME_TYPE = 'application/vnd.google-apps.document';

export const createdDocIds = new Set();

export const QUOTA_RETRY_DELAY_MS = 60_000;
export const QUOTA_RETRIES = 3;

export const isQuotaError = (error) =>
  error?.code === 429 || error?.status === 429 || /Quota exceeded/.test(error?.message ?? '');

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls `call`, and on a quota error waits `delayMs` and calls again, up to `retries` times. Rethrows the quota error when the retries run out. */
export async function retryOnQuota(call, { retries = QUOTA_RETRIES, delayMs = QUOTA_RETRY_DELAY_MS, sleep = realSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!isQuotaError(error) || attempt >= retries) throw error;
      await sleep(delayMs);
    }
  }
}

/** Wraps a googleapis client so every call it makes goes through retryOnQuota. */
export function quotaRetrying(api, options = {}) {
  return new Proxy({}, {
    get(_unused, property) {
      const member = Reflect.get(api, property);
      if (typeof member === 'function') {
        return (...args) => {
          const call = () => member.apply(api, args);
          const first = call();
          if (typeof first?.then !== 'function') return first;
          return first.catch((error) => {
            if (!isQuotaError(error)) throw error;
            const sleep = options.sleep ?? realSleep;
            return sleep(options.delayMs ?? QUOTA_RETRY_DELAY_MS).then(() =>
              retryOnQuota(call, { ...options, retries: (options.retries ?? QUOTA_RETRIES) - 1 }));
          });
        };
      }
      return typeof member === 'object' && member !== null ? quotaRetrying(member, options) : member;
    },
  });
}

export async function evalClients() {
  const clients = await clientsForAccount(EVAL_ACCOUNT);
  return { ...clients, docs: quotaRetrying(clients.docs), drive: quotaRetrying(clients.drive) };
}

export const docUrl = (documentId) => `https://docs.google.com/document/d/${documentId}/edit`;

export async function createEmptyDoc(clients, name) {
  const { data } = await clients.docs.documents.create({ requestBody: { title: name } });
  createdDocIds.add(data.documentId);
  return data.documentId;
}

export async function createDocFromMarkdown(clients, name, markdown) {
  const documentId = await createEmptyDoc(clients, name);
  await renderMarkdownInto(clients, documentId, markdown, {});
  return documentId;
}

export async function trashDocById(clients, documentId) {
  await clients.drive.files.update({ fileId: documentId, requestBody: { trashed: true }, supportsAllDrives: true });
  createdDocIds.delete(documentId);
}

export async function findUntrashedEvalDocs(clients) {
  const found = [];
  let pageToken;
  do {
    const { data } = await clients.drive.files.list({
      q: `mimeType='${DOCS_MIME_TYPE}' and trashed=false and name contains 'eval'`,
      fields: 'nextPageToken, files(id,name)',
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    found.push(...(data.files ?? []).filter((file) => file.name.startsWith(DOC_NAME_PREFIX)));
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return found;
}

export async function fetchDoc(clients, documentId) {
  return (await clients.docs.documents.get({ documentId })).data;
}

export const paragraphText = (paragraph) =>
  (paragraph.elements ?? []).map((element) => element.textRun?.content ?? '').join('').replace(/\n$/, '');

export const cellText = (cell) =>
  cell.content.map((block) => paragraphText(block.paragraph)).join('').replace(/\n+$/, '').trim();

export const tablesOf = (doc) => doc.body.content.filter((element) => element.table).map((element) => element.table);

export const gridOf = (table) => table.tableRows.map((row) => row.tableCells.map(cellText));

function backgroundOf(cell) {
  const rgb = cell.tableCellStyle?.backgroundColor?.color?.rgbColor;
  return rgb ? [rgb.red ?? 0, rgb.green ?? 0, rgb.blue ?? 0] : null;
}

export const isLightGray = (rgb) =>
  Boolean(rgb) && rgb.every((value) => value > 0.7 && value < 1) && Math.max(...rgb) - Math.min(...rgb) < 0.08;

export function describeBody(doc) {
  return doc.body.content.slice(1).map((element) => {
    if (element.table) {
      return {
        table: gridOf(element.table),
        backgrounds: element.table.tableRows.map((row) => row.tableCells.map(backgroundOf)),
        fixedWidths: (element.table.tableStyle?.tableColumnProperties ?? []).map((column) =>
          column.widthType === 'FIXED_WIDTH' ? column.width?.magnitude : null),
      };
    }
    return {
      text: paragraphText(element.paragraph),
      style: element.paragraph?.paragraphStyle?.namedStyleType,
      bullet: Boolean(element.paragraph?.bullet),
    };
  });
}

export function emptyParagraphBesideTableFailures(described) {
  const empties = described.filter((block, index) =>
    block.text === '' && (described[index - 1]?.table || described[index + 1]?.table) && index !== 0 && index !== described.length - 1);
  return empties.length ? [`empty paragraph next to table x${empties.length}`] : [];
}

export const STANDARD_QUOTE_ROWS = [['Design', '$1,200'], ['Build', '$3,000'], ['Total', '$4,200']];

export function createPricingQuote(clients, name, rows) {
  const body = rows.map(([item, price]) => `| ${item === 'Design' ? '<span style="color:#ff0000">Design</span>' : item} | ${price} |`).join('\n');
  return createDocFromMarkdown(clients, name, `# Quote for Acme\n\n| Item | Price |\n|---|---|\n${body}\n\nPrices exclude tax.\n`);
}

export function pricingTableFailures(doc, wantGrid, { totalMayChange = false } = {}) {
  const failures = [];
  const tables = tablesOf(doc);
  if (tables.length !== 1) failures.push(`tables ${tables.length}`);
  const table = tables[0];
  const grid = table ? gridOf(table) : [];
  const want = wantGrid.map((row) => [...row]);
  const totalRow = grid.find((row) => row[0] === 'Total');
  if (totalMayChange && totalRow) want[want.length - 1][want[0].length - 1] = totalRow[totalRow.length - 1];
  if (JSON.stringify(grid) !== JSON.stringify(want)) failures.push(`grid ${JSON.stringify(grid)}`);
  const designRow = table?.tableRows.find((row) => cellText(row.tableCells[0]) === 'Design');
  const designRun = designRow?.tableCells[0].content[0].paragraph.elements.find((element) => element.textRun?.content.includes('Design'));
  const red = designRun?.textRun.textStyle?.foregroundColor?.color?.rgbColor;
  if (!red || red.red !== 1 || red.green) failures.push('Design lost its red (retyped?)');
  return failures;
}

const namedTextStyle = (doc, namedStyleType) =>
  doc.namedStyles?.styles?.find((style) => style.namedStyleType === namedStyleType)?.textStyle ?? {};

export function effectiveRunLook(doc, paragraph, run) {
  const named = namedTextStyle(doc, paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT');
  const normal = namedTextStyle(doc, 'NORMAL_TEXT');
  const style = run.textStyle ?? {};
  return {
    font: style.weightedFontFamily?.fontFamily ?? named.weightedFontFamily?.fontFamily ?? normal.weightedFontFamily?.fontFamily,
    size: style.fontSize?.magnitude ?? named.fontSize?.magnitude ?? normal.fontSize?.magnitude,
  };
}

export const textParagraphsOf = (doc) =>
  doc.body.content.filter((element) => element.paragraph && paragraphText(element.paragraph).trim()).map((element) => element.paragraph);

export function lookFailures(doc, { font, size }) {
  const failures = [];
  for (const paragraph of textParagraphsOf(doc)) {
    for (const run of paragraph.elements.filter((element) => element.textRun?.content.trim())) {
      const look = effectiveRunLook(doc, paragraph, run);
      if (look.font !== font || look.size !== size) {
        failures.push(`"${paragraphText(paragraph).slice(0, 12)}" is ${look.font} ${look.size}pt, wanted ${font} ${size}pt`);
        break;
      }
    }
  }
  return failures;
}

export function paymentAfterTableFailures(described, wantGrid) {
  const failures = [];
  const tableIndex = described.findIndex((block) => block.table);
  if (tableIndex < 0) return ['no table'];
  if (JSON.stringify(described[tableIndex].table) !== JSON.stringify(wantGrid)) failures.push(`table changed: ${JSON.stringify(described[tableIndex].table)}`);
  if (described.filter((block) => block.table).length !== 1) failures.push('table count');
  const after = described.slice(tableIndex + 1).find((block) => /30 days/.test(block.text ?? ''));
  if (!after) failures.push('no payment paragraph after table');
  else if (after.style !== 'NORMAL_TEXT' || after.bullet) failures.push(`payment paragraph style ${after.style}`);
  if (described.slice(0, tableIndex).some((block) => /30 days/.test(block.text ?? ''))) failures.push('payment text before table');
  return failures;
}

export async function fetchReviewed(clients, documentId) {
  return (await clients.docs.documents.get({
    documentId,
    includeTabsContent: true,
    suggestionsViewMode: 'SUGGESTIONS_INLINE',
    commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
  })).data;
}

async function bodyTextIn(clients, documentId, suggestionsViewMode) {
  const { data } = await clients.docs.documents.get({ documentId, suggestionsViewMode });
  return data.body.content.filter((element) => element.paragraph).map((element) => paragraphText(element.paragraph)).filter((text) => text.trim()).join('\n');
}

export const committedText = (clients, documentId) => bodyTextIn(clients, documentId, 'PREVIEW_WITHOUT_SUGGESTIONS');

export const acceptedText = (clients, documentId) => bodyTextIn(clients, documentId, 'PREVIEW_SUGGESTIONS_ACCEPTED');

export function textInRange(reviewed, { startIndex, endIndex }) {
  let text = '';
  for (const element of reviewed.tabs[0].documentTab.body.content) {
    for (const run of element.paragraph?.elements ?? []) {
      const content = run.textRun?.content ?? '';
      for (let i = 0; i < content.length; i++) {
        const at = (run.startIndex ?? 0) + i;
        if (at >= startIndex && at < endIndex) text += content[i];
      }
    }
  }
  return text;
}

export const CONTRACT_PARAGRAPHS = [
  'Preamble. This agreement sets out the terms between the parties.',
  'Term. The agreement lasts one year from the date of signing and renews each year unless either party gives written notice.',
  'Fees. Fees are due monthly.',
];

export function contractIndentFailures(doc, { hangingPoints }) {
  const failures = [];
  const paragraphs = textParagraphsOf(doc);
  if (paragraphs.length !== CONTRACT_PARAGRAPHS.length) failures.push(`paragraphs ${paragraphs.length}`);
  if (!paragraphs.some((paragraph) => paragraphText(paragraph).startsWith('Term.'))) failures.push('no Term paragraph');
  for (const paragraph of paragraphs) {
    const label = `"${paragraphText(paragraph).slice(0, 12)}"`;
    const namedStyleType = paragraph.paragraphStyle?.namedStyleType;
    if (namedStyleType !== 'NORMAL_TEXT') failures.push(`${label} is ${namedStyleType}`);
    if (paragraph.bullet) failures.push(`${label} became a list item`);
    const start = paragraph.paragraphStyle?.indentStart?.magnitude ?? 0;
    const firstLine = paragraph.paragraphStyle?.indentFirstLine?.magnitude ?? 0;
    const wantStart = paragraphText(paragraph).startsWith('Term.') ? hangingPoints : 0;
    if (start !== wantStart || firstLine !== 0) failures.push(`${label} indent start ${start} first line ${firstLine}, wanted ${wantStart} and 0`);
  }
  return failures;
}
