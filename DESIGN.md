# googledocs-mcp-server — Design

An MCP server that lets an AI agent (Claude Code) treat a Google Doc **like a local file** — read it, edit it by content, review and act on suggestions, manage comments, work across tabs, and across multiple Google accounts.

The goal is not broad Workspace automation. It is the specific, unoccupied quadrant: **suggestion- and comment-aware, file-like editing of Google Docs for an AI agent.**

---

## 1. Core model — the Doc *is* the file

There is no canonical local copy and no continuous sync in the core model. The Google Doc is the source of truth, and the agent interacts with it through the same primitives it uses for local files: read, edit (by unique string), overwrite, search.

(Multi-file ⇄ tabs reconciliation is a separate, later layer — see §10.)

### Why this over "sync"
- No source-of-truth ambiguity for the common case.
- Editing maps directly to the agent's existing `Read`/`Edit`/`Write` muscle memory.
- It sidesteps the Docs API's worst limitation (see §6) instead of fighting it.

---

## 2. Interface format — markdown + inline HTML

The agent reads and writes **GitHub-flavored markdown with inline HTML**:

- **Content & inline emphasis** → markdown (`#`, `**bold**`, lists, tables, links).
- **Docs-only formatting** markdown can't express (alignment/justify, color, font, size, spacing, indent, image dimensions) → inline HTML (`<p style="text-align: justify">`, `<span style="color:#1a73e8">`, `<img width="400">`).
- **Suggestions / tracked changes** → HTML `<ins>` / `<del>` with an ID marker (`data-sug` attribute or `<!-- sug:id -->`).

This single format does both jobs: formatting is **visible in the read** (so the agent can perceive *and* verify style changes), and it is a format the agent authors natively. It replaces an earlier "clean markdown + separate formatting sidecar" idea.

Markdown is otherwise a ceiling — it cannot express alignment, color, fonts, image sizing, etc. The HTML escape-hatch is what lifts that ceiling.

---

## 3. Tool surface

| Tool | Role |
|---|---|
| `read_doc(doc, tab?, mode)` | Read as markdown+HTML. `mode`: `clean` (default) · `tracked` (`<ins>/<del>`+IDs) · `accepted` · `rejected` |
| `edit_doc(doc, old_string, new_string, tab?, replace_all?, strict?)` | String-anchored edit (the workhorse) |
| `overwrite_doc(doc, content, tab?)` | Wholesale replace — **guarded** (§4) |
| `create_doc(content)` | New doc |
| `format_doc(doc, target_string, style, tab?)` | Style existing text **in place**, no content change |
| `insert_image(doc, at, source, width?, align?, tab?)` | Images (markdown can't size/place them) |
| `insert_table(doc, rows, cols, data?, tab?)` | Programmatic/large tables (simple ones stay markdown) |
| `search_doc(doc, query, tab?)` | Grep |
| `list_suggestions(doc, tab?)` | Suggestions as before→after diffs |
| `apply_suggestion(doc, id, accept\|reject)` | Resolve a suggestion (§6) |
| `accept_all / reject_all(doc, tab?)` | Bulk resolve |
| `list_comments / add_comment / reply_comment / resolve_comment` | Drive comments |
| `list_tabs / add_tab / rename_tab / reorder_tab / delete_tab` | Tab structure |
| `add_account / list_accounts` | Multi-account (§9) |

---

## 4. Editing contract

`edit_doc` mirrors the agent's local `Edit` tool. The server hides Docs API integer indices entirely.

**Matching rules:**
- **Match space:** doc projected to plain text; `old_string` matched against it.
- **Markup-tolerant:** `"# Title"` and `"Title"` both match the heading.
- **Whitespace-normalized:** collapse repeated spaces, ignore soft-wraps, trim — robust against invisible-character mismatches.
- **Cross-run:** matches across formatting boundaries (a bold word mid-sentence does not break the match).
- **0 matches** → error "not found" (+ nearest-text hint).
- **>1 matches** → error listing each with surrounding context; agent retries with more context (same escape hatch as local `Edit`). This is also how disambiguation works without polluting reads with anchor IDs.
- **`replace_all`** flag, same semantics as local `Edit`.

**Output (`new_string`):** interpreted as **markdown + inline HTML** for inline constructs (bold/italic/code/links + HTML styling). Inserted text inherits the paragraph style of the match location. Block-level restructuring (new tables, headings from scratch) goes through dedicated insert tools, not `edit_doc`.

Design asymmetry, deliberate: **locate by loose plain-text match, author with markdown/HTML formatting.**

**`format_doc` vs inline HTML in `edit_doc`:** complementary. `edit_doc` changes content (and inline style as written). `format_doc` styles text that is *already there*, by anchor, without re-typing it (avoids transcription risk) and returns *what it set* (restores the verify loop).

**`overwrite_doc` guard:** wholesale replace orphans comments and wipes suggestions. If the target has comments/suggestions, the tool **warns and requires confirmation** before proceeding. `edit_doc` (surgical, anchor-preserving) is the default for nearly everything. A future "smart replace" (diff new vs current, emit minimal edits) is a later upgrade.

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

**Acting (`apply_suggestion`):** the API cannot create suggestions or write *in* suggestion mode, but existing suggestions **can** be resolved by operating on the raw tagged ranges with normal (direct) edits:

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

**Edit-the-markup-to-act** (accept by editing `<ins>/<del>` in a `tracked` read) is a tempting v2: it needs an intent-inference/reconciliation engine and is fragile to marker drift, so the discrete `apply_suggestion(id, decision)` stays the reliable path; ID references come naturally from what was just read.

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
| `overwrite_doc`, `accept_all` | **strict**: pin `requiredRevisionId` to last read; fail on any concurrent change |
| `apply_suggestion` | re-resolve by ID; if gone, report "already resolved" |

> **Validated by spike.** A `batchUpdate` with a stale `requiredRevisionId` is rejected (`"The required revision ID ... does not match the latest revision."`), while the current revision succeeds. Optimistic locking is enforceable as designed.

Optional `strict: true` on `edit_doc` pins the revision for high-stakes edits. The one unhandleable case (a collaborator edits the *exact* target so it still matches but means something different) is vanishingly rare and covered by `strict`.

---

## 9. Multi-account

Tokens are **global** (authorize each account once); defaults are **scoped per project**.

```
~/.config/googledocs-mcp/
  client_secret.json          # one shared OAuth app
  tokens/
    damithsc@gmail.com.json    # per-account refresh tokens (0600)
    work@company.com.json
```

| Piece | Design |
|---|---|
| Identifier | email canonical; optional friendly alias (`work` → `work@company.com`) |
| Add accounts | `add_account` runs loopback OAuth in browser → stores token by email; `list_accounts` lists them |
| Account resolution | per-call `account` → project `GDOCS_DEFAULT_ACCOUNT` (in `.mcp.json`) → global default |
| Cross-account doc resolution | **auto-discover** (opt-in default): if the active account 404/403s on a doc, quietly try other authorized accounts, use the one with access, and report which. Falls back to a clear error if none can see it. A discrete `find_doc_account(docId)` also exists |

Per-project default is just an env var in that project's `.mcp.json`, so a work project can't accidentally default to a personal account.

---

## 10. Tabs & multi-file reconciliation

### 10a. Tab-aware editing (core) — a tab is a file in a folder
Every tool takes an optional `tab` param (tabId or title). The Doc stays canonical; tabs are sub-files. No source-of-truth conflict.

> **Implemented + validated.** `read_doc`/`edit_doc`/`list_suggestions`/`apply_suggestion` accept `tab`; writes stamp `tabId` onto ranges/locations. Live test confirmed per-tab read isolation, correct per-tab index space for editing, and no cross-tab bleed. Tab selection resolves by tabId or title.

> **Tab CRUD — supported, validated live.** The Docs API `batchUpdate` supports `addDocumentTab` / `updateDocumentTabProperties` (rename) / `deleteTab` (cascades to children), plus `tabId` targeting for content edits and read via `includeTabsContent`/`tabProperties`. `add_tab`/`rename_tab`/`delete_tab`/`list_tabs` are implemented and round-trip-tested against the live API. **This means §10b's "push files → one-tab-per-chapter" assemble CAN create tabs programmatically** — the vision is unblocked.
>
> **Gotcha — stale generated types.** `googleapis@144`'s TypeScript types lag the live API: `addDocumentTab`/`deleteTab`/`updateDocumentTabProperties` are absent from `Schema$Request` even though the API accepts them. We construct + cast these requests (`src/docs/document.ts`). A type-only grep wrongly concluded the feature was missing — always confirm against the live API, not the bundled types. A future `googleapis` bump should remove the casts.

Internal gotcha: three batchUpdate ops (`ReplaceAllText`, `DeleteNamedRange`, `ReplaceNamedRangeContent`) ignore `tabId` and hit **all** tabs — the edit layer must avoid or scope them so a per-chapter edit can't bleed across tabs. Reads require `includeTabsContent=true` (default silently returns first-tab-only).

### 10b. Multi-file ⇄ tabs (the manuscript use case) — NOT a coded subsystem
Use case: chapter `.md` files ⇄ one Doc with one tab per chapter, with review (suggestions/comments) happening in the Doc.

**Design decision (corrected):** this is **not** a feature to build into the server. An earlier draft proposed a coded subsystem — `assemble`/`export` commands, a `.gdocs-manuscript.json` manifest, a 3-way AI-merge engine with canonical-projection diffing. That duplicates the *brain* into the *hands*. The merge intelligence — deciding the file↔tab mapping, reasoning about what changed on each side, going through suggestions, judging conflicts — **is exactly what Claude Code does.** The server provides **primitives**; Claude orchestrates.

```
  Claude Code (orchestration)                 MCP server (primitives)
  • read local chapter .md (filesystem)  ──▶  read_doc · edit_doc
  • decide file↔tab mapping                   list_suggestions · apply_suggestion
  • reason about / merge differences          add_tab · format_doc · comments
  • go through suggestions, judge each        overwrite_doc(markdown, tab) ← push a chapter
  • apply the result as edits            ──▶  create_doc(markdown)
```

The only thing the server genuinely owed this use case was a **mechanical** content primitive: rendering a whole chapter of markdown (block structure) into a doc/tab. That's now built (`write.ts`): `create_doc`/`overwrite_doc` render markdown (headings, paragraphs, inline, bullet/ordered lists), and `overwrite_doc` is tab-aware — so "push `chapter-03.md` into the Ch.3 tab" is one call. Everything else (mapping, merging, review) is Claude's job, no server code.

**Distinction that drives the boundary:** mechanical/deterministic transforms → server; judgment/decisions → Claude. Merging is judgment → Claude. Markdown↔Docs rendering is mechanical → server.

---

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
2. **markdown + HTML + `<ins>/<del>` round-trip** — ✅ **read validated**; ✅ **style-write validated** via `format_doc`; ✅ **inline `new_string` markdown *and* HTML validated** in `edit_doc`; ✅ **block-level markdown→Docs validated** (`write.ts`: headings, paragraphs, inline, bullet/ordered nested lists → `create_doc`/`overwrite_doc`, with a **lossless live round-trip** md→Docs→md). Reader/writer share `markdown-spec` constants + round-trip tests (the "extend in pairs" discipline) instead of a bidirectional spec engine. Open: Tier-2 blocks (tables, images, code blocks) in the renderer.
3. **String-anchored editing over batchUpdate** — ✅ **validated in code**: plain-text projection + index map across runs, exact + markup-tolerant match, ambiguity→context, optimistic revision, delete+insert. Live round-trip edit confirmed. Open: whitespace-normalized matching; new_string formatting.

The canonical-projection requirement (§10b) is the linchpin for AI-merge and a stressor for round-trip fidelity generally.

---

## 14. Roadmap

```
v1   core: doc-as-file (read/edit/overwrite/format/insert/search)
          + suggestions (list/apply) + comments + tab-aware editing + tab CRUD
          + objects (image/table) + sharing + multi-account
          + markdown block rendering (create_doc/overwrite_doc)
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

The script does everything scriptable and **prints exact instructions for the 2–3 manual console steps** that remain, then drops `client_secret.json` into `~/.config/googledocs-mcp/`. The README's setup guide mirrors these steps for users who prefer clicking.

**Note on shared projects:** one Cloud project can serve multiple accounts (e.g. a household — both partners' Google accounts authorized against the same app, separate token files). The setup guide presents "your own project" as the default and "share within a household/team" as a documented option; the script supports re-running `add_account` for each account against the existing project.
