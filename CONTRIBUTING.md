# Contributing

Thanks for your interest in `@dasasian/gdocs-mcp`. This is an early-stage project — issues, ideas, and PRs are welcome.

## Development setup

```sh
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

To use your source build like the published package — the `gdocs-mcp` binary for both the CLI (`gdocs-mcp add-account`) and as the `.mcp.json` `command` — link it once:

```sh
npm link            # or: npm install -g .
gdocs-mcp add-account
```

`npm link` symlinks the binary to `dist/index.js`, so it stays current across rebuilds. (Without linking you can always invoke it directly: `node dist/index.js add-account`.)

When iterating on server code, remember it's a long-running process: after a change, `npm run build` and **restart your MCP client** to load it. Data changes (tokens, `.gdocs-mcp.json`) are read live and need no restart — see [docs/setup.md](docs/setup.md#applying-changes).

You'll need your own Google Cloud OAuth client to run against the live API — see [docs/setup.md](docs/setup.md). Tests that don't touch the network (parsers, transformer, matchers) run without any credentials.

## Project shape

- **TypeScript, ESM.** Use `import` (never `require`, never `await import`). Imports use explicit `.js` extensions (NodeNext resolution).
- `src/docs/` — document logic (read/edit/format/write transformers, suggestions, tabs, objects).
- `src/drive/` — Drive-side logic (comments, sharing).
- `src/auth/`, `src/google/` — OAuth + client construction.
- `src/server.ts` — MCP tool registration; `src/index.ts` — CLI/stdio entry.

## Conventions that matter here

- **Confirm against the live API, not the generated types.** `googleapis@144`'s TypeScript types lag the API (e.g. tab-CRUD requests exist at runtime but aren't in `Schema$Request`). When a request is missing from the types but the API supports it, construct and cast it — and leave a comment. Don't conclude a feature is missing from a type-only check.
- **Reader and writer are a pair.** The Docs→markdown reader (`transformer.ts`) and markdown→Docs writer (`write.ts`) share the mapping constants in `markdown-spec.ts`. When you add a block type, add it to **both** directions **and** a round-trip test in the same change. We deliberately do not build a bidirectional "spec engine" — shared constants + round-trip tests are the anti-drift mechanism.
- **Mechanical vs. judgment.** The server does deterministic transforms; anything requiring judgment (merging, deciding, reviewing) is left to the calling agent. Don't add "smart" orchestration into the server.
- **Never log secrets.** No token contents, no `client_secret.json`. Treat tool input paths as untrusted.

## Adding a tool

1. Implement the logic in the relevant `src/docs` or `src/drive` module (pure functions where possible, so they're unit-testable).
2. Register it in `src/server.ts` with a zod `inputSchema` and a short description.
3. Add tests — unit tests for any pure logic; note in the PR how you validated it against the live API.
4. Add it to the tools table in `README.md`.

## Pull requests

- Keep PRs focused. Run `npm run build && npm run typecheck && npm test` before pushing.
- Describe how you verified behavior against real Google Docs (the CI can't do that for you).
- Update `README.md` / `CHANGELOG.md` as needed.

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
