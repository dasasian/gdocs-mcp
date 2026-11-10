import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLIENT_SECRET_PATH,
  TOKENS_DIR,
  KEYCHAIN_INDEX_PATH,
  KEYCHAIN_SERVICE,
  TOKEN_STORE,
  PROJECT_DEFAULT_ACCOUNT,
} from '../config.js';
import {
  createTokenStore,
  nativeKeyring,
  parseTokenStoreMode,
  type LoadedToken,
  type TokenStore,
  type TokenStoreKind,
  type Tokens,
} from './token-store.js';

export interface ProjectConfig {
  account?: string;
  folder?: string; // default Drive folder (URL or id) for new docs
}

// A project can pin defaults with a `.gdocs-mcp.json` file
// ({ "account": "you@example.com", "folder": "…" }) instead of repeating a full
// .mcp.json entry. We search upward from the working directory (like .git /
// package.json discovery), so it works from the project root or a subdirectory.
export function findProjectConfig(fromDir: string = process.cwd()): ProjectConfig {
  const p = findProjectConfigPath(fromDir);
  if (!p) return {};
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as ProjectConfig;
    return { account: cfg.account, folder: cfg.folder };
  } catch {
    return {}; // ignore a malformed file
  }
}

export function findProjectAccount(fromDir: string = process.cwd()): string | undefined {
  return findProjectConfig(fromDir).account;
}

// Path of an existing `.gdocs-mcp.json` (walking up), if any.
export function findProjectConfigPath(fromDir: string = process.cwd()): string | undefined {
  let dir = fromDir;
  for (;;) {
    const p = path.join(dir, '.gdocs-mcp.json');
    if (existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Write/merge project defaults. Updates an existing `.gdocs-mcp.json` up the tree,
// else creates one in `fromDir` (the project root, i.e. the server's cwd).
export function setProjectConfig(
  patch: ProjectConfig,
  fromDir: string = process.cwd(),
): { path: string; config: ProjectConfig } {
  const existingPath = findProjectConfigPath(fromDir);
  const targetPath = existingPath ?? path.join(fromDir, '.gdocs-mcp.json');
  const current: ProjectConfig = existingPath ? findProjectConfig(fromDir) : {};
  const config: ProjectConfig = { ...current };
  if (patch.account !== undefined) config.account = patch.account;
  if (patch.folder !== undefined) config.folder = patch.folder;
  writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  return { path: targetPath, config };
}

export interface ClientSecret {
  clientId: string;
  clientSecret: string;
}

export async function loadClientSecret(): Promise<ClientSecret> {
  if (!existsSync(CLIENT_SECRET_PATH)) {
    throw new Error(
      `Missing OAuth client at ${CLIENT_SECRET_PATH}. Run \`gdocs-mcp add-account\` setup (see README).`,
    );
  }
  const raw = JSON.parse(await readFile(CLIENT_SECRET_PATH, 'utf8'));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) {
    throw new Error('client_secret.json is missing client_id/client_secret');
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

// Built on first use, not at import (no side effects at import time).
let tokenStore: TokenStore | undefined;
function tokens(): TokenStore {
  tokenStore ??= createTokenStore({
    tokensDir: TOKENS_DIR,
    indexPath: KEYCHAIN_INDEX_PATH,
    mode: parseTokenStoreMode(TOKEN_STORE),
    keyring: nativeKeyring(KEYCHAIN_SERVICE),
    // stderr: stdout is the MCP stdio channel.
    // eslint-disable-next-line no-console
    warn: (m) => console.error(m),
  });
  return tokenStore;
}

export async function listAccounts(): Promise<string[]> {
  return tokens().list();
}

// A newly authorized token (add-account): the OS keychain when available, else
// a 0600 file. Returns which store it went to.
export async function saveToken(email: string, t: Tokens): Promise<TokenStoreKind> {
  return tokens().save(email, t);
}

// `save` on the result writes a refreshed token back to the store it came from.
// A file token found with no keychain copy is moved into the keychain first.
export async function loadToken(email: string): Promise<LoadedToken> {
  return tokens().load(email);
}

// Resolution order: explicit per-call → project `.gdocs-mcp.json` (cwd or a parent)
// → project default env (GDOCS_DEFAULT_ACCOUNT) → the sole account if exactly one
// is authorized. Otherwise the caller must disambiguate.
export async function resolveAccount(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const fromFile = findProjectAccount();
  if (fromFile) return fromFile;
  if (PROJECT_DEFAULT_ACCOUNT) return PROJECT_DEFAULT_ACCOUNT;
  const accounts = await listAccounts();
  if (accounts.length === 1) return accounts[0];
  if (accounts.length === 0) {
    throw new Error('No accounts authorized. Run `gdocs-mcp add-account`.');
  }
  throw new Error(
    `Multiple accounts authorized (${accounts.join(', ')}). Pass an \`account\`, or set GDOCS_DEFAULT_ACCOUNT.`,
  );
}
