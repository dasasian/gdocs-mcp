import path from 'node:path';
import os from 'node:os';

// All persistent state lives under one config dir. Tokens are global (authorize
// each account once); per-project default account comes from an env var.
export const CONFIG_DIR =
  process.env.GDOCS_MCP_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'googledocs-mcp');

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
