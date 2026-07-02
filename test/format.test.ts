import { describe, it, expect } from 'vitest';
import { hexToRgb, buildTextStyle } from '../src/docs/format.js';

describe('hexToRgb', () => {
  it('parses black and white', () => {
    expect(hexToRgb('#000000')).toEqual({ red: 0, green: 0, blue: 0 });
    expect(hexToRgb('#ffffff')).toEqual({ red: 1, green: 1, blue: 1 });
  });
  it('parses a mid color', () => {
    const c = hexToRgb('#1a73e8');
    expect(c.red).toBeCloseTo(0x1a / 255);
    expect(c.green).toBeCloseTo(0x73 / 255);
    expect(c.blue).toBeCloseTo(0xe8 / 255);
  });
  it('expands 3-digit hex', () => {
    expect(hexToRgb('#fff')).toEqual({ red: 1, green: 1, blue: 1 });
  });
});

describe('buildTextStyle', () => {
  it('emits only the requested fields', () => {
    const { textStyle, fields } = buildTextStyle({ bold: true, color: '#ff0000' });
    expect(fields.sort()).toEqual(['bold', 'foregroundColor']);
    expect(textStyle.bold).toBe(true);
    expect(textStyle.foregroundColor?.color?.rgbColor).toEqual({ red: 1, green: 0, blue: 0 });
  });
  it('maps fontSize and fontFamily', () => {
    const { textStyle, fields } = buildTextStyle({ fontSize: 14, fontFamily: 'Georgia' });
    expect(fields.sort()).toEqual(['fontSize', 'weightedFontFamily']);
    expect(textStyle.fontSize).toEqual({ magnitude: 14, unit: 'PT' });
    expect(textStyle.weightedFontFamily?.fontFamily).toBe('Georgia');
  });
  it('supports unsetting (bold:false)', () => {
    const { textStyle, fields } = buildTextStyle({ bold: false });
    expect(fields).toEqual(['bold']);
    expect(textStyle.bold).toBe(false);
  });
  it('is empty for no styles', () => {
    expect(buildTextStyle({}).fields).toEqual([]);
  });
});
