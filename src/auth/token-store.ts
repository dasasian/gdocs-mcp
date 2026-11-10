import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Where each account's OAuth token lives. Two stores:
// - keychain: the OS credential store (macOS Keychain, Windows Credential
//   Manager, Linux Secret Service), one item per account: service = the
//   keychain service name, account = the email.
// - file: `<tokensDir>/<email>.json`, mode 0600 (the original store).
//
// The keychain can't be listed cheaply on every platform, so a small index
// (`keychain-accounts.json`, emails only, never secrets) records which accounts
// live there. An account is in the keychain iff the index names it, so a
// keychain item that never made it into the index (a failed migration) can't
// shadow a file token.

export type TokenStoreKind = 'keychain' | 'file';
// auto: keychain, falling back to files (logged once) when it is unavailable.
export type TokenStoreMode = 'auto' | 'keychain' | 'file';
export type Tokens = Record<string, unknown>;

export interface KeyringBackend {
  get(email: string): Promise<string | null>;
  set(email: string, secret: string): Promise<void>;
  delete(email: string): Promise<void>;
}

export interface TokenStoreOptions {
  tokensDir: string;
  indexPath: string;
  mode: TokenStoreMode;
  keyring: KeyringBackend;
  warn: (message: string) => void;
}

export interface LoadedToken {
  tokens: Tokens;
  store: TokenStoreKind;
  // Persist updated tokens (a refresh) to the store they were loaded from.
  save(tokens: Tokens): Promise<void>;
}

export interface TokenStore {
  list(): Promise<string[]>;
  load(email: string): Promise<LoadedToken>;
  // Store a newly authorized token in the preferred store; returns where it went.
  save(email: string, tokens: Tokens): Promise<TokenStoreKind>;
}

export function parseTokenStoreMode(value: string | undefined): TokenStoreMode {
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  if (value === 'keychain' || value === 'file') return value;
  throw new Error(`GDOCS_TOKEN_STORE must be "keychain", "file" or "auto", not "${value}".`);
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createTokenStore(opts: TokenStoreOptions): TokenStore {
  const { tokensDir, indexPath, mode, keyring } = opts;
  let warned = false;

  const tokenPath = (email: string) => path.join(tokensDir, `${email}.json`);

  // Called whenever the keychain failed. In auto mode we carry on from token
  // files and say so once per process, with the reason but never the token.
  function fallBack(e: unknown): void {
    if (mode === 'keychain') {
      throw new Error(`OS keychain unavailable (${reasonOf(e)}), and GDOCS_TOKEN_STORE=keychain forbids token files.`);
    }
    if (warned) return;
    warned = true;
    opts.warn(
      `gdocs-mcp: could not use the OS keychain (${reasonOf(e)}); keeping OAuth tokens in ${tokensDir} (mode 0600). ` +
        'Set GDOCS_TOKEN_STORE=file to use token files without this notice.',
    );
  }

  async function readIndex(): Promise<string[]> {
    if (!existsSync(indexPath)) return [];
    const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as { accounts?: unknown };
    return Array.isArray(parsed.accounts) ? parsed.accounts.filter((a): a is string => typeof a === 'string') : [];
  }

  async function writeIndex(accounts: string[]): Promise<void> {
    await mkdir(path.dirname(indexPath), { recursive: true });
    const tmp = `${indexPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ accounts: [...new Set(accounts)].sort() }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, indexPath);
  }

  async function indexAdd(email: string): Promise<void> {
    const accounts = await readIndex();
    if (!accounts.includes(email)) await writeIndex([...accounts, email]);
  }

  async function indexRemove(email: string): Promise<void> {
    const accounts = await readIndex();
    if (accounts.includes(email)) await writeIndex(accounts.filter((a) => a !== email));
  }

  async function writeFileToken(email: string, tokens: Tokens): Promise<void> {
    await mkdir(tokensDir, { recursive: true });
    await writeFile(tokenPath(email), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  async function readFileToken(email: string): Promise<Tokens | undefined> {
    const p = tokenPath(email);
    if (!existsSync(p)) return undefined;
    return JSON.parse(await readFile(p, 'utf8')) as Tokens;
  }

  // Copy into the keychain and prove it by reading it back; only then index it
  // and delete the file. Throws, leaving any file alone, if a step fails.
  async function moveToKeychain(email: string, tokens: Tokens): Promise<void> {
    const secret = JSON.stringify(tokens);
    await keyring.set(email, secret);
    if ((await keyring.get(email)) !== secret) {
      await keyring.delete(email).catch(() => undefined); // best effort: unindexed, it can't win anyway
      throw new Error('the keychain read back a different value');
    }
    await indexAdd(email);
    if (existsSync(tokenPath(email))) await unlink(tokenPath(email));
  }

  const loaded = (email: string, tokens: Tokens, store: TokenStoreKind): LoadedToken => ({
    tokens,
    store,
    save: (t) => (store === 'keychain' ? keyring.set(email, JSON.stringify(t)) : writeFileToken(email, t)),
  });

  return {
    async list() {
      const files = existsSync(tokensDir)
        ? (await readdir(tokensDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length))
        : [];
      const indexed = mode === 'file' ? [] : await readIndex();
      return [...new Set([...files, ...indexed])].sort();
    },

    async load(email) {
      const indexed = (await readIndex()).includes(email);
      if (indexed && mode === 'file' && !existsSync(tokenPath(email))) {
        throw new Error(
          `The token for "${email}" is in the OS keychain, which GDOCS_TOKEN_STORE=file turns off. ` +
            'Unset it, or re-run `gdocs-mcp add-account`.',
        );
      }
      if (indexed && mode !== 'file') {
        try {
          const secret = await keyring.get(email);
          if (secret !== null) return loaded(email, JSON.parse(secret) as Tokens, 'keychain');
        } catch (e) {
          fallBack(e);
        }
      }
      const fileTokens = await readFileToken(email);
      if (fileTokens) {
        if (mode === 'file' || indexed) return loaded(email, fileTokens, 'file');
        try {
          await moveToKeychain(email, fileTokens);
          return loaded(email, fileTokens, 'keychain');
        } catch (e) {
          fallBack(e);
          return loaded(email, fileTokens, 'file');
        }
      }
      throw new Error(`No token for account "${email}". Authorize it with \`gdocs-mcp add-account\`.`);
    },

    async save(email, tokens) {
      if (mode !== 'file') {
        try {
          await moveToKeychain(email, tokens);
          return 'keychain';
        } catch (e) {
          fallBack(e);
          await indexRemove(email); // the file written below is now the account's token
        }
      }
      await writeFileToken(email, tokens);
      return 'file';
    },
  };
}

// The real backend: @napi-rs/keyring (prebuilt N-API binaries, keyring-rs
// underneath). Loaded on first use rather than imported, so a platform with no
// prebuilt binary falls back to token files instead of failing to start, and
// nothing touches the keychain at import time. On Linux it is pinned to the
// Secret Service: the library's default silently falls back to the kernel
// keyring, which forgets everything on reboot.
type KeyringModule = typeof import('@napi-rs/keyring');
let keyringModule: KeyringModule | undefined;

export function nativeKeyring(service: string): KeyringBackend {
  const entry = (email: string) => {
    keyringModule ??= createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule;
    return new keyringModule.AsyncEntry(service, email, { linux: { store: 'secret-service' } });
  };
  return {
    get: async (email) => entry(email).getPassword(),
    set: async (email, secret) => entry(email).setPassword(secret),
    delete: async (email) => {
      await entry(email).deleteCredential();
    },
  };
}
