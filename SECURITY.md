# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/dasasian/gdocs-mcp/security/advisories/new) rather than a public issue. We aim to acknowledge reports within a few days.

## How this server handles your credentials

- **OAuth tokens never leave your machine.** Each user creates their own Google Cloud OAuth client; this project ships no shared client secret and has no backend. Tokens are stored in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service), one item per account under the service `gdocs-mcp`. Where there is none, or with `GDOCS_TOKEN_STORE=file`, they are files under `~/.config/gdocs-mcp/tokens/` with `0600` permissions; the server says on stderr when it falls back. See [docs/setup.md](docs/setup.md#where-tokens-live).
- **Scopes.** The server requests `documents` and `drive` (the full Drive scope is required to open arbitrary docs by id and read/write comments — `drive.file` cannot open docs the app did not create), plus `userinfo.email` to key tokens by account.
- **No telemetry.** The server makes calls only to Google APIs on your behalf.

## Notes for contributors

- Never log token contents or `client_secret.json`.
- Treat any path derived from tool input as untrusted — validate before filesystem use (guard against path traversal).
- Keep `client_secret.json`, `.token.json`, and `tokens/` out of version control (already in `.gitignore`).
