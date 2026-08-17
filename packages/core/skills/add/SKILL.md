---
name: add
description: Use when capturing a thought, note, idea, fact, or update into the brain — jotting something down, recording what was just decided, remembering a detail. Also use when a capture landed under the wrong type or path, or when new content should extend an existing document instead of creating a second one.
---

# Add — Quick Capture

Getting a thought into the brain should be one command. Prefer `brain add` over hand-crafting a
file: it writes valid frontmatter, routes the content to the right directory, and keeps titles
consistent.

**This skill is guidance; `brain add` does the work.** The agent's judgment is only needed when
the heuristic guess is likely wrong or the user is clearly capturing a specific type.

## Default: let it classify

```bash
brain add "Kubernetes readiness probes need a longer initialDelay on cold starts"
```

With no flags, `brain add` classifies heuristically from the content and files it into the type's
directory with derived frontmatter. This is the Tier-0 path — it works with no API key and no
agent. Add `--smart` to use the configured completions provider for a better classification when a
key is available and the content is ambiguous.

## When to override

Override only when the guess is likely wrong or the user was explicit:

- `--type <type>` — force the document type (e.g. the user said "add this as an opinion").
- `--title "<title>"` — set an explicit title instead of deriving one from the first line.
- `--tags a,b,c` — seed tags when they matter for later retrieval.

If unsure, let the heuristic run and refile later with `/process-notes` — capture speed beats
perfect routing.

## Append vs. create (title-matched content)

Some types **append** rather than create a new file when the title matches an existing document —
for example ongoing project logs or per-contact network notes. When adding an update to something
that already exists (a new entry under an existing project, another data point about a known
contact), reuse the existing title so the content lands on the current document instead of
spawning a near-duplicate. When in doubt, search first:

```bash
brain search "<subject>" --json
```

If a clear home already exists, add with its title; otherwise let a new file be created.

## Notes

- Quick capture with no obvious home lands in the inbox (`notes/`, `status: active`) — that's
  intended. `/process-notes` files inbox items into the taxonomy later.
- Don't hand-write frontmatter to capture something; `brain add` gets the schema right every time.

## CLI it relies on

- `brain add "<content>" [--type] [--title] [--tags] [--smart]` — quick capture.
- `brain search --json` — check for an existing home before appending.
