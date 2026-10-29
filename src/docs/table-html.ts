import { parseElementCss, elementDeclarations, type ElementCss, type TableElement } from './table-css.js';
import { styleAttribute } from './css.js';
import type { LayoutCell, LayoutColumn, LayoutRow, TableLayout } from './table-layout.js';

const styleAttr = (css: ElementCss): string => {
  const style = styleAttribute(elementDeclarations(css));
  return style ? ` style="${style}"` : '';
};

const columnHasStyle = (column: LayoutColumn): boolean => column.width !== undefined || Object.keys(column.css).length > 0;

const cellMarkup = (cell: LayoutCell, tag: 'td' | 'th'): string => {
  const spans = `${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}`;
  const content = cell.asBlocks && cell.markdown.includes('\n') ? `\n\n${cell.markdown}\n\n` : cell.markdown;
  return `<${tag}${spans}${styleAttr({ cell: cell.css })}>${content}</${tag}>`;
};

const rowMarkup = (row: LayoutRow): string =>
  `<tr${styleAttr({ cell: row.css, height: row.height })}>${row.cells.map((cell) => cellMarkup(cell, row.pinned ? 'th' : 'td')).join('')}</tr>`;

/** One row per line; a cell that holds blocks spans lines. The rows that repeat on every page sit in <thead>. */
export function renderHtmlTable(layout: TableLayout): string {
  const lines = [`<table${styleAttr({ cell: layout.css })}>`];
  if (layout.columns.some(columnHasStyle)) {
    lines.push(layout.columns.map((column) => `<col${styleAttr({ cell: column.css, width: column.width })}>`).join(''));
  }
  const pinned = layout.rows.filter((row) => row.pinned);
  if (pinned.length) lines.push('<thead>', ...pinned.map(rowMarkup), '</thead>');
  lines.push(...layout.rows.filter((row) => !row.pinned).map(rowMarkup), '</table>');
  return lines.join('\n');
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)>/y;
const ATTRIBUTE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
const CELL_CLOSE = /<\/t[dh]\s*>/iy;
const BLOCK_START = /^<(?:p|h[1-6])\b/i;
const SNIPPET = 40;

interface Tag {
  closing: boolean;
  name: string;
  attributes: Record<string, string>;
  rest: string;
}

function attributesOf(name: string, source: string, allowed: string[], issues: string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, attribute, value] of source.matchAll(ATTRIBUTE)) attributes[attribute.toLowerCase()] = value;
  const leftover = source.replace(ATTRIBUTE, '').trim();
  if (leftover) issues.push(`<${name} ${leftover}> is not supported (only ${allowed.join(', ')})`);
  for (const attribute of Object.keys(attributes)) {
    if (!allowed.includes(attribute)) issues.push(`<${name} ${attribute}=…> is not supported (only ${allowed.join(', ')})`);
  }
  return attributes;
}

const ATTRIBUTES_OF: Record<string, string[]> = { table: ['style'], col: ['style'], tr: ['style'], td: ['style', 'colspan', 'rowspan'], th: ['style', 'colspan', 'rowspan'], thead: [], tbody: [] };

class Scanner {
  pos = 0;
  constructor(readonly text: string, readonly issues: string[]) {}

  skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  snippet(): string {
    return this.text.slice(this.pos, this.pos + SNIPPET).replace(/\n/g, ' ');
  }

  tag(): Tag | undefined {
    TAG.lastIndex = this.pos;
    const m = TAG.exec(this.text);
    if (!m) return undefined;
    this.pos = TAG.lastIndex;
    const name = m[2].toLowerCase();
    const allowed = ATTRIBUTES_OF[name];
    return { closing: m[1] === '/', name, attributes: allowed && !m[1] ? attributesOf(name, m[3], allowed, this.issues) : {}, rest: m[3] };
  }

  cellContent(): string | undefined {
    let i = this.pos;
    while (i < this.text.length) {
      if (this.text[i] === '\\') {
        i += 2;
        continue;
      }
      CELL_CLOSE.lastIndex = i;
      if (CELL_CLOSE.test(this.text)) {
        const content = this.text.slice(this.pos, i);
        this.pos = CELL_CLOSE.lastIndex;
        return content;
      }
      i++;
    }
    return undefined;
  }
}

function elementCss(element: TableElement, attributes: Record<string, string>, issues: string[]): ElementCss {
  if (attributes.style === undefined) return { cell: {} };
  const parsed = parseElementCss(element, attributes.style);
  issues.push(...parsed.issues);
  return parsed.css;
}

function spanOf(name: 'colspan' | 'rowspan', attributes: Record<string, string>, issues: string[]): number {
  if (attributes[name] === undefined) return 1;
  const n = Number(attributes[name]);
  if (Number.isInteger(n) && n >= 1) return n;
  issues.push(`${name}="${attributes[name]}" is not a whole number of 1 or more`);
  return 1;
}

function readCell(scanner: Scanner, tag: Tag, row: LayoutRow, issues: string[]): void {
  const content = scanner.cellContent();
  if (content === undefined) {
    issues.push(`<${tag.name}> is never closed`);
    scanner.pos = scanner.text.length;
    return;
  }
  const trimmed = content.trim();
  row.cells.push({
    markdown: trimmed,
    asBlocks: content.includes('\n') || BLOCK_START.test(trimmed),
    css: elementCss('td', tag.attributes, issues).cell,
    colspan: spanOf('colspan', tag.attributes, issues),
    rowspan: spanOf('rowspan', tag.attributes, issues),
  });
}

function readRow(scanner: Scanner, tag: Tag, pinned: boolean, issues: string[]): LayoutRow {
  const css = elementCss('tr', tag.attributes, issues);
  const row: LayoutRow = { css: css.cell, height: css.height, pinned, cells: [] };
  for (;;) {
    scanner.skipSpace();
    const next = scanner.tag();
    if (!next) {
      issues.push(scanner.atEnd() ? '<tr> is never closed' : `"${scanner.snippet()}" is between cells; text belongs inside <td>`);
      scanner.pos = scanner.text.length;
      return row;
    }
    if (next.name === 'tr' && next.closing) return row;
    if ((next.name === 'td' || next.name === 'th') && !next.closing) readCell(scanner, next, row, issues);
    else issues.push(`<${next.closing ? '/' : ''}${next.name}> is not supported inside a row (use <td> or <th>)`);
  }
}

/** Reads the HTML form `renderHtmlTable` writes. Every problem is reported; nothing is thrown. */
export function parseHtmlTable(source: string): { layout: TableLayout; issues: string[] } {
  const issues: string[] = [];
  const scanner = new Scanner(source.trim(), issues);
  const layout: TableLayout = { css: {}, columns: [], rows: [] };
  const open = scanner.tag();
  if (!open || open.name !== 'table' || open.closing) return { layout, issues: ['a table starts with <table>'] };
  layout.css = elementCss('table', open.attributes, issues).cell;
  let inHead = false;
  let closed = false;
  while (!closed) {
    scanner.skipSpace();
    if (scanner.atEnd()) {
      issues.push('<table> is never closed');
      break;
    }
    const tag = scanner.tag();
    if (!tag) {
      issues.push(`"${scanner.snippet()}" is between rows; text belongs inside <td>`);
      break;
    }
    if (tag.name === 'table' && tag.closing) closed = true;
    else if (tag.name === 'col' && !tag.closing) {
      const css = elementCss('col', tag.attributes, issues);
      layout.columns.push({ css: css.cell, width: css.width });
    } else if (tag.name === 'thead') {
      if (!tag.closing && layout.rows.length > 0) issues.push('<thead> must come before the other rows');
      inHead = !tag.closing;
    } else if (tag.name === 'tbody') {
      continue;
    } else if (tag.name === 'tr' && !tag.closing) layout.rows.push(readRow(scanner, tag, inHead, issues));
    else issues.push(`<${tag.closing ? '/' : ''}${tag.name}> is not supported in a table`);
  }
  if (layout.rows.length === 0) issues.push('a table needs at least one <tr>');
  return { layout, issues };
}
