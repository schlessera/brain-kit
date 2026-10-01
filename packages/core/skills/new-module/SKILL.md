---
name: new-module
description: Use when a recurring domain workflow has outgrown personal overlay skills and deserves to be installable in its own right, with its own directories, taxonomy types, commands, and skills.
compatibility: Requires bun to run the module's tests.
---

# New Module — Author a Workflow Module

Scaffolds a new module the same way first-party modules are built — a manifest, skills, a README,
and tests — and gates it on the same checks. A module is an npm package (or local directory) whose
entry default-exports a manifest via `defineModule()`; it contributes taxonomy, skills, optional
CLI commands, MCP tools, hygiene checks, and cron lines. No plugin daemon — pure data plus lazy imports.

**This skill orchestrates; the CLI validates.** The agent designs and scaffolds; `brain module lint`
and `brain validate` enforce correctness before it's declared done.

## 1. Interview

Establish scope before writing anything:

- **Domain** — what recurring workflow does this module serve?
- **Types and directories** — which document types does it own, and where do they live?
- **Lifecycle moments** — which points in the workflow deserve a skill (capture, review, follow-up)?
- **CLI command** — is a namespaced `brain <word>` command warranted, or do skills calling core
  commands suffice? Modules register at most one top-level word.
- **MCP tool** — does a CLI operation need to be reachable from a client without a shell?
  Name the use case and the operation. The tool and CLI subcommand must call one shared
  deterministic function; do not create a second implementation or expose every command.

## 2. Collision-check the effective taxonomy — before scaffolding

The effective taxonomy is core built-ins ⊕ module contributions ⊕ user overrides. Two owners for
one type, or overlapping directory prefixes, are **hard validation errors**. Check first:

```bash
brain config check
```

Confirm the proposed types and directories don't collide with core or an already-enabled module.
Resolve any clash by renaming before generating files.
When tools or instruction contributions are wanted, choose a module name matching `^[a-z][a-z0-9-]{0,30}$` before
scaffolding: lowercase letters/digits/hyphens, at most 31 characters, and never `brain`.
Local tool names match `^[a-z][a-z0-9_]{0,31}$`. Core composes `<module>_<local>`.
The CLI validates these rules; a name outside them must be settled before generating the module.

## 3. Scaffold

Create the module package skeleton and wire it into config:

```
modules/<name>/
  module.ts              defineModule({ name, configSchema?, setup: (config) => ({ taxonomy?, skills?, instructions?, commands?, tools?, hygieneChecks?, cron? }) })
  mcp/<local>.ts         only for an agreed tool; defineModuleTool wrapper over the shared operation
  skills/<skill>/SKILL.md one per lifecycle moment identified in step 1
  README.md              contributed types, index-sync rules, hygiene checks; MCP tools when declared
  tests/module.test.ts   manifest + taxonomy roundtrip
```

Add the module's entry to the `modules` block in `brain.config.ts`. Skill bodies must be
agent-agnostic and call `brain` subcommands (they will be linted like every core skill).
For each agreed tool, declare a lazy `tools` import, strict zod 4 input/output object schemas,
described inputs, explicit `readOnlyHint` and `openWorldHint`, and `destructiveHint` when it writes.
State defaults and result caps in the description. Type its context with `ToolContext<Config>`
and use the provided config without casts or re-reading it. Backend permissions are separate;
annotations grant no access. Follow the
[module authoring guide](https://github.com/schlessera/brain-kit/blob/main/docs/modules.md#authoring-mcp-tools).

## 4. Quality gates — all green before "done"

```bash
brain module lint <name>
brain validate
brain skills sync
```

- `brain module lint <name>` — zod-validates the contributed manifest, checks skill frontmatter,
  runs the skill lint rules, and detects command/type/directory collisions. (`configSchema`
  already gates the load itself, so a loaded module implies a valid config block.) Tool checks
  cover imports, names, annotations, strict schemas, input descriptions and README coverage.
- `brain validate` — the brain is still consistent.
- `brain skills sync` — the module's skills are picked up and linked.
- **Taxonomy roundtrip** — for each contributed type `t`, `typeForPath(dirForType(t) + "/x.md")`
  returns `t`. Cover it in `tests/module.test.ts` and run the suite:
  ```bash
  bun test modules/<name>
  ```

## 5. Document it

Write the README to the same structure first-party modules use — they are the reference examples.
State the contributed types, how `_index.md` registries stay in sync with detail files (the Index
Sync Principle), and each hygiene check the module adds. A module without this documentation is
not done.
For a module with tools, scaffold a README `## MCP tools` section naming every canonical tool,
its inputs/defaults/caps and result shape, and the shared CLI operation. State which names and
schemas the module supports and how it versions them: namespacing prevents collisions, and
does not exclude them from compatibility policy. `brain module lint` enforces the tool checks.

For domain conventions, return optional `instructions: { text }` from `setup(config)`, derived
from validated settings. Text must be nonempty and contain no ownership markers. Core derives
owned `module-<name>` regions and estimates their active context cost. Personal prose and the
shared installed contract stay independently owned. Existing mixed generated sections need
explicit migration before toggles; never infer paragraph ownership. Test disable/enable with
content and config intact, and use the [module guide](https://github.com/schlessera/brain-kit/blob/main/docs/modules.md#instruction-contributions)
for the owned-region format.

## CLI it relies on

- `brain config check` — pre-scaffold collision check on the effective taxonomy.
- `brain module lint <name>` — manifest, skill, collision, config-schema and MCP tool validation.
- `brain validate` — whole-brain consistency.
- `brain skills sync` — register the new skills.
- `bun test` — run the module's roundtrip and unit tests.
