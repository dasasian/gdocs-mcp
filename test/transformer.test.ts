import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { project, renderMarkdown } from '../src/docs/transformer.js';

// Minimal doc builders.
function para(elements: docs_v1.Schema$ParagraphElement[], style?: docs_v1.Schema$ParagraphStyle, bullet?: docs_v1.Schema$Bullet): docs_v1.Schema$StructuralElement {
  return { paragraph: { elements, paragraphStyle: style, bullet } };
}
function run(content: string, start: number, textStyle?: docs_v1.Schema$TextStyle, extra?: Partial<docs_v1.Schema$ParagraphElement>): docs_v1.Schema$ParagraphElement {
  return { startIndex: start, endIndex: start + content.length, textRun: { content, textStyle }, ...extra };
}
function doc(content: docs_v1.Schema$StructuralElement[]): docs_v1.Schema$Document {
  return { body: { content } };
}

describe('project', () => {
  it('maps each plain char to its Docs index', () => {
    const d = doc([para([run('abc', 5)])]);
    const p = project(d);
    expect(p.text).toBe('abc');
    expect(p.map).toEqual([5, 6, 7]);
  });
  it('concatenates runs and preserves per-run indices (gaps ok)', () => {
    const d = doc([para([run('ab', 5), run('cd', 10)])]);
    const p = project(d);
    expect(p.text).toBe('abcd');
    expect(p.map).toEqual([5, 6, 10, 11]);
  });
});

describe('renderMarkdown', () => {
  it('renders headings', () => {
    const d = doc([para([run('Title\n', 1)], { namedStyleType: 'HEADING_1' })]);
    expect(renderMarkdown(d)).toBe('# Title');
  });
  it('renders inline emphasis', () => {
    const d = doc([para([run('hi ', 1), run('bold', 4, { bold: true }), run(' ', 8), run('it', 9, { italic: true })])]);
    expect(renderMarkdown(d)).toBe('hi **bold** *it*');
  });
  it('renders links', () => {
    const d = doc([para([run('see ', 1), run('here', 5, { link: { url: 'https://x.com' } })])]);
    expect(renderMarkdown(d)).toBe('see [here](https://x.com)');
  });
  it('renders bullet lists', () => {
    const d = doc([
      para([run('one\n', 1)], undefined, { nestingLevel: 0 }),
      para([run('two\n', 5)], undefined, { nestingLevel: 1 }),
    ]);
    expect(renderMarkdown(d)).toBe('- one\n  - two');
  });
  it('renders non-default alignment as html', () => {
    const d = doc([para([run('centered\n', 1)], { alignment: 'CENTER' })]);
    expect(renderMarkdown(d)).toBe('<p style="text-align:center">centered</p>');
  });
  it('wraps suggestions in <ins>/<del> in tracked mode', () => {
    const d = doc([
      para([
        run('new', 1, undefined, { textRun: { content: 'new', suggestedInsertionIds: ['s1'] } }),
        run('old', 4, undefined, { textRun: { content: 'old', suggestedDeletionIds: ['s1'] } }),
      ]),
    ]);
    expect(renderMarkdown(d, { tracked: true })).toBe('<ins data-sug="s1">new</ins><del data-sug="s1">old</del>');
  });
});
