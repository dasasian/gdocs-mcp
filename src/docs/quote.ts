import type { docs_v1 } from 'googleapis';
import { hexToRgb, rgbToHex } from './color.js';
import { QUOTE_BORDER_HEX, QUOTE_BORDER_WIDTH_PT, QUOTE_INDENT_PT } from './markdown-spec.js';

const points = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

/** What a quote is written with. The Docs API refuses a border sent without a padding unit and a dash style, so both are here. */
export const QUOTE_PARAGRAPH_STYLE: docs_v1.Schema$ParagraphStyle = {
  indentStart: points(QUOTE_INDENT_PT),
  indentFirstLine: points(QUOTE_INDENT_PT),
  borderLeft: {
    color: { color: { rgbColor: hexToRgb(QUOTE_BORDER_HEX) } },
    width: points(QUOTE_BORDER_WIDTH_PT),
    padding: points(0),
    dashStyle: 'SOLID',
  },
};

export const QUOTE_PARAGRAPH_FIELDS = ['indentStart', 'indentFirstLine', 'borderLeft'];

/** True when the left border is the one a quote is written with. The border is the mark the read finds; the indent is not checked. */
export function hasQuoteBorder(style: docs_v1.Schema$ParagraphStyle | undefined): boolean {
  const border = style?.borderLeft;
  return border?.width?.magnitude === QUOTE_BORDER_WIDTH_PT && rgbToHex(border.color?.color?.rgbColor ?? undefined) === QUOTE_BORDER_HEX;
}
