# CLAUDE.md — working conventions for this repo

Guidance for AI agents (and humans) working on gdocs-mcp. Read before adding or
changing tools.

## What this is

An MCP server that lets an agent treat a Google Doc like a local file: read as
markdown, string-anchored edits, styling, suggestions, comments, tables, images,
sharing, tabs, multi-account. Architecture and rationale live in `DESIGN.md`; the
canonical tool list is the table in `README.md`; known API dead-ends are in
`docs/limitations.md`.

## Build / test

- `npm run typecheck` · `npm run build` (tsc) · `npm test` (vitest).
- Tests are sandboxed: `test/setup.ts` points `GDOCS_MCP_CONFIG_DIR` at a temp
  dir, so nothing touches a real `~/.config`. Keep it that way — never let a
  module perform filesystem side effects at import time (see `src/config.ts`).

## Tool-surface discipline (READ BEFORE ADDING A TOOL)

The tool count is a **budget, not a free-for-all** — every tool's schema costs
context on every call and enlarges the model's selection space, which measurably
lowers accuracy. We deliberately keep the surface small (~31 tools). Before adding
one, do this review and record the trade-off in the PR/commit:

1. **Default to enhancing an existing tool.** Can this be a new parameter or a
   `target`/`op` variant on a tool that already exists? Prefer that. Examples we
   chose: whole-document styling became a `whole_document` flag on `set_style`,
   not a new tool; file passthrough became `contentFile` on create/overwrite.
2. **Merge symmetric verbs.** CRUD verbs that share a target and param shape
   should be one parametric tool: `edit_table({op, side})`, `update_doc({name?,
   folder?})`, `add_comment({replyTo?})`, `share_doc` (person vs. link),
   `apply_suggestions` (1+ ids).
3. **A new tool is justified only when the vocabulary or return shape genuinely
   differs.** `set_page_setup` earns its place because page geometry (margins/
   size/orientation via `updateDocumentStyle`) shares nothing with text styling.
   Same test gates `get_page_setup` as its read counterpart.
4. **Keep destructive / create-destroy verbs as distinct, named tools.** Do NOT
   hide `delete_*` / `unshare_doc` / `overwrite_doc` behind a generic `op` enum —
   their confirmation guards (`expectTitle`, `expectQuote`, `force`) must stay
   legible at the call site.
5. **Uniform-vocabulary targets can merge; target-dependent style can't.** A tool
   is clearest to the model when its style/param fields don't change based on the
   target. `set_style` covers `from`/`to`/`whole` because they share one text+
   paragraph vocabulary; it does NOT absorb table or page styling (different
   fields). Reads over a *range* are ambiguous (mixed styles) — that's why
   `get_style` stays single-anchor while `set_style` takes a selection.
6. **Pair reads with writes.** `get_style`/`set_style`, `get_page_setup`/
   `set_page_setup`. If you add a setter for a new dimension, consider whether a
   matching getter is needed for round-tripping (it usually is).

If, after this, a new tool is still the right call — add it, and say in the commit
why enhancing an existing tool was rejected.

## Other disciplines

- **Extend read and write in pairs.** The markdown⇄Docs reader (`transformer.ts`)
  and writer (`write.ts`/`inline.ts`) share `markdown-spec` constants and
  round-trip tests. When you teach one side a construct, teach the other and add a
  round-trip test — don't let read emit something write can't parse (that was #16).
- **Verify against the live API, not just tests.** Unit tests assert request
  payloads; they don't prove Google does what you expect. Drive the real flow with
  a throwaway doc (create → mutate → read back → assert → trash) before committing
  anything non-trivial. This is how we caught the `weightedFontFamily`-clears-bold
  gotcha and the raw vertical-tab (U+000B) line-break artifact — neither showed up in unit
  tests. Use the `damith@dasasian.com` account for verification.
- **Commits:** one concern per commit, reference the issue (`(#NN)`), and note the
  live verification in the body. `git add -A` before committing.
- **Keep the docs in sync** when the tool surface changes: `README.md` table,
  `CHANGELOG.md`, `DESIGN.md` §3, and `docs/limitations.md`.
