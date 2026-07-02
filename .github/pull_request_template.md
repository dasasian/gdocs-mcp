## What & why

<!-- What does this change do, and why? Link any related issue. -->

## How it was verified

<!-- CI runs build/typecheck/tests, but it can't hit the live Google API.
     Describe how you verified behavior against real Google Docs. -->

- [ ] `npm run build` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Verified against a live Google Doc (describe below)

## Checklist

- [ ] If I added/changed a tool, I updated the tools table in `README.md`
- [ ] If I touched the markdown reader **or** writer, I updated **both** and added/updated a round-trip test
- [ ] I did not log or commit any secrets/tokens
- [ ] Updated `CHANGELOG.md` if user-facing
