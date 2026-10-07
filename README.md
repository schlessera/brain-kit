# brain-kit

Keep notes, decisions and plans in Markdown, and let your coding agent capture,
search and maintain them in a git repository you own.

The `brain` CLI works locally without API keys: capture a thought, find it again,
and check for broken links or stale notes. A coding agent adds conversational
capture and review. Your files remain readable in any editor; `brain.db` is a
disposable search index that `brain index --force` rebuilds from those files.

> **Early and solo-maintained.** Extension interfaces remain `@experimental`
> until 1.0. See the [roadmap](ROADMAP.md) for current limits and the
> [issues](https://github.com/schlessera/brain-kit/issues) for planned work.

## Start here

| What you want to do | Where to start |
| --- | --- |
| Use a brain from the CLI or a coding agent | [Quickstart](docs/quickstart.md): create a private copy of the [brain template](https://github.com/schlessera/brain-template), capture a note and search it. |
| Back up your brain or self-host the chat UI | [Hosting overview](docs/hosting/README.md): private git backup works today; the hosting starter is not published yet. |
| Build with the packages or contribute | [Development](CONTRIBUTING.md) for setup and checks; [extension guide](docs/extending/README.md) for the supported provider interfaces. |

## Capture and search your first note

You need [Bun](https://bun.sh) **≥ 1.3.5**, git, and an authenticated
[GitHub CLI](https://cli.github.com). Keep the content repository private.

```sh
gh repo create my-brain --template schlessera/brain-template --private --clone
cd my-brain
bun install
bun run setup
bun run brain index
bun run brain add "Tie me to the mast before the Sirens."
bun run brain search "Sirens"
```

`bun run brain` uses the installed package from inside your repository, so it
works even if the `brain` command link is not on your `PATH`. Setup configures
hooks, syncs agent skills and installs that link; the explicit `index` builds
the initial search database. Capture writes a Markdown note with frontmatter
and indexes it. After editing files by hand, run `bun run brain index` again.

For conversational use, open the repository in a signed-in coding agent and
run `/brain-init`. The interview proposes directories and document types for
your own needs. You can also [configure them by hand](docs/configuration.md).
The CLI path above works before the interview; live agent onboarding still
[awaits maintainer verification](https://github.com/schlessera/brain-kit/issues/26).

## What you can do

- **Find what you wrote.** Full-text search uses SQLite FTS5 with no keys.
  Optional embeddings add semantic and hybrid search through sqlite-vec.
  [Search setup](docs/quickstart.md#turn-on-semantic-search-optional)
  explains the opt-in step.
- **Keep notes usable.** `brain validate` checks frontmatter and links;
  `brain audit` finds stale content, orphans and lagging summaries;
  `brain briefing` surfaces deadlines and review dates. See the
  [content model](docs/concepts.md) and [CLI reference](docs/cli.md).
- **Capture and query from an agent.** The [MCP server](docs/mcp.md) exposes
  `brain_*` tools. Skills guide onboarding, imports and maintenance while the
  CLI performs the deterministic operations.
- **Add a domain workflow.** Optional modules cover
  [job search](packages/module-jobs/README.md),
  [talks and conferences](packages/module-speaking/README.md),
  [client receivables](packages/module-finance/README.md), and
  [image generation and editing](packages/module-images/README.md).
  Each has its own setup and provider requirements; enable only what you need.
  The separate [travel module](packages/module-travel/README.md) covers journeys,
  day trips and visited places, with migration from the speaking module.

## Optional chat UI

The published server and React packages provide chat, file browsing and voice
capture. A host supplies the process, build, authentication configuration and
branding, separately from the repository that holds your notes.

**The hosting template is not published yet.** The
[hosting overview](docs/hosting/README.md) explains backup, hosting prerequisites
and costs. A ready-to-generate self-hosting path remains
[tracked in the hosting epic](https://github.com/schlessera/brain-kit/issues/70).

## Privacy and costs

Local indexing, ordinary capture and full-text search need no model service.
A coding agent uses its own subscription or API credentials. Optional
embeddings, completions, image generation and voice services can send content
or audio to their providers and may incur charges. A private git repository
does not encrypt the Markdown files; choose storage and backup protection
accordingly. See [SECURITY.md](SECURITY.md) for the threat model and reporting.

## Developers

This monorepo publishes the CLI, domain modules and chat UI as packages. Start
with [CONTRIBUTING.md](CONTRIBUTING.md) for runtime prerequisites, development
commands and the checks a contribution must pass:

```sh
bun install
bun run test       # supplies the CLI tests' timeout and network guards
bun run typecheck
```

The [integration contract](docs/integration-contract.md) defines the supported
machine surfaces. The [extension guide](docs/extending/README.md) covers typed
provider interfaces for embeddings, completions, agent runners and backends,
speech and other supported seams. Those extension interfaces are experimental
until 1.0.

Deliberately **not** pluggable: SQLite+FTS5+sqlite-vec as the index engine, markdown+git as
the source of truth, the chunking/ranking pipeline, the wire protocol, the Bun/Hono/React
stack, and the `brain` CLI/MCP surface. These are the product.

<details>
<summary>Package map and repository layout</summary>

## Repository layout

```
packages/geo                 @schlessera/brain-geo — shared geo services, track measurements and static maps
packages/core                @schlessera/brain — CLI, MCP server, search, index, config, skills
packages/module-video        @schlessera/brain-module-video — Gemini video watching, opt-in
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

</details>

## More documentation

- [Documentation index](docs/README.md): concepts, configuration and reference.
- [Roadmap](ROADMAP.md): current state and binding decisions.
- [Decision records](docs/decisions/README.md): why the architecture has this shape.
- [Project process](docs/process/github.md): issues, labels and milestones.

## License

[MIT](LICENSE)
