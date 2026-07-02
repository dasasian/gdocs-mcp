import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectAccount, findProjectConfig, setProjectConfig } from '../src/auth/accounts.js';

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

describe('setProjectConfig', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'gdocs-set-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a config file with the given fields', () => {
    const { path: p, config } = setProjectConfig({ account: 'a@x.com' }, root);
    expect(config).toEqual({ account: 'a@x.com' });
    expect(findProjectConfig(root)).toEqual({ account: 'a@x.com', folder: undefined });
    expect(p).toBe(path.join(root, '.gdocs-mcp.json'));
  });

  it('merges without clobbering the other field', () => {
    setProjectConfig({ account: 'a@x.com' }, root);
    setProjectConfig({ folder: 'FID' }, root);
    expect(findProjectConfig(root)).toMatchObject({ account: 'a@x.com', folder: 'FID' });
  });
});
