import { describe, it, expect } from 'vitest';
import { hexToRgb } from '../src/docs/color.js';

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
