# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.1] — 2026-07-31

### Added
- **MCP Registry metadata** — a `server.json` (registry schema) plus an `mcpName` field in `package.json`, so the server can be published to the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.dasasian/gdocs-mcp`. No functional or API changes.

## [0.1.0] — 2026-07-31

First public release — a Model Context Protocol server that lets an AI agent treat a
Google Doc **like a local file**. The full tool surface is implemented and validated
against the live Docs/Drive API. As a `0.x` release the tool surface may still change
between minor versions.

### Reading & editing
- **read_doc** — markdown + inline HTML, in `clean` / `tracked` (`<ins>/<del>`) / `accepted` / `rejected` modes.
- **edit_doc** — string-anchored, markup-tolerant edits (no indices); `new_string` renders inline markdown + HTML.
- **overwrite_doc** — guarded wholesale replace (refuses to orphan comments/suggestions); accepts inline `content` or a `contentFile` path read server-side.
- **create_doc** — render a markdown doc (inline `content` or `contentFile`), optionally into a Drive folder.
- **update_doc** — rename and/or move a doc, with a title-verification guard on move.

### Styling
- **set_style** — style existing text the way you select in Docs: a single `from` snippet, a `from`/`to` selection, or the `whole_document`; bold/italic/underline/strikethrough, color, font size/family, link, alignment, and paragraph spacing. Bold survives a whole-document font change (works around a Docs API quirk that otherwise drops it).
- **get_style** — read the effective (inherited-resolved) style at a text anchor.
- **set_page_setup / get_page_setup** — document margins, page size (preset or explicit), and orientation.

### Suggestions (tracked changes)
- **list_suggestions** — pending changes as `before → after` diffs.
- **apply_suggestions** — accept/reject one or more in a single atomic update; resolves overlapping/adjacent **clusters** safely (resolving them one at a time corrupts neighbours) and surfaces genuine `conflicts` instead of reporting a clean merge.

### Comments
- **list_comments / add_comment** (replies via `replyTo`) **/ resolve_comment** — with a quote-verification guard on resolve.

### Tables & images
- Markdown tables render on create/overwrite and round-trip via read_doc (inline formatting + column alignment).
- **insert_table**, **edit_table** (insert/delete a row or column, located by cell text), **set_table_style** (padding, background, column widths).
- **insert_image** (position/size/align); markdown images render on create/overwrite; **download_images** pulls embedded images to disk with an id→file map + sha256.

### Tabs, Drive & accounts
- **list_tabs / add_tab / rename_tab / delete_tab**, plus tab-targeting on read/edit/suggestion tools.
- **list_folder / search_drive**; **list_permissions / share_doc** (a person or anyone-with-link) **/ unshare_doc**.
- **list_accounts**, `add-account` CLI, per-project defaults via `.gdocs-mcp.json` and `GDOCS_DEFAULT_ACCOUNT`.

### Safety
- Confirmation guards on destructive / opaque-id tools: a human-readable label (`expectTitle` / `expectQuote`) is shown in the permission prompt **and** verified against live state before mutating — a mismatch refuses without changing anything.
- Every write is a direct (live-text) edit, not a tracked suggestion — tools say so in their descriptions and results.

### Known limitations (Google-API constraints, not bugs)
See [docs/limitations.md](docs/limitations.md). Highlights: suggestion attribution
(author/time) is unavailable via any Google API; comment author email isn't returned
by Drive; images are inline-only and don't read back to a stable URL; embedded code
blocks aren't rendered yet (Tier-2 roadmap).

[Unreleased]: https://github.com/dasasian/gdocs-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/dasasian/gdocs-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dasasian/gdocs-mcp/releases/tag/v0.1.0
