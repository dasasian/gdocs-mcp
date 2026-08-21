# Recipes — what you can ask Claude to do

gdocs-mcp lets an AI agent treat a Google Doc **like a local file**. You don't call
tools directly — you ask Claude in plain language, and it drives the right tools.
These are real, task-shaped examples. Each shows the kind of prompt that works, the
tools it fires, and what you get back.

> Tip: give Claude the doc's URL or id (or a distinctive title it can
> search for with `drive({ cmd: "find" })`). For layout/style tasks, point it at a reference doc to match.

---

## Whole jobs — several tools, one ask

These are the ones that change how a day goes. Each is a single instruction that
fans out into several tools; doing any of them by hand is an afternoon.

### A. Fill a template without rebuilding it

**Ask Claude:** *"Copy the Proposal Template into /Clients/Acme, name it 'Acme Q3
Proposal', then fill in the client name, the dates, and the pricing table."*

**What happens:** `drive({ cmd: "cp" })` duplicates the template, so the letterhead,
the logo at its exact size, the fonts and the page setup come along intact. Then
`edit_doc` swaps each placeholder by content, and `edit_table` fills the pricing
rows.

**Why it's nice:** a template is precisely the thing a markdown round-trip *cannot*
rebuild — headers, footers, image sizing, the fiddly formatting somebody spent an
hour on. Copying keeps all of it and edits only the words that change. The
alternative is retyping a document you already have.

---

### B. A whole review pass in one instruction

**Ask Claude:** *"Go through this doc: show me the pending suggestions as a diff,
accept the typo fixes, reject anything that changes meaning, then reply to the open
comments and resolve the ones that are settled."*

**What happens:** `list_suggestions` renders each pending tracked change as
`before → after` so Claude can judge it, `apply_suggestions` accepts and rejects in
atomic batches, `list_comments` pulls the open threads with their quoted text, and
`add_comment`/`resolve_comment` reply and close them.

**Why it's nice:** four tools, one sentence, and the judgement in the middle is the
part you actually wanted help with. Most Docs integrations cannot see tracked
changes at all, let alone act on them safely.

---

### C. Publish a folder of markdown as a Drive tree

**Ask Claude:** *"Mirror the folder structure of ./handbook under /Handbook in
Drive, and publish every .md file there as a Doc."*

**What happens:** `drive({ cmd: "mkdir", args: ["-p", …] })` builds each folder path
in one call per branch, and `create_doc` with `contentFile` renders each file
server-side — headings, tables, images and all — straight into the right folder.

**Why it's nice:** the structure and the content arrive together. Nothing is
retyped, so nothing is silently dropped from the long files.

---

### D. Audit many documents at once

**Ask Claude:** *"Find every doc with 'Lease' in the title, then check each one's
margins and body font against the 2026 template and tell me which are off."*

**What happens:** `drive({ cmd: "find" })` locates them — including files that sit in
no folder and that browsing would never show — then `get_page_setup` and `get_style`
read each one's real, inherited-resolved values, which markdown cannot express.

**Why it's nice:** consistency drift across a folder of documents is invisible until
someone opens all of them. This reads them instead.

---

### E. Bring a doc back into the repo

**Ask Claude:** *"Pull the latest Spec doc into ./spec.md with its images, and commit
it."*

**What happens:** `read_doc` renders the doc as markdown (styling included, as
`<span style>`, so it survives a round trip), `download_images` fetches the embedded
images next to it, and Claude commits the result.

**Why it's nice:** the doc stops being a place work goes to die. It round-trips.

---

## Single moves

One tool, one job — the building blocks the whole jobs above are made of.

### 1. Publish a markdown file as a formatted Google Doc

**Ask Claude:** *"Create a Google Doc titled 'Q3 Report' from `./report.md` and put it in my Reports folder."*

**What happens:** `create_doc` with `contentFile: ./report.md` — the server reads
the file directly (no retyping, so nothing gets dropped from long docs), renders
headings, **bold**/*italic*, links, nested lists, tables, and images, and drops it
in the folder.

**Why it's nice:** for a 6,000-word doc, passing the file beats pasting the text
inline — that's the difference between a clean publish and silently fused sentences.

---

### 2. Restyle a whole document's font — without losing the bold

**Ask Claude:** *"Set the entire doc to Georgia 11pt to match our house style."*

**What happens:** `set_style` with `whole_document: true` applies the font across the
whole doc in one call (no per-paragraph loop). Bold headings **stay bold** — the
server works around a Google API quirk where changing the font otherwise strips the
bold attribute.

**Variant:** *"Make just the signature block at the bottom Times New Roman."* →
`set_style` with a `from`/`to` selection styles the whole span between two anchors,
no need to quote everything in between.

---

### 3. Review and resolve tracked-change suggestions

**Ask Claude:** *"Show me the pending suggestions as a diff, then accept the wording
fixes and reject the deletions."*

**What happens:** `list_suggestions` returns each pending change as `before → after`;
`apply_suggestions` accepts/rejects them in one atomic update. Overlapping or
adjacent suggestions (a "cluster") are resolved together — resolving them one at a
time would corrupt neighbours, so the tool refuses a partial cluster.

**Why it's the headline:** most tools can't even *see* tracked changes correctly.
This one reads them as diffs and acts on them safely.

---

### 4. Mirror another document's page layout

**Ask Claude:** *"Match this new lease's margins, page size, and orientation to the
existing lease at <url>."*

**What happens:** `get_page_setup` reads the source doc's margins / size / orientation
(and reports the preset name, e.g. "a4"), then `set_page_setup` applies the same to
the new doc. The read/write pair makes "make this look like that" a two-step ask.

---

### 5. Edit by content, never by position

**Ask Claude:** *"In the lease, change 'net 30' to 'net 15' wherever it appears."*

**What happens:** `edit_doc` matches your text against the doc's plain text
(markup-tolerant, whitespace-normalized, matches across bold/italic boundaries) and
replaces it. No line numbers, no character offsets — the same muscle memory as
editing a local file. Ambiguous match? It lists each occurrence with surrounding
context so you can disambiguate.

---

### 6. Build and reshape real tables

**Ask Claude:** *"Turn my markdown table into a real table with a shaded header, then
add a row under 'Deposit' and widen the first column."*

**What happens:** `insert_table` renders the table (with header shading and column
widths); `edit_table` inserts the row (located by the cell text "Deposit", no
indices); `set_table_style` adjusts padding / background / column widths on the
existing table.

---

### 7. Center a block, add a signature line

**Ask Claude:** *"Center the address block, and set the whole intro paragraph to
justified."*

**What happens:** `set_style` sets paragraph alignment over the selection. Reading
the doc back returns the same `<p style="text-align:center">…</p>` you can reuse —
alignment and in-paragraph line breaks (`<br>`) round-trip between read and write.

---

### 8. Work the comment thread

**Ask Claude:** *"Reply to Dana's comment saying it's fixed, then resolve it."*

**What happens:** `list_comments` finds the thread; `add_comment` with `replyTo`
posts the reply; `resolve_comment` closes it (verified against the comment's quoted
text so it won't resolve the wrong one).

---

### 9. Pull a Doc back to markdown + images

**Ask Claude:** *"Download <doc> as markdown with its images into `./exported/`."*

**What happens:** `read_doc` returns markdown (with `![](image:<id>)` markers) and
`download_images` saves every embedded image to the folder with an id→filename map —
the inverse of publishing, so a Doc can round-trip back to files.

---

### 10. Across accounts and folders

**Ask Claude:** *"Using my work account, share this doc with dana@acme.com as a
commenter, and turn on anyone-with-link viewing."*

**What happens:** the `account` arg (or a per-project `.gdocs-mcp.json` default)
selects the Google account; `share_doc` grants Dana commenter access, and a second
`share_doc` call with no email sets anyone-with-link to reader.

---

### Phrasing that works well
- **Point at references:** "match the font/margins of <url>" beats "make it look nice."
- **Name the anchor text:** "change the 'net 30' clause" — the tools locate by content.
- **Batch it:** "restyle the whole doc," "resolve all the wording suggestions" — the
  tools have whole-document and multi-item paths so Claude won't loop needlessly.
- **Ask to verify:** "then read it back and confirm" — Claude can re-read the doc to
  show you the result.
