# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`set_style` selection model + whole-document (#17)** — `format_doc` is now **`set_style`**, modeled on selecting text in Docs and applying formatting. One tool, three ways to target: a single `from` snippet, a `from`/`to` **selection** (style the whole span without quoting everything between), or `whole_document: true` (one font throughout, no per-paragraph calls). All resolve to one range feeding the existing text+paragraph styling path; anchors stay string-based.
- **`set_page_setup` (#18)** — document-level page setup via `updateDocumentStyle`: margins (points), page size (preset `letter`/`legal`/`a4`/`tabloid` or explicit `{width,height}`), and orientation (`portrait`/`landscape`, which orders the page dimensions).
- **`get_page_setup`** — read counterpart to `set_page_setup` (margins/size/orientation, plus a matching preset name), for mirroring another document's layout.
- **`contentFile` passthrough (#14)** — `create_doc`/`overwrite_doc` accept `contentFile` (a local path the server reads directly) so long documents are passed through mechanically instead of retyped inline, which could silently drop/fuse text. `baseDir` defaults to the file's folder so its relative image paths resolve.

### Changed
- **Tool-surface consolidation (37 → 31)** — breaking renames, merging symmetric verbs into parametric tools (fewer schemas per call, better model selection):
  - `inspect_style` → **`get_style`** (read counterpart to `set_style`)
  - `insert_row`/`delete_row`/`insert_column`/`delete_column` → **`edit_table({op, side})`**
  - `rename_doc`/`move_doc` → **`update_doc({name?, folder?})`** (a move-title mismatch blocks the rename too)
  - `reply_comment` → **`add_comment({replyTo?})`**
  - `apply_suggestion` → **`apply_suggestions`** (superset: one or more resolutions, handles clusters)
  - `set_link_access` → **`share_doc`** (omit `email` for anyone-with-link; role `none` disables it); `unshare_doc` kept separate (destructive).
  - Destructive/create-destroy verbs (`delete_tab`, `unshare_doc`, `overwrite_doc`, tab add/rename/delete) deliberately left as distinct named tools so their confirmation guards stay legible.

### Fixed
- **Font change no longer strips bold** — setting a font family writes `weightedFontFamily` with `weight:400`, which drops the `bold` boolean; `set_style` now re-asserts bold over previously-bold spans after a font change, so bold survives a whole-document font change.
- **read/write HTML round-trip (#16)** — `read_doc` emitted `<p style="text-align:…">` and a raw `U+000B` line-break control char that the writers couldn't parse. Writers now parse the aligned-paragraph and `<br>` subset, and read emits `<br>` for in-paragraph breaks, so alignment and line breaks round-trip.
- **Markdown parser: underscore runs + escapes (#15)** — long underscore runs (signature blank lines) are no longer misread as `__bold__` (CommonMark word-boundary guards), and backslash escapes (`\_`, `\*`, …) are honored.
- **Test isolation (#12)** — `src/config.ts` no longer performs a filesystem migration at import time (it was mutating the real `~/.config` during test runs); config resolution is pure, and a vitest setup file sandboxes `GDOCS_MCP_CONFIG_DIR`.

### Planned
- Tier-2: code blocks embedded in markdown (tables and images now supported).

(Suggestion attribution is not planned — no API path exists; see [docs/limitations.md](docs/limitations.md).)

## [0.1.0] — Unreleased (alpha)

Initial release. A Model Context Protocol server that lets an AI agent treat a Google Doc like a local file.

### Fixed
- **Clustered-suggestion corruption (#7)** — resolving overlapping/adjacent/interleaved suggestions one at a time could silently corrupt neighbours while reporting success. apply_suggestion now refuses a clustered suggestion (status `cluster`); a new **apply_suggestions** resolves a whole cluster atomically (compute the region text from raw runs + a decision per member, replace in one batchUpdate). Isolated non-contiguous suggestions now also resolve correctly.

### Added
- **Surface conflicting overlapping suggestions (#11)** — when `apply_suggestions` resolves a cluster where one suggestion inserts text *inside* another suggestion's deletion and both are accepted (a genuine conflict), it still resolves deterministically (keeps the insertion) but now returns a `conflicts` array describing each — so an auto-resolved conflict is visible to the user rather than looking like a clean merge. Follow-up from the #7 fix.
- **Confirmation guards on destructive tools (#10)** — extending the #6 pattern to more of the mutating surface, tools that take an opaque id now accept a human-readable label that is shown in the permission prompt *and* verified against live state before mutating: `delete_tab` (expectTitle, **required** — refuses if the tab's live title differs), `resolve_comment` (expectQuote — verified against the comment's quoted text/body), `overwrite_doc` and `move_doc` (expectTitle — verified against the live doc title). Mismatch returns status `mismatch` and does not mutate.
- **Edit existing-table style (#8)** — new **set_table_style** locates an existing table by any cell's text (same pattern as insert_row) and sets cell padding (fixes thin padding that clips the first letter of a cell), background color, and column widths. `scope` picks table/row/column/cell for padding & background; reuses the same request types insert_table already builds.
- **Computed-style read + paragraph spacing (#5)** — new **inspect_style** reads the effective (inherited-resolved) style at a text anchor: paragraph spacing (space before/after in pt, line spacing %, and whether it's inherited), alignment, named style, and run fonts/size/color/link — style that read_doc's markdown can't express. **format_doc** now also *sets* paragraph spacing (`spaceBefore`/`spaceAfter`/`lineSpacing`), so a "gap between paragraphs" that is spacing (not a blank line) is now both diagnosable and fixable instead of a silent edit_doc no-op.
- **Direct-write disclosure (#2)** — edit_doc/format_doc/overwrite_doc/insert_table/insert_image state in their descriptions that writes are direct (live text), not tracked suggestions; edit_doc and add_comment also return a `note` in the result so the constraint is visible in the tool output.
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
