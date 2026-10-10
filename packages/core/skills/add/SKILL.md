---
name: add
description: Use when capturing a thought, note, idea, fact, or update into the brain — jotting something down, recording what was just decided, remembering a detail. Also use when a capture landed under the wrong type or path, or when new content should extend an existing document instead of creating a second one.
---

## Hosted turns and terminal use

In a hosted turn, use `brain_add`, `brain_update`, and `brain_archive`
(Claude: `mcp__brain-ui__brain_add`, `mcp__brain-ui__brain_update`, and
`mcp__brain-ui__brain_archive`) for capture, append/frontmatter updates and
archiving. Read `brain_read_base` (`mcp__brain-ui__brain_read_base` on Claude)
before updating or archiving and pass its `expectedBaseHash`. Archive retains
its existing confirmation; voice cannot archive or grant by speech.

For another permitted Markdown change, use `write_file`, `edit_file`, or
`apply_staged_changes` (Claude: the corresponding `mcp__brain-ui__` name),
naming exact files, proposed content and base hashes. Never submit a command
for server replay. For note assimilation, capture the reviewed content with
`brain_add` and archive the source only after capture succeeds and the existing
archive approval permits it. The server indexes successful applications.

The CLI examples below are for a writable terminal brain. A CLI write in a
read-only hosted worker refuses visibly; it is not staged or replayed. Operations
on configuration, skills, assets, git or other unsupported file kinds require a
writable terminal. Do not substitute a shell write when a hosted tool refuses.


# Add — Quick Capture

Getting a thought into the brain should be one command. Prefer `brain add` over hand-crafting a
file: it writes valid frontmatter, routes the content to the right directory, and keeps titles
consistent.

**This skill is guidance; `brain add` does the work.** The agent's judgment is only needed when
the heuristic guess is likely wrong or the user is clearly capturing a specific type.

## Default: let it classify

```bash
brain add "The raft needs a stronger mast support before departure"
```

With no flags, `brain add` classifies heuristically from the content and files it into the type's
directory with derived frontmatter. This is the Tier-0 path — it works with no API key and no
agent.

For agent-assisted capture, use `brain add "<content>" --smart`. It delegates the content to
the configured agent runner, which can search, classify and route it using this skill. Smart
capture requires an available runner; follow that runner's own authentication setup.

## When to override

For ordinary capture, override when the guess is likely wrong or the user was explicit:

- `--type <type>` — force the document type (e.g. the user said "add this as an opinion").
- `--title "<title>"` — set an explicit title instead of deriving one from the first line.
- `--tags a,b,c` — seed tags when they matter for later retrieval.

Use ordinary capture for these explicit flags. The current `--smart` branch forwards only the
content to the agent runner; it does not forward `--type`, `--title` or `--tags`.

If unsure, let the heuristic run and refile later with `/process-notes` — capture speed beats
perfect routing.

## Append vs. create (title-matched content)

Types configured with `appendMatch: true` — for example project logs or per-contact notes — can
**append** to an indexed document. Ordinary capture uses the content's first line as its title:
that line must exactly match the existing title, ignoring case. Put the update below it and leave
`--type` unset to allow the automatic append. `--title` sets the output title; it does not choose
an existing append target by itself, and an explicit title must also match the target for an append.
When in doubt, search first:

```bash
brain search "<subject>" --json
```

If a clear home already exists in an append-match type, use its title as the content's first line.
Otherwise let a new file be created.

## Notes

- Quick capture with no obvious home lands in the inbox (`notes/`, `status: active`) — that's
  intended. `/process-notes` files inbox items into the taxonomy later.
- Don't hand-write frontmatter to capture something; `brain add` gets the schema right every time.

## CLI it relies on

- `brain add "<content>" [--type <type>] [--title "<title>"] [--tags a,b,c]` — ordinary keyless capture.
- `brain add "<content>" --smart` — delegate the content to the configured agent runner.
- `brain search --json` — check for an existing home before appending.
