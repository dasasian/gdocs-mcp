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

> Running from source (not `npm install -g`)? Replace `gdocs-mcp` with `node /abs/path/to/gdocs-mcp/dist/index.js` in the commands below and in `.mcp.json`.

This opens a browser for consent (you'll see the "unverified app" notice — choose *Advanced → continue*). The token is stored under `~/.config/googledocs-mcp/tokens/<email>.json`. Repeat for each account.

Check what's authorized:

```sh
gdocs-mcp list-accounts
```

## 5. Point a project at an account

In the project's `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "gdocs": {
      "command": "gdocs-mcp",
      "env": { "GDOCS_DEFAULT_ACCOUNT": "you@example.com" }
    }
  }
}
```

## Troubleshooting

- **`invalid_grant` / token expired after a week** — your consent screen is still in *Testing*. Set it to *In production* (step 2) and re-run `add-account`.
- **`File not found` opening a doc by URL** — that doc isn't accessible to the active account. Pass a different `account`, or set the right `GDOCS_DEFAULT_ACCOUNT`.
- **`Google Drive API has not been used…`** — enable `drive.googleapis.com` (step 1).
