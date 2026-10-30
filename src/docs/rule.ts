import type { docs_v1 } from 'googleapis';
import { hexToRgb, rgbToHex } from './color.js';
import { RULE_BORDER_HEX, RULE_BORDER_WIDTH_PT } from './markdown-spec.js';

const points = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

/** What a horizontal rule is written with. The Docs API refuses a border sent without a padding unit and a dash style, so both are here. */
export const RULE_PARAGRAPH_STYLE: docs_v1.Schema$ParagraphStyle = {
  borderBottom: {
    color: { color: { rgbColor: hexToRgb(RULE_BORDER_HEX) } },
    width: points(RULE_BORDER_WIDTH_PT),
    padding: points(1),
    dashStyle: 'SOLID',
  },
};

export const RULE_PARAGRAPH_FIELDS = ['borderBottom'];

/** True when the bottom border is the one a written rule has. The border is the mark the read finds. */
export function hasRuleBorder(style: docs_v1.Schema$ParagraphStyle | undefined): boolean {
  const border = style?.borderBottom;
  return border?.width?.magnitude === RULE_BORDER_WIDTH_PT && rgbToHex(border.color?.color?.rgbColor ?? undefined) === RULE_BORDER_HEX;
}
