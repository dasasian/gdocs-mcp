# Limitations imposed by Google's APIs

Everything here is a **constraint of the Google Docs / Drive APIs — not a bug in `gdocs-mcp`.** Where a constraint has a workaround or a partial mitigation, the last column says what the server does instead. If Google adds first-class support for any of these, we'll revisit.

Legend for "What gdocs-mcp does": **mitigated** = a tool works around it; **surfaced** = you're told about it in the tool result/description; **hard limit** = no workaround exists.

---

## Suggestions (tracked changes)

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Cannot create suggestions.** No tool can *propose* a tracked change; every write is a direct (live-text) edit. | There is no API to write "in suggestion mode" — `batchUpdate` only makes direct edits. | **surfaced** — `edit_doc`/`set_style`/`overwrite_doc`/`insert_table`/`insert_image` say so in their description, and `edit_doc`/`add_comment` return a `note`. `apply_suggestions` only *resolves* existing suggestions. |
| **No suggestion attribution** (author or timestamp). | `documents.get` returns only `suggestedInsertionIds`/`suggestedDeletionIds` — no author, no time. Drive Revisions don't represent pending suggestions; Drive Activity gives an actor but no `suggestionId` to link it to; a bare suggestion never appears in the Comments API. | **hard limit** — `list_suggestions` presents suggestions in **document order** (the natural review order), never by author or "latest". |
| **Overlapping suggestions can genuinely conflict.** When one suggestion inserts text *inside* the range another suggestion deletes and both are accepted, the outcome is contradictory. | The tagged runs encode both intents; the API has no notion of "the right merge". | **surfaced** — `apply_suggestions` resolves it deterministically (keeps the insertion) and returns a `conflicts` array so you know it wasn't a clean merge. |
| **Style-only suggestions can't be resolved by us.** A suggestion that only changes text style (no insert/delete) is refused. | Resolving a cluster works by delete+re-insert of the region; a style-only change carries no text to re-create, so it would be silently dropped. | **surfaced** — refused with a clear reason rather than corrupting the doc. |

> The whole suggestion feature is built on the one workable path: read in `SUGGESTIONS_INLINE` (the only view mode returning `batchUpdate`-valid indices), then resolve by operating on the raw tagged ranges with normal edits. See [DESIGN.md](../DESIGN.md) §6.

---

## Comments

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **API-created comments aren't anchored** to specific text. | The Drive comments API can't attach a programmatic comment to a text range. | **surfaced** — `add_comment` returns a `note`; its description says so. |
| **No comment author email** — display name only. | Drive omits the email for privacy by default. | **hard limit** — author name is shown as returned. |
| **Bare suggestions don't appear in the Comments API.** | Only explicit user comments are exposed; a tracked change with no attached comment is invisible there. | **hard limit** — this is *why* suggestion attribution can't be recovered by correlating comments. |

---

## Styling & computed properties

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Markdown can't express computed style** — paragraph spacing, line spacing, font, size, color. | `read_doc` projects the doc to markdown, which only represents structure/content, not paragraph/run style. A "gap" between paragraphs may be *spacing*, not a blank line. | **mitigated** — text color, size and font now read back as `<span style="…">`, the same spelling the writer parses, so a `set_style` change is visible on the next read and round-trips (#30). Paragraph/line spacing is still style-only: `get_style` reads the effective (inherited-resolved) style at a text anchor, and `set_style` sets it. |
| **Inserted text inherits formatting from the insertion point** — and inside a single `batchUpdate`, from text deleted earlier in that same batch. | Google Docs behaviour: `insertText` carries the character style of the surrounding position, and a batched delete+insert is treated as continuous. | **mitigated** — the markdown writer clears direct character styling over the range it inserts before applying what the markdown specifies, so `overwrite_doc`/`insert_content` produce what was written, not what was there (#32). Named styles are untouched, so document-level fonts still inherit. |

---

## Headers & footers

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Only the *default* header/footer can be created via the API.** A first-page or even-page one has to be enabled in the editor first. | `createHeader`/`createFooter` take a type but the API rejects creating the first/even variants. | **mitigated** — `createSegment: true` creates the default; asking for `page: 'first'`/`'even'` on a doc that lacks one returns a clear message instead of silently making the wrong thing. |
| **Header/footer content is invisible to a body read** — it is a separate content tree, not part of `body.content`. | By design in the Docs data model. | **mitigated** — every content tool takes `segment: 'header'\|'footer'` — the text tools since #23, and the table and suggestion tools since #28 — and a body read reports which segments exist and what they hold. |

---

## Images

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Inline only** — no floating / text-wrapped / exact x,y positioning. | The Docs API can only insert *inline* images (with size + left/center/right alignment). | **hard limit** — `insert_image` supports position/size/align; floating layout is unavailable. |
| **Embedded images are downscaled + re-encoded.** A pulled image is visually identical but **not** byte-identical to your original. | Google re-encodes embedded images to ≤ 2048 px on the long edge. | **surfaced** — `download_images` returns a `sha256`; keep your local files as the quality source of truth. |
| **Images don't round-trip as URLs** — the source link isn't recoverable on read-back. | Google stores the embedded bytes, not the original URL. | **mitigated** — `read_doc` marks each position as `<img src="image:<objectId>" width="…" height="…">`, carrying the size (points), and `download_images` pulls the actual bytes. Writing that marker back is refused with an explanation rather than a missing-file error, since the bytes aren't re-fetchable from the id (#30). |
| **Image alt text can't be written.** `read_doc` surfaces it as `alt="…"` when a document has it, but an `alt` you write is ignored. | The Docs API has 33 batchUpdate request types and none sets an embedded object's title/description; `insertInlineImage` takes only a location, uri and size. | **hard limit** — set it in the editor. |
| **Can't tag or checksum-match the image itself** inside the doc. | No API field to stamp an identity on an embedded image. | **mitigated** — `create_doc`/`overwrite_doc` return each image's `{ src, objectId }`; an agent keeps a small sidecar (`objectId → local file + hash`) to detect changes. The mapping must be *recorded*, not inferred. |

---

## Tables

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Deeper table styling flattens in the markdown.** Merged cells, cell colors, and column widths are not represented in the pipe table `read_doc` returns. | Markdown has no syntax for them, so the *markdown* cannot carry them. The Docs API returns them all — this was never an API limit. | **mitigated both ways** — `set_table_style` sets cell padding, background, borders, column widths and pinned header rows; `get_table_style` reads them back, with column widths in the shape the setter accepts (#33). Merged cells remain read-only. |
| **Nothing can be inserted between a table and whatever follows it by anchoring on cell text** — a `deleteContentRange`/insert can't cross a table cell boundary. | Docs API restriction on ranges spanning a cell edge. | **worked around** — `insert_content({at: 'end'})` writes at a structural index instead of an anchor, so a paragraph after a trailing table needs no anchor text. |
| **No whole-table page alignment.** | The Docs API doesn't expose table-level page positioning. | **hard limit**. |
| **`tableRowStyle.tableHeader` can be read but not written.** Sending it on `updateTableRowStyle` fails live with `Unallowed field: tableHeader`. | It's an output-only mirror of the pinned-rows state. | **worked around** — `set_table_style(headerRows: N)` uses the dedicated `pinTableHeaderRows` request instead. |
| **Can't tell which rows land on which printed/scrolled page**, so nothing can verify or fix a row split across a page boundary. | Pagination is computed at render time by the Docs layout engine (font metrics, page size, margins); it's never part of the document JSON `batchUpdate`/`documents.get` return. | **hard limit** — must be checked visually in the editor. (Pinning header rows to repeat on every page *is* supported: `set_table_style(headerRows: N)` — #19.) |

---

## Sharing & access

| Limitation | Why | What gdocs-mcp does |
|---|---|---|
| **Permission changes are in no version history.** Docs' version history restores content; a revision carries `exportLinks, lastModifyingUser, kind, id, mimeType, modifiedTime, published` and nothing about sharing. A revoked grant leaves no record of who had what. | Version history is a document-content feature; permissions are Drive ACLs, kept separately and not versioned. | **mitigated** — `unshare_doc` requires `expectRole`, so the caller must read the grant before removing it, and echoes back what it removed so the role is at least known afterwards (#43). |
| **A new doc may already be shared before you share it.** Under a Google Workspace domain, files can be created carrying a domain-wide grant — on `dasasian.com`, every doc this server creates starts as `{type: domain, role: reader, allowFileDiscovery: true}`, meaning anyone in the domain can read it *and* it surfaces in their Drive search. | A Workspace admin setting applied at creation, not something the server does or can opt out of. | **surfaced** — `list_permissions` names the grant (`x.com (domain)`) and says whether the file is discoverable in that domain's search; `unshare_doc` revokes it by `permissionId`. If a document must not be domain-readable, check `list_permissions` after creating it. |

---

## Drive navigation

| Limitation | Why | What gdocs-mcp does |
|---|---|---|
| **Drive has no query operator for "has no parent".** Orphaned files — the ones in no folder, which browsing can never reach — cannot be asked for. Finding them means paging files and filtering client-side, which is cheap over 30 files and expensive over 50,000. | `files.list` filters on parentage only as `'<id>' in parents`; there is no negation and no "parents is empty". | **mitigated** — `ls /lost+found` narrows the scan to `'me' in owners` (shared-with-me files are legitimately parentless and not yours to re-home), bounds it at 10 pages of 1000, and returns `scanned`/`complete` so a scan that hit the bound reports itself instead of passing a cap off as the whole answer (#46). |
| **Drive is not a tree in three ways the shell vocabulary assumes it is.** Two files may share a name in one folder; matching folds case (`Reports` and `reports` collide); and names may contain `/`, so a file called "Q1/Q2" cannot be addressed by path at all. | Drive names files in a flat store keyed by id, with parentage as metadata. The filesystem uniqueness and escaping rules were never part of it. | **mitigated** — a path matching more than one entry is refused with the candidates and their ids listed, never guessed, and `cp`/`mv` refuse to create a duplicate name rather than manufacturing that state. A name containing `/` is addressable by id, which every tool accepts wherever a path is taken (#44). |
| **`cp -r` does not exist.** Drive's `files.copy` refuses a folder — verified live, it answers *"This file cannot be copied by the user"*. Drive's own web UI cannot copy a folder either. | `files.copy` operates on a single file; there is no recursive copy in the API. | **surfaced** — `cp` on a folder returns `unsupported` and says `-r` cannot help, rather than half-copying (#44). |
| **`mv` into a shared drive gives the file away.** Shell `mv` across filesystems leaves you owning the file; moving into a shared drive transfers ownership to that drive's organization, and you cannot move it back out. | Shared drives own their contents; a move across the boundary is an ownership change, not a reparent. | **mitigated** — refused unless the caller passes `acceptOwnershipTransfer: true`, with the consequence stated in the refusal (#44). |
| **An orphan cannot be reproduced on purpose, or undone.** Removing a file's only parent does not orphan it — Drive reparents it to My Drive root. Once a file *is* orphaned, re-homing it is one-way; there is no "put it back where it wasn't". | Orphaning is a side effect of someone else deleting or unsharing a folder your files were in, not an operation you can perform. | **surfaced** — the state is listable and fixable with `mv`, but the fix is not reversible, so the usual `expectName` guard applies. |

---

## Markdown rendering coverage

| Limitation | Why | What gdocs-mcp does |
|---|---|---|
| **Code blocks aren't rendered** from pushed markdown yet. | Not a Google limit — a not-yet-built writer feature. | **roadmap** — Tier-2 block rendering. |
| **Tables/images embedded *in* pushed markdown** render on `create_doc`/`overwrite_doc`; standalone insertion is via `insert_table`/`insert_image`. | — | **mitigated**. |
| **Two inline containers of the same tag can't nest** — `<span …><span …>x</span></span>` closes the outer span on the inner one's end tag. | The inline patterns are regexes; matching balanced same-tag nesting needs a real parser. | **documented** — the reader never emits this shape (every style of a run goes in one span), and one span carrying both properties (`style="color:blue;font-size:14pt"`) is the supported spelling. Different tags nest fine (`<u>**x**</u>`, #31). |

> Only the code-block row here is a `gdocs-mcp` roadmap item; everything else on this page is a Google-API constraint.
