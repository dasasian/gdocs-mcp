import type { docs_v1 } from 'googleapis';

const pt = (n: number): docs_v1.Schema$Dimension => ({ magnitude: n, unit: 'PT' });
const gray = { red: 0.8, green: 0.8, blue: 0.8 };

export const border = (width: number, rgb = gray): docs_v1.Schema$TableCellBorder => ({ width: pt(width), color: { color: { rgbColor: rgb } }, dashStyle: 'SOLID' });
export const background = (hex: 'eee' | 'yellow'): docs_v1.Schema$OptionalColor => ({
  color: { rgbColor: hex === 'eee' ? { red: 0.93333334, green: 0.93333334, blue: 0.93333334 } : { red: 1, green: 1, blue: 0.8 } },
});

/** What `insertTable` reports for a cell nobody styled. */
export const DOCS_DEFAULT_CELL: docs_v1.Schema$TableCellStyle = {
  rowSpan: 1,
  columnSpan: 1,
  backgroundColor: {},
  paddingLeft: pt(5),
  paddingRight: pt(5),
  paddingTop: pt(5),
  paddingBottom: pt(5),
  contentAlignment: 'TOP',
};

export interface CellSpec {
  /** one string per paragraph. */
  text?: string | string[];
  style?: docs_v1.Schema$TableCellStyle;
  paragraphStyle?: docs_v1.Schema$ParagraphStyle;
  bullet?: boolean;
  runStyle?: docs_v1.Schema$TextStyle;
}

export interface RowSpec {
  cells: CellSpec[];
  style?: docs_v1.Schema$TableRowStyle;
}

export interface TableSpec {
  rows: RowSpec[];
  columns?: docs_v1.Schema$TableColumnProperties[];
}

export const plain = (...texts: string[]): RowSpec => ({ cells: texts.map((text) => ({ text })) });

function cellOf(spec: CellSpec, startAt: number): { cell: docs_v1.Schema$TableCell; next: number } {
  let index = startAt;
  const paragraphs = (Array.isArray(spec.text) ? spec.text : [spec.text ?? '']).map((text) => {
    const startIndex = index;
    index += text.length + 1;
    const paragraph: docs_v1.Schema$Paragraph = {
      elements: [{ startIndex, endIndex: index, textRun: { content: `${text}\n`, textStyle: spec.runStyle } }],
      paragraphStyle: { namedStyleType: 'NORMAL_TEXT', lineSpacing: 100, ...spec.paragraphStyle },
      ...(spec.bullet ? { bullet: { listId: 'l1' } } : {}),
    };
    return { startIndex, endIndex: index, paragraph };
  });
  return { cell: { content: paragraphs, tableCellStyle: { ...DOCS_DEFAULT_CELL, ...spec.style } }, next: index };
}

export function tableElement(spec: TableSpec, startIndex: number): docs_v1.Schema$StructuralElement {
  let index = startIndex + 1;
  const tableRows = spec.rows.map((row) => {
    const rowStart = index;
    index += 1;
    const tableCells = row.cells.map((cell) => {
      index += 1;
      const built = cellOf(cell, index);
      index = built.next;
      return built.cell;
    });
    return { startIndex: rowStart, endIndex: index, tableCells, tableRowStyle: { minRowHeight: { unit: 'PT' }, ...row.style } };
  });
  const columnCount = Math.max(...spec.rows.map((r) => r.cells.length));
  const tableColumnProperties = spec.columns ?? Array.from({ length: columnCount }, () => ({ widthType: 'EVENLY_DISTRIBUTED' }));
  index += 1;
  return { startIndex, endIndex: index, table: { rows: spec.rows.length, columns: columnCount, tableRows, tableStyle: { tableColumnProperties } } };
}

const NAMED_STYLES: docs_v1.Schema$NamedStyles = { styles: [{ namedStyleType: 'NORMAL_TEXT', paragraphStyle: { lineSpacing: 115 } }] };

export function bodyDocWithTable(spec: TableSpec): docs_v1.Schema$Document {
  const table = tableElement(spec, 1);
  const end = table.endIndex ?? 1;
  return { revisionId: 'r1', namedStyles: NAMED_STYLES, body: { content: [table, { startIndex: end, endIndex: end + 1, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } };
}

export function headerDocWithTable(spec: TableSpec): docs_v1.Schema$Document {
  return {
    revisionId: 'r1',
    namedStyles: NAMED_STYLES,
    documentStyle: { defaultHeaderId: 'h1' },
    headers: { h1: { headerId: 'h1', content: [tableElement(spec, 0), { startIndex: 90, endIndex: 91, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } },
    body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] },
  };
}

/** A header-row shaded, merged, pinned, column-width table: the shape the live round trip uses. */
export const STYLED_TABLE: TableSpec = {
  columns: [{ widthType: 'FIXED_WIDTH', width: pt(120) }, { widthType: 'EVENLY_DISTRIBUTED' }, { widthType: 'EVENLY_DISTRIBUTED' }],
  rows: [
    {
      style: { tableHeader: true },
      cells: ['Item', 'Price', 'Notes'].map((text) => ({ text, style: { backgroundColor: background('eee'), borderTop: border(0.5), borderBottom: border(0.5), borderLeft: border(0.5), borderRight: border(0.5) } })),
    },
    {
      cells: [
        { text: 'Design', style: { borderTop: border(0.5), borderBottom: border(0.5), borderLeft: border(0.5), borderRight: border(0.5) } },
        { text: '$1,200', style: { borderTop: border(0.5), borderBottom: border(0.5), borderLeft: border(0.5), borderRight: border(0.5) } },
        { text: 'Fixed fee', runStyle: { bold: true }, style: { borderTop: border(0.5), borderBottom: border(0.5), borderLeft: border(0.5), borderRight: border(0.5) } },
      ],
    },
    {
      cells: [
        { text: 'Total', style: { columnSpan: 2, backgroundColor: background('yellow'), borderTop: border(0.5), borderBottom: border(0.5), borderLeft: border(0.5) } },
        { text: '', style: { backgroundColor: background('yellow'), borderTop: border(0.5), borderBottom: border(0.5), borderRight: border(0.5) } },
        { text: '$4,200', style: { borderTop: border(0.5), borderBottom: border(0.5), borderLeft: border(0.5), borderRight: border(0.5) } },
      ],
    },
  ],
};
