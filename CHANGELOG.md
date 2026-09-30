# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

> **Six tools are removed and one added (#55): `create_doc` and `overwrite_doc` become `write_doc`; `list_tabs`, `add_tab`, `rename_tab` and `delete_tab` go.** Every doc tool takes `path` instead of `documentId` and `tab`. 30 tools become 25.

| Removed | Use instead |
|---|---|
| `list_tabs(documentId)` | `drive({cmd:'ls', args:['<doc>']})` — one level of tabs, each with the `path` to pass back |
| `rename_tab(documentId, tabId, title)` | `drive({cmd:'mv', args:['<doc>/<tab>', '<doc>/<new title>']})` |
| `create_doc(title, content, folder)` | `write_doc(path: '/<folder>/<title>', content)` — a path that names nothing is created; never asks |
| `overwrite_doc(documentId, content, force, expectTitle, tab)` | `write_doc(path, content)`, then again with the `confirmLoss` string from the refusal. `force` and `expectTitle` are gone: the loss summary is the guard, and it is a fact the caller had to fetch |
| `add_tab(documentId, title, index, parentTabId)` | `write_doc(path: '/<folder>/<doc>/<title>', content)` creates the tab (child tab: name the parent in the path); `index` and `parentTabId` afterwards with `drive mv` |
| the `folder` argument of `create_doc`, and the silent use of the project-default folder | the folder in the path; a bare name is refused with the default folder's full path to call |
| the `tab` param on every doc tool | a tab step in `path`: `/Work/Contract/Ch.4`, `<id>/Ch.4`, or a URL with `?tab=` |
| the `documentId` param on every doc tool | `path` — an id or URL still works, so `documentId: X` becomes `path: X` |
| `delete_tab(documentId, tabId, expectTitle)` | none — nothing deletes a tab; delete it in Docs (DESIGN.md §3c) |

### Added

- **Page breaks round-trip through markdown (#48).** A page break reads as `<div style="page-break-after:always"></div>` on its own line, where the break is, and `write_doc`, `edit_doc` and `insert_content` send `insertPageBreak` for it — so a read written back keeps the break, and a title page is one line: `new_string` `Title page\n<div style="page-break-after:always"></div>`. Google's own `<hr style="page-break-before:always">`, `break-before: page` and `break-after: page` are accepted too; any other `<div>` or `<hr>` is refused before a request is sent, like any unsupported CSS (#49). A paragraph whose text really is that string reads as `<p>…</p>` and stays text. The break's own paragraph is reset to Normal text with no bullet, since Docs would otherwise give it the heading or list item it lands next to. `edit_doc` matches a break as that line, so an anchor can span one. A break in a header or footer is refused (the Docs API refuses it). `write_doc`'s loss summary now counts section breaks and column breaks, which are not carried (#57).
- **`write_doc` (#55).** Creates a doc in a folder, a tab in a doc or a child tab when the path names nothing, and never asks. Replacing what a path names is refused once with a loss summary — paragraphs, comments, suggestions, tab stops, person/date/link chips, links to bookmarks — and proceeds when the same summary comes back as `confirmLoss`. The summary carries the doc's revision, so an edit between the two calls, or a new comment, refuses it again. Counted from the Docs API (`paragraphStyle.tabStops`, `person` / `dateElement` / `richLink` elements, `suggestedInsertionIds`, links to a bookmark or heading) and from Drive (comments). Approximate in two places, and the summary says so: comments are counted for the whole doc (the API does not say which tab an anchor is in) and a bookmark nothing links to is invisible. A doc with several tabs needs a tab step.
- **Every doc tool takes one `path` (#55).** An id, a URL, `/Work/Contract` or `/Work/Contract/Ch.4`, walked by the same resolver `drive` uses. A doc with one tab means that tab (so most calls name none); a doc with several and no tab step is refused, listing every tab's full path, in `read_doc`, `edit_doc` and every other tab-level tool — it used to go silently to the first tab. Comments, sharing and export act on the file, so a tab path there names its doc. Doc URLs are now accepted by every tool.
- **`drive` reaches into a doc's tabs (#55).** A path walks folders, and the first step that is a Google Doc switches to that doc's tabs; a nested tab is one more step, a step may be a title or a tabId, and an id or a URL (`?tab=` is honoured) can start the path. `ls <doc>` lists tabs, `ls <folder>` shows each doc's tab count (the first 50 docs). `mv` renames, nests and un-nests a tab; the new `index` parameter reorders it. `mv` of a tab to another doc or a folder and `cp` of a tab are refused with the reason; two tabs with one name are refused with every candidate listed.

- **`read_doc` shows style as CSS (#49).** The read opens with a `<style>` block, one rule per named style (`p`, `h1`–`h6`, `.title`, `.subtitle`), in pt. A paragraph shows `style="…"` only where it differs from its rule: `text-align`, `line-height`, `margin-top`/`margin-bottom`/`margin-left`/`margin-right`, `text-indent`. A hanging indent reads as `margin-left:36pt; text-indent:-18pt` (CSS measures `text-indent` from `margin-left`; Docs measures its first-line indent from the page margin). List items show no indent — their nesting owns it.

- **`create_doc` / `overwrite_doc` / `insert_content` accept the same CSS (#49).** A leading `<style>` block sets the named styles; `<p style>`, `<hN style>`, `<p class="title">` and `<span style>` style paragraphs and runs. `text-indent` is added back to `margin-left` on the way in, so a hanging indent read from a doc writes back as it was. The supported set is one list, shared with the reader.
- **`edit_doc` is how style changes (#49).** `new_string` accepts `<p style>`, `<hN style>`, `<p class>`, `<span style>` and `<style>` rules. When `old_string` and `new_string` carry the same words and differ only in markup, only `updateParagraphStyle` / `updateTextStyle` are sent — never a delete or an insert — so a 300-word paragraph is restyled from a short anchor (`<p>4. Term` → `<p style="text-indent:36pt">4. Term`) and its words cannot change. Markup the new text no longer has is cleared. An edit inside the `<style>` block becomes one `updateNamedStyle` per changed rule, and every paragraph that does not override it follows.
- **An unsupported property is an error, not text (#49).** `<p style="border:1px">` used to be inserted into the doc as visible characters. Now the whole write is refused before any request is sent — `create_doc` does not even create the doc — with one error naming every offending line and the supported set.

### Removed

> **Breaking: `get_style` and `set_style` are removed.** Anything calling them by name must move to `read_doc` (to see style) and `edit_doc` (to change it). 32 tools become 30.

- `read_doc` shows what `get_style` returned — and for the whole doc, not one anchor. `edit_doc` does what `set_style` did: same words with new markup restyles without retyping, and a `<style>` rule edit restyles the whole document (#49).

### Fixed

- **`export_doc` on a tab path exports that tab, not every tab (#55).** It resolved the path to the doc and exported the whole thing. Drive's `files.export` cannot scope to a tab, so a tab path of a multi-tab doc now goes through the Docs UI's `export?tab=` endpoint, which does (all eight formats checked live; a parent tab exports without its children). That endpoint is undocumented and throttled, so when it fails the call is refused with the doc path to use instead — it never widens silently. A doc path still exports every tab.
- **A folder id or URL can start a path (#55).** `write_doc("<folderId>/New doc")` failed with "is not a Google Doc, so it has no tabs to walk into", although agents get folder ids from `drive ls` and `find`. An id or URL now resolves to whatever Drive says it is: a folder walks on into the folder (and into a doc's tabs after that), a doc walks into its tabs. `https://drive.google.com/drive/folders/<id>` works the same way, with or without further steps after it.
- **Reordering a tab in place works (#55).** `drive mv <doc>/Summary <doc>/Summary` with `index: 0` was refused as moving a tab into itself — the first thing every model tried. The same tab as source and destination now means "stay under the same parent": with `index` it reorders, without it nothing changes and the result says so. Moving a tab under itself or under one of its own descendants is still refused, and now before the Docs API is asked.
- **A read written back gives back the same document (#52).** Document text that spells markup used to become markup on the next `overwrite_doc`: `4. Term` turned into a list item, `5 * 3 * 2` lost its asterisks, `[Name](the Company)` became a link, `~~draft~~` was struck through, a literal `<b>` bolded. `read_doc` now marks such text as literal: a line that would parse as a block reads as `<p>4. Term</p>`, and a character that would open inline markup reads with a backslash (`5 \* 3 \* 2`); a real backslash before punctuation reads as `\\`. What needs marking is decided by asking the writer's own parser, so only text that would really change is marked — `file_name_here`, `____`, `<Client Name>` and `---` read unchanged. The same holds in table cells and in headers and footers. `edit_doc` ignores the markers when it locates text: `5 * 3`, `5 \* 3` and `<p>4. Term` all find the same words. An escaped `<span style="…">` is text, not a style error.
- **Leading and trailing tabs and spaces survive a read written back (#54).** A paragraph typed as `⇥Indented clause`, or `Signature:⇥` against a tab stop with an underline leader, lost its edge whitespace on `overwrite_doc`. `read_doc` now reads such a line as `<p>⇥Indented clause</p>`, and the writer keeps every space and tab inside `<p>` — in `create_doc`, `overwrite_doc`, `insert_content`, `edit_doc`, table cells and headers/footers — whether the `<p>` came from a read or was typed. Outside `<p>`, edge whitespace is still trimmed. Tabs stay tabs. A tab in the middle of a line gets no mark.

### Changed

- **`write_doc` does not create from a bare name; the project default folder says where it would go (#55).** `write_doc("Meeting notes", …)` — not a path, URL or Drive id — creates nothing. It is refused with "Not created: no folder was given. Tell the user it will go in the default folder /Work/Clients, then call write_doc(\"/Work/Clients/Meeting notes\", …)", or, with no default, "Name a folder, e.g. ~/Meeting notes.". The folder set with `set_project_default` (which was left read by nothing after `create_doc` went) is resolved to a path when the server starts and shown in `write_doc`'s description; a change made mid-session shows there after a restart, while the refusal reads it fresh. A bare string that is a Drive id still names that doc. With a default folder set, a new doc at the top of My Drive (`/Name` or `~/Name`) is refused once as well — models wrote `/Meeting notes` and skipped the default in 2 of 2 headless runs — and the identical call repeated (remembered for the life of the server process) creates it. Tabs, replaces, deeper paths, shared-drive roots and projects with no default are unaffected.
- **The `write_doc` refusal leads with the instruction to ask the user (#55).** It opens "Ask the user before doing anything else: nothing has been changed, and the user has not agreed to this yet", then the loss list, then how to confirm. Headless Haiku had confirmed its own loss without asking in 2 of 3 runs, so the text now says the thing that mattered first; it is wording only, not a guard.
- `overwrite_doc` clears the paragraph style the new text would inherit from the paragraph it lands in; an indent on the old last paragraph no longer leaks into the first new one (#49).
- Title and Subtitle paragraphs read as `<p class="title">` / `<p class="subtitle">` instead of `# …` (#49).

## [0.6.0] — 2026-08-21

### Changed

> **Breaking: five Drive tools became one.** `list_folder`, `search_drive`, `create_folder`, `copy_doc` and `update_doc` are removed, replaced by `drive({ cmd, args })`. Anything calling them by name must be updated.

- **Drive navigation is now a filesystem (#44).** The five Drive tools became `drive({ cmd, args })` speaking `ls` / `find` / `mkdir` / `cp` / `mv` — 36 tools down to 32. Paths are `/` or `~` (My Drive), `/shared/<drive name>`, `/shared-with-me` and `/lost+found`; anything else is read as a Drive id or URL, so ids from other tools paste straight in. A whole path resolves in a single `files.list` call.
- **Drive is not a filesystem in three ways, and each refuses rather than half-working (#44).** Two files may share a name in one folder and matching folds case, so an ambiguous path is refused with the candidates listed — and `cp`/`mv` refuse to create that state. `cp -r` does not exist: Drive's `files.copy` rejects folders outright. `mv` into `/shared/…` transfers ownership irreversibly, so it requires `acceptOwnershipTransfer`.
- **`mv` keeps `update_doc`'s guard as `expectName`**, and covers rename and move together the way a filesystem does: an existing folder as the destination means "into it", anything else means "to that name" (#44).
- **Flags and operands parse in any order**, as a terminal accepts them: `cp -r a b`, `cp a b -r` and `cp a -r b` are one command, and `--` ends the options. What an unrecognised `-token` means is set per command, because the commands disagree — `ls -la /Work` wants the flag ignored, `find -2026` wants `-2026` searched for (#44).
- **`cp` keeps the source name.** Drive's `files.copy` defaults to "Copy of …", which is its UI convention; `cp file /dir` on a filesystem produces `file` (#44).
- **`ls /lost+found` replaces `list_folder({ folder: "orphaned" })`** — Unix's name for exactly this (#44, #46).
- **No destructive command ships.** There is none in the surface to collapse, and host permissions are granted per tool *name*: allowlisting `drive` so `ls` stops prompting would allowlist `rm` too. Conditions that would change that are in #47 (#44).

### Added

- **Files in no folder are listable** — `ls /lost+found`. A parentless file opens and turns up in a search, but nothing that browses the tree will ever show it, so it is found only by someone who already remembers it exists. Drive has no query operator for "has no parent", so the scan pages the files you own and reports `scanned`/`complete` rather than passing a silent cap off as the whole answer. Re-home one with `mv` (#46).
- **The README shows what to ask for.** Two chained examples — filling a template without rebuilding it, and a whole review pass in one instruction — now sit above the tool table, where the only pointer to `docs/recipes.md` used to be a blockquote below it. `docs/recipes.md` gains a **Whole jobs** section above the single-tool recipes (#44).

## [0.5.0] — 2026-08-16

### Changed

> **Breaking: `unshare_doc` now requires `expectRole`.** A call passing only `documentId` and `email` will be rejected. Run `list_permissions` first and echo the role back.

- **`unshare_doc` now requires `expectRole`.** Revoking access is the one operation in the surface with no undo — verified live, a Drive revision carries no permission data at all, so version history restores content and never sharing. Echo back the role `list_permissions` reported and the call proceeds only if the grant is still that; otherwise nothing is removed. An optional `expectTitle` refuses a wrong document id as well.

### Fixed
- **Two tool descriptions pointed at tools that do not exist.** `set_style` told callers to run `inspect_style`, which was renamed `get_style`; `list_suggestions` pointed at `apply_suggestion`, whose singular form was deleted. Both sent the model somewhere there was nothing. A test now reads the descriptions and fails on any name that is not a registered tool (#45).
- **`set_style` and `edit_doc` did not say which to use.** Since 0.3.0 both can style existing text, but `edit_doc` requires restating the whole run, and retyping is how text gets silently dropped. Each now names the other and says when it is the wrong choice (#45).
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
