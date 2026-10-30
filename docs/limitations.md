# Limitations imposed by Google's APIs

Everything here is a **constraint of the Google Docs / Drive APIs — not a bug in `gdocs-mcp`.** Where a constraint has a workaround or a partial mitigation, the last column says what the server does instead. If Google adds first-class support for any of these, we'll revisit.

**Each row about a missing API feature names the request that fails, so it can be tried again.** Google adds requests over time (suggestions and comments arrived in 2026). After each check, open an issue to check again in a month; the interval is changed at each check.

Legend for "What gdocs-mcp does": **mitigated** = a tool works around it; **surfaced** = you're told about it in the tool result/description; **hard limit** = no workaround exists.

---

## Suggestions (tracked changes)

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Some changes cannot be suggested.** A new tab, deleting a header or footer, a named range, a table column width, and some document-style fields. | `writeMode: SUGGEST` does not support `AddDocumentTab`, `DeleteHeader`/`DeleteFooter`, `CreateNamedRange`/`DeleteNamedRange`, `UpdateTableColumnProperties`, `UpdateDocumentTabProperties`, `DeleteTab`, or some `UpdateDocumentStyle` fields (`useFirstPageHeaderFooter`, `useEvenPageHeaderFooter` and `documentFormat` are refused; margins, page size, orientation and the page background are not, checked live). | **surfaced** — an `edit_doc` or `write_doc` with `suggest: true` that needs one (or that writes a header or footer the doc does not have yet) is refused before anything is sent, naming it; it is never split into a suggested part and a direct part. `set_page_setup` has no `suggest`. |
| **A row or column deleted as a suggestion stays in the table until it is accepted,** and a retyped cell can show a "Format" suggestion nobody made. | A suggested delete only marks the row (`suggestedDeletionIds`), and a style reset sent for a style that is not set is still recorded as a suggestion. | **handled** — a suggested table edit addresses later requests where rows now sit, leaves out the rows and columns it just suggested deleting when it checks the table's shape, and sends no style reset for a cell of unstyled words (DESIGN.md §2d). In `read_doc(mode: "tracked")` the cells of a suggested row carry `<ins>`/`<del>` tags (an empty cell carries them empty); quote the text without the tags in `edit_doc`. |
| **A change next to your own pending suggestion joins it.** | Docs folds a new suggested change into a touching suggestion by the same person (checked live). | **surfaced** — `edit_doc` and `write_doc` read the doc once after a suggested write and return the ids of the suggestions that now hold the edited text, so the list is never empty after a write; it can include one that already existed (yours, that the change joined). |
| **A user with comment access can suggest and comment, but not edit, accept, or reject another person's suggestion.** | Checked live: a commenter's `batchUpdate` with `writeMode: SUGGEST` and `insertComment` work; a direct edit, `acceptSuggestion`, and `rejectSuggestion` of someone else's suggestion are refused with 403 "Write access is required, comment-only access is not sufficient". A commenter can reject their own suggestion. | **surfaced** — `edit_doc` and `write_doc` without `suggest` say "you can only suggest on it: pass suggest: true"; `apply_suggestions` says that comment access can reject only the caller's own suggestions. The role is not looked up first: the refusal is Google's, so it is never out of date. Other write tools (`set_page_setup`, a tab `drive mv`, `share_doc`, `unshare_doc`) still show Google's own message. |
| **A replace cannot keep tab stops, suggestions, comment anchors, or the elements the API cannot make.** `write_doc` to an existing doc or tab rebuilds the body from markdown. | The Docs API rejects `tabStops` on `updateParagraphStyle`, cannot make the elements listed under "Elements the API can read but not make" below, leaves a section break's page setup and headers outside the markdown (#57), cannot move a comment's range or re-create someone else's suggestion, and does not expose a bookmark itself at all — only links that point at one (verified live, #55). | **surfaced** — the first `write_doc` call is refused with a loss summary counting each (section breaks and those elements included; the footnotes, chips and dropdowns the API can make are written back, so they are not counted), and only the same summary passed back as `confirmLoss` (which also binds the doc's revision) proceeds. With `suggest: true` nothing is lost until a person accepts, so it does not ask. Two counts are approximate: a **comment** added through Drive has no range, so it is counted for the whole doc — the summary says so for a multi-tab doc; **bookmarks** are counted as links to a bookmark or heading, so a bookmark nothing links to is not listed. |

> Suggestions are written, read and resolved by the Docs API itself: `writeMode: SUGGEST`, `SuggestionThread` (with author and time), and `acceptSuggestion`/`rejectSuggestion`. See [DESIGN.md](../DESIGN.md) §6.

---

## Comments

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **A comment added through Drive has no range,** only its quote. Comments left that way before, or by other tools, stay so. | The Drive comments API cannot attach a programmatic comment to a text range. | **mitigated** — `add_comment` writes through the Docs API, which anchors it to the range `quotedText` matches (DESIGN.md §7). A comment with no range is still listed, with its quote as `context`. |
| **No comment author email** — display name only. | Neither API returns the email (the Docs API gives a People API resource name). | **hard limit** — author name is shown as returned. |

---

## Styling & computed properties

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Style is a small CSS subset** — `text-align`, `line-height`, `margin-top`/`bottom`/`left`/`right`, `text-indent` on paragraphs; `font-family`, `font-size`, `font-weight`, `font-style`, `text-decoration`, `color` on runs and named styles. Borders, shading, keep-with-next, tab stops and text direction are not expressible. A page break is: it reads as `<div style="page-break-after:always"></div>` on its own line and writes back (#48). | The markdown carries CSS only for what the writer can apply. A property outside the list would be lost on write, so it is refused rather than silently dropped; a Docs property outside the list is not shown by `read_doc`, so `read_doc` → `write_doc` drops it. A tab character survives the round trip (#54), but the tab stop and leader it aligns to do not. | **surfaced** — `write_doc`/`edit_doc` refuse any other property before sending a request, in one error naming every offending line and the supported set (#49). List items carry no indent in the read: their nesting owns it, and markdown has no way to write one. |
| **Inserted text inherits formatting from the insertion point** — and inside a single `batchUpdate`, from text deleted earlier in that same batch. | Google Docs behaviour: `insertText` carries the character style of the surrounding position, and a batched delete+insert is treated as continuous. | **mitigated** — the markdown writer clears direct character styling over the range it inserts before applying what the markdown specifies, so `write_doc`/`edit_doc` produce what was written, not what was there (#32). Named styles are untouched, so document-level fonts still inherit. Paragraph style is cleared too, for what is new: `write_doc` clears it when it replaces (#49), and a block `edit_doc` adds is Normal text with no bullet unless the markdown says otherwise (#60). Text added inside an existing paragraph keeps that paragraph's style. |

---

## Headers & footers

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Only the *default* header/footer can be created via the API.** A first-page or even-page one has to be enabled in the editor first. | `createHeader`/`createFooter` take a type but the API rejects creating the first/even variants. | **mitigated** — `write_doc` with `segment` creates the default header/footer; asking for `page: 'first'`/`'even'` on a doc that lacks one is refused with "Turn on Different first page in Docs (Format → Headers & footers), then retry." instead of silently making the wrong thing (#60). |
| **Header/footer content is invisible to a body read** — it is a separate content tree, not part of `body.content`. | By design in the Docs data model. | **mitigated** — every content tool takes `segment: 'header'\|'footer'` — the text tools since #23, and the table and suggestion tools since #28 — and a body read reports which segments exist and what they hold. |
| **A page-number or page-count field cannot be created.** | The Docs API returns one as an `autoText` element of type `PAGE_NUMBER` or `PAGE_COUNT`, but none of its batchUpdate requests inserts one (a docx with a PAGE field converts to one, so the type is real; no request makes one, #63). | **mitigated** — `write_doc`'s loss summary counts every such field in what the replace would remove ("1 page-number field"; a body or tab replace counts that body only, since it leaves headers and footers alone, and a `segment` write counts that header or footer), so a replace that would delete one asks first. To get a doc with one: make a template doc with the field added by hand in Docs (Insert → Page numbers), then `drive cp` it and write into the copy's body, leaving the footer in place. |

---

## Elements the API can read but not make

Each of these reads (DESIGN.md §2f) and is kept by an edit that gives it back unchanged; an edit that drops one deletes it. Writing a new one is refused before anything is sent, naming the element. A `write_doc` replace counts each one that sits in the doc (a footnote cannot be in a header, so it has nothing to count).

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **A horizontal rule cannot be made.** | `horizontalRule` is a paragraph element; no batchUpdate request inserts one (no `insertHorizontalRule`). | **surfaced** — reads as `---`; a new `---` is refused. |
| **A column break cannot be made.** | `columnBreak` is a paragraph element; there is no `insertColumnBreak`, and `insertText` strips the control character (#48). | **surfaced** — reads as `<span style="break-after:column"></span>`; a new one is refused. |
| **An equation cannot be made.** | `equation` is a paragraph element; no request inserts one. | **surfaced** — reads as `<span class="equation">…</span>`; a new one is refused. |
| **A page-number or page-count field cannot be made.** | `autoText` of type `PAGE_NUMBER` / `PAGE_COUNT`; no request inserts one (#63). See also Headers & footers. | **surfaced** — reads as `<span class="page-number">7</span>`; a new one is refused. |
| **A link chip can be made only for a Google Drive file.** | `insertRichLink` answers "The URL is invalid" for YouTube, Calendar, Maps and web URLs, and "Error fetching chip data" for a Drive id that names no file (checked live, #58). Docs makes YouTube chips in the editor. | **surfaced** — a new `<a class="chip">` to anything but a Drive file is refused with the plain link to write instead. |
| **A date in an imported format cannot be made again.** | `DATE_FORMAT_CUSTOM` is output only; `insertDate` takes the four other formats. | **surfaced** — the date reads with the text Docs shows and is kept by an edit; a replace counts it. |
| **A footnote cannot go in a header, footer or another footnote.** | `createFootnote` refuses those segments. | **surfaced** — refused, naming why. |

---

## Images

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Inline only** — no floating / text-wrapped / exact x,y positioning. | The Docs API can only insert *inline* images (with size + left/center/right alignment). | **hard limit** — `edit_doc` and `write_doc` take `<img width height>` and a centered `<p style="text-align:center"><img …></p>`; floating layout is unavailable. |
| **Embedded images are downscaled + re-encoded.** A pulled image is visually identical but **not** byte-identical to your original. | Google re-encodes embedded images to ≤ 2048 px on the long edge. | **surfaced** — `download_images` returns a `sha256`; keep your local files as the quality source of truth. |
| **Images don't round-trip as URLs** — the source link isn't recoverable on read-back. | Google stores the embedded bytes, not the original URL. | **mitigated** — `read_doc` marks each position as `<img src="image:<objectId>" width="…" height="…">`, carrying the size (points), and `download_images` pulls the actual bytes. Writing that marker back is refused with an explanation rather than a missing-file error, since the bytes aren't re-fetchable from the id (#30). |
| **Image alt text can't be written.** `read_doc` surfaces it as `alt="…"` when a document has it, but an `alt` you write is ignored. | The Docs API has 33 batchUpdate request types and none sets an embedded object's title/description; `insertInlineImage` takes only a location, uri and size. | **hard limit** — set it in the editor. |
| **Can't tag or checksum-match the image itself** inside the doc. | No API field to stamp an identity on an embedded image. | **mitigated** — `write_doc` returns each image's `{ src, objectId }`; an agent keeps a small sidecar (`objectId → local file + hash`) to detect changes. The mapping must be *recorded*, not inferred. |

---

## Tables

| Limitation | Why (API reason) | What gdocs-mcp does |
|---|---|---|
| **Deeper table styling flattens in the markdown.** Merged cells, cell colors, borders, column widths and pinned header rows are not carried by a pipe table. | Markdown has no syntax for them, so the *markdown* cannot carry them. The Docs API returns them all — this was never an API limit. | **resolved** — a table with nothing but Docs defaults reads as a pipe table; any other reads as an HTML `<table>` carrying the same style as CSS (`border`, `padding`, `background`, `vertical-align`, `width` on `<col>`, `height` on `<tr>`, `colspan`, `rowspan`, `<thead>` for the pinned rows), and `edit_doc` changes it with a style-only edit (#61). Border, padding and background sit at the narrowest level every cell under them shares; a border Docs reports in a dash style HTML does not name (long dash, dash-dot) reads as `dashed`. |
| **Nothing can be inserted between a table and whatever follows it by anchoring on cell text** — a `deleteContentRange`/insert can't cross a table cell boundary. | Docs API restriction on ranges spanning a cell edge. | **worked around** — `edit_doc` keeps what comes back unchanged and puts new blocks after the whole table, so quoting the table's last row and writing it back with a paragraph after it adds the paragraph without crossing a cell edge (#60). |
| **A row or column cannot be moved.** The Docs API has `insertTableRow`/`deleteTableRow` (and the column pair) and no move, so a moved row is a delete and an insert and the comments anchored in its text are lost. | Docs API has no move request, and no request moves a comment's range, so a comment cannot be re-attached. | **mitigated** — `edit_doc` counts the comments whose range falls in the moved row or column, and those with no range whose quoted text is in it, and asks once with `confirmLoss`, as `write_doc` does; a move with no such comments does not ask (#62). The count can be too high, never too low. |
| **No whole-table page alignment.** | The Docs API doesn't expose table-level page positioning. | **hard limit**. |
| **`tableRowStyle.tableHeader` can be read but not written.** Sending it on `updateTableRowStyle` fails live with `Unallowed field: tableHeader`. | It's an output-only mirror of the pinned-rows state. | **worked around** — `<thead>` in the HTML table is exactly the pinned rows, and the writer sends the dedicated `pinTableHeaderRows` request for it (#61). |
| **Can't tell which rows land on which printed/scrolled page**, so nothing can verify or fix a row split across a page boundary. | Pagination is computed at render time by the Docs layout engine (font metrics, page size, margins); it's never part of the document JSON `batchUpdate`/`documents.get` return. | **hard limit** — must be checked visually in the editor. (Pinning header rows to repeat on every page *is* supported: `<thead>` in the HTML table — #19, #61.) |

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
| **Drive's export cannot export one tab.** `files.export` always renders every tab. | The documented API has no tab parameter. | **worked around, on an undocumented endpoint** — `export_doc` on a tab path of a multi-tab doc uses the Docs UI's `docs.google.com/document/d/<id>/export?format=<f>&tab=<tabId>`, which the OAuth token is accepted on and which scopes the output for every format (verified live for txt, md, html, rtf, epub, docx, odt; pdf renders 1 page instead of 2, #55). It exports only that tab, not its child tabs. Google does not document it, and it answered 429 to a burst of requests, so if it fails `export_doc` throws, names the doc path, and never falls back to the whole doc. A doc path exports every tab, as before; a one-tab doc goes through Drive. |

---

## Markdown rendering coverage

| Limitation | Why | What gdocs-mcp does |
|---|---|---|
| **Docs has no code-block or blockquote style.** | A paragraph is the only block, so both are paragraphs with direct styling. | **mitigated** — a fenced or four-space-indented code block is one Courier New paragraph with line breaks and every space kept, and a paragraph that is Courier New throughout reads back as a fence (the language tag is dropped; a code run that is also bold, sized or coloured stays a code span). A `>` quote is a paragraph indented 36pt with a 1.5pt #cccccc left border, read back as `> `; a paragraph with that border and other paragraph styling reads as a styled paragraph, not a quote. One quote level only: `>>`, and a list, heading or code block inside a quote, are refused, naming the line (#59). |
| **Tables/images embedded *in* pushed markdown** render on `write_doc` and `edit_doc`; there are no standalone insert tools. | — | **mitigated**. |
| **Two inline containers of the same tag can't nest** — `<span …><span …>x</span></span>` closes the outer span on the inner one's end tag. | The inline patterns are regexes; matching balanced same-tag nesting needs a real parser. | **documented** — the reader never emits this shape (every style of a run goes in one span), and one span carrying both properties (`style="color:blue;font-size:14pt"`) is the supported spelling. Different tags nest fine (`<u>**x**</u>`, #31). |

> Nothing on this page is a `gdocs-mcp` roadmap item: each row is a Google-API constraint or the way a markdown construct is mapped to Docs.
