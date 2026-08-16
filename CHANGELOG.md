# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **A domain or group grant could be seen but never revoked.** `unshare_doc` matched on email, and a domain or anyone-with-link grant has none — so the domain-wide grant every doc gets under a Workspace was permanent as far as the tool surface was concerned. It now also accepts a `permissionId` from `list_permissions`, which covers every grant type, echoes back what it removed, refuses the owner, and lists what is present when nothing matches (#41).
- **`list_permissions` could not name a domain or link grant.** It never asked Drive for `domain` or `allowFileDiscovery`, so a domain-wide grant came back with a null email and no way to tell which domain it covered — rendering as `null:reader`. Every entry now carries a `subject` naming its audience (`alice@x.com`, `x.com (domain)`, `anyone with the link`), and domain/link grants report whether the file is discoverable in search rather than only reachable by link (#42).

## [0.4.0] — 2026-08-16

### Added
- **`get_table_style`** — reads a table's column widths, pinned header rows, and the matched cell's padding, background and per-side borders, located by cell text like its setter. `set_table_style` was the only setter with no getter, so everything it wrote was invisible on read. `columnWidths` comes back in the shape the setter accepts, so one table's layout can be copied onto another (#33).

## [0.3.0] — 2026-08-16

### Changed

**`read_doc`'s output format changed. Anything that parses it should be checked.**

- **Text color, size and font read back as `<span style="…">`** — the spelling the writer already parsed, so they round-trip. Previously a `set_style` colour change was invisible on the next read, leaving no way to verify it or preserve it while rewriting. Quiet by default: Google only sets these fields on runs that override them, so inherited text and headings are untouched (#30).
- **Embedded images read back with their size** — `<img src="image:<objectId>" width="…" height="…">` (points) rather than a bare `![](image:<objectId>)`, and the writer accepts an `<img>` line, so dimensions survive a round-trip. The plain `![alt](src)` form is unchanged for authoring. Writing an `image:` marker back is now refused with an explanation instead of failing as a missing file, since Docs keeps the bytes and not a re-fetchable URL (#30).

### Added

- **`segment`/`page` on the table and suggestion tools** — `insert_table`, `edit_table`, `set_table_style`, `list_suggestions` and `apply_suggestions` reach headers and footers, as the text tools already did. A letterhead table was previously unreachable and failed *silently*, reporting "no table cell containing …" as though it did not exist; these now return `no_segment` listing what the doc has. `insert_table` also takes `createSegment` (#28).
- **Inline code round-trips.** Docs has no code style, so the writer maps `` `x` `` to a monospace font; the reader now maps it back. Previously the backticks were dropped on read (#30).
- **`insert_table` cells accept inline markdown, and take per-column `align`.** Cell text now goes through the same renderer the markdown path uses, so `**bold**`, `` `code` `` and `[links](url)` work; `align: ["center","right"]` sets column alignment at creation (#29).
- **`insert_image` accepts a local file path**, not just a public URL — it uploads to Drive, embeds, and removes the temp upload, the same way `![](./logo.png)` in pushed markdown already did. Relative paths resolve against `baseDir` (#29).

### Fixed

- **`overwrite_doc` and `insert_content` inherited the styling they replaced.** `insertText` picks up the formatting at the insertion point, and inheritance carries across a single `batchUpdate` — which is what an overwrite is — so plain markdown pushed into a bold, coloured document came back bold and coloured. The rendered range now has its direct character styling cleared first. Named styles still inherit, so a document's `NORMAL_TEXT` font is unaffected (#32).
- **`read_doc` wrapped every hyperlink in a redundant colour span.** Docs writes its link blue in as a direct run colour, which the new colour rendering then surfaced. The default is now suppressed on links (as underline already was), while a deliberately coloured link still shows (#32).
- **`insert_table` wrote literal markdown into cells.** `data: [["**Bold**"]]` inserted the asterisks as text. Because `read_doc` renders genuinely-bold text as `**Bold**` too, a read-back looked correct while the document held corrupt text, so callers had no way to notice (#29).
- **A read→write round-trip corrupted nested inline styles.** The reader emits styles in layers (`<u>**AAA**</u>`), but the writer's parser was one level deep and took a container's contents verbatim: the inner style was dropped and its markers became literal text. Each cycle added another layer (`<u>****AAA****</u>`), so a document degraded every time it was read and written back. Containers now re-parse their contents. Same-tag nesting stays unsupported, documented in `docs/limitations.md` (#31).
- **`edit_doc` could not match text containing `__`.** `old_string` falls back to a markup-stripped retry, and that step ran its own copy of the markdown grammar, drifted from the writer's. It lacked the writer's CommonMark word-boundary guard, so a signature rule (`____ ____`) or an intraword `a__b__c` copied out of `read_doc` was mangled into something the document never held. It now derives its plain text from the writer's own parser (#27).

## [0.2.0] — 2026-08-15

### Added
- **`copy_doc`** — duplicate a Doc via Drive `files.copy`, with an optional new name and target folder. Copying preserves what a markdown round-trip cannot rebuild (headers/footers, image sizing, exact formatting), so a template can be reused instead of recreated. Kept as its own tool rather than an `update_doc` mode: it creates a file rather than mutating one (#24).
- **`create_folder`** — create a Drive folder, optionally inside a parent (URL or id). Previously the only way to make a folder was the Drive UI (#25).
- **`set_table_style({ border })`** — cell border width (pt), color (hex), dash style, and which sides, over the same `scope` as padding/background. `border: { width: 0 }` makes a table borderless (#21).
- **`set_table_style({ headerRows })`** — repeat the top N rows on every page (Docs' "pin header rows"); `0` unpins (#19).

- **`insert_content`** — insert new markdown-rendered content at a structural position: `at: "end"` (default), `"top"`, or a unique text anchor to insert right after. This is the only path to content that `edit_doc` cannot anchor: a paragraph after a table that ends the doc (a table cell can't anchor an insert outside the table, and Docs' mandatory trailing empty paragraph has no text to match). Kept as its own tool rather than an `edit_doc` mode so `edit_doc` stays "replace this exact text" (#20).
- **`export_doc`** — export a Doc to a local file: pdf (default), docx, odt, rtf, txt, html, epub, or md, via Drive `files.export`. Google renders server-side, so pagination and page setup match the editor. Note Drive refuses exports over 10 MB (#22).

### Changed
- **Headers and footers are reachable everywhere text is (#23).** `read_doc`, `edit_doc`, `set_style`, `get_style`, `insert_content` and `insert_image` all take `segment: "body" | "header" | "footer"` (plus `page` for first-/even-page variants); `read_doc` also takes `segment: "all"`. Writes to a header/footer that doesn't exist return `no_segment` listing what does, and `createSegment: true` creates it (default header/footer only — the API cannot create first-/even-page ones). Implemented by threading `segmentId` through the existing request builders, not a parallel set of tools.
- **A body read no longer looks empty when it isn't (#23).** `read_doc` now reports the headers/footers it did not render, with paragraph and image counts. This was a wrong answer, not a missing one: a letterhead's logo lives in the page header, so `read_doc` returned markdown with no image at all and the doc read as having no logo.
- **`search_drive` / `list_folder` results now carry `parents`** — each entry lists its parent folder(s) as `{ id, name }`, so a hit can be traced upward (e.g. to create a sibling folder). Parent names are resolved once per distinct id, and degrade to the bare id if a lookup fails (#26).

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

[Unreleased]: https://github.com/dasasian/gdocs-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dasasian/gdocs-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/dasasian/gdocs-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dasasian/gdocs-mcp/releases/tag/v0.1.0
