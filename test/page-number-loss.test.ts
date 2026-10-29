import { describe, expect, it } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { confirmLossToken, lossDetails, lossSummary, measureLoss } from '../src/docs/loss.js';

function paragraphOf(...elements: docs_v1.Schema$ParagraphElement[]): docs_v1.Schema$StructuralElement {
  return { paragraph: { elements: [...elements, { textRun: { content: '\n' } }] } };
}

const text = (content: string): docs_v1.Schema$ParagraphElement => ({ textRun: { content } });
const field = (type: string): docs_v1.Schema$ParagraphElement => ({ autoText: { type } });

function docWith(parts: {
  body?: docs_v1.Schema$StructuralElement[];
  footer?: docs_v1.Schema$StructuralElement[];
  secondTab?: docs_v1.Schema$StructuralElement[];
}): docs_v1.Schema$Document {
  return {
    revisionId: 'rev',
    tabs: [
      { tabProperties: { tabId: 't.a' }, documentTab: { body: { content: parts.body ?? [paragraphOf(text('Body'))] }, footers: { 'kix.f': { content: parts.footer ?? [] } } } },
      { tabProperties: { tabId: 't.b' }, documentTab: { body: { content: parts.secondTab ?? [paragraphOf(text('Other'))] } } },
    ],
  };
}

describe('page-number fields are in the loss summary (#63)', () => {
  it('counts a page number and a page count in the body', () => {
    const doc = docWith({ body: [paragraphOf(text('Page '), field('PAGE_NUMBER'), text(' of '), field('PAGE_COUNT'))] });
    expect(measureLoss(doc, 't.a', 0).pageNumberFields).toBe(2);
  });

  it('names the count in the summary and in the confirmLoss string', () => {
    const doc = docWith({ body: [paragraphOf(text('Page '), field('PAGE_NUMBER'))] });
    const loss = measureLoss(doc, 't.a', 0);
    expect(lossSummary(loss)).toBe('1 paragraph, 1 page-number field');
    expect(confirmLossToken(loss, 'rev')).toBe('1 paragraph, 1 page-number field [revision rev]');
    expect(lossDetails(loss, false).join(' ')).toContain('cannot create');
  });

  it('counts a field inside a table cell', () => {
    const table: docs_v1.Schema$StructuralElement = { table: { tableRows: [{ tableCells: [{ content: [paragraphOf(field('PAGE_NUMBER'))] }] }] } };
    expect(measureLoss(docWith({ body: [table] }), 't.a', 0).pageNumberFields).toBe(1);
  });

  it('does not count any other auto text', () => {
    const doc = docWith({ body: [paragraphOf(field('TYPE_UNSPECIFIED'), field('SOMETHING_NEW'))] });
    expect(measureLoss(doc, 't.a', 0).pageNumberFields).toBe(0);
  });

  it('a body replace does not count the footer, because the replace leaves it alone', () => {
    const doc = docWith({ footer: [paragraphOf(field('PAGE_NUMBER'))] });
    expect(measureLoss(doc, 't.a', 0).pageNumberFields).toBe(0);
  });

  it('a footer write counts the footer and not the body', () => {
    const doc = docWith({ body: [paragraphOf(field('PAGE_COUNT'))], footer: [paragraphOf(field('PAGE_NUMBER'))] });
    expect(measureLoss(doc, 't.a', 0, 'kix.f').pageNumberFields).toBe(1);
  });

  it('a tab replace counts that tab and not the other', () => {
    const doc = docWith({ body: [paragraphOf(field('PAGE_NUMBER'))], secondTab: [paragraphOf(field('PAGE_NUMBER'), field('PAGE_COUNT'))] });
    expect(measureLoss(doc, 't.a', 0).pageNumberFields).toBe(1);
    expect(measureLoss(doc, 't.b', 0).pageNumberFields).toBe(2);
  });
});
