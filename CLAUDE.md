# CLAUDE.md

The rules for working in this repo are agent-agnostic and live in one place, so
this file only points at them.

@AGENTS.md

Repo-local skills live in `.agents/skills/` and are symlinked into
`.claude/skills/`:

- **`release`** — load it before versioning, publishing, or changing what a
  release ships.
- **`github`** — load it before filing, triaging, picking up or closing work in
  either issue tracker.
