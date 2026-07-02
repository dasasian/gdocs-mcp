import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_SECRET_PATH, TOKENS_DIR, PROJECT_DEFAULT_ACCOUNT } from '../config.js';

// A project can pin its default account with a `.gdocs-mcp.json` file
// ({ "account": "you@example.com" }) instead of repeating a full .mcp.json entry.
// We search upward from the working directory (like .git / package.json discovery),
// so it works whether the server is launched at the project root or a subdirectory.
export function findProjectAccount(fromDir: string = process.cwd()): string | undefined {
  let dir = fromDir;
  for (;;) {
    const p = path.join(dir, '.gdocs-mcp.json');
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(readFileSync(p, 'utf8')) as { account?: string };
        if (cfg.account) return cfg.account;
      } catch {
        // ignore a malformed file and keep looking / fall through
      }
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
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
