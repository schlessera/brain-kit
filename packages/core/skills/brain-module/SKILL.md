---
name: brain-module
description: Use when activating or parking a workflow domain — jobs, speaking, travel, finance, or a local module — while preserving its content, configuration and valid document types.
compatibility: Requires git.
---

# Brain Module — Enable / Disable Domains

Activates or parks configured modules with an optional `enabled` boolean (default true).
Dormant content and validated domain config stay in place; skills, generated module context,
classifier hints, cron metadata and module hygiene leave the active workflow.

**This skill orchestrates; the CLI executes.** Interview and scaffold new domains, review
explicit instruction migration when needed, then use the CLI for deterministic toggles.

## List what's available

```bash
brain module list
```

Show configured modules, their active/dormant state and the estimated active context cost
from `brain module list --json`. Shared contracts and personal prose are not charged to modules.
Keep the existing domain settings when reactivating; no new interview is needed.

## Enable a module

1. For a newly configured domain, install its matching package, add its config entry and
   interview only missing required fields. Scaffold the owned directories and `_index.md`
   files. For a dormant configured domain, retain its complete config and documents.
2. Review the instruction migration prerequisite below if legacy mixed sections remain.
3. Run the deterministic toggle and validate:
   ```bash
   brain module enable <name>
   brain validate
   ```
4. Inspect the source/context diff and commit the change:
   ```bash
   git add -A && git commit -m "brain-module: enable <name>"
   ```

Scheduler-facing metadata includes active cron entries. Existing hosts refresh their
schedules through their own lifecycle; no schedule is executed by this skill.

## Disable a module

Run `brain module disable <name>`, then `brain validate` and inspect the diff before committing.
The command writes `enabled: false`, retains domain config and content, removes managed skills
and module-owned generated regions, and leaves the shared installed contract and personal
prose alone. Never delete the config entry or documents to represent dormancy. A manifest may
refuse dormancy with its reason. An unchanged second toggle is a no-op.

## Explicit instruction migration

Both toggles refuse legacy mixed generated sections before changing config, skills or
instruction bytes. Review their full contents: keep personal prose under user ownership
outside generated markers, and put module conventions in authoritative
`instructions: { text }` contributions from `setup(validatedConfig)`. Separate them explicitly;
never infer paragraph ownership from a module name or delete a whole mixed section.

Owned regions are named `module-<name>` and immediately follow a newline-terminated
`<!-- brain:module-instructions:<name> -->` ownership slot. The slot stays when dormant;
generated prose is derived again from current validated config when re-enabled. Review and
remove obsolete generic section markers only after preserving every personal paragraph and
module convention. Retry the CLI after this migration. See the
[instruction migration guide](https://github.com/schlessera/brain-kit/blob/main/docs/modules.md#instruction-migration).

## Notes

- Because the config is the single source of truth, running enable twice is a no-op and running
  disable never loses data.
- Dormant types and directory anchors remain valid and searchable; only active module hygiene
  checks are applied. Running sessions keep their loaded state. MCP filtering is separately
  tracked in #603; dormancy is context control and never permission revocation.

## CLI it relies on

- `brain module list --json` — configured modules, state and active context estimates.
- `brain module enable <name>` / `disable <name>` — source-preserving state/context changes.
- `brain validate` — confirm the config and structure are consistent.
- `brain skills sync` — refresh managed discovery output after other manual skill changes.
- `git` — commit the enable/disable.
