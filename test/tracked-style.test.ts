import { describe, it, expect } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { renderMarkdown } from '../src/docs/transformer.js';

// A suggested format change (Docs' "Format: …" suggestion) changes no text, so it
// has no <ins>/<del> to show it. These are the shapes Docs returns for one under
// SUGGESTIONS_INLINE (checked live): the run keeps its current `textStyle`, and
// `suggestedTextStyleChanges` maps each suggestion id to the style it proposes, with
// a `…Suggested` flag for every field it sets. A flagged field the proposed style
// leaves out is one the suggestion clears. Paragraph style is the same, one level up.

const EVERY_TEXT_FIELD: docs_v1.Schema$TextStyleSuggestionState = {
  boldSuggested: true,
  italicSuggested: true,
  underlineSuggested: true,
  strikethroughSuggested: true,
  smallCapsSuggested: true,
  backgroundColorSuggested: true,
  foregroundColorSuggested: true,
  fontSizeSuggested: true,
  weightedFontFamilySuggested: true,
  baselineOffsetSuggested: true,
};

const RED = { color: { rgbColor: { red: 0.7764706, green: 0.15686275, blue: 0.15686275 } } };

type Changes = Record<string, docs_v1.Schema$SuggestedTextStyle>;

function styled(content: string, textStyle: docs_v1.Schema$TextStyle, changes?: Changes): docs_v1.Schema$ParagraphElement {
  return { textRun: { content, textStyle, ...(changes ? { suggestedTextStyleChanges: changes } : {}) } };
}

function doc(elements: docs_v1.Schema$ParagraphElement[], paragraph: Partial<docs_v1.Schema$Paragraph> = {}): docs_v1.Schema$Document {
  return { body: { content: [{ paragraph: { elements, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, ...paragraph } }] } };
}

const colorSuggestion: Changes = {
  'suggest.v5mh7qjnuid0': { textStyle: { foregroundColor: RED }, textStyleSuggestionState: EVERY_TEXT_FIELD },
};

describe('tracked read of a suggested text style change', () => {
  it('marks the run with the suggestion id and the CSS it would set', () => {
    const d = doc([styled('Valladolid\n', {}, colorSuggestion)]);
    expect(renderMarkdown(d, { tracked: true })).toBe(
      '<span data-sug="suggest.v5mh7qjnuid0" data-sug-css="color:#c62828">Valladolid</span>',
    );
  });

  it('leaves the run as it is now outside tracked mode', () => {
    const d = doc([styled('Valladolid\n', {}, colorSuggestion)]);
    expect(renderMarkdown(d)).toBe('Valladolid');
  });

  it('keeps the current style inside the marker, so dropping the marker gives the clean read', () => {
    const d = doc([styled('Tulum\n', { foregroundColor: { color: { rgbColor: { green: 0.5 } } } }, colorSuggestion)]);
    expect(renderMarkdown(d, { tracked: true })).toBe(
      '<span data-sug="suggest.v5mh7qjnuid0" data-sug-css="color:#c62828"><span style="color:#008000">Tulum</span></span>',
    );
  });

  it('shows a field the suggestion clears as its off value', () => {
    // Docs' shape for un-bolding: the field is flagged, and left out of the proposed style.
    const d = doc([styled('Proposal 3\n', { bold: true }, { 'suggest.a2mkwoqgmb5r': { textStyle: {}, textStyleSuggestionState: EVERY_TEXT_FIELD } })]);
    expect(renderMarkdown(d, { tracked: true })).toBe('<span data-sug="suggest.a2mkwoqgmb5r" data-sug-css="font-weight:normal">**Proposal 3**</span>');
  });

  it('shows a cleared color, size or font as inherit (the named style’s value)', () => {
    const d = doc([
      styled('note\n', { foregroundColor: RED, fontSize: { magnitude: 14, unit: 'PT' } }, { s1: { textStyle: {}, textStyleSuggestionState: { foregroundColorSuggested: true, fontSizeSuggested: true } } }),
    ]);
    expect(renderMarkdown(d, { tracked: true })).toBe(
      '<span data-sug="s1" data-sug-css="font-size:inherit; color:inherit"><span style="color:#c62828;font-size:14pt">note</span></span>',
    );
  });

  it('ignores fields the suggestion does not flag', () => {
    const d = doc([styled('word\n', { bold: true }, { s1: { textStyle: { italic: true, bold: false }, textStyleSuggestionState: { italicSuggested: true } } })]);
    expect(renderMarkdown(d, { tracked: true })).toBe('<span data-sug="s1" data-sug-css="font-style:italic">**word**</span>');
  });

  it('keeps both text decorations when only one of them changes', () => {
    const d = doc([styled('word\n', { strikethrough: true }, { s1: { textStyle: { underline: true }, textStyleSuggestionState: { underlineSuggested: true } } })]);
    expect(renderMarkdown(d, { tracked: true })).toBe('<span data-sug="s1" data-sug-css="text-decoration:underline line-through">~~word~~</span>');
  });

  it('still names a suggestion that changes nothing the read shows', () => {
    // A highlight, or a field set to the value it already has: the id must still be findable.
    const d = doc([styled('word\n', { bold: true }, { s1: { textStyle: { bold: true }, textStyleSuggestionState: { boldSuggested: true } } })]);
    expect(renderMarkdown(d, { tracked: true })).toBe('<span data-sug="s1" data-sug-css="">**word**</span>');
  });

  it('marks each of several suggestions on one run, in the order Docs lists them', () => {
    const d = doc([
      styled('word\n', {}, {
        s1: { textStyle: { bold: true }, textStyleSuggestionState: { boldSuggested: true } },
        s2: { textStyle: { foregroundColor: RED }, textStyleSuggestionState: { foregroundColorSuggested: true } },
      }),
    ]);
    expect(renderMarkdown(d, { tracked: true })).toBe(
      '<span data-sug="s2" data-sug-css="color:#c62828"><span data-sug="s1" data-sug-css="font-weight:bold">word</span></span>',
    );
  });

  it('marks a suggested style change inside a table cell', () => {
    const cell = (content: string, changes?: Changes): docs_v1.Schema$TableCell => ({
      content: [{ paragraph: { elements: [styled(content, {}, changes)], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } }],
    });
    const d: docs_v1.Schema$Document = {
      body: { content: [{ table: { rows: 1, columns: 2, tableRows: [{ tableCells: [cell('Thu 21\n'), cell('Valladolid\n', colorSuggestion)] }] } }] },
    };
    expect(renderMarkdown(d, { tracked: true })).toContain('<span data-sug="suggest.v5mh7qjnuid0" data-sug-css="color:#c62828">Valladolid</span>');
    expect(renderMarkdown(d)).not.toContain('data-sug');
  });
});

describe('tracked read of a suggested paragraph style change', () => {
  // Docs' shape: the proposed paragraphStyle is complete, but only the flagged fields are the suggestion.
  const centered = {
    'suggest.mpwylek31qik': {
      paragraphStyle: { namedStyleType: 'NORMAL_TEXT', alignment: 'CENTER', lineSpacing: 115, spaceBelow: { unit: 'PT' } },
      paragraphStyleSuggestionState: { alignmentSuggested: true },
    },
  };

  it('puts the suggestion id and the CSS it would set on the paragraph tag', () => {
    const d = doc([styled('Nights:', { bold: true }), styled(' Playa del Carmen 3.\n', {})], { suggestedParagraphStyleChanges: centered });
    expect(renderMarkdown(d, { tracked: true })).toBe('<p data-sug="suggest.mpwylek31qik" data-sug-css="text-align:center">**Nights:** Playa del Carmen 3.</p>');
    expect(renderMarkdown(d)).toBe('**Nights:** Playa del Carmen 3.');
  });

  it('keeps the paragraph’s own style beside the marker', () => {
    const d = doc([styled('Body\n', {})], { paragraphStyle: { namedStyleType: 'NORMAL_TEXT', spaceBelow: { magnitude: 11.25, unit: 'PT' } }, suggestedParagraphStyleChanges: centered });
    expect(renderMarkdown(d, { tracked: true })).toBe('<p style="margin-bottom:11.25pt" data-sug="suggest.mpwylek31qik" data-sug-css="text-align:center">Body</p>');
  });

  it('marks a heading on its tag', () => {
    const d = doc([styled('Plan\n', {})], { paragraphStyle: { namedStyleType: 'HEADING_2' }, suggestedParagraphStyleChanges: centered });
    expect(renderMarkdown(d, { tracked: true })).toBe('<h2 data-sug="suggest.mpwylek31qik" data-sug-css="text-align:center">Plan</h2>');
  });

  it('marks a list item inside the item', () => {
    const d = doc([styled('one\n', {})], { bullet: { nestingLevel: 0 }, suggestedParagraphStyleChanges: centered });
    expect(renderMarkdown(d, { tracked: true })).toBe('- <p data-sug="suggest.mpwylek31qik" data-sug-css="text-align:center">one</p>');
  });
});
