---
name: new-module
description: Use when a recurring domain workflow has outgrown personal overlay skills and deserves to be installable in its own right, with its own directories, taxonomy types, commands, and skills.
compatibility: Requires bun to run the module's tests.
---

# New Module — Author a Workflow Module

Scaffolds a new module the same way first-party modules are built — a manifest, skills, a README,
and tests — and gates it on the same checks. A module is an npm package (or local directory) whose
entry default-exports a manifest via `defineModule()`; it contributes taxonomy, skills, optional
CLI commands, hygiene checks, and cron lines. No plugin daemon — pure data plus lazy command imports.

**This skill orchestrates; the CLI validates.** The agent designs and scaffolds; `brain module lint`
and `brain validate` enforce correctness before it's declared done.

## 1. Interview

Establish scope before writing anything:

- **Domain** — what recurring workflow does this module serve?
- **Types and directories** — which document types does it own, and where do they live?
- **Lifecycle moments** — which points in the workflow deserve a skill (capture, review, follow-up)?
- **CLI command** — is a namespaced `brain <word>` command warranted, or do skills calling core
  commands suffice? Modules register at most one top-level word.

## 2. Collision-check the effective taxonomy — before scaffolding

The effective taxonomy is core built-ins ⊕ module contributions ⊕ user overrides. Two owners for
one type, or overlapping directory prefixes, are **hard validation errors**. Check first:

```bash
brain config check
```

Confirm the proposed types and directories don't collide with core or an already-enabled module.
Resolve any clash by renaming before generating files.

## 3. Scaffold

Create the module package skeleton and wire it into config:

```
modules/<name>/
  module.ts              defineModule({ name, configSchema?, setup: (config) => ({ taxonomy?, skills?, commands?, hygieneChecks?, cron? }) })
  skills/<skill>/SKILL.md one per lifecycle moment identified in step 1
  README.md              contributed types, index-sync rules, hygiene checks
  tests/module.test.ts   manifest + taxonomy roundtrip
```

Add the module's entry to the `modules` block in `brain.config.ts`. Skill bodies must be
agent-agnostic and call `brain` subcommands (they will be linted like every core skill).

## 4. Quality gates — all green before "done"

```bash
brain module lint <name>
brain validate
brain skills sync
```

- `brain module lint <name>` — zod-validates the contributed manifest, checks skill frontmatter,
  runs the skill lint rules, and detects command/type/directory collisions. (`configSchema`
  already gates the load itself, so a loaded module implies a valid config block.)
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

## CLI it relies on

- `brain config check` — pre-scaffold collision check on the effective taxonomy.
- `brain module lint <name>` — manifest, skill, collision, and config-schema validation.
- `brain validate` — whole-brain consistency.
- `brain skills sync` — register the new skills.
- `bun test` — run the module's roundtrip and unit tests.
