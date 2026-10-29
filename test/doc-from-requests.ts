import type { docs_v1 } from 'googleapis';

type StylePatch = { range: docs_v1.Schema$Range; style: Record<string, unknown> };

function paragraphSpans(text: string, startIndex: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = startIndex;
  for (const line of text.split('\n').slice(0, -1)) {
    spans.push({ start, end: start + line.length + 1 });
    start += line.length + 1;
  }
  return spans;
}

/** The paragraphs a write's insertText and style requests leave in a doc, for a reader to read back. Only the style fields the requests set are applied. */
export function paragraphsFromRequests(requests: docs_v1.Schema$Request[], text: string, startIndex = 1): docs_v1.Schema$StructuralElement[] {
  const textPatches: StylePatch[] = requests.flatMap((r) => (r.updateTextStyle ? [{ range: r.updateTextStyle.range!, style: r.updateTextStyle.textStyle as Record<string, unknown> }] : []));
  const paragraphPatches: StylePatch[] = requests.flatMap((r) => (r.updateParagraphStyle ? [{ range: r.updateParagraphStyle.range!, style: r.updateParagraphStyle.paragraphStyle as Record<string, unknown> }] : []));
  const characterStyleAt = (index: number): Record<string, unknown> => Object.assign({}, ...textPatches.filter((p) => p.range.startIndex! <= index && index < p.range.endIndex!).map((p) => p.style));
  return paragraphSpans(text, startIndex).map(({ start, end }) => {
    const content = text.slice(start - startIndex, end - startIndex);
    const runs: docs_v1.Schema$ParagraphElement[] = [];
    for (let index = start; index < end; index++) {
      const style = characterStyleAt(index);
      const char = content[index - start];
      const last = runs[runs.length - 1];
      if (last && JSON.stringify(last.textRun!.textStyle) === JSON.stringify(style)) last.textRun!.content += char;
      else runs.push({ startIndex: index, textRun: { content: char, textStyle: style as docs_v1.Schema$TextStyle } });
    }
    const paragraphStyle = Object.assign({ namedStyleType: 'NORMAL_TEXT' }, ...paragraphPatches.filter((p) => p.range.startIndex! <= start && start < p.range.endIndex!).map((p) => p.style));
    return { startIndex: start, endIndex: end, paragraph: { elements: runs, paragraphStyle: paragraphStyle as docs_v1.Schema$ParagraphStyle } };
  });
}

export const bodyDocument = (content: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$Document => ({ body: { content } });

export const tableWithCell = (cellContent: docs_v1.Schema$StructuralElement[], cellStyle: docs_v1.Schema$TableCellStyle = {}): docs_v1.Schema$StructuralElement => ({
  table: { rows: 1, columns: 1, tableRows: [{ tableCells: [{ content: cellContent, tableCellStyle: { rowSpan: 1, columnSpan: 1, ...cellStyle } }] }] },
});
