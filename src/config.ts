import path from 'node:path';
import os from 'node:os';

// All persistent state lives under one config dir. Tokens are global (authorize
// each account once); per-project default account comes from an env var.
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'gdocs-mcp');

// Pure: reads the override env var (if set), else the default path. No filesystem
// mutation or I/O — safe to call at import time. (The one-time googledocs-mcp ->
// gdocs-mcp rename migration has run everywhere it applies and was removed; a rare
// un-migrated install just re-runs add-account.)
function resolveConfigDir(): string {
  return process.env.GDOCS_MCP_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

export const CONFIG_DIR = resolveConfigDir();

export const CLIENT_SECRET_PATH = path.join(CONFIG_DIR, 'client_secret.json');
export const TOKENS_DIR = path.join(CONFIG_DIR, 'tokens');

// Per-project default account (set in a project's .mcp.json env).
export const PROJECT_DEFAULT_ACCOUNT = process.env.GDOCS_DEFAULT_ACCOUNT;

// Scopes: documents (content) + drive (comments + open arbitrary docs by id).
// drive.file is insufficient — it can't open docs the app didn't create.
// userinfo.email lets add-account key the stored token by the account's email.
export const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
];
