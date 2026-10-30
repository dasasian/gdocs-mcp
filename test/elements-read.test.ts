import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import { renderMarkdown, renderDatalists } from '../src/docs/transformer.js';
import { markdownToRequests } from '../src/docs/write.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): docs_v1.Schema$Document => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8')) as docs_v1.Schema$Document;

const elementsDoc = fixture('elements-doc.json');
const importedDoc = fixture('imported-elements-doc.json');
const ruleDoc = fixture('rule-doc.json');

const PERSON = '<a class="chip" href="mailto:damith@dasasian.com">Damith Chandrasekara</a>';
const DATE = '<time datetime="2026-11-15">Nov 15, 2026</time>';
const LINK = '<a class="chip" href="https://docs.google.com/document/d/16wB_36oR5g3qV7X2qGCjPL-bmx01EycDDCMTJLNy8Uw/edit">probe58 elements (trash me)</a>';
const DROPDOWN = '<input class="chip" list="kix.pzpzmipgftxw" value="Draft">';
const DATALIST = '<datalist id="kix.pzpzmipgftxw" title="Status"><option>Draft</option><option>Final</option></datalist>';
const LINE = `O[^1]wner: ${PERSON}, due ${DATE}. See ${LINK}. Status: ${DROPDOWN}end`;

describe('the read shows every element a paragraph holds (#58)', () => {
  it('spells a footnote, a person, a date, a Drive link chip and a dropdown, the notes at the end', () => {
    expect(renderMarkdown(elementsDoc)).toBe(`${LINE}\n\n[^1]:`);
  });

  it('writes each dropdown list once, by Google id and title', () => {
    expect(renderDatalists(elementsDoc)).toBe(DATALIST);
  });

  it('spells an equation and a column break, which the API gives no text for', () => {
    const read = renderMarkdown(importedDoc);
    expect(read).toContain('<span class="equation" title="Google\'s API does not expose this equation; edit it in Google Docs"></span>');
    expect(read).toContain('Before column<span style="break-after:column"></span>After column');
  });

  it('spells a horizontal rule as --- on a line of its own', () => {
    expect(renderMarkdown(ruleDoc)).toBe('Above rule\n\n---\n\nBelow rule');
  });

  it('reads an empty paragraph with the rule border as ---', () => {
    const doc: docs_v1.Schema$Document = {
      body: { content: [{ paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }], paragraphStyle: { borderBottom: { width: { magnitude: 1, unit: 'PT' }, color: { color: { rgbColor: { red: 0.8, green: 0.8, blue: 0.8 } } } } } } }] },
    };
    expect(renderMarkdown(doc)).toBe('---');
  });

  it('reads a page-number field as an empty titled span', () => {
    const doc: docs_v1.Schema$Document = { body: { content: [{ paragraph: { elements: [{ startIndex: 1, endIndex: 2, autoText: { type: 'PAGE_NUMBER' } }, { startIndex: 2, endIndex: 3, textRun: { content: '\n' } }] } }] } };
    expect(renderMarkdown(doc)).toBe('<span class="page-number" title="Docs fills in the page number on each page"></span>');
  });

  it('wraps a suggested element in <ins> in a tracked read', () => {
    const doc = JSON.parse(JSON.stringify(elementsDoc)) as docs_v1.Schema$Document;
    const person = doc.tabs![0].documentTab!.body!.content![1].paragraph!.elements!.find((e) => e.person)!;
    person.person!.suggestedInsertionIds = ['suggest.p1'];
    expect(renderMarkdown(doc, { tracked: true })).toContain(`<ins data-sug="suggest.p1">${PERSON}</ins>`);
  });

  it('keeps text that looks like an element as text', () => {
    const doc: docs_v1.Schema$Document = { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'a [^abc] class and <time>\n' } }] } }] } };
    const read = renderMarkdown(doc);
    expect(read).toBe('a \\[^abc] class and \\<time>');
    expect(markdownToRequests(read, 1).text).toBe('a [^abc] class and <time>\n');
  });

  it('puts a dropdown in a table cell on the read, escaping nothing it needs', () => {
    const doc = JSON.parse(JSON.stringify(elementsDoc)) as docs_v1.Schema$Document;
    const dropdown = doc.tabs![0].documentTab!.body!.content![1].paragraph!.elements!.find((e) => (e as { dropdown?: unknown }).dropdown)!;
    const cell = (content: docs_v1.Schema$ParagraphElement[]) => ({ content: [{ paragraph: { elements: [...content, { textRun: { content: '\n' } }] } }], tableCellStyle: { rowSpan: 1, columnSpan: 1 } });
    doc.tabs![0].documentTab!.body!.content = [{ table: { rows: 2, columns: 1, tableRows: [{ tableCells: [cell([{ textRun: { content: 'Status' } }])] }, { tableCells: [cell([dropdown])] }] } }];
    expect(renderMarkdown(doc)).toBe(`| Status |\n| --- |\n| ${DROPDOWN} |`);
  });
});
