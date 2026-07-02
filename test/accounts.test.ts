import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectAccount } from '../src/auth/accounts.js';

describe('findProjectAccount', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'gdocs-cfg-'));
    mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the account in the same directory', () => {
    writeFileSync(path.join(root, '.gdocs-mcp.json'), JSON.stringify({ account: 'a@x.com' }));
    expect(findProjectAccount(root)).toBe('a@x.com');
  });

  it('walks up from a subdirectory', () => {
    writeFileSync(path.join(root, '.gdocs-mcp.json'), JSON.stringify({ account: 'up@x.com' }));
    expect(findProjectAccount(path.join(root, 'sub', 'deep'))).toBe('up@x.com');
  });

  it('returns undefined when no config exists', () => {
    expect(findProjectAccount(path.join(root, 'sub'))).toBeUndefined();
  });

  it('ignores a malformed config file', () => {
    writeFileSync(path.join(root, '.gdocs-mcp.json'), 'not json');
    expect(findProjectAccount(root)).toBeUndefined();
  });

  it('ignores a config without an account field', () => {
    writeFileSync(path.join(root, '.gdocs-mcp.json'), JSON.stringify({ other: true }));
    expect(findProjectAccount(root)).toBeUndefined();
  });
});
