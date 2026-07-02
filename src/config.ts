import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// All persistent state lives under one config dir. Tokens are global (authorize
// each account once); per-project default account comes from an env var.
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'gdocs-mcp');
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.config', 'googledocs-mcp');

// The config dir was renamed googledocs-mcp -> gdocs-mcp to match the package/repo.
// One-time seamless migration: if only the legacy dir exists, move it (they're
// siblings under ~/.config, so the rename is atomic) so existing tokens/secret
// keep working. Falls back to the legacy dir if the move can't be done.
function resolveConfigDir(): string {
  if (process.env.GDOCS_MCP_CONFIG_DIR) return process.env.GDOCS_MCP_CONFIG_DIR;
  if (!fs.existsSync(DEFAULT_CONFIG_DIR) && fs.existsSync(LEGACY_CONFIG_DIR)) {
    try {
      fs.renameSync(LEGACY_CONFIG_DIR, DEFAULT_CONFIG_DIR);
      console.error(`[gdocs-mcp] migrated config dir ${LEGACY_CONFIG_DIR} -> ${DEFAULT_CONFIG_DIR}`);
    } catch {
      return LEGACY_CONFIG_DIR;
    }
  }
  return DEFAULT_CONFIG_DIR;
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
