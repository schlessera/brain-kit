---
"@schlessera/brain": minor
"@schlessera/brain-module-speaking": patch
---

The `codex` skill emitter now gives Codex the brain's agent contract, and stops writing files Codex never read. `brain skills sync` with `skills: { emitters: ["codex"] }` copies the body of the installed `CONTRACT.md` into `AGENTS.md` between `<!-- brain-kit:contract:start -->` and `<!-- brain-kit:contract:end -->`, and it no longer writes `.codex/prompts/`. Codex already finds skills in `.agents/skills/`. The first sync after upgrading swaps the old "Skills index" block for the contract block in place. It also deletes the `.codex/prompts/<name>.md` files that block named, and `.codex/` if that leaves it empty. With the emitter on, `/brain-init` writes `CLAUDE.md` as `@AGENTS.md` plus your overlay, so the contract loads only once.

Manual-only skills are now manual-only for Codex too. The shipped `sync` and `new-submission` skills carry `agents/openai.yaml` with `policy.allow_implicit_invocation: false`, and `brain skills lint` warns when a skill's `disable-model-invocation` and that policy disagree. `runSkillEmitterContract` takes `readsCanonicalHome: true` for an emitter whose agent reads `.agents/skills/` itself.
