import http from 'node:http';
import { URL } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import open from 'open';
import { loadClientSecret } from './accounts.js';
import { SCOPES, TOKENS_DIR } from '../config.js';

// Loopback OAuth (Authorization Code + PKCE via the library). Stores the token
// keyed by the account's email, which we read back from the userinfo endpoint.
export async function addAccount(): Promise<string> {
  const { clientId, clientSecret } = await loadClientSecret();

  const { tokens } = await new Promise<{ tokens: Record<string, unknown> }>((resolve, reject) => {
    const httpServer = http.createServer();
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (!address || typeof address === 'string') return reject(new Error('no loopback port'));
      const redirectUri = `http://127.0.0.1:${address.port}`;
      const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
      });

      httpServer.on('request', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', redirectUri);
          const code = url.searchParams.get('code');
          const err = url.searchParams.get('error');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(err ? `Auth error: ${err}` : 'Authorized. You can close this tab.');
          httpServer.close();
          if (err || !code) return reject(new Error(err ?? 'no code'));
          const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
          resolve({ tokens: tokens as Record<string, unknown> });
        } catch (e) {
          reject(e);
        }
      });

      // eslint-disable-next-line no-console
      console.error(`Opening browser for consent...\nIf it does not open, visit:\n${authUrl}\n`);
      void open(authUrl);
    });
    httpServer.on('error', reject);
  });

  // Identify the account email so we can key the token file.
  const idClient = new OAuth2Client({ clientId, clientSecret });
  idClient.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: idClient });
  const me = await oauth2.userinfo.get();
  const email = me.data.email;
  if (!email) throw new Error('could not determine account email');

  await mkdir(TOKENS_DIR, { recursive: true });
  await writeFile(path.join(TOKENS_DIR, `${email}.json`), JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
  return email;
}
