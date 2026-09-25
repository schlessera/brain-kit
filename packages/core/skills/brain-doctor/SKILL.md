---
name: brain-doctor
description: Use when a brain is misbehaving and it is not obvious why — commands failing, search returning nothing, skills or slash commands missing, the index refusing to update, hooks not firing. Also use right after setup to confirm everything is wired, or to produce diagnostics for a bug report.
compatibility: Requires bun. Some fixes shell out to claude to register the MCP server; other agents register it their own way.
---

# Brain Doctor — Diagnose and Repair

Runs the full check battery, groups the results, explains problems in plain language, and
fixes them one at a time with the user's consent — then re-runs until all green. The raw
output also doubles as the bug-report artifact for issue templates.

**This skill orchestrates; `brain doctor` executes the checks.** The agent's job is triage,
plain-language explanation, consent, and re-verification — not re-implementing detection.

## Flow

1. Run the battery:
   ```bash
   brain doctor --json
   ```
   The envelope is `{ checks: [{ id, status: pass|warn|fail, detail, fix? }] }`.

2. **Group and report.** Summarize green checks in one line. For each `warn`/`fail`, explain
   what it means without jargon — e.g. "your search index is older than 12 of your files, so
   searches can miss recent edits; I'll rebuild it."

3. **Fix one at a time, with consent.** Apply the smallest fix, confirm the outcome, move on.
   Never batch destructive or outward-facing changes silently.

4. **Re-run `brain doctor --json`** after fixes and confirm the checks flipped to green. Repeat
   until clean or until a check needs the user (missing runtime, missing API key).

## Check battery

| Check | Detects | Fix |
|---|---|---|
| runtime | bun missing / too old | none — explain how to install; stop if blocking |
| git-hooks | `core.hooksPath` not set, or an installed hook missing or different from the packaged one (an older copy after an upgrade) | `brain setup` or `brain doctor --fix`, which replace the hooks with the packaged ones |
| symlinks | `~/.local/bin/brain` or `.claude/skills/*` broken/stale | `brain skills sync` |
| shadowed-commands | a `.claude/commands/<name>.md` file with the same name as a skill; the skill runs, so the file is dead | none automatic — ask, then delete or rename each listed file |
| instructions-weight | `CLAUDE.md` (with its `@` imports), `AGENTS.md` and model-invocable skill descriptions together exceed `instructions.maxTokens` (default 8000) | none automatic — show the three largest contributors, and offer to trim them or move rarely needed rules into a skill |
| config | `brain.config` missing / invalid vs schema | none — point to `/brain-init` |
| db | brain.db missing, schema mismatch, or stale vs file mtimes | `brain index` (add `--force` on schema mismatch) |
| embeddings | model mismatch / missing coverage / no API key | `brain index --embeddings` (a missing key needs the user) |
| mcp | `brain` not registered with the agent | register the MCP server (Claude: `claude mcp add brain -- bun node_modules/.bin/brain mcp`) |
| deps | node_modules missing / lockfile drift | `bun install` |
| version | core package outside `brain.config` compat range | none — explain the upgrade |
| privacy | **git remote exists and is PUBLIC** | none — **loud warning, never auto-fix** |
| tracked-leftovers | committed tool leftovers (`.DS_Store`, `*:Zone.Identifier`, editor swap files, LaTeX `*.aux` and friends) | none automatic: show the `git rm --cached` command from `fix`, and run it only with the user's consent |
| tracked-media | a tracked file over `media.maxTrackedBytes` (and, always, the five largest tracked binaries) | none automatic: explain that git keeps every version, and offer a `media.ignore` glob, Git LFS, or a higher limit (docs/media.md) |

## Rules

- **Privacy is never auto-fixed.** A public remote on a personal brain is a serious foot-gun:
  warn loudly, explain the exposure, and let the user decide (make it private, or accept the risk
  deliberately). Do not touch remote visibility on their behalf.
- Fixes that call `bun install` or register MCP touch the environment — confirm before running.
- The `warnings` array that `brain search --json` already returns models the same degraded
  states (no vectors, model mismatch, missing key); doctor reuses those signals, so a fix here
  should clear the corresponding search warning too.
- **Bug reports:** when the user is filing an issue, capture the full `brain doctor --json`
  output verbatim — it is the required diagnostic artifact.

## CLI it relies on

- `brain doctor --json` — the check battery.
- `brain setup` — restores hooksPath, symlinks, bin.
- `brain skills sync` — re-links skills.
- `brain index` / `brain index --force` / `brain index --embeddings` — rebuild the index.
- `bun install` (deps fix), `claude mcp add` (Claude-only MCP registration example).
