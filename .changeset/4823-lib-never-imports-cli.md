---
"@schlessera/brain": patch
---

Internal (#4823): core's library code no longer imports the CLI layer. `resolveEmitters` moves to `lib/skills/resolve-emitters.ts` and the `brain module enable|disable` body to `cli/module-toggle.ts`, and `bun run lint` now refuses any import of `cli/` from `lib/`, `providers/`, `queries/` or `config/`. No command, flag, output or export changes.
