# brainform

> **Status: pre-release, under active construction.** This repo is being built out from a
> proven private implementation. Progress: [PROGRESS.md](PROGRESS.md). Plans: [plan/](plan/).

A private, file-first knowledge base your AI agent actually operates — not a note app with an
AI plugin.

You clone a template, open a coding agent, run `/brain-init`, answer an interview, and end up
with an **individualized directory taxonomy** that works out of the box with:

- the `brain` CLI — index, search, validate, audit, briefing, add, …
- SQLite hybrid search (FTS5 + sqlite-vec) with optional embeddings
- an MCP server (`brain_*` tools) for any agent session
- workflow skills (core lifecycle + optional modules: jobs, speaking, finance)
- optionally, a self-hosted chat UI (brain-ui, separate repo)

## What makes it different

1. **Markdown is the source of truth; the index is disposable.** `brain index --force`
   regenerates everything — that is also the upgrade story.
2. **One versioned contract** across CLI + hybrid search + MCP + skills + optional chat UI.
3. **Onboarding builds *your* taxonomy** instead of shipping someone else's.
4. **Provider-agnostic by architecture** — embeddings, completions, agent runners, agent
   backends, and STT sit behind small typed seams. Surviving model/provider/SDK shakeups is a
   design goal.

Deliberately **not** pluggable: SQLite+FTS5+sqlite-vec as the index engine, markdown+git as
the source of truth, the chunking/ranking pipeline, the wire protocol, the Bun/Hono/React
stack, and the `brain` CLI/MCP surface. These are the product.

## Repository layout

```
packages/core                @brainform/core — CLI, MCP server, search, index, config, skills
packages/module-jobs         @brainform/module-jobs — job-search scraping/scoring module
packages/module-speaking     @brainform/module-speaking — talks/conferences/travel module
packages/module-finance      @brainform/module-finance — client ledger / AR module
packages/ui-sdk              @brainform/ui-sdk — chat-UI wire protocol + runtime schemas,
                             AgentBackend/SpeechProvider seams, renderer/ASR registries
packages/ui-backend-claude   @brainform/ui-backend-claude — AgentBackend on the Claude Agent SDK
packages/ui-backend-pi       @brainform/ui-backend-pi — AgentBackend on the pi coding-agent SDK
packages/ui-render-puppeteer @brainform/ui-render-puppeteer — optional HTML→PNG/PDF renderer
                             (network-denied, scriptless; see its header for the threat model)
template/                    source for the brainform-template repo (user starting point)
docs/                        quickstart, concepts, CLI, MCP, hosting, modules, extending
plan/                        implementation plans (removed from the public release)
research/                    verified research notes (removed from the public release)
```

## Development

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
