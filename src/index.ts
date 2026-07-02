#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { addAccount } from './auth/oauth.js';
import { listAccounts } from './auth/accounts.js';

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === 'add-account') {
    // Interactive browser consent — a CLI setup step, not an MCP tool.
    const email = await addAccount();
    console.error(`Authorized ${email}`);
    return;
  }

  if (cmd === 'list-accounts') {
    console.error((await listAccounts()).join('\n') || '(none)');
    return;
  }

  // Default: run the MCP server over stdio.
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
