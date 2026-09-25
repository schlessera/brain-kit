# Quickstart

> **Requires Bun ≥ 1.3.5 — npm/npx will not warn you (npm ignores `engines.bun`);
> install from https://bun.sh.**

From nothing to a working, searchable brain in three shell commands and one
conversation. This is the template path — the primary way to start.

You also need git, the [GitHub CLI](https://cli.github.com) (`gh`), and a coding
agent (Claude Code, or any agent that speaks MCP).

## 1. Create a private repo from the template

brain-kit ships a GitHub template repo. Create your own **private** copy and
clone it in one command:

```sh
gh repo create my-brain --template schlessera/brain-template --private --clone
cd my-brain
```

> **Keep this repository private.** It holds personal data, and coding agents
> read its files as instructions — a public repo is both a data leak and a
> prompt-injection surface. The `--private` flag above is not optional, and
> `brain doctor` warns loudly if your remote ever becomes public.

## 2. Install and set up

```sh
bun install
bun run setup
```

The explicit setup step configures the git hooks path, syncs skills into your
agent's discovery location, and installs the `brain` command as a symlink in
`~/.local/bin` (or `$XDG_BIN_HOME`). Setup does not add that directory to your
`PATH`; if `brain` is not found afterwards, add it to your shell profile, or run
`bun run brain …` from the repository instead. Setup does not build
the search index — nothing has been indexed yet, and a search before the first
`brain index` answers `Database not found. Run \`brain index\` first.` So index
once, and the CLI works with no API keys and no further setup:

```sh
brain index                            # builds brain.db from the markdown
brain search "hello"                   # finds the example note, notes/hello-brain.md
brain add "a thought I want to keep"   # captures a note into the inbox
```

`brain add` indexes what it writes, so after the first capture the index keeps
itself current; `brain index` is what you run after editing files by hand.

## 3. Run the onboarding interview

Open the repo in your coding agent. The bootstrap `CLAUDE.md` tells the agent
this is an uninitialized brain and points at the first step. Run:

```text
/brain-init
```

`/brain-init` is a conversation, not a form. It walks through:

1. **Identity** — your name, what you do (in a sentence or two), content
   language, and how you like the assistant to behave.
2. **Domains** — an open question ("what parts of your life should this track?")
   followed by a menu (work projects, career & job search, speaking, clients &
   freelancing, content, travel, health, hobbies, home, studies). A follow-up or
   two per domain sizes the structure.
3. **Taxonomy proposal** — it shows you the proposed directory tree and type
   list as plain text and iterates until you approve it.
4. **Generation** — it writes `brain.config.ts`, the directories (each with an
   `_index.md`), a seeded `me/identity.md`, your `CLAUDE.md`, and an `.env` stub,
   then makes one git commit. Every write goes through git, so a re-run is always
   revertable — the skill tells you so.
5. **Validation ladder** — it indexes, validates, runs a full-text search for
   your name to prove `me/identity.md` is findable, optionally wires up
   embeddings (below), and registers the MCP server.
6. **Handoff** — it points you at `/brain-import` (if you mentioned existing
   notes), `/brain-host`, and demonstrates a `brain add` capture.

If your brain has already been through this — its config declares a profile, a
taxonomy or a module — `/brain-init` switches to **amend mode**, and offers to
add a domain or regenerate sections instead of starting over. The starter
`brain.config.ts` the template ships does not count: it declares nothing, so a
brand-new brain gets the full interview. Either way it never overwrites files
that hold your content.

## 4. First capture and first search

Capture is one command; it writes valid frontmatter and routes the note to the
inbox:

```sh
brain add "Reading about hybrid search — FTS plus vectors, fused by score."
```

Search works in plain full-text mode with no keys at all:

```sh
brain search "hybrid search"
```

From inside an agent session the same capabilities are available as MCP tools
(`brain_search`, `brain_add`, `brain_context`, …), so you can capture and query
conversationally.

### Turn on semantic search (optional)

Full-text search finds documents that share your words. Semantic search finds
documents that share your *meaning*. To enable it, add a Gemini API key — the
free tier is plenty for a personal corpus:

```sh
# .env  (gitignored — never commit keys)
GEMINI_API_KEY=your-key-here
```

Then re-index with embeddings:

```sh
brain index --embeddings
```

`/brain-init` offers to do this for you and finishes with a "search by meaning"
query using a *paraphrase* of your identity sentence — the moment semantic
search proves itself.

## The degradation ladder

brain-kit is built so that every capability is additive: each tier adds power
without breaking the one below it. You are never blocked waiting for a key.

| Tier | You provide                          | You get                                                                                                                                             |
| ---- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | nothing (just Bun)                   | Full-text search (auto-degrades with warnings), `brain index`, `brain validate`, `brain audit`, mechanical `brain briefing`, heuristic `brain add`, MCP tools (degraded) |
| 1    | a signed-in coding agent             | Everything above **plus every skill** — `/brain-init`, `/brain-import`, conversational capture and review                                            |
| 2    | + a `GEMINI_API_KEY` (free tier fine)| Semantic and hybrid search, generated asset descriptions, richer `/whatsup` skill output via `brain briefing`                                        |
| 3    | + a `DEEPGRAM_API_KEY` (with the chat UI)| Voice capture in the self-hosted chat UI                                                                                                            |

Tier 0 is genuinely useful the moment you clone — the CLI needs only Bun. Tier 1
is what the flagship onboarding assumes. With no coding agent, you grow
`brain.config.ts` by hand ([configuration.md](configuration.md)); `brain init
--default` only fills in whatever of the core layout is missing — on a template
brain that is a root `_index.md` — then indexes and validates. It adds no
taxonomy of its own. Tiers 2 and 3 are opt-in upgrades. Hosting and voice are covered in
[hosting/README.md](hosting/README.md).

## Troubleshooting

When something looks off — after setup, after moving the repo between machines,
or before filing a bug — run the doctor:

```text
/brain-doctor
```

It runs a check battery (Bun version, git hooks, skill and bin symlinks, config
validity, index freshness, embeddings coverage, MCP registration, dependency
state, and **whether your git remote is public**), explains any failures in
plain language, and applies the safe fixes one at a time with your consent until
everything is green.

The underlying command is `brain doctor --json`; its output is also the
artifact to paste into a bug report — the doctor doubles as the support tool.

Run straight after `bun run setup`, before the first `brain index`, the `db`
check fails with `brain.db is missing`; the `brain index` in section 2 fixes it.
Once you have indexed, a keyless brain — Tier 0, the configuration you have the
moment you clone — passes every check except one, and that one is expected:

```
[warn] embeddings         GEMINI_API_KEY not set — vector search disabled (FTS still works)
```

That is the doctor reporting the tier you are on, not a problem to fix. It turns
into a pass when you add a key and re-index (see
[Turn on semantic search](#turn-on-semantic-search-optional)). Any *other*
warning is worth reading.

## See also

- [concepts.md](concepts.md) — frontmatter, types, wiki-links, the inbox.
- [configuration.md](configuration.md) — grow `brain.config.ts` by hand.
- [modules.md](modules.md) — add job-search, speaking, or finance workflows.
- [hosting/README.md](hosting/README.md) — back up and self-host your brain.
