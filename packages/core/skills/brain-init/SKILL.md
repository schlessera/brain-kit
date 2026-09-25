---
name: brain-init
description: Use when setting up a brand-new brain for the first time, turning a fresh template into a personal one, or later when its identity, domains, or taxonomy need extending.
compatibility: Requires git. The MCP registration example uses claude; other agents register it their own way.
---

# Brain Init — Personalized First-Run Interview

Turns a fresh template into a working, individualized brain through a conversation.
The agent interviews the user, proposes a taxonomy, generates the structure, and walks
a validation ladder to a searchable brain. Every write funnels through one git commit,
so a re-run is always revertable — tell the user this up front.

**Principle: this skill orchestrates; the `brain` CLI executes.** Judgment (what domains,
what taxonomy, tone) lives here. Deterministic checks and file/index operations are
`brain` subcommands.

## Stage 0 — Preflight

```bash
brain init --check
```

Read the JSON: bun version, git repo, `core.hooksPath`, the `config` block, existing
content dirs, key presence.

- Branch on **`config.initialized`**, never on `config.exists`. The template ships a
  `brain.config.ts` with every field commented out, so `exists` is true on a brain that has
  never been through this interview — branching on it sent every new user into amend mode.
  `initialized` is true only once the config declares something: a profile, a taxonomy, a
  module, an embedding provider.
- If `config.initialized` is **true** → switch to **amend mode**. Never proceed as if fresh
  and never overwrite user content. Offer: add a domain, regenerate CLAUDE.md marked
  sections, re-run validation. Run the relevant stages below against the existing config only.
- If `config.initialized` is **false** → run the full interview, even when `exists` is true.
  Stage 4 writes over the starter config; that is what it is for.
- If `config.valid` is **false**, the config file is there but broken (`config.error` says how).
  Fix or replace it with the user before interviewing — do not interview against a brain whose
  config does not load.
- If preflight reports a blocking problem (no bun, not a git repo), explain it plainly and stop.

## Stage 1 — Identity interview

Ask, one topic at a time:

1. Their name, and what the agent should call them.
2. "In one or two sentences, what do you do?" — capture verbatim. This seeds `me/identity.md`
   **and** the Stage 5 search smoke test, so keep the exact wording.
3. Content language (non-English brains are a first-class case — do not assume English).
4. Assistant tone and interaction preferences (terse vs. explanatory, proactive vs. on-request).
   These become the Personal Rules overlay in CLAUDE.md.

## Stage 2 — Domains interview

Open question first: "What parts of your life should this system track?" Let them answer freely.

**Then** present the module menu with recognizable one-liners so nothing is forgotten:

- work projects · career & job search · speaking & conferences · clients & freelancing
- content & social presence · travel · health · hobbies · home & household · studies

For each selected domain, ask 1–2 sizing follow-ups (e.g. speaking: "track CFP submissions
per conference?"; clients: "one ledger per client?"). **Remember whether they mention existing
notes to import** — Stage 6 needs that answer.

## Stage 3 — Taxonomy proposal

Present the proposed structure as a literal ASCII tree plus a type list, and iterate until the
user approves it. Core types are always present regardless of domains:
`identity`, `context`, `note`, `index`.

```
me/            identity   — who you are, bios, canonical facts
context/       context    — current focus, working state
notes/         note       — quick-capture inbox
projects/      project    — (if work projects selected)
career/        career     — (if career & job search selected)
...
_index.md      index      — one per directory: purpose + registry table
```

Explain each type in one line. Fold domain choices into concrete directories. Do not finalize
until the user says the tree matches how they think about their life.

## Stage 4 — Generation

After showing a summary of what will be written, generate:

- **`brain.config.ts`** — the approved taxonomy, enabled modules, profile (name, cliTitle),
  and provider defaults. This is the single source of the structure.
- **Directories**, each with an `_index.md` (type `index`): a one-line purpose blurb and an
  empty registry table.
- **`me/identity.md`** seeded from the Stage 1 self-description.
- **CLAUDE.md** — the personal overlay (Layer 2). Import the shipped agent contract on the
  first line via `@node_modules/@schlessera/brain/CONTRACT.md`, then fill the fixed skeleton
  (Quick Navigation, Key Conventions, Directory Structure, Personal Rules). Wrap every
  generated region in `<!-- brain:generated:{section} -->` … `<!-- /brain:generated:{section} -->`
  markers. Anything outside the markers is the user's forever and must never be rewritten.
- **`.env`** from `.env.example` with keys commented out.
- Ensure the empty sidecar caches exist (`.context-cache.jsonl`, `.asset-cache.jsonl`).

Then commit once:

```bash
git add -A
git commit -m "brain-init: personalized structure (N domains)"
```

Substitute the real domain count for N. This single commit is the revert point.

## Stage 5 — Validation ladder

Run these in order and report each result in plain language:

1. `brain index` → doc count is at least the number of files generated.
2. `brain validate` → zero errors. If any, fix and re-run before proceeding.
3. FTS smoke — the user's name must surface their identity file:
   ```bash
   brain search "<user's name>" --mode fts --json
   ```
   Confirm `me/identity.md` is in the results.
4. **Optional embeddings — the "wow" moment.** Offer `GEMINI_API_KEY`: "optional, enables
   semantic search; the free tier covers a personal brain." If provided, write it to `.env`, then:
   ```bash
   brain index --embeddings
   ```
   Then run a **semantic** query using a *paraphrase* of their identity sentence (deliberately
   not their literal words) and show the hit:
   ```bash
   brain search "<paraphrase of their self-description>" --mode vector --json
   ```
   Point out that no shared keywords were needed — that is the embeddings working.
5. **MCP registration** — make the `brain_*` tools available in-session, served from
   **this** brain. First ask the CLI whether a `brain` server is registered anywhere:
   ```bash
   brain doctor --json
   ```
   Read the entry of `checks` whose `id` is `"mcp"`. It passes when it finds a `brain`
   server in the project's `.mcp.json`, in the top-level `mcpServers` of `~/.claude.json`
   (user scope), or in the output of `claude mcp list`. It does not start the server or
   check which brain it serves, so a pass means "registered", not "working here".
   - **`status` is `"pass"`** — do **not** run `claude mcp add`: on a template brain the
     project's `.mcp.json` already declares the server, and adding it again leaves a second
     `brain` server beside the one the repo carries. Tell the user where it is registered
     (the check's `detail`) and go to the verification below.
   - **Any other status** — register it. For Claude Code:
     ```bash
     claude mcp add brain -- bun node_modules/.bin/brain mcp
     ```
     (Other agents register the `brain` MCP server through their own mechanism.)

   **Verify against this brain.** A server the project's `.mcp.json` declares loads when the
   session starts and the user approves it. If the `brain_*` tools are not there yet, ask the
   user to restart the session and approve the `brain` server; a restart or an approval is
   not success on its own. Then:
   - call `brain_search` for the user's name and confirm `me/identity.md` is among the hits;
   - call `brain_read` on `me/identity.md` and confirm it returns the same frontmatter and
     body as `me/identity.md` on disk in this repo, as Stage 4 wrote it (read the file to
     compare; an index warning the tool adds is not part of the note). A hit on the name
     alone does not prove it: a `brain` server registered for another brain can hold an
     identity note for the same person.

   **If verification fails** — the tools are still missing after the restart and approval,
   or `brain_read` returns anything other than this repo's file — the registration doctor
   found serves another brain or does not start. Register the server for this repo at
   project scope, which Claude Code prefers over a user-scope `brain`:
   - if `.mcp.json` has no `brain` entry:
     ```bash
     claude mcp add --scope project brain -- bun node_modules/.bin/brain mcp
     ```
   - if `.mcp.json` has a `brain` entry, rewrite that entry to
     `{ "command": "bun", "args": ["node_modules/.bin/brain", "mcp"] }`.

   A local-scope `brain` for this directory still wins over both; `claude mcp get brain` shows
   which definition is live, and if it is a local-scope one pointing elsewhere, remove it with
   the user's consent (`claude mcp remove brain --scope local`). Restart, approve, and verify
   again. Do not move on to Stage 6 until `brain_read` returns this brain's identity note.

## Stage 6 — Handoff

Close the loop:

- If Stage 2 surfaced existing notes to bring in, point them to `/brain-import`.
- Mention `/brain-host` for backup or self-hosting when they are ready.
- Demonstrate one capture live: `brain add "a quick thought"` and show where it landed.

## Idempotency (state this to the user)

- Amend mode never treats an initialized brain as fresh.
- Files with user content are never overwritten; only marker-delimited regions are rewritten.
- Everything went through one git commit, so any re-run damage is `git revert`-able.

## CLI it relies on

- `brain init --check` — preflight JSON (runtime, git, config, keys).
- `brain index` / `brain index --embeddings` — build the search index.
- `brain validate` — frontmatter and link validation.
- `brain search --mode fts|vector --json` — FTS and semantic smoke tests.
- `brain doctor --json` — its `mcp` check says whether the MCP server is already registered.
- `brain add` — demonstrate quick capture.
- `git` (commit the generated structure), `claude mcp add` (Claude-only MCP registration example).
