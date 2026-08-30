---
name: add-skill
description: Use when the user wants to create, design, install, or improve a custom skill for their brain — "add a skill", "make a skill that…", "turn this workflow into a skill", or when a workflow keeps repeating and deserves packaging. Also use to review why an existing custom skill isn't triggering or isn't working across backends.
---

# Add Skill — guided custom-skill authoring

You are helping the user add THEIR OWN skill to this brain deployment. Custom
skills live in the brain repo at `.agents/skills/<name>/` as real directories:
they persist across redeployments, ride the repo's git backups, take
precedence over same-named built-ins, and reach EVERY backend (Claude, pi,
codex, gemini) through `brain skills sync`. The user can later edit,
disable, or remove them in Settings → Skills.

**This is an interview, not a transcription job.** A skill written from one
sentence of intent is usually wrong in the two places that matter most: the
trigger and the scope.

## 1. Interview

Ask (use the ask-user picker where the answer is one of a few options):

- **What workflow?** Get one concrete example of the user doing it manually,
  end to end. The skill's body is that walkthrough, generalized.
- **When should it fire?** Collect the phrases the user would actually say
  ("post this to LinkedIn", "log my weight"). These become the description.
- **When should it NOT fire?** Near-miss cases; put exclusions in the
  description if triggering wrongly would annoy.
- **What does it touch?** Brain documents only? External services? Files?
  Anything needing credentials → the credential must already be in the
  container env; say so if it isn't.

## 2. Design rules for THIS environment

- **The description is the dispatch mechanism.** Write it as trigger
  conditions ("Use when…"), not a summary. Include the user's own phrasings.
  Every agent picks skills by this one line.
- **Name**: lowercase kebab-case, max 64 chars; the frontmatter `name` MUST
  equal the directory name.
- **Portable frontmatter only**: `name` and `description`. Claude-specific
  fields (`allowed-tools`, `context`, `agent`) are silently ignored by the
  other backends — do not rely on them.
- **Backend-portable instructions**: the backends have DIFFERENT tool names
  (Claude: `Bash`, `mcp__brain__brain_search`; pi: `bash`, `brain_search`).
  Never name a specific tool in the skill body. Instead:
  - Describe intent ("search the brain for…", "read the document…"), or
  - Use the `brain` CLI via shell (`brain search`, `brain add`, …) — every
    backend has a shell tool and the CLI is on PATH in the repo.
- **Scripts**: put helper scripts inside the skill directory and reference
  them by path relative to the repo root
  (`.agents/skills/<name>/helper.ts`); run them with `bun`, which every
  backend's shell has. No Python unless the deployment confirmed it exists.
- **Approvals**: shell commands and writes may raise approval cards. Batch
  work; don't design a skill that fires twenty tiny gated commands.
- **Keep it one screen.** A skill is instructions, not documentation. Move
  bulk reference into extra files in the skill dir and tell the agent to
  read them only when needed.

## 3. Write it

1. Draft the SKILL.md and show it to the user for confirmation BEFORE
   writing — the description line especially.
2. Write to `.agents/skills/<name>/SKILL.md` (create the directory; add any
   helper files beside it).
3. Run `brain skills sync` — this links the skill into every agent
   integration dir and updates the AGENTS.md index.
4. Run `brain skills lint` and fix anything it reports.

## 4. Verify and hand off

- The Claude backend sees the skill from its NEXT turn; the pi backend from
  its next new conversation.
- Tell the user: manage it later in Settings → Skills (edit, disable,
  remove — and install more from a ZIP or a GitHub repo there), and the
  files live in the brain repo so the next `brain sync` commits them.
- Offer a dry run: restate a trigger phrase and confirm the skill would be
  the one to fire.
