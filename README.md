# brain-kit

> **Status: early, solo-maintained, extension interfaces marked `@experimental` until 1.0.**
> Where this stands and what binds new work: [ROADMAP.md](ROADMAP.md).
> What is planned: the [issues](https://github.com/schlessera/brain-kit/issues).

A private, file-first knowledge base your AI agent actually operates — not a note app with an
AI plugin.

You clone a template, open a coding agent, run `/brain-init`, answer an interview, and end up
with an **individualized directory taxonomy** that works out of the box with:

- the `brain` CLI — index, search, validate, audit, briefing, add, …
- SQLite hybrid search (FTS5 + sqlite-vec) with optional embeddings
- an MCP server (`brain_*` tools) for any agent session
- workflow skills (core lifecycle + optional modules: jobs, speaking, finance)
- optionally, a self-hosted chat UI, to be deployed from `brain-hosting-template`
  (not published yet; see [docs/hosting](docs/hosting/README.md))

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
packages/core                @schlessera/brain — CLI, MCP server, search, index, config, skills
packages/module-images       @schlessera/brain-module-images — image generation/editing, routed
                             between OpenAI and Gemini models by capability
packages/module-jobs         @schlessera/brain-module-jobs — job-search scraping/scoring module
packages/module-speaking     @schlessera/brain-module-speaking — talks/conferences module
packages/module-travel       @schlessera/brain-module-travel — journeys/day trips/visited places
packages/module-finance      @schlessera/brain-module-finance — client ledger / AR module
packages/ui-sdk              @schlessera/brain-ui-sdk — chat-UI wire protocol + runtime schemas,
                             AgentBackend/SpeechProvider seams, renderer/ASR registries
packages/ui-backend-claude   @schlessera/brain-backend-claude — AgentBackend on the Claude Agent SDK
packages/ui-backend-pi       @schlessera/brain-backend-pi — AgentBackend on the pi coding-agent SDK
packages/render-template     @schlessera/brain-render-template — shared markdown/HTML → print-ready
                             document shell (marked + stylesheet); used by /api/render and `brain render`
packages/ui-render-puppeteer @schlessera/brain-render-puppeteer — optional HTML→PNG/PDF renderer
                             (network-denied, scriptless; see its header for the threat model)
packages/scrape              @schlessera/brain-scrape — scraping base: polite HTTP (robots.txt,
                             per-host pacing), optional headless Chrome, site-adapter seam
packages/ui-server           @schlessera/brain-ui-server — Hono app factory: WS turn coordinator,
                             auth (password/passkeys/tailscale/proxy), session catalog, routes
packages/ui-kit              @schlessera/brain-ui-kit — presentational design kit: components,
                             design tokens, and the Storybook that documents them
packages/ui-react            @schlessera/brain-ui-react — React chat/files/voice components,
                             stores, WS transport; prebuilt JS + precompiled CSS
template/                    source for the brain-template repo (user starting point)
docs/                        quickstart, concepts, CLI, MCP, hosting, modules, extending,
                             plus decisions/ (why), plans/ (unbuilt design) and process/
```

The chat UI is not in this repository either. What you self-host is a thin
deployment shell — Dockerfile, bin entry, branding — over the published
`brain-ui-server` and `brain-ui-react` packages. You will generate that shell
from `schlessera/brain-hosting-template`; see
[docs/hosting/README.md](docs/hosting/README.md), and note that the template is
not published yet.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3.5.

```sh
bun install
bun run test       # not `bun test` — the script supplies the timeout the CLI tests need
bun run typecheck
```

## Where to go

- [docs/quickstart.md](docs/quickstart.md) — clone the template to a working brain.
- [docs/README.md](docs/README.md) — the full documentation index.
- [CONTRIBUTING.md](CONTRIBUTING.md) — prerequisites, running the code, what gets merged.
- [SECURITY.md](SECURITY.md) — threat model and how to report.
- [ROADMAP.md](ROADMAP.md) — where this stands and the decisions that bind new work.
- [docs/process/github.md](docs/process/github.md) — how work is tracked: labels, milestones, the board.
- [docs/decisions/](docs/decisions/README.md) — why things are the way they are.
- [docs/hosting/README.md](docs/hosting/README.md) — backups, and self-hosting the chat UI.

## License

MIT
