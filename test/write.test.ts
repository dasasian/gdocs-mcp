import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../src/docs/write.js';

describe('parseBlocks', () => {
  it('parses headings with level', () => {
    expect(parseBlocks('# A\n\n### B')).toEqual([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'heading', level: 3, text: 'B' },
    ]);
  });

  it('soft-joins paragraph lines', () => {
    expect(parseBlocks('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', text: 'one two' },
      { type: 'paragraph', text: 'three' },
    ]);
  });

  it('groups a bullet list with nesting', () => {
    const blocks = parseBlocks('- a\n- b\n  - c');
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          { level: 0, text: 'a' },
          { level: 0, text: 'b' },
          { level: 1, text: 'c' },
        ],
      },
    ]);
  });

  it('detects ordered lists', () => {
    const blocks = parseBlocks('1. first\n2. second');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true });
    expect(blocks[0]).toHaveProperty('items.length', 2);
  });

  it('separates a bullet list from a following ordered list', () => {
    const blocks = parseBlocks('- a\n\n1. b');
    expect(blocks.map((b) => (b.type === 'list' ? b.ordered : b.type))).toEqual([false, true]);
  });

  it('keeps inline markup intact for later parsing', () => {
    expect(parseBlocks('A **b** c')).toEqual([{ type: 'paragraph', text: 'A **b** c' }]);
  });

  it('parses a table (consuming the separator row)', () => {
    const blocks = parseBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    expect(blocks).toEqual([
      {
        type: 'table',
        rows: [
          ['A', 'B'],
          ['1', '2'],
          ['3', '4'],
        ],
      },
    ]);
  });

  it('separates a table from surrounding paragraphs', () => {
    const blocks = parseBlocks('before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
  });

  it('unescapes pipes in cells', () => {
    const blocks = parseBlocks('| a \\| b | c |\n|---|---|\n| 1 | 2 |');
    expect(blocks[0]).toMatchObject({ rows: [['a | b', 'c'], ['1', '2']] });
  });
});
