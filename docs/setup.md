# Setup guide

Standing up the Google Cloud OAuth client is the one manual part. It takes ~10 minutes and you only do it once. Each user creates their own client — this keeps your credentials yours and avoids Google app-verification for the restricted Drive scope (unverified personal use is fine under a 100-user lifetime cap).

A single project can serve **multiple accounts** — e.g. a household where two people authorize their own Google accounts against the same app.

## 1. Create the project and enable the APIs

With the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install):

```sh
gcloud auth login
gcloud projects create my-gdocs-mcp           # globally-unique id; pick your own
gcloud config set project my-gdocs-mcp
gcloud services enable docs.googleapis.com drive.googleapis.com
```

Or in the [Cloud Console](https://console.cloud.google.com): create a project, then enable the **Google Docs API** and **Google Drive API** under *APIs & Services → Library*.

## 2. Configure the OAuth consent screen

*APIs & Services → OAuth consent screen*:

- **User type: External.**
- Fill in app name, your support email, and developer email.
- **Add your Google account(s) as Test users.**
- **Publishing status:** set to **In production**. This matters — while in *Testing*, refresh tokens expire after **7 days**, so you'd have to re-authorize weekly. "In production" does **not** require full verification for personal use; users just see an "unverified app" notice they can click through.

## 3. Create the OAuth client

*APIs & Services → Credentials → Create credentials → OAuth client ID*:

- **Application type: Desktop app.**
- Create, then **Download JSON**.
- Save it as `~/.config/googledocs-mcp/client_secret.json` (create the folder first: `mkdir -p ~/.config/googledocs-mcp`).

## 4. Authorize accounts

```sh
gdocs-mcp add-account
```

> Running from source (not `npm install -g`)? Run `npm link` once after building — then `gdocs-mcp` works everywhere, exactly as below. (Or, without linking, replace `gdocs-mcp` with `node /abs/path/to/gdocs-mcp/dist/index.js` in the commands and in `.mcp.json`.)

This opens a browser for consent (you'll see the "unverified app" notice — choose *Advanced → continue*). The token is stored under `~/.config/googledocs-mcp/tokens/<email>.json`. Repeat for each account.

Check what's authorized:

```sh
gdocs-mcp list-accounts
```

## 5. Register the server and pick a default account

Register it **once for all projects** (user scope):

```sh
claude mcp add gdocs -s user -e GDOCS_DEFAULT_ACCOUNT=you@example.com -- gdocs-mcp
```

Or per project, in that project's `.mcp.json`:

```jsonc
{ "mcpServers": { "gdocs": {
    "command": "gdocs-mcp",
    "env": { "GDOCS_DEFAULT_ACCOUNT": "you@example.com" }
} } }
```

### Overriding the account per project

If you registered at user scope but one project needs a different account, drop a
`.gdocs-mcp.json` in that project (no need to repeat the whole `.mcp.json`):

```json
{ "account": "work@company.com" }
```

Account resolution, highest priority first:

1. an `account` argument on a tool call (one-off)
2. `.gdocs-mcp.json` in the working directory or a parent
3. `GDOCS_DEFAULT_ACCOUNT` (env, from `.mcp.json`)
4. the sole authorized account, if only one

## Applying changes

The server is a long-running process, but it reads your **data** (tokens, `.gdocs-mcp.json`) from disk on every call. So most changes apply instantly — you only restart for **new server code**.

| Change | Restart the MCP client? |
|---|---|
| Default account or folder (`set_project_default`, or editing `.gdocs-mcp.json`) | No — next tool call uses it |
| Newly authorized account (`gdocs-mcp add-account`) | No — the token store is read live |
| Upgrading the server (`npm update -g @dasasian/gdocs-mcp`) | **Yes** |
| From source: `git pull` → `npm run build` | **Yes** (and rebuild — the server runs `dist/`, not the source) |

In short: day to day you never restart; only when you deliberately upgrade the server.

## Troubleshooting

- **`invalid_grant` / token expired after a week** — your consent screen is still in *Testing*. Set it to *In production* (step 2) and re-run `add-account`.
- **`File not found` opening a doc by URL** — that doc isn't accessible to the active account. Pass a different `account`, or set the right `GDOCS_DEFAULT_ACCOUNT`.
- **`Google Drive API has not been used…`** — enable `drive.googleapis.com` (step 1).
