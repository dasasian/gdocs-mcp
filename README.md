# @dasasian/gdocs-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (like Claude Code) treat a **Google Doc like a local file** — read it, edit it by content, review and resolve **suggestions**, manage **comments**, and work across **tabs** and **multiple Google accounts**.

> **Status:** early / alpha. The full tool surface is implemented and validated against the live API; a few block-rendering features are still in progress (see [Roadmap](#roadmap)).

## Why this exists

Most Google Docs MCP servers treat a doc as flat text. This one fills the gap nobody else does:

- **Suggestions as diffs you can act on.** `list_suggestions` shows pending tracked-changes as `before → after`; `apply_suggestion` accepts/rejects them cleanly. `read_doc` can render them inline as `<ins>/<del>`.
- **File-like editing.** `edit_doc` matches a unique snippet of text (like a local `Edit`) and rewrites it — indices are never exposed.
- **Comments.** Read threads (author, quoted text, replies, resolved status), reply, resolve, add.
- **Tabs as sub-files.** Full create/rename/delete, and every read/edit tool can target a specific tab.
- **Multiple accounts.** Authorize several Google accounts; pick a default per project.

## Install

```sh
npm install -g @dasasian/gdocs-mcp
```

Or from source (during alpha):

```sh
git clone https://github.com/dasasian/gdocs-mcp && cd gdocs-mcp
npm install && npm run build
# then point your MCP client at: node /abs/path/to/gdocs-mcp/dist/index.js
```

## Setup

You need a Google Cloud OAuth client (one-time). Each user creates their own — this keeps your credentials yours and avoids Google app-verification for the restricted Drive scope.

1. **Create a project + enable APIs** (or use the [setup guide](docs/setup.md)):
   ```sh
   gcloud projects create my-gdocs-mcp
   gcloud config set project my-gdocs-mcp
   gcloud services enable docs.googleapis.com drive.googleapis.com
   ```
2. **OAuth consent screen** (Cloud Console → APIs & Services → OAuth consent screen): User type **External**, add yourself as a **Test user**. For long-lived tokens, set publishing status to **In production** (avoids the 7-day refresh-token expiry).
3. **OAuth client** → Create credentials → **OAuth client ID** → **Desktop app**. Download the JSON and save it as `~/.config/googledocs-mcp/client_secret.json`.
4. **Authorize an account** (opens a browser):
   ```sh
   gdocs-mcp add-account
   ```
   Repeat for each Google account you want to use.

## Configure your MCP client

In a project's `.mcp.json` (Claude Code) or equivalent:

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

`GDOCS_DEFAULT_ACCOUNT` sets which authorized account this project uses by default — so a work project and a personal project can point at different accounts without re-authorizing. Any tool call can override it with an `account` argument.

## Tools

| Tool | Description |
|---|---|
| `read_doc` | Read as markdown + inline HTML. Modes: `clean` · `tracked` (`<ins>/<del>`) · `accepted` · `rejected` |
| `edit_doc` | Replace a unique text snippet (string-anchored, markup-tolerant; new text supports inline markdown) |
| `format_doc` | Style an existing snippet in place: bold/italic/underline/strikethrough, color, font size/family, link, alignment |
| `overwrite_doc` | Replace a doc/tab body with markdown-rendered content — guarded against orphaning comments/suggestions |
| `create_doc` / `rename_doc` | Create (from markdown) / rename a doc |
| `list_suggestions` | Pending suggestions as `before → after` diffs |
| `apply_suggestion` | Accept or reject a suggestion |
| `insert_image` | Insert an inline image (URL) — position, size, left/center/right align |
| `insert_table` | Insert a rows×columns table — optional data fill, column widths, header shading |
| `list_comments` / `add_comment` / `reply_comment` / `resolve_comment` | Comment threads |
| `list_tabs` / `add_tab` / `rename_tab` / `delete_tab` | Tab structure |
| `list_permissions` / `share_doc` / `unshare_doc` / `set_link_access` | Sharing |
| `list_accounts` | Authorized Google accounts |

Every doc tool accepts an optional `account` (override the default) and, where relevant, a `tab` (target a tab by id or title).

## Known limitations

These are Google-API constraints, not bugs:

- **Suggestion attribution is unavailable.** The Docs API exposes no author or timestamp for suggestions, so they're listed in document order, not by "latest" or author.
- **Comment author email** is not returned by Drive — display name only.
- **Creating suggestions** is not possible via any API (only reading/resolving). `apply_suggestion` resolves; it cannot propose.
- **API-created comments** are not anchored to specific text.
- **Images are inline only.** Floating / text-wrapped images (with exact x,y positioning) cannot be created via the Docs API — only inline placement, sizing, and left/center/right alignment. Whole-table page alignment is likewise unsupported.
- **Markdown rendering is Tier 1.** `create_doc` / `overwrite_doc` render headings, paragraphs, inline styling, and bullet/ordered lists. Tables, images, and code blocks *embedded in* the markdown are not yet rendered (use the `insert_table` / `insert_image` tools for those). Reading a doc back flattens tables and can't reliably reproduce image URLs.

## Roadmap

- **Tier-2 block rendering** in the markdown writer — tables, images, and code blocks *embedded in* pushed markdown (the standalone `insert_table` / `insert_image` tools already exist).
- Optional best-effort suggestion attribution via comment correlation.

> The "manuscript sync" use case (chapter files ⇄ tabs, reviewing suggestions, merging) is intentionally **not** a server feature — an AI agent orchestrates it over these primitives. See [DESIGN.md](DESIGN.md) §10b.

## Development

```sh
npm install
npm run build      # tsc
npm test           # vitest
npm run typecheck
```

See [DESIGN.md](DESIGN.md) for the full architecture and the empirical findings behind it.

## Acknowledgements

Architecture and approach informed by prior open-source Google Docs MCP servers — notably [`@a-bonus/google-docs-mcp`](https://github.com/a-bonus/google-docs-mcp) and [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp).

## License

[MIT](LICENSE) © Dasasian
