import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTokenStore,
  parseTokenStoreMode,
  type KeyringBackend,
  type TokenStoreMode,
} from '../src/auth/token-store.js';

const SECRET = '1//refresh-SECRET-do-not-print';
const tok = (extra: Record<string, unknown> = {}) => ({ refresh_token: SECRET, access_token: 'ya29.x', ...extra });

// In-memory stand-in for the OS keychain. `broken` makes every call throw, the
// way a Linux box with no Secret Service (or a locked keychain) does.
class FakeKeyring implements KeyringBackend {
  items = new Map<string, string>();
  calls = 0;
  broken = false;
  failSet = false;
  corruptOnSet = false;
  private check() {
    this.calls++;
    if (this.broken) throw new Error('Platform secure storage failure: no Secret Service');
  }
  async get(email: string) {
    this.check();
    return this.items.get(email) ?? null;
  }
  async set(email: string, secret: string) {
    this.check();
    if (this.failSet) throw new Error('write refused');
    this.items.set(email, this.corruptOnSet ? secret.slice(0, 10) : secret);
  }
  async delete(email: string) {
    this.check();
    this.items.delete(email);
  }
}

describe('token store', () => {
  let dir: string;
  let tokensDir: string;
  let indexPath: string;
  let keyring: FakeKeyring;
  let warnings: string[];

  const store = (mode: TokenStoreMode = 'auto') =>
    createTokenStore({ tokensDir, indexPath, mode, keyring, warn: (m) => warnings.push(m) });
  const tokenFile = (email: string) => path.join(tokensDir, `${email}.json`);
  const writeTokenFile = (email: string, t: unknown) => {
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(tokenFile(email), JSON.stringify(t), { mode: 0o600 });
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gdocs-tokens-'));
    tokensDir = path.join(dir, 'tokens');
    indexPath = path.join(dir, 'keychain-accounts.json');
    keyring = new FakeKeyring();
    warnings = [];
  });
  afterEach(() => {
    // No message may ever carry token contents.
    for (const w of warnings) expect(w).not.toContain(SECRET);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new account to the keychain and reads it back', async () => {
    const s = store();
    expect(await s.save('a@x.com', tok())).toBe('keychain');
    expect(existsSync(tokenFile('a@x.com'))).toBe(false);
    expect(JSON.parse(readFileSync(indexPath, 'utf8'))).toEqual({ accounts: ['a@x.com'] });
    // The index holds emails only, never secrets.
    expect(readFileSync(indexPath, 'utf8')).not.toContain(SECRET);
    const loaded = await s.load('a@x.com');
    expect(loaded.store).toBe('keychain');
    expect(loaded.tokens).toEqual(tok());
    expect(warnings).toEqual([]);
  });

  it('falls back to the file store when the keychain throws, and says so once', async () => {
    keyring.broken = true;
    const s = store();
    expect(await s.save('a@x.com', tok())).toBe('file');
    expect(await s.save('b@x.com', tok())).toBe('file');
    expect(statSync(tokenFile('a@x.com')).mode & 0o777).toBe(0o600);
    const loaded = await s.load('a@x.com');
    expect(loaded.store).toBe('file');
    expect(loaded.tokens).toEqual(tok());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/keychain/i);
    expect(warnings[0]).toContain(tokensDir);
  });

  it('GDOCS_TOKEN_STORE=keychain refuses to fall back', async () => {
    keyring.broken = true;
    await expect(store('keychain').save('a@x.com', tok())).rejects.toThrow(/keychain/i);
    expect(existsSync(tokenFile('a@x.com'))).toBe(false);
  });

  it('GDOCS_TOKEN_STORE=file never touches the keychain', async () => {
    writeTokenFile('old@x.com', tok());
    const s = store('file');
    expect(await s.save('a@x.com', tok())).toBe('file');
    expect((await s.load('old@x.com')).store).toBe('file');
    expect(existsSync(tokenFile('old@x.com'))).toBe(true);
    expect(keyring.calls).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('migrates a file token into the keychain, then deletes the file', async () => {
    writeTokenFile('a@x.com', tok());
    const loaded = await store().load('a@x.com');
    expect(loaded.store).toBe('keychain');
    expect(loaded.tokens).toEqual(tok());
    expect(JSON.parse(keyring.items.get('a@x.com')!)).toEqual(tok());
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).accounts).toContain('a@x.com');
    expect(existsSync(tokenFile('a@x.com'))).toBe(false);
  });

  it('keeps the file when the keychain write fails', async () => {
    writeTokenFile('a@x.com', tok());
    keyring.failSet = true;
    const loaded = await store().load('a@x.com');
    expect(loaded.store).toBe('file');
    expect(loaded.tokens).toEqual(tok());
    expect(existsSync(tokenFile('a@x.com'))).toBe(true);
    expect(existsSync(indexPath)).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('keeps the file when the keychain reads back something else', async () => {
    writeTokenFile('a@x.com', tok());
    keyring.corruptOnSet = true;
    const s = store();
    expect((await s.load('a@x.com')).store).toBe('file');
    expect(existsSync(tokenFile('a@x.com'))).toBe(true);
    // The bad copy is removed and never wins over the file.
    expect(keyring.items.has('a@x.com')).toBe(false);
    keyring.corruptOnSet = false;
    keyring.failSet = true;
    const again = await s.load('a@x.com');
    expect(again.tokens).toEqual(tok());
  });

  it('keeps the file when the keychain is unavailable', async () => {
    writeTokenFile('a@x.com', tok());
    keyring.broken = true;
    const loaded = await store().load('a@x.com');
    expect(loaded.store).toBe('file');
    expect(existsSync(tokenFile('a@x.com'))).toBe(true);
  });

  it('a refresh writes back to the keychain when the token came from there', async () => {
    const s = store();
    await s.save('a@x.com', tok());
    const loaded = await s.load('a@x.com');
    await loaded.save({ ...loaded.tokens, access_token: 'ya29.new' });
    expect(JSON.parse(keyring.items.get('a@x.com')!).access_token).toBe('ya29.new');
    expect(existsSync(tokenFile('a@x.com'))).toBe(false);
  });

  it('a refresh writes back to the file when the token came from there', async () => {
    writeTokenFile('a@x.com', tok());
    keyring.failSet = true; // migration fails, so the token stays in the file
    const s = store();
    const loaded = await s.load('a@x.com');
    expect(loaded.store).toBe('file');
    keyring.failSet = false; // even if the keychain recovers, the refresh goes where the token came from
    await loaded.save({ ...loaded.tokens, access_token: 'ya29.new' });
    expect(JSON.parse(readFileSync(tokenFile('a@x.com'), 'utf8')).access_token).toBe('ya29.new');
    expect(statSync(tokenFile('a@x.com')).mode & 0o777).toBe(0o600);
    expect(keyring.items.has('a@x.com')).toBe(false);
  });

  it('lists accounts from both stores, once each', async () => {
    const s = store();
    await s.save('k@x.com', tok());
    writeTokenFile('f@x.com', tok());
    writeTokenFile('k@x.com', tok()); // a stray file for a keychain account
    expect(await s.list()).toEqual(['f@x.com', 'k@x.com']);
    expect(await store('file').list()).toEqual(['f@x.com', 'k@x.com']);
  });

  it('re-authorizing a file account moves it to the keychain', async () => {
    writeTokenFile('a@x.com', tok({ access_token: 'old' }));
    const s = store();
    expect(await s.save('a@x.com', tok())).toBe('keychain');
    expect(existsSync(tokenFile('a@x.com'))).toBe(false);
    expect((await s.load('a@x.com')).tokens).toEqual(tok());
  });

  it('GDOCS_TOKEN_STORE=file says where a keychain account went', async () => {
    await store().save('a@x.com', tok());
    await expect(store('file').load('a@x.com')).rejects.toThrow(/in the OS keychain/);
    expect(keyring.calls).toBe(2); // the save's write and read-back only
  });

  it('rejects an unknown GDOCS_TOKEN_STORE', () => {
    expect(parseTokenStoreMode(undefined)).toBe('auto');
    expect(parseTokenStoreMode('file')).toBe('file');
    expect(() => parseTokenStoreMode('vault')).toThrow(/GDOCS_TOKEN_STORE/);
  });

  it('names add-account when there is no token anywhere, without printing secrets', async () => {
    await expect(store().load('nobody@x.com')).rejects.toThrow(/add-account/);
  });
});
