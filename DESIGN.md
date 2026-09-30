# gdocs-mcp — Design

An MCP server that lets an AI agent (Claude Code) treat a Google Doc **like a local file** — read it, edit it by content, review and act on suggestions, manage comments, work across tabs, and across multiple Google accounts.

The goal is not broad Workspace automation. It is the specific, unoccupied quadrant: **suggestion- and comment-aware, file-like editing of Google Docs for an AI agent.**

> This doc is the design *reasoning* (the empirical findings behind each decision). For a consolidated, user-facing list of what Google's APIs won't allow — and how the server works around or surfaces each — see **[docs/limitations.md](docs/limitations.md)**.

---

## 1. Core model — the Doc *is* the file

There is no canonical local copy and no continuous sync in the core model. The Google Doc is the source of truth, and the agent interacts with it through the same primitives it uses for local files: read, edit (by unique string), write, search.

(Multi-file ⇄ tabs reconciliation is a separate, later layer — see §10.)

### Why this over "sync"
- No source-of-truth ambiguity for the common case.
- Editing maps directly to the agent's existing `Read`/`Edit`/`Write` muscle memory.
- It sidesteps the Docs API's worst limitation (see §6) instead of fighting it.

---

## 2. Interface format — markdown + inline HTML

The agent reads and writes **GitHub-flavored markdown with inline HTML**:

- **Content & inline emphasis** → markdown (`#`, `**bold**`, lists, tables, links).
- **Docs-only formatting** markdown can't express (alignment, color, font, size, spacing, indent, image dimensions) → CSS, in the two places a web page puts it (§2a): a `<style>` block for the document's defaults, and `style="…"` on a `<p>` or `<span>` that differs from them. `<img width="400">` for images.
- **Suggestions / tracked changes** → HTML `<ins>` / `<del>` with an ID marker (`data-sug` attribute or `<!-- sug:id -->`).

This single format does both jobs: formatting is **visible in the read** (so the agent can perceive *and* verify style changes), and it is a format the agent authors natively. It replaces an earlier "clean markdown + separate formatting sidecar" idea.

"Visible in the read" is the load-bearing half, and it was aspirational for a
while: the writer parsed `<span style="color:…">` and `<img width>` long before
the reader emitted either, so a colour change or an image's size simply vanished
on the next read — the agent could not verify its own edit. Closed in #30. The
rule that follows: a construct the writer accepts must be a construct the reader
emits, or the escape hatch is a one-way valve.

Markdown is otherwise a ceiling — it cannot express alignment, color, fonts, image sizing, etc. The HTML escape-hatch is what lifts that ceiling.

### 2a. Style is CSS, and the read is the only place to see it

There is one place style lives: the markdown `read_doc` returns. No separate style
reader, no separate style writer. The agent already knows how a web page is styled,
so the doc is styled the same way:

```
<style>
p        { font-family: Arial; font-size: 11pt; margin-bottom: 8pt }
h1       { font-size: 20pt; font-weight: bold }
.title   { font-size: 26pt }
</style>

# Agreement
<p class="title">Operating Agreement</p>
<p style="margin-left:36pt; text-indent:-18pt">4. Term. The Company shall…</p>
```

- **The `<style>` block is the named styles.** One rule per named style: `p` is
  Normal text, `h1`–`h6` the headings, `.title` / `.subtitle` the two named styles
  HTML has no tag for (a paragraph in one reads as `<p class="title">`). Editing a
  rule is one `updateNamedStyle`, so the whole document restyles by inheritance,
  exactly as the CSS cascade says it should. Live-verified: `updateNamedStyle`
  rejects the request unless `namedStyleType` is in its field mask.
- **`style="…"` appears only where a paragraph or run differs from its rule.** A
  paragraph with no `style` inherits; that is what "inherited" means, and the agent
  reads it without being told. Emitting every resolved value on every paragraph
  would double the read and bury the text `edit_doc` anchors on.
- **Units are `pt`.** Docs stores points; converting to `in`/`em` on the way out
  would make every round trip lossy.
- **CSS and Docs measure first-line indent differently.** CSS `text-indent` is
  relative to `margin-left`; Docs `indentFirstLine` is measured from the page
  margin. The reader emits `text-indent = indentFirstLine − indentStart` and the
  writer adds it back, so a hanging indent reads as the negative `text-indent` a
  web author would write.
- **List nesting owns list indent.** A list item's indent comes from its nesting
  level, which markdown already carries. The reader never emits `margin-left` or
  `text-indent` a list's nesting explains; emitting it would indent the item twice
  on the next write, and again on every read → write after.

**A property the writer can't apply is an error, not text.** The supported set is
small and named in `markdown-spec`. A `style` holding anything else — `border`,
`float`, a typo — fails the whole write before any request is sent, and the error
names every offending line and the supported set, so the agent fixes all of them
in one retry. The bug this replaces (#49): the writer knew one shape,
`<p style="text-align:…">`, and wrote any other `<p style>` into the document as
visible characters. An agent that inferred `text-indent` from `text-align` — a
correct inference about CSS — shipped the literal tag into a legal document.

### 2b. Text that looks like markup reads as text

A read, written back unchanged, must give back the same document. That fails
whenever the document's own text happens to spell markup: a clause typed as
`4. Term` is a Normal paragraph in Docs, but the same characters in markdown are
an ordered list, and the next `write_doc` makes it one (#52). The reader
therefore marks such text as literal, in one of two ways:

- **A line start that would parse as a block** — `4.`, `4)`, `-`, `*`, `+`,
  `#`, `- [ ]`, and lines the writer treats as structure (`![alt](src)`,
  `<!--`, `<style>`) — reads as `<p>4. Term…</p>`. The same `<p>` that carries a
  paragraph's style in §2a, so there is one rule: `<p>` is a plain paragraph, and
  a paragraph that also has a style is one tag (`<p style="…">4. Term…</p>`).
  Wrapping beats the CommonMark escape `4\.` because the agent copies what it
  sees: asked to add clause 5 in the same format, Haiku reproduced `<p>` 10/10
  and `4\.` 6/15 — the misses wrote a bare `5.`, which is the bug again.
- **Mid-line text that would parse as inline markup** — `5 * 3 * 2`,
  `[Name](the Company)`, `~~draft~~`, a literal `<b>` — reads with a CommonMark
  backslash (`5 \* 3 \* 2`). A single character can't be wrapped, so this is the
  only form available. A real backslash before punctuation reads as `\\`.
- **A line that starts or ends with a space or tab** — `⇥Indented clause`,
  `Signature:⇥` — reads as `<p>⇥Indented clause</p>`. Markdown drops edge
  whitespace (and four leading spaces are a code block), but in Docs it is
  content: a trailing tab against a tab stop with an underline leader *is* the
  signature line (#54). Tabs stay tabs; a tab and spaces are not the same thing
  in Docs. A tab in the middle of a line needs no mark.

Inside `<p>…</p>` the writer keeps every space and tab exactly, whether the `<p>`
came from a read or the agent typed it. Outside `<p>`, edge whitespace on a line
is still trimmed, so stray spaces an agent types are harmless.

**The writer's parser decides.** The reader keeps no list of what counts as
markup. It renders the line, parses it the way the writer will (`parseBlocks`,
`parseInline`), and marks only if the result is not one plain paragraph of the
same words; the escape set is then the smallest set of punctuation kinds that
restores the same parse. So `file_name_here`, a signature line of underscores,
`<Client Name>`, `---`, and a lone `>` (the writer has no blockquote) already
round-trip and stay clean, and a new construct taught to the writer is marked
by the reader with no second edit. Table cells and header/footer segments use the
same path; a cell also accounts for the `\|` pipe step its row goes through.

The writer accepts both forms, and CommonMark escapes anywhere, so an agent that
writes Google's own export style (`4\. Term`) gets a plain paragraph too. Either
way the document stores only the text; the next read shows the one canonical form.

### 2c. A page break is a CSS break, on its own line

A page break (Insert → Break → Page break; a `pageBreak` element in the Docs
API) reads as

```
<div style="page-break-after:always"></div>
```

on its own line where the break is, and a read written back keeps it (#48). This
is the spelling markdown-to-PDF tools already use, so a local `.md` holding a
read renders the break when printed and shows nothing in a GitHub or VS Code
preview. Google's own HTML export writes `<hr style="page-break-before:always">`
instead; a bare `<hr>` is a visible rule wherever the style is stripped, so the
read does not use it.

The writer accepts the common spellings — that `<div>`, Google's `<hr>`, and the
modern `break-before: page` / `break-after: page` — in `write_doc`, `edit_doc`
and `insert_content`, and sends `insertPageBreak`. There is no page-break tool.
A `<div>` or `<hr>` on its own line that is anything else is refused the way §2a
refuses unsupported CSS: a bare `<hr>` or `<div style="color:red">` is an error,
not text. Text that really spells the line reads as `<p>…</p>` (§2b), since the
writer's own parser sees a break there, and stays text.

**How a break sits in the Docs JSON** (checked live, #48). `pageBreak` is a
one-index paragraph element. `insertPageBreak` at index *i* puts the break at *i*
and adds a paragraph mark after it, so where the break lands decides the shape:

- at the start of a paragraph: a paragraph of its own, `[pageBreak, "\n"]`, then
  the paragraph that was there. This is what the writer produces.
- at the end of a paragraph's text (`insertPageBreak` at the end of "Title page", the issue's probe):
  `["Title page", pageBreak, "\n"]`, then an *empty* paragraph, then the body.
- with text inserted after it: `["Third", pageBreak, "tail\n"]`. Made through
  the API by inserting text after the break (not tried in the Docs UI); the reader handles it.

The reader splits a paragraph at each `pageBreak` and emits the text before, the
`<div>` line, and the text after; an empty piece is skipped, which is also why the
empty paragraph Google adds never shows. All three shapes read the same, so read →
write → read is identical, and the writer's shape (no empty paragraph) is what the
second read finds. `edit_doc` projects a break as its line, with a newline on
each side when text shares its paragraph, so `Title page\n<div …></div>` matches
both shapes; an anchor across a break deletes it with the rest.

Two things the design did not foresee. The break's new paragraph **inherits the
heading style and bullet of the paragraph it lands in** (verified: a break at the
start of a Heading 1 or a list item came out as a heading or list item), so the
writer resets each one to Normal text with no bullet. And **a break in a header or
footer is refused by the API**, so the writer refuses it first, naming why.

Section breaks and column breaks are not carried: a section break holds its
own page setup and headers, which is its own design (#57). The read does not
show them, and `write_doc`'s loss summary counts them (§4). A column break cannot
be made through the API at all (`insertText` strips the control character and
there is no `insertColumnBreak`); it is counted from the documented
`columnBreak` paragraph element.

---

## 3. Tool surface

The canonical, always-current list is the table in `README.md`; this is the
conceptual map. The surface is kept deliberately small (~25 tools) — see
`CLAUDE.md` for the add-vs-enhance discipline (merge symmetric verbs; a new tool
only when the vocabulary/return-shape differs; destructive verbs stay distinct).

| Tool | Role |
|---|---|
| `read_doc(path, mode, segment?)` | Read as markdown+HTML — a `<style>` block of the named styles, `style="…"` where a paragraph or run differs, images as `<img src="image:…" width height>` (§2, §2a). `mode`: `clean` (default) · `tracked` (`<ins>/<del>`+IDs) · `accepted` · `rejected`. `segment`: `body`/`header`/`footer`/`all` (§3a) |
| `edit_doc(path, old_string, new_string, replace_all?, strict?, segment?)` | String-anchored edit (the workhorse). Also the only style writer: a `style`, a class, or a `<style>` rule (§2a, §4) |
| `write_doc(path, content\|contentFile, confirmLoss?)` | The local `Write`: creates the doc or tab when the path names nothing, replaces it when it names something — **guarded** (§4) |
| `insert_content(path, content\|contentFile, at?)` | Insert new content at a structural position (`end`/`top`/anchor) — the non-anchored counterpart to `edit_doc` (§4) |
| `export_doc(path, dir, format?, filename?)` | Server-side render to pdf/docx/odt/rtf/txt/html/epub/md. A doc path (or a one-tab doc) goes through Drive `files.export`, which renders every tab; a tab path of a multi-tab doc goes through the Docs UI's `export?tab=` endpoint — undocumented and throttled, so a failure is refused, never widened to the whole doc (`docs/limitations.md`) |
| `set_page_setup / get_page_setup(path)` | Document page setup: margins, page size, orientation |
| `insert_image(path, at, uri, width?, height?, align?, baseDir?, segment?)` | Images from a URL or a local file (markdown can't size/place them) |
| `insert_table(path, rows, cols, data?, align?, segment?)` · `edit_table(path, cell, op, side?, segment?)` · `set_table_style / get_table_style(path, cell, segment?)` | Tables: create (cells take inline markdown), insert/delete row-or-column, style and read style back. `segment` reaches a letterhead table (§3a) |
| `list_suggestions(path, segment?)` | Suggestions as before→after diffs |
| `apply_suggestions(path, resolutions[], segment?)` | Resolve one or more suggestions atomically (§6) |
| `list_comments / add_comment(replyTo?) / resolve_comment` | Drive comments (`add_comment` also replies) |
| `drive(cmd, args, expectName?, index?, acceptOwnershipTransfer?)` | Drive as a shell: `ls` · `find` · `mkdir` · `cp` · `mv` over paths (`~`, `/shared/<drive>`, `/shared-with-me`, `/lost+found`) or ids, down into a doc's tabs (§3c, §3d). `mv` covers rename and move, and on a tab rename, nest and un-nest; `index` (tab `mv` only) is the position among its new siblings, because a shell `mv` has no way to say it; `cp` is Drive `files.copy`. Collapsed from five bespoke tools (#44) |
| `list_permissions / share_doc(email?|link) / unshare_doc(email?|permissionId?, expectRole)` | Sharing (person, group, domain, or anyone-with-link). A grant with no email is addressed by the `permissionId` the read returns; `expectRole` is required because a revocation is recorded nowhere (§4) |
| `add_account / list_accounts` | Multi-account (§9) |

Nothing deletes a doc, a folder or a tab. The user does that in Drive or Docs;
the reason is the allowlist argument at the end of §3c.

### 3c. Drive as a filesystem — borrowing a prior, and where it lies

Drive navigation is one tool speaking shell (`ls` · `find` · `mkdir` · `cp` · `mv`)
rather than five bespoke names. The trick this project already plays with markdown
(`read_doc`), the file-edit idiom (`edit_doc`) and CSS (§2a) needs three
conditions to hold together: the vocabulary is **pre-trained**, the namespace is
**stable**, and an **interpreter** is cheap. Miss the first and the surface has not
shrunk — it has moved from a typed schema into prose the model reads less reliably.

The win is not mainly the four tool slots. `ls` versus `find` needs no explanation
where `list_folder` versus `search_drive` did, so the selection problem shrinks
from "one of 36" to "one of 32, then one of five inside a namespace the model knows
cold". Arguments stay positional and differ per command deliberately: a shell is
not uniform, and that variability *is* the pattern being borrowed. Guards are the
exception and stay named fields, per §4 — `expectName` buried in `args[2]` would
not be legible at the call site.

**Where the prior is wrong, the tool refuses rather than half-works.** A borrowed
vocabulary is a liability exactly where the borrowed thing behaves differently,
because the model will not defensively check something no filesystem it learned
from does:

| the prior says | Drive does | response |
|---|---|---|
| one name per folder, case-sensitive | duplicates allowed, matching folds case | refuse with candidates listed; `cp`/`mv` also refuse to *create* the state |
| `cp -r` copies a tree | `files.copy` refuses folders | refuse, and say `-r` cannot help |
| `mv` keeps you the owner | into a shared drive it transfers ownership, irreversibly | refuse without `acceptOwnershipTransfer` |
| `mv` can move a file anywhere | a tab cannot leave its doc | refuse, and say to read the tab and `write_doc` it into the other doc |

**Paths are a convenience over the part of Drive that happens to be a tree.** A
file with no parent is reachable by search and by id but by no path (#46), so
`find` is the complete view and `/lost+found` is where those surface. That is a
property to state, not a bug to fix.

No destructive command ships. There was none in the surface to collapse, and host
permissions are granted per tool *name*: a user who allowlists `drive` so `ls`
stops prompting would be allowlisting `rm` too. See #47. The same argument keeps
`write_doc` out of `drive`: a write that replaces is a delete and a write.

### 3d. Paths — one name for a doc or a tab

Every tool that takes a document takes one `path`, and it names a doc or a tab
the way a file path names a file: an id, a URL, `/Work/Contract`, or
`/Work/Contract/Ch.4`. There is no separate `tab` parameter. The path is walked
one step at a time against Drive; the first step that is a Google Doc switches
the walk from folders to that doc's tabs, and a nested tab is one more step
(`/Work/Contract/Part 2/Ch.4`). An id or URL can start the path,
and what it names decides where the walk begins: a doc id walks into its tabs
(`1wIt…/Ch.4`), a folder id or folder URL walks into the folder
(`<folderId>/Contract/Ch.4`). A step can be a tabId instead of a title.

The file prior holds where the path is ambiguous, because the tool refuses
rather than picks:

| the path | response |
|---|---|
| a doc with one tab | that tab — most docs, so most calls never name a tab |
| a doc with several tabs, no tab step | refused like `cat` on a directory, listing each tab's full path |
| two tabs (or a folder and a doc) with the same name | refused, listing each candidate with its id |

`drive ls <doc>` lists its tabs; `drive mv` renames, reorders and nests them
(`updateDocumentTabProperties`). A new tab is made by `write_doc` to a path whose
last step names nothing yet, exactly as a new doc is — there is no `touch` and no
tab `mkdir`. A path that creates is always absolute (`/`, `~`, a URL or a Drive id start); there
is no working directory to resolve a bare name against, so a bare name is never
created. `write_doc("Meeting notes", …)` is refused, and the refusal opens with
where the doc would go, so the user hears it before anything exists: with a
project default folder (`set_project_default`), "Not created: no folder was
given. This project's default folder for new docs is /Work/Clients. Tell the
user, then call write_doc("/Work/Clients/Meeting notes", …) — or, if the user
wants it at the top of My Drive, call write_doc("/Meeting notes", …)"; with none,
"Not created: no folder was given. Name a folder, e.g. ~/Meeting notes." A bare
string that Drive knows as an id keeps its meaning (it names that doc).

With a default folder set, `/Meeting notes` is a bare name in all but syntax —
no folder was given — and models reached for it (Haiku and Sonnet, 2 of 2 headless
runs, wrote `/Meeting notes` and put the doc at the top of My Drive without
mentioning the default). So a create of a new doc at the top of My Drive (`/Name`
or `~/Name`, one step that resolves to nothing) is refused once: "Not created:
this project's default folder for new docs is /Work/Clients. Tell the user, then
call write_doc("/Work/Clients/Name", …) — or, if the user wants it at the top of
My Drive, repeat this same call." The server remembers the refused path (folded
to case, per account) for the life of the process — one stdio process is one
session — and the identical call, or `~/Name` for `/Name`, then proceeds. A bare
name that was refused is remembered the same way, so the `/Name` its refusal
offers goes straight through. Scope is narrow on purpose: only a new doc at the
top of My Drive, only when a default is set — not a tab, not a replace, not
`/Personal/Notes` (the user named a folder there), not the root of a shared
drive (`/shared/Team/Name`), and nothing changes without a default. `/Name` is
not ambiguous with another root: `/shared`, `/shared-with-me` and `/lost+found`
are peeled off as reserved first steps before the walk, so as a single step they
can never be a My Drive doc (they are refused as "not a folder"), which is the
existing limit that a doc named one of those is reachable by id only.

The default folder is resolved to a path when the server starts and written into
`write_doc`'s description, since the config is known then (the server's working
directory is the project); the refusals read the config fresh, so they stay right
after a `set_project_default` mid-session while the description waits for a
restart. A folder no path reaches (an orphan, shared only with you) is named by
its id, which starts a path too.

`segment` (header/footer) stays a parameter, not a path step: a
header is part of a tab, not a child of it, and a path step would collide with a
tab titled "Footer".

### 3a. Segments — the body is not the whole document

Headers and footers are parallel content trees, addressed in write requests by
`segmentId` (the body's is empty). Nothing about them is exotic: the same
`insertText`/`updateTextStyle`/`insertInlineImage` requests work, just carrying a
segmentId. So rather than a separate family of tools, every content tool takes
`segment: 'body' | 'header' | 'footer'` (+ `page` for first-/even-page variants),
resolved by `src/docs/segments.ts`.

"Every content tool" is load-bearing, and was not true at first: the text tools
got this in #23, but the table ops and the suggestion tools kept walking the body
only, so a letterhead table and a tracked change on a footer disclaimer were
unreachable — and, worse, unreachable *silently*, since a body-scoped scan simply
never matched. #28 closed that by threading the same primitive through, rather
than giving tables and suggestions a mechanism of their own. A tool that reads or
writes document content and does not accept `segment` is a bug, not a design
choice.

Two rules this design enforces:

1. **A read must never look empty when it isn't.** A body read reports the
   headers/footers it did not show, with paragraph and image counts. The bug
   that motivated this (#23) was a letterhead whose logo lives in the header:
   `read_doc` returned markdown with no image, which read as "this template has
   no logo" — a wrong answer, not a missing one.
2. **A write must never silently land in the wrong tree.** Targeting a
   header/footer that doesn't exist returns `no_segment` with what does exist,
   rather than falling back to the body. This is also why indices are always
   paired with their segmentId on the way out: offsets are per-segment, so a
   range read from a header but written without its id would land at the same
   numeric offset in the body. `createSegment: true` opts in to
   creating it (default header/footer only — the API cannot create a
   first-page/even-page one).

---

## 4. Editing contract

`edit_doc` mirrors the agent's local `Edit` tool. The server hides Docs API integer indices entirely.

**Matching rules:**
- **Match space:** doc projected to plain text; `old_string` matched against it.
- **Markup-tolerant:** `"# Title"` and `"Title"` both match the heading. Literal-text markers (§2b) are markup too: `5 * 3`, `5 \* 3` and `<p>4. Term` all find the text they spell.
- **Whitespace-normalized:** collapse repeated spaces, ignore soft-wraps, trim — robust against invisible-character mismatches.
- **Cross-run:** matches across formatting boundaries (a bold word mid-sentence does not break the match).
- **0 matches** → error "not found" (+ nearest-text hint).
- **>1 matches** → error listing each with surrounding context; agent retries with more context (same escape hatch as local `Edit`). This is also how disambiguation works without polluting reads with anchor IDs.
- **`replace_all`** flag, same semantics as local `Edit`.

**Output (`new_string`):** interpreted as **markdown + inline HTML** for inline constructs (bold/italic/code/links + `<span style>`), plus a paragraph's own `<p style="…">` / `<p class="…">`. Inserted text inherits the paragraph style of the match location. Block-level restructuring (new tables, headings from scratch) goes through dedicated insert tools, not `edit_doc`.

Design asymmetry, deliberate: **locate by loose plain-text match, author with markdown/HTML formatting.**

**Same words in, same words out → a style-only edit.** When `old_string` and
`new_string` carry the same text and differ only in markup, `edit_doc` sends only
`updateParagraphStyle` / `updateTextStyle` and never deletes or inserts. The words
cannot change because no request that could change them is built — not because
the agent was careful to copy them. That guarantee is what lets the anchor stay
short: indenting a 300-word clause is

```
old_string: <p>4. Term
new_string: <p style="text-indent:36pt">4. Term
```

and the other 298 words are never sent. Styling many paragraphs is many such
edits; there is no range-styling tool, because the main path covers it.

**The `<style>` block is edited the same way.** `old_string` is a rule or part of
one (`p { font-size: 11pt`), `new_string` the changed rule; the edit becomes one
`updateNamedStyle` for that named style, and every paragraph that doesn't override
it follows.

**`write_doc` — creating is free, replacing is asked for once.** `write_doc`
mirrors the local `Write`: a path that names nothing is created (a doc in a
folder, a tab in a doc), and a path that names something is replaced. Replacing
is refused on the first call, and the refusal is a loss summary: the paragraphs
of text, and everything a read cannot carry that the replace would take with it
— comments, suggestions, tab stops (the Docs API cannot write them back),
smart chips, bookmarks, section and column breaks.

```
write_doc("/Work/Contract", …)
→ refused: replacing "/Work/Contract" removes 42 paragraphs, 2 comments,
  3 tab stops. tab stops on 3 line(s): "Signature:", "Date:", "Witness:" …
  confirmLoss: "42 paragraphs, 2 comments, 3 tab stops [revision ANLC…]"
```

The agent tells the user, the user decides, and a second call carrying
`confirmLoss` proceeds. It is the local `Write`'s "read the file before you
overwrite it", enforced: the summary is a fact the caller had to fetch. The
string is the counts **and the doc's revision id**. The counts alone are not
enough: an edit that changes words but no count would still match, so the
revision is in the string, and the counts stay in it because a comment added
in Drive changes no revision. Either changing makes the second call refuse
again with a fresh summary. Creating asks nothing, but only an absolute path creates, and with a project default folder a new doc at the top of My Drive is asked about once (§3d). Only the last step of the path may be new; a path
two levels short is refused, since there is no `mkdir -p` for tabs. A path with
one tab means that tab, so replacing a one-tab doc asks like any other.

Two items are counted less exactly than the summary reads, and it says so.
**Comments** live in Drive and their anchor (`kix.…`) is opaque — it appears
nowhere in the Docs API, so which tab a comment belongs to cannot be told;
a tab replace counts the whole doc's comments and says so when the doc has
several tabs. **Bookmarks** are not exposed by the Docs API at all, only links
that point at one (`textStyle.link.bookmark`, `.heading`); the summary counts
those, and a bookmark nothing links to is invisible (checked live, #55). The text is always on the list, so a
path that matched an existing doc by accident (Drive folds case) is never
replaced silently. `edit_doc` stays the default for changing a document; it
touches only what its anchor covers and keeps everything else.

---

## 5. Read representation — decided

`read_doc` returns **markdown + inline HTML** (per §2). Earlier options considered and rejected:

- **Plain text only** — robust matching but loses all structure/formatting visibility.
- **Markdown + visible anchor IDs** — most robust against ambiguity, but noisy to read; "durable" anchors only truly exist if implemented as Docs named ranges, which mutate the doc on read. Disambiguation is handled instead by the context-on-ambiguity fallback in §4.

> **Read backbone — decided by spike.** We build our own Docs-JSON → markdown+HTML transformer; we do **not** offload reads to Google's native export. Empirical results:
> - **Native `text/markdown` export is unusable**: it silently concatenates a pending suggestion into the text (`"2"→"3"` rendered as `"32 weeks"`) with no tracked-change markup, and **drops comments**.
> - **Native `text/html` export is high-fidelity for formatting** (full `text-align`/color/font/size attrs) and includes comments as footnote refs + divs, but still renders suggestions silently — usable only as a *formatting cross-check*, not the primary read.
> - Only the Docs API `SUGGESTIONS_INLINE` + our parser represents suggestions correctly; editing also needs the index map that export doesn't provide.
> - **Hazard:** any text extraction that doesn't pick an explicit `suggestionsViewMode` risks the `32` corruption. The transformer must always set the mode deliberately.

---

## 6. Suggestions — the headline feature

No existing server surfaces suggestion **content** as a diff, and all repeat that the API "can't accept/reject." Both gaps are addressable.

**Reading (`list_suggestions`):** read the doc in `SUGGESTIONS_INLINE` (the only view mode that returns batchUpdate-valid indices), walk the content, group insertion/deletion-tagged runs by suggestion ID, emit clean diffs:

```json
{ "id": "suggest.abc", "type": "replacement",
  "context": "The timeline is 3 weeks.",
  "before": "3 weeks", "after": "2 weeks" }
```

In `read_doc(mode: "tracked")` the same suggestions render inline as `<ins>/<del>` + IDs, so reviewing them is just reading the doc.

**Acting (`apply_suggestions`):** the API cannot create suggestions or write *in* suggestion mode, but existing suggestions **can** be resolved by operating on the raw tagged ranges with normal (direct) edits:

| Decision | Mechanism | Clean? |
|---|---|---|
| Accept insertion | delete suggested range, re-insert as plain text | ✓ tag gone |
| Reject insertion | delete suggested range | ✓ |
| Accept deletion | actually delete the marked range | ✓ |
| Reject deletion | delete + re-insert same text plain (strips tag) | ✓ |
| Style-change suggestion | reapply chosen style | ⚠️ partial — maps, fiddlier |

The trick: **to clear a suggestion tag, delete the tagged content and reinsert the chosen final text as a normal edit.** No "ghost" suggestion remains (revision history still preserves it). This requires operating on the raw suggestion ranges, not string-editing the preview.

> **Validated by spike** (now removed; logic ported to `src/` + `test/`). (1) A live ACCEPT of a replacement suggestion (`"3 weeks"`→`"2 weeks"`) via direct `deleteContentRange` + `insertText` over the tagged span resolved cleanly: suggestion gone, no ghost — the API does **not** reject direct edits over suggested ranges. (2) Two **adjacent** suggestions resolved in a single `batchUpdate` with descending-index ordering: both gone, correct text, no index corruption. Lower-risk variants still unexercised: reject path, pure-insertion/deletion *suggestions*, style-only.

**Caveats:**
- Text suggestions are clean; **style-change** suggestions are partial.
- **Overlapping** suggestions need descending-index application.
- **Attribution has no clean API path — confirmed by spike + research.** `documents.get` carries only `suggestedInsertionIds`/`suggestedDeletionIds` (no author/time). Investigated alternatives: Drive **Revisions** = dead end (a pending suggestion isn't a revision; on accept `lastModifyingUser` is the *acceptor*); Drive **Activity API v2** = partial (gives actor+timestamp but its `Suggestion` event has no `suggestionId`/range, so it can't be linked to a specific suggestion); Drive **Comments** = also a dead end for the common case. **Spike-disproven:** a *bare* suggestion (a tracked change with no attached comment) does **not** appear in the Drive comments API at all — only explicit user comments do. So there's no comment thread to correlate to unless the suggester *also* typed a comment (uncommon). The "fuzzy-match suggestion text ↔ comment quoted text" route therefore doesn't apply to typical suggestions.
  - **Decision — v1 (final): no attribution.** Present suggestions in **document order** (the natural review order; serves "go through them" fully). Author and "latest by time" are simply not available via any API for typical suggestions. Not revisited unless Google adds first-class support.

**Edit-the-markup-to-act** (accept by editing `<ins>/<del>` in a `tracked` read) is a tempting v2: it needs an intent-inference/reconciliation engine and is fragile to marker drift, so the discrete `apply_suggestions(id, decision)` stays the reliable path; ID references come naturally from what was just read.

---

## 7. Comments

Drive API v3 `comments`/`replies`. Full read/reply/resolve/add. Resolve = `replies.create` with `action: "resolve"`. `fields` parameter is mandatory on every call.

> **Validated by spike.** Reading comments works: `author.displayName`, `createdTime`, `quotedFileContent.value` (anchored text), `content`, `resolved`, and `replies` all return. **Caveat:** `author.emailAddress` comes back empty — Drive returns the **display name only, not the email** (privacy default). So comment attribution is name-only. (Reply/resolve/add are standard Drive writes — not yet spiked.)

Limitation: programmatic text-selection anchoring is opaque/undocumented (only line-based anchoring is documented). Reading comments + quoted text and reply/resolve work well; **creating** a new comment pinned to a specific phrase may render orphaned in the UI — treat comment creation as best-effort.

---

## 8. Concurrency / staleness

A Doc can change between read and edit (collaborators, a human resolving a suggestion, the agent's own prior edit shifting indices). String-anchoring does most of the work; the server manages revision IDs — the agent never threads them.

| Operation | Strategy |
|---|---|
| `edit_doc` | optimistic: re-read live + re-match `old_string` at write time (self-heals index shifts); `requiredRevisionId` closes the tiny internal read→write window; on match-loss/ambiguity return current surrounding text + "re-read" |
| `write_doc` (replace), `accept_all` | **strict**: pin `requiredRevisionId` to last read; fail on any concurrent change |
| `apply_suggestions` | re-resolve by ID; if gone, report "already resolved" |

> **Validated by spike.** A `batchUpdate` with a stale `requiredRevisionId` is rejected (`"The required revision ID ... does not match the latest revision."`), while the current revision succeeds. Optimistic locking is enforceable as designed.

Optional `strict: true` on `edit_doc` pins the revision for high-stakes edits. The one unhandleable case (a collaborator edits the *exact* target so it still matches but means something different) is vanishingly rare and covered by `strict`.

---

## 9. Multi-account

Tokens are **global** (authorize each account once); defaults are **scoped per project**.

```
~/.config/gdocs-mcp/
  client_secret.json          # one shared OAuth app
  tokens/
    damithsc@gmail.com.json    # per-account refresh tokens (0600)
    work@company.com.json
```

| Piece | Design |
|---|---|
| Identifier | email canonical; optional friendly alias (`work` → `work@company.com`) |
| Add accounts | `add_account` runs loopback OAuth in browser → stores token by email; `list_accounts` lists them |
| Account resolution | per-call `account` → project `.gdocs-mcp.json` (cwd or a parent) → `GDOCS_DEFAULT_ACCOUNT` env → sole account. The `.gdocs-mcp.json` file lets a user-scope (all-projects) registration be overridden per folder without repeating the `.mcp.json` entry. |
| Cross-account doc resolution | **auto-discover** (opt-in default): if the active account 404/403s on a doc, quietly try other authorized accounts, use the one with access, and report which. Falls back to a clear error if none can see it. A discrete `find_doc_account(docId)` also exists |

Per-project default is just an env var in that project's `.mcp.json`, so a work project can't accidentally default to a personal account.

---

## 10. Tabs & multi-file reconciliation

### 10a. Tab-aware editing (core) — a tab is a file in a folder
A tab is addressed by path (§3d): a doc is the folder, its tabs the files in it.
The Doc stays canonical; tabs are sub-files. No source-of-truth conflict. Writes
stamp `tabId` onto ranges and locations; reads use `includeTabsContent`.

Tab structure goes through the same tools as files: `drive ls` lists tabs,
`drive mv` renames, reorders and nests them (`updateDocumentTabProperties`), and
`write_doc` to a new path adds one (`addDocumentTab`). Deleting a tab is the
user's, like deleting a file.

> **Gotcha — stale generated types.** `googleapis@144`'s TypeScript types lag the live API: `addDocumentTab`/`deleteTab`/`updateDocumentTabProperties` are absent from `Schema$Request` even though the API accepts them. We construct + cast these requests (`src/docs/document.ts`). A type-only grep wrongly concluded the feature was missing — always confirm against the live API, not the bundled types. `dateElement` is missing from `Schema$ParagraphElement` the same way (`src/docs/loss.ts` widens the type). A future `googleapis` bump should remove the casts.

> **`updateDocumentTabProperties`, verified live (#55).** `title`, `index` and `parentTabId` combine in one request. `parentTabId` nests the tab (it lands at child index 0 unless `index` is also given); un-nesting to the top level takes an explicit empty `parentTabId` with `parentTabId` in the field mask, and `index` alone reorders within the tab's current parent. Nesting a tab under its own child is refused by the API.

Internal gotcha: three batchUpdate ops (`ReplaceAllText`, `DeleteNamedRange`, `ReplaceNamedRangeContent`) ignore `tabId` and hit **all** tabs — the edit layer must avoid or scope them so a per-chapter edit can't bleed across tabs. Reads require `includeTabsContent=true` (default silently returns first-tab-only).

### 10b. Multi-file ⇄ tabs (the manuscript use case) — NOT a coded subsystem
Use case: chapter `.md` files ⇄ one Doc with one tab per chapter, with review (suggestions/comments) happening in the Doc.

**Design decision (corrected):** this is **not** a feature to build into the server. An earlier draft proposed a coded subsystem — `assemble`/`export` commands, a `.gdocs-manuscript.json` manifest, a 3-way AI-merge engine with canonical-projection diffing. That duplicates the *brain* into the *hands*. The merge intelligence — deciding the file↔tab mapping, reasoning about what changed on each side, going through suggestions, judging conflicts — **is exactly what Claude Code does.** The server provides **primitives**; Claude orchestrates.

```
  Claude Code (orchestration)                 MCP server (primitives)
  • read local chapter .md (filesystem)  ──▶  read_doc · edit_doc
  • decide file↔tab mapping                   list_suggestions · apply_suggestions
  • reason about / merge differences          drive ls · edit_doc · comments
  • go through suggestions, judge each        write_doc("<doc>/Ch.3", …) ← push a chapter
  • apply the result as edits            ──▶  edit_doc
```

The only thing the server genuinely owed this use case was a **mechanical** content primitive: rendering a whole chapter of markdown (block structure) into a doc/tab. That's now built (`write.ts`): `write_doc` renders markdown (headings, paragraphs, inline, bullet/ordered lists) into a doc or a tab, creating the tab if it is new — so "push `chapter-03.md` into the Ch.3 tab" is one call. Everything else (mapping, merging, review) is Claude's job, no server code.

**Distinction that drives the boundary:** mechanical/deterministic transforms → server; judgment/decisions → Claude. Merging is judgment → Claude. Markdown↔Docs rendering is mechanical → server.

---

### 10c. Image publish/pull + change tracking (agent-orchestrated)

Images publish one-way cleanly (local `![](file)` → embedded in the Doc, `.md` read-only) but don't round-trip as URLs, and Google **downscales to ≤2048px + re-encodes** on embed — so a pulled image is a lossy copy, not the original, and it can't be checksum-matched or API-tagged with a source marker. Identity/change-tracking must therefore be **recorded**, not inferred.

The server provides the fingerprints; the agent owns the record:
- `write_doc` returns `images: [{ src, objectId }]` (publish side).
- `download_images` returns `sha256` per image (doc side).
- `read_doc` marks image positions as `![](image:<objectId>)`.

**Tracking lives inline in the markdown as an HTML comment** (self-contained, no sidecar; the writer ignores all HTML comments so they never render into the Doc):

```markdown
![Palk Strait…](The%20Car…png) <!-- gdocs img=kix.abc loc=5615d43b doc=abddc34b -->
```
- `img` = Doc image objectId (the stable anchor)
- `loc` = hash of the local file at last sync → detect local edits (or lean on git)
- `doc` = hash of the Doc's (downscaled) copy at last sync → detect doc-side edits

The agent maintains these (writes on publish/pull, compares on demand): local drift = `hash(file) ≠ loc`; doc drift = objectId gone, or `download sha256 ≠ doc`. Only the comment-ignoring in the writer is server code; the rest is orchestration and degrades gracefully (no comment → just publish/download).

## 11. Auth, scopes, setup

- **Scopes:** `https://www.googleapis.com/auth/documents` + `https://www.googleapis.com/auth/drive` (full restricted scope). `drive.file` is **insufficient** — it can't open arbitrary docs by ID, only app-created/picker-picked files.
- **Flow:** Authorization Code + PKCE via loopback (`http://127.0.0.1:<port>`). OOB flow is removed.
- **Refresh tokens:** in "Testing" publishing status they expire after **7 days**. The consent screen **must be set to "In production"** to keep them alive — a one-time manual setup step (does not require full Google verification for personal use). Unverified apps can use restricted scopes for the developer's own accounts (≤100 users lifetime, with an "unverified app" warning).
- **Quotas:** Docs API ~300 reads / 60 writes per user per minute; 429 → truncated exponential backoff with jitter.
- **Indices:** UTF-16 code units (emoji count as 2); edits within a batch ordered **descending** by index.

---

## 12. Tech stack & prior art

- **Language:** TypeScript. **MCP SDK:** official `@modelcontextprotocol/sdk` (not FastMCP).
- **Build fresh, borrow aggressively** (permissive licenses):
  - `@a-bonus/google-docs-mcp` — markdown↔Docs transformer logic, batchUpdate phase-splitting (delete→insert→format), comment CRUD. (Note: fix its open path-traversal issue #146 if any code is lifted; it strips suggestions and is env-var-profile multi-account only.)
  - `dmorrill/gmail-mcp-multi`, `bakissation/mcp-google-multi` — per-call account routing, encrypted token store, `account: "*"` fan-out.
- **Spend net-new effort on the three novel bets** (below).

### Where this sits vs the field
| Capability | Best existing | This server |
|---|---|---|
| Read suggestions as a diff | nobody | ✓ |
| Accept/reject suggestions | nobody ("API can't") | ✓ range-reconstruction |
| Editing model | index-based (all) | string-anchored, indices hidden |
| Formatting visible on read | lossy markdown / plain | markdown + inline HTML |
| Suggestions inline in read | nobody | `<ins>/<del>` tracked view |
| Multi-account + deep Docs together | separate, never combined | combined + cross-account auto-resolve |
| Staleness/concurrency | unaddressed | optimistic re-match |

Existing servers still win on **breadth** (18–50+ tools, multi-service), **maturity** (shipped, battle-tested), and already-built transformers. This server is deliberately narrow and deep.

---

## 12b. Open-source readiness

This ships as a public GitHub project, held to a high standard.

- **Naming:** GitHub repo `dasasian/gdocs-mcp`; npm package `@dasasian/gdocs-mcp` (namespaced — the bare `gdocs-mcp` is crowded with low-signal look-alikes). Google Cloud project ID `gdocs-mcp` is a separate namespace.
- **License: MIT** — maximally permissive, compatible with the MIT/ISC code we borrow (§12), and the norm for MCP servers. Respect upstream attribution in a `NOTICE`/README for any logic lifted from `@a-bonus/google-docs-mcp` et al.

| Artifact | Purpose |
|---|---|
| `README.md` | front door: the differentiator, install, OAuth setup walkthrough, config, tool reference, examples |
| `docs/setup.md` | step-by-step Google Cloud project + consent screen (incl. "In production"), mirrors the `gcloud` script |
| `LICENSE` | MIT |
| `SECURITY.md` | token handling, scope justification, vuln reporting — **non-optional**, we store OAuth refresh tokens |
| `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` | contributor hygiene |
| `.github/` | issue + PR templates, Actions CI (lint · typecheck · test · build) |
| `CHANGELOG.md` | semver history; npm-published so `npx` works |
| `examples/` | the manuscript-with-tabs workflow as a showcase |

Security posture is first-class: token files `0600`, scope justification documented, and a **regression test against the path-traversal class of bug** (the issue #146 in upstream we must not inherit).

## 13. Risks

The three differentiators are unproven *because* nobody has done them:
1. **Suggestion accept/reject via range-reconstruction** — ✅ **validated** (spike): clean ACCEPT of a replacement (no ghost) *and* multi-suggestion batch resolve with descending-index ordering (no corruption). Remaining cases (reject path, insertion/deletion-only, style) are lower-risk variants of the same proven mechanism.
2. **markdown + HTML + `<ins>/<del>` round-trip** — ✅ **read validated**; ✅ **style-write validated** (paragraph, text and named styles, §2a); ✅ **inline `new_string` markdown *and* HTML validated** in `edit_doc`; ✅ **block-level markdown→Docs validated** (`write.ts`: headings, paragraphs, inline, bullet/ordered nested lists → `write_doc`, with a **lossless live round-trip** md→Docs→md). Reader/writer share `markdown-spec` constants + round-trip tests (the "extend in pairs" discipline) instead of a bidirectional spec engine. Open: Tier-2 blocks (tables, images, code blocks) in the renderer.
3. **String-anchored editing over batchUpdate** — ✅ **validated in code**: plain-text projection + index map across runs, exact + markup-tolerant match, ambiguity→context, optimistic revision, delete+insert. Live round-trip edit confirmed. Open: whitespace-normalized matching; new_string formatting.

The canonical-projection requirement (§10b) is the linchpin for AI-merge and a stressor for round-trip fidelity generally.

---

## 14. Roadmap

```
v1   core: doc-as-file (read/edit/overwrite/format/insert/search)
          + suggestions (list/apply) + comments + tab-aware editing + tab CRUD
          + objects (image/table) + sharing + multi-account
          + markdown block rendering (write_doc)
          + gcloud setup script + setup guide                ← onboarding (see below)
later  Tier-2 block rendering (tables/images/code in the markdown writer)
       (the manuscript "sync" is NOT a server feature — Claude orchestrates it
        over the primitives; see §10b)
```

De-risk first: spike the **suggestion accept/reject round-trip** (smallest, highest-uncertainty novel bet) before committing to the full tool surface.

### `gcloud` setup script (v1 onboarding)
The Google Cloud project is the #1 onboarding friction (§11). A `scripts/setup.sh` wrapping the `gcloud` CLI reduces a ~15-minute console slog to a few commands:

| Step | Automatable via `gcloud`? |
|---|---|
| Create the Cloud project | ✓ `gcloud projects create` |
| Enable Docs API + Drive API | ✓ `gcloud services enable docs.googleapis.com drive.googleapis.com` |
| Create the OAuth client (desktop/installed app) | ✓ partly — `gcloud` + API; emits `client_secret.json` |
| Configure consent screen scopes | ⚠️ partial — some fields still need the console |
| Set publishing status to **"In production"** | ✗ manual (one click; required to avoid 7-day token expiry) |
| Add test users (if left unverified) | ⚠️ console, or moot once "In production" |

The script does everything scriptable and **prints exact instructions for the 2–3 manual console steps** that remain, then drops `client_secret.json` into `~/.config/gdocs-mcp/`. The README's setup guide mirrors these steps for users who prefer clicking.

**Note on shared projects:** one Cloud project can serve multiple accounts (e.g. a household — both partners' Google accounts authorized against the same app, separate token files). The setup guide presents "your own project" as the default and "share within a household/team" as a documented option; the script supports re-running `add_account` for each account against the existing project.
