import type { docs_v1 } from 'googleapis';

// Parse a CSS color (hex #rgb / #rrggbb, or rgb(r,g,b)) to a Docs RgbColor (0..1).
export function hexToRgb(input: string): docs_v1.Schema$RgbColor {
  const s = input.trim();
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (rgbMatch) {
    return { red: +rgbMatch[1] / 255, green: +rgbMatch[2] / 255, blue: +rgbMatch[3] / 255 };
  }
  const h = s.replace('#', '');
  const full = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h;
  const n = parseInt(full, 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}
