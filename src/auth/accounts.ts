import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_SECRET_PATH, TOKENS_DIR, PROJECT_DEFAULT_ACCOUNT } from '../config.js';

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

function tokenPath(email: string): string {
  return path.join(TOKENS_DIR, `${email}.json`);
}

export async function listAccounts(): Promise<string[]> {
  if (!existsSync(TOKENS_DIR)) return [];
  const files = await readdir(TOKENS_DIR);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
}

// The one place token files are written — same path and 0600 mode for both the
// initial add-account consent and later silent refreshes.
export async function saveToken(email: string, tokens: unknown): Promise<void> {
  await mkdir(TOKENS_DIR, { recursive: true });
  await writeFile(tokenPath(email), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function loadToken(email: string): Promise<Record<string, unknown>> {
  const p = tokenPath(email);
  if (!existsSync(p)) throw new Error(`No token for account "${email}". Authorize it with \`gdocs-mcp add-account\`.`);
  return JSON.parse(await readFile(p, 'utf8'));
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
