# Extending: skill emitters

The `SkillEmitter` seam bridges endoxa's skills to the many places different
coding agents look for them. Skills have **one canonical home** —
`.agents/skills/<name>/SKILL.md` — and emitters materialize that home into each
agent's native discovery location during `brain skills sync`.

## The interface

From `@endoxa/core` (`src/lib/seams.ts`):

```ts
export interface SkillManifest {
  name: string;                          // directory name == skill name
  description: string;
  dir: string;                           // absolute path to the skill directory
  source: "core" | "module" | "local";   // origin layer, for precedence
  frontmatter: Record<string, unknown>;  // raw frontmatter, for emitters that need extra keys
}

export interface SkillEmitter {
  agent: string;
  emit(
    skills: SkillManifest[],
    repoRoot: string
  ): { written: string[]; removed: string[] };
}
```

`emit` receives every discovered skill and writes them into the agent's expected
layout, returning what it wrote and what stale entries it removed.

## Built-ins

| Emitter  | Emits into                                                      | When it runs                          |
| -------- | -------------------------------------------------------------- | ------------------------------------- |
| `claude` | Symlinks in `.claude/skills/` (Windows junction fallback)      | Always.                               |
| `codex`  | `.codex/prompts/<name>.md` + a managed "Skills index" block in `AGENTS.md` | Opt-in via `skills.emitters`. |
| `gemini` | A managed "Skills index" block in `GEMINI.md`                   | Opt-in via `skills.emitters`.         |

The `claude` emitter always runs. Add others in `brain.config.ts`:

```ts
skills: { emitters: ["codex"] }   // claude always; also emit for codex
```

The **pi family needs no emitter** — pi and OMP-style agents discover
`.agents/skills/` (and `.claude` directories) natively, so the canonical home is
enough for them.

## Skill discovery layers

`brain skills sync` collects skills from three layers, later layers overriding
earlier ones by name:

1. **core** — skills shipped in `@endoxa/core`.
2. **module** — skills from enabled modules.
3. **local** — `.agents/skills/` in your own repo (your personal overrides win).

It then runs the emitter list. This is also how you keep a personal variant of a
shipped skill: drop your version in `.agents/skills/<name>/` and it shadows the
package's.

## Add your own (≤3 steps)

Emitters are small (each built-in is roughly 40 lines) — the index-block helpers
(`renderIndexBlock`, `upsertIndexBlock`, `readManagedNames`) are exported from
core so a new emitter is mostly a layout choice.

1. **Implement `SkillEmitter`:**

   ```ts
   // my-emitter.ts
   import type { SkillEmitter } from "@endoxa/core";

   export const myEmitter: SkillEmitter = {
     agent: "opencode",
     emit(skills, repoRoot) {
       const written: string[] = [];
       const removed: string[] = [];
       /* write skills into your agent's layout under repoRoot */
       return { written, removed };
     },
   };
   ```

2. **Wire it in.** The built-in emitters resolve by name from `skills.emitters`;
   a custom emitter is registered by the code that calls `syncSkills`. For a
   personal setup, the simplest path is a small local script that imports
   `syncSkills` with your emitter in the list.

3. **(Optional) publish** the emitter so others can adopt your agent format.

## Capability and degradation notes

- **Skill lint keeps skills portable.** `brain skills lint` (folded into `brain
  module lint`) flags agent-specific assumptions: it errors on missing
  `name`/`description`, warns when a skill body references Claude-only tools
  outside an `<!-- agent:claude -->` fenced section, and notes claude-specific
  frontmatter keys that other agents ignore. Write skills to the lint and they
  emit cleanly everywhere.
- **Index-block emitters are additive.** The codex/gemini emitters manage only a
  fenced block in `AGENTS.md` / `GEMINI.md`; everything you write around that
  block is preserved across syncs.

## See also

- [agent-runners.md](agent-runners.md) — running an agent against the brain.
- [README.md](README.md) — the seam meta-mechanism.
- [../configuration.md](../configuration.md#skills) — the `skills.emitters` config key.
- [../modules.md](../modules.md) — modules that contribute skills.
