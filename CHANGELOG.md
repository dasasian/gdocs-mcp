# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Tier-2: code blocks embedded in markdown (tables and images now supported).
- Optional best-effort suggestion attribution via comment correlation.

## [0.1.0] — Unreleased (alpha)

Initial release. A Model Context Protocol server that lets an AI agent treat a Google Doc like a local file.

### Fixed
- **Clustered-suggestion corruption (#7)** — resolving overlapping/adjacent/interleaved suggestions one at a time could silently corrupt neighbours while reporting success. apply_suggestion now refuses a clustered suggestion (status `cluster`); a new **apply_suggestions** resolves a whole cluster atomically (compute the region text from raw runs + a decision per member, replace in one batchUpdate). Isolated non-contiguous suggestions now also resolve correctly.

### Added
- **Image change-tracking hooks** — create_doc/overwrite_doc return each embedded image's { src, objectId }; download_images returns a sha256 per image. Enables an agent-maintained objectId→file sidecar to detect local/doc-side changes.
- **Image pull** — read_doc marks image positions as `![](image:<objectId>)` and download_images saves a doc's embedded images to a local folder (with the objectId→file mapping), enabling Doc→markdown+images (the inverse of publish).
- **Markdown images** — block images (`![alt](src)`) render on create/overwrite: remote URLs directly, and local files via a `baseDir` (uploaded to Drive, embedded, temp upload cleaned up; your .md is left unchanged).
- **Markdown tables** — render on create/overwrite and round-trip via read_doc, including inline formatting in cells and column alignment (:---/:---:/---:). edit_doc edits cell text surgically; insert_row/delete_row/insert_column/delete_column reshape tables while preserving the rest.
- **In-session project defaults** — set_project_default / get_project_config write and read a project's .gdocs-mcp.json (default account + folder) without editing files by hand.
- **Drive navigation** — `list_folder` (browse a folder) and `search_drive` (find files/folders by name).
- **Folders** — `create_doc` accepts a `folder` (URL or id) to create in place; `move_doc` relocates an existing doc.
- **Per-project defaults** — `.gdocs-mcp.json` (`{ "account": "…", "folder": "…" }`) sets a default account *and* a default folder for new docs, discovered up from the working directory.
- **Reading** — `read_doc` (markdown + inline HTML; `clean` / `tracked` / `accepted` / `rejected` modes).
- **Editing** — `edit_doc` (string-anchored, markup-tolerant; `new_string` renders inline markdown + HTML), `overwrite_doc` (markdown-rendered, tab-aware, guarded), `create_doc` (markdown), `rename_doc`.
- **Formatting** — `format_doc` (bold/italic/underline/strikethrough, color, font size/family, link, alignment).
- **Suggestions** — `list_suggestions` (before→after diffs), `apply_suggestion` (accept/reject via range reconstruction).
- **Comments** — `list_comments`, `add_comment`, `reply_comment`, `resolve_comment`.
- **Tabs** — `list_tabs`, `add_tab`, `rename_tab`, `delete_tab`, plus tab-targeting on read/edit/suggestion tools.
- **Objects** — `insert_image` (position/size/align), `insert_table` (data fill, column widths, header shading).
- **Sharing** — `list_permissions`, `share_doc`, `unshare_doc`, `set_link_access`.
- **Multi-account** — `list_accounts`, `add-account` CLI, per-project default via `GDOCS_DEFAULT_ACCOUNT`, cross-account resolution.
- Markdown ⇄ Docs transformers with a lossless Tier-1 round-trip (headings, paragraphs, inline styling, bullet/ordered nested lists).

### Known limitations
- Suggestion attribution (author/time) is unavailable via any Google API.
- Comment author email is not returned by Drive (display name only).
- Images are inline only; they do not read back to a stable URL.
- Markdown block rendering is Tier 1 (embedded tables/images/code not yet rendered).

[Unreleased]: https://github.com/dasasian/gdocs-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dasasian/gdocs-mcp/releases/tag/v0.1.0
