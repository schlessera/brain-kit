# my-brain

> ## KEEP THIS REPOSITORY PRIVATE
>
> This is your personal brain. It holds identity notes, context about your life
> and work, and anything else you capture. Treat it like a private journal, not
> a public project. Two reasons it must stay private:
>
> 1. **Personal data.** Everything here is about you. A public repo leaks it to
>    the whole internet — permanently and searchably.
> 2. **Prompt-injection surface.** Coding agents read these files as
>    instructions. If a stranger could open a PR or issue that lands text in
>    your brain, they could try to steer your agent. Keeping the repo private
>    and solo removes that attack surface.
>
> The quickstart below creates the repo with `--private`, and `brain doctor`
> warns loudly if your remote ever becomes public. Keep it private.

A file-first personal knowledge base you operate through a coding agent.
Markdown is the source of truth; the search index (`brain.db`) is disposable and
rebuilt on demand.

## Quickstart

Create a **private** repo from the template and clone it:

```sh
gh repo create my-brain --template schlessera/brain-template --private --clone
cd my-brain
```

Install dependencies, then run the one-time setup explicitly:

```sh
bun install
bun run setup
```

Setup configures the repository's git hooks, syncs agent skills, and installs
the local `brain` command link.

Open the repo in your coding agent and run:

```
/brain-init
```

That interview builds your personalized taxonomy, seeds `me/identity.md`, wires
up the MCP server, and leaves you with a working brain. Even before it, the CLI
already works:

```sh
brain search "hello"                 # finds notes/hello-brain.md
brain add "a thought I want to keep"  # captures a note
```

## What works without any API keys

brain-kit degrades gracefully. Each tier adds capability without breaking the
one below it:

| Tier | You provide | You get |
|---|---|---|
| 0 | nothing (just Bun) | Full-text search, `brain index`, `brain validate`, `brain audit`, mechanical `brain briefing`, heuristic `brain add` capture, MCP tools (degraded) |
| 1 | a signed-in coding agent | Everything above **plus** all skills — `/brain-init`, `/brain-import`, conversational capture and review |
| 2 | + `GEMINI_API_KEY` (free tier is fine) | Semantic + hybrid search, asset descriptions, richer `/whatsup` skill output via `brain briefing` |
| 3 | + `DEEPGRAM_API_KEY` (with brain-ui) | Voice capture |

Tier 0 means the CLI is useful the moment you clone. Add a `GEMINI_API_KEY` when
you want the "search by meaning" experience — see [`.env.example`](.env.example).

## Documentation

Full docs — concepts, CLI reference, MCP, hosting, and modules — live with the
core project: <https://github.com/schlessera/brain-kit>.
