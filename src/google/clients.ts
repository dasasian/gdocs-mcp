import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { google, type docs_v1, type drive_v3 } from 'googleapis';
import { loadClientSecret, loadToken, resolveAccount } from '../auth/accounts.js';
import { TOKENS_DIR } from '../config.js';

export interface GoogleClients {
  account: string;
  auth: OAuth2Client;
  docs: docs_v1.Docs;
  drive: drive_v3.Drive;
}

// Build authenticated Docs + Drive clients for the resolved account. Refreshed
// tokens are persisted back so we don't force re-consent.
export async function clientsForAccount(explicitAccount?: string): Promise<GoogleClients> {
  const account = await resolveAccount(explicitAccount);
  const { clientId, clientSecret } = await loadClientSecret();
  const tokens = await loadToken(account);

  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials(tokens);
  auth.on('tokens', async (t) => {
    const merged = { ...tokens, ...t };
    await mkdir(TOKENS_DIR, { recursive: true });
    await writeFile(path.join(TOKENS_DIR, `${account}.json`), JSON.stringify(merged, null, 2), {
      mode: 0o600,
    });
  });

  return {
    account,
    auth,
    docs: google.docs({ version: 'v1', auth }),
    drive: google.drive({ version: 'v3', auth }),
  };
}
