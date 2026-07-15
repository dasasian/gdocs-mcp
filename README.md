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
npm link   # makes `gdocs-mcp` available globally, same as the published package
```

Then follow the setup below exactly as an installed user would. (`npm link` symlinks the
`gdocs-mcp` binary to your build; see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.)

## Setup

You need a Google Cloud OAuth client (one-time). Each user creates their own — this keeps your credentials yours and avoids Google app-verification for the restricted Drive scope.

1. **Create a project + enable APIs** (or use the [setup guide](docs/setup.md)):
   ```sh
   gcloud projects create my-gdocs-mcp
   gcloud config set project my-gdocs-mcp
   gcloud services enable docs.googleapis.com drive.googleapis.com
   ```
2. **OAuth consent screen** (Cloud Console → APIs & Services → OAuth consent screen): User type **External**, add yourself as a **Test user**. For long-lived tokens, set publishing status to **In production** (avoids the 7-day refresh-token expiry).
3. **OAuth client** → Create credentials → **OAuth client ID** → **Desktop app**. Download the JSON and save it as `~/.config/gdocs-mcp/client_secret.json`.
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

Prefer it available in **every** project? Register once at user scope: `claude mcp add gdocs -s user -e GDOCS_DEFAULT_ACCOUNT=you@example.com -- gdocs-mcp`. Then a project can pin its own defaults with a `.gdocs-mcp.json` — both the account and a default folder for new docs:

```json
{ "account": "work@company.com", "folder": "https://drive.google.com/drive/folders/…" }
```

With a `folder` set, `create_doc` files new docs there automatically (an explicit `folder` argument still overrides). See [docs/setup.md](docs/setup.md) for the full resolution order.

You don't have to edit that file by hand — just tell the agent *"make damithsc@gmail.com my default account for this project"* or *"make my Manuscripts folder the default here,"* and it writes the `.gdocs-mcp.json` for you via `set_project_default` (searching for the folder by name if needed).

## Tools

| Tool | Description |
|---|---|
| `read_doc` | Read as markdown + inline HTML. Modes: `clean` · `tracked` (`<ins>/<del>`) · `accepted` · `rejected` |
| `edit_doc` | Replace a unique text snippet (string-anchored, markup-tolerant; new text supports inline markdown) |
| `set_style` | Style existing text in place — like selecting in Docs and applying formatting: a `from`/`to` selection, a single `from` snippet, or the `whole_document`. bold/italic/underline/strikethrough, color, font size/family, link, alignment, paragraph spacing (before/after/line) |
| `inspect_style` | Read the computed (inherited-resolved) style at a text anchor — paragraph spacing, alignment, fonts, colors that markdown can't show |
| `overwrite_doc` | Replace a doc/tab body with markdown-rendered content — guarded against orphaning comments/suggestions |
| `create_doc` / `rename_doc` / `move_doc` | Create (from markdown, optionally in a folder) / rename / move a doc to a folder |
| `list_suggestions` | Pending suggestions as `before → after` diffs |
| `apply_suggestion` | Accept or reject a single (isolated) suggestion |
| `apply_suggestions` | Accept/reject multiple suggestions atomically — required for overlapping/adjacent "clusters" |
| `insert_image` | Insert an inline image (URL) — position, size, left/center/right align |
| `download_images` | Download a doc’s embedded images to a local folder (pairs with `read_doc`’s image markers — the inverse of publishing) |
| `insert_table` | Insert a rows×columns table — optional data fill, column widths, header shading |
| `insert_row` / `delete_row` / `insert_column` / `delete_column` | Table structure ops (surgical — locate the table by cell text) |
| `set_table_style` | Style an existing table (located by cell text): cell padding, background, column widths — scope table/row/column/cell |
| `list_comments` / `add_comment` / `reply_comment` / `resolve_comment` | Comment threads |
| `list_tabs` / `add_tab` / `rename_tab` / `delete_tab` | Tab structure |
| `list_folder` / `search_drive` | Browse a Drive folder / search files+folders by name |
| `list_permissions` / `share_doc` / `unshare_doc` / `set_link_access` | Sharing |
| `list_accounts` | Authorized Google accounts |
| `set_project_default` / `get_project_config` | Set/show this project’s default account + folder (writes `.gdocs-mcp.json`) |

Every doc tool accepts an optional `account` (override the default) and, where relevant, a `tab` (target a tab by id or title).

## Known limitations

These are **Google-API constraints, not bugs** — the highlights are below; the complete reference (with the API reason and the workaround for each) is in **[docs/limitations.md](docs/limitations.md)**.

- **Can't *create* suggestions.** No API writes in suggestion mode — every edit is direct (live text). `apply_suggestion` only resolves existing ones. Tools that write say so.
- **No suggestion attribution** (author/timestamp) — suggestions are listed in document order.
- **Comments** created via the API aren't anchored to text, and Drive returns author *name* only (no email).
- **Images are inline only** (no floating/x,y positioning), and Google downscales/re-encodes embedded images, so pulled copies aren't byte-identical.
- **Markdown can't express computed style** (spacing, fonts, colors) or deep table styling — read it with `inspect_style`, set it with `set_style`/`set_table_style`. Code blocks aren't rendered from markdown yet (roadmap).

See **[docs/limitations.md](docs/limitations.md)** for the full table, including how each is mitigated or surfaced.

## Roadmap

- **Code blocks** in the markdown writer — the remaining Tier-2 block type (tables and images already render; standalone `insert_table` / `insert_image` tools exist too).

> Suggestion attribution (author/timestamp) is **not** on the roadmap — it has no API path for typical suggestions (see [docs/limitations.md](docs/limitations.md)).

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
