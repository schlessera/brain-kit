# Maintainer note — this directory is the template source

**This file is NOT part of the template output.** It is a note for brainform
maintainers, excluded when the template repo is cut.

`template/` in the `schlessera/brainform` monorepo is the source of truth for the
standalone **`schlessera/brainform-template`** repo — the one users clone via
GitHub's "Use this template" (see the `gh repo create … --template` one-liner in
`README.md`). Everything else in this directory is real template content and ends
up in the user's brand-new brain verbatim.

## How the template repo gets cut

1. Copy the contents of `template/` into the `schlessera/brainform-template` repo
   with **fresh git history** (no monorepo history, per plan/06 publishing).
2. **Exclude this file** (`README-template-dev.md`) from the copy — it is the
   only file here that must not ship.
3. The zero-byte sidecars (`.context-cache.jsonl`, `.asset-cache.jsonl`) must be
   committed empty; they are the sidecar-cache contract and `brain index`
   expects them to exist.
4. Verify: `bun install` in a clone runs `prepare → brain setup` cleanly, and
   `brain search hello` returns `notes/hello-brain.md` with no API key.

## Contents (what ships)

- `brain.config.ts` — minimal default; core types only, commented examples.
- `package.json` — `my-brain`, private, pinned `@brainform/core`, `prepare` hook.
- `CLAUDE.md` — imports the packaged `CONTRACT.md`; marker-delimited bootstrap
  region telling the agent to run `/brain-init`.
- `README.md` — quickstart, KEEP-PRIVATE banner, degradation-ladder table.
- `.mcp.json` — stdio entry pointing at the packaged MCP server.
- `.env.example` — `GEMINI_API_KEY`, commented, framed as optional.
- `me/.gitkeep`, `context/.gitkeep`, `notes/hello-brain.md` — starter structure.
- `.context-cache.jsonl`, `.asset-cache.jsonl` — empty sidecars.
- `.claude/settings.json` — conservative default permissions.
- `.agents/skills/.gitkeep` — user-local skills overlay dir.
- `.gitignore` — `brain.db*`, `.env`, `node_modules/`, `workspaces/*/`.

## Choices worth knowing

- Paths that reference not-yet-built core files are fixed by the plan spec:
  `CONTRACT.md` (shipped in `@brainform/core`'s `files`) and
  `src/mcp-server.ts` (plan/01 §1). Keep `.mcp.json` and `CLAUDE.md` in sync if
  those move.
- `me/`, `context/`, `notes/` are core built-ins (`CORE_TYPES` in
  `packages/core/src/lib/config.ts`), so `brain.config.ts` does not redeclare
  them — an uninitialized brain is valid with an essentially empty config.
