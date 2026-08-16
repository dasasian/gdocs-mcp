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
| **Markdown can't express computed style** — paragraph spacing, line spacing, font, size, color. | `read_doc` projects the doc to markdown, which only represents structure/content, not paragraph/run style. A "gap" between paragraphs may be *spacing*, not a blank line. | **mitigated** — `get_style` reads the effective (inherited-resolved) style at a text anchor; `set_style` sets paragraph spacing, and text color/size/font/alignment. |

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
| **Images don't round-trip as URLs** — the source link isn't recoverable on read-back. | Google stores the embedded bytes, not the original URL. | **mitigated** — `read_doc` marks each position as `![](image:<objectId>)`, and `download_images` pulls the actual bytes. |
| **Can't tag or checksum-match the image itself** inside the doc. | No API field to stamp an identity on an embedded image. | **mitigated** — `create_doc`/`overwrite_doc` return each image's `{ src, objectId }`; an agent keeps a small sidecar (`objectId → local file + hash`) to detect changes. The mapping must be *recorded*, not inferred. |

---

## Tables

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Deeper table styling flattens on read-back.** Merged cells, cell colors, and column widths become a plain markdown table when read. | Markdown has no representation for them. | **mitigated (write side)** — `set_table_style` sets cell padding, background, borders, column widths, and pinned header rows on an existing table; `insert_table` sets widths + header shading at creation. Reading these back is not available. |
| **Nothing can be inserted between a table and whatever follows it by anchoring on cell text** — a `deleteContentRange`/insert can't cross a table cell boundary. | Docs API restriction on ranges spanning a cell edge. | **worked around** — `insert_content({at: 'end'})` writes at a structural index instead of an anchor, so a paragraph after a trailing table needs no anchor text. |
| **No whole-table page alignment.** | The Docs API doesn't expose table-level page positioning. | **hard limit**. |
| **`tableRowStyle.tableHeader` can be read but not written.** Sending it on `updateTableRowStyle` fails live with `Unallowed field: tableHeader`. | It's an output-only mirror of the pinned-rows state. | **worked around** — `set_table_style(headerRows: N)` uses the dedicated `pinTableHeaderRows` request instead. |
| **Can't tell which rows land on which printed/scrolled page**, so nothing can verify or fix a row split across a page boundary. | Pagination is computed at render time by the Docs layout engine (font metrics, page size, margins); it's never part of the document JSON `batchUpdate`/`documents.get` return. | **hard limit** — must be checked visually in the editor. (Pinning header rows to repeat on every page *is* supported: `set_table_style(headerRows: N)` — #19.) |

---

## Markdown rendering coverage

| Limitation | Why | What gdocs-mcp does |
|---|---|---|
| **Code blocks aren't rendered** from pushed markdown yet. | Not a Google limit — a not-yet-built writer feature. | **roadmap** — Tier-2 block rendering. |
| **Tables/images embedded *in* pushed markdown** render on `create_doc`/`overwrite_doc`; standalone insertion is via `insert_table`/`insert_image`. | — | **mitigated**. |
| **Two inline containers of the same tag can't nest** — `<span …><span …>x</span></span>` closes the outer span on the inner one's end tag. | The inline patterns are regexes; matching balanced same-tag nesting needs a real parser. | **documented** — the reader never emits this shape (every style of a run goes in one span), and one span carrying both properties (`style="color:blue;font-size:14pt"`) is the supported spelling. Different tags nest fine (`<u>**x**</u>`, #31). |

> Only the code-block row here is a `gdocs-mcp` roadmap item; everything else on this page is a Google-API constraint.
