# Extending: skill emitters

The `SkillEmitter` seam bridges brain-kit's skills to the many places different
coding agents look for them. Skills have **one canonical home** —
`.agents/skills/<name>/SKILL.md` — and emitters materialize that home into each
agent's native discovery location during `brain skills sync`.

## The interface

From `@schlessera/brain` (`src/lib/seams.ts`):

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
| `codex`  | A managed contract block in `AGENTS.md` (the installed `CONTRACT.md`) | Opt-in via `skills.emitters`. |
| `gemini` | A managed "Skills index" block in `GEMINI.md`                   | Opt-in via `skills.emitters`.         |
| `pi`     | Symlinks in `.pi/skills/` (Windows junction fallback)           | Opt-in via `skills.emitters`.         |

The `claude` emitter always runs. Add others in `brain.config.ts`:

```ts
skills: { emitters: ["codex"] }   // claude always; also emit for codex
```

Codex discovers skills in `.agents/skills/` itself, from the working directory
up to the repository root, so the `codex` emitter writes no per-skill files.
What Codex cannot reach is the agent contract: `CLAUDE.md` imports
`CONTRACT.md` with an `@` line, and `AGENTS.md` has no import mechanism. The
emitter copies the body of the installed `CONTRACT.md` between
`<!-- brain-kit:contract:start -->` and `<!-- brain-kit:contract:end -->`, so it
updates with the package on every sync. With the emitter on, `/brain-init`
writes `CLAUDE.md` as `@AGENTS.md` plus the personal overlay, so the contract
is loaded once. A skill that is manual-only (`disable-model-invocation: true`)
ships an `agents/openai.yaml` with `policy.allow_implicit_invocation: false`
beside its `SKILL.md`, which is where Codex reads that policy; `brain skills
lint` warns when the two disagree.

Earlier versions wrote `.codex/prompts/<name>.md`, which Codex never read from
a project, and a "Skills index" block in `AGENTS.md`. The first sync after
upgrading replaces the index block with the contract block in place and
deletes the prompt files the index block named. Prompts it did not name are
yours and stay.

pi does **not** read `.agents/skills/`, despite the name. It discovers skills
from `<agentDir>/skills` (user level — `$PI_AGENT_DIR`, else `~/.pi/agent`) and
from `<cwd>/.pi/skills` (project level), so a brain's skills are invisible to it
without the `pi` emitter even though they sit one directory away.

## Skill discovery layers

`brain skills sync` collects skills from three layers, later layers overriding
earlier ones by name:

1. **core** — skills shipped in `@schlessera/brain`.
2. **module** — skills from enabled modules.
3. **local** — `.agents/skills/` in your own repo (your personal overrides win).

It then runs the emitter list. This is also how you keep a personal variant of a
shipped skill: drop your version in `.agents/skills/<name>/` and it shadows the
package's.

## Add your own (≤3 steps)

Emitters are small (each built-in is roughly 40 to 80 lines), and a new one is
mostly a layout choice.

1. **Implement `SkillEmitter`:**

   ```ts
   // my-emitter.ts
   import type { SkillEmitter } from "@schlessera/brain";

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

## Test it against the contract

`@schlessera/brain/testing` exports `runSkillEmitterContract`, the suite every
entry in `BUILTIN_EMITTERS` runs in `packages/core/tests/seam-contracts.test.ts`.
It builds a scratch repository with two skills in `.agents/skills/` and
asserts that `emit` reports repo-relative paths that exist once written and
are gone once removed, that every skill is reachable from what it wrote, that
a skill dropped from the list leaves the layout, that re-emitting an
unchanged list removes nothing, and that `.agents/skills/` itself is never
written. An emitter for an agent that reads `.agents/skills/` natively, as
Codex does, passes `readsCanonicalHome: true`: the reachability checks are
waived, and everything else still applies.

```ts
import { describe, expect, test } from "bun:test";
import { runSkillEmitterContract } from "@schlessera/brain/testing";
import { myEmitter } from "./my-emitter";

runSkillEmitterContract({ name: "opencode", emitter: () => myEmitter }, { describe, expect, test });
```

## Capability and degradation notes

- **Skill lint keeps skills portable.** `brain skills lint` (folded into `brain
  module lint`) flags agent-specific assumptions: it errors on missing
  `name`/`description`, warns when a skill body references Claude-only tools
  outside an `<!-- agent:claude -->` fenced section, and notes claude-specific
  frontmatter keys that other agents ignore. Write skills to the lint and they
  emit cleanly everywhere.
- **Block emitters are additive.** The codex and gemini emitters manage only a
  fenced block in `AGENTS.md` / `GEMINI.md`; everything you write around that
  block is preserved byte for byte across syncs.

## See also

- [agent-runners.md](agent-runners.md) — running an agent against the brain.
- [README.md](README.md) — the seam meta-mechanism.
- [../configuration.md](../configuration.md#skills) — the `skills.emitters` config key.
- [../modules.md](../modules.md) — modules that contribute skills.
