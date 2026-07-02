import { describe, it, expect } from 'vitest';
import { parseDriveId } from '../src/docs/document.js';

describe('parseDriveId', () => {
  it('extracts a folder id from a Drive folder URL', () => {
    expect(parseDriveId('https://drive.google.com/drive/folders/1AbC_dEf-123?usp=sharing')).toBe('1AbC_dEf-123');
  });
  it('extracts a doc id from a Docs URL', () => {
    expect(parseDriveId('https://docs.google.com/document/d/12w2cyDJ_x-Y/edit?tab=t.0#h')).toBe('12w2cyDJ_x-Y');
  });
  it('passes a raw id through', () => {
    expect(parseDriveId('1AbC_dEf-123')).toBe('1AbC_dEf-123');
  });
  it('strips query/hash from a raw id', () => {
    expect(parseDriveId('1AbC_dEf-123?x=1')).toBe('1AbC_dEf-123');
  });
});
