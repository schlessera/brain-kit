# Roadmap

Where brain-kit stands, and what binds future work.

**What is planned lives in the issue tracker, not here.** This file used to
carry a "Next" and a "Later" list, and both drifted — at one point it named a
release for work that shipped something else entirely. A roadmap that has to be
edited by hand to stay true is a roadmap that is quietly false most of the time.

- **[Issues](https://github.com/schlessera/brain-kit/issues)** — everything
  planned, at the size it gets worked.
- **[The project board](https://github.com/users/schlessera/projects/1)** —
  the same work with a state and a theme. The roadmap view is the closest thing
  to a timeline this project has, and it is intent rather than commitment.
- **[docs/process/github.md](docs/process/github.md)** — what the labels,
  milestones and board fields mean.

Everything below is the part that does *not* change every week.

## Where this stands

Sixteen packages version in lockstep under `@schlessera/brain-*`. The travel module
joins the next release; existing published packages remain independently consumable:

| Package | What it is |
| --- | --- |
| `brain-geo` | Shared geo services, track measurements and static maps |
| `brain` | Core: CLI, MCP server, hybrid search, indexer, config/taxonomy, skills |
| `brain-module-jobs` / `-speaking` / `-travel` / `-finance` / `-images` | First-party content modules |
| `brain-ui-sdk` | Chat-UI wire protocol, runtime schemas, `AgentBackend`/`SpeechProvider` seams |
| `brain-backend-claude` / `brain-backend-pi` | Agent backends (Claude Agent SDK / pi coding-agent SDK) |
| `brain-render-template` | Shared markdown/HTML → print-ready document shell |
| `brain-render-puppeteer` | Optional HTML→PNG/PDF renderer, network-denied and scriptless |
| `brain-scrape` | Scraping base: polite HTTP, robots.txt, headless Chrome, site-adapter seam |
| `brain-ui-server` | Hono app factory: WS turn coordinator, auth, session catalog, routes |
| `brain-ui-kit` | Presentational design kit: components, tokens, Storybook |
| `brain-ui-react` | React chat/files/voice components, stores, WS transport |

What that means in practice:

- **The whole stack is consumable from the registry.** No sibling checkout, no
  build secret, no source overrides. Packages ship both `src/` and a built
  `dist/` behind conditional exports, so Bun resolves TypeScript source while
  tsc and bundlers get the compiled output — all generated from one source.
- **The chat UI is a thin deployment shell.** A deployment (to be generated
  from `brain-hosting-template`, not published yet) owns the Dockerfile, the
  bin entry, and branding;
  every line of app behavior lives in `brain-ui-server` and `brain-ui-react`
  here.
- **It is dogfooded.** The maintainer's own brain runs the published packages
  as dependencies — there is no vendored copy of the toolchain anywhere.
- **Sessions run in parallel** (protocol rev 2), capped by configuration, with
  per-turn permission gating and host-minted turn ids. A session carries a
  named, revocable principal.
- **Search degrades gracefully.** FTS5 works with no keys at all; embeddings
  are additive. The same rule holds up the stack: the answer-classification
  pass is progressive enhancement, and the surface works with no key for it.

For whether the suite is green, read CI. A test count written down here is a
number that is wrong by the next commit.

## What binds future work

These decisions are settled. Reopening one needs a reason that did not exist
when it was made — not a preference.

1. **Markdown is the source of truth; the index is disposable.** `brain index
   --force` regenerates everything. This is also the upgrade story: there is no
   such thing as a data migration for derived state.
2. **A seam only where a second implementation is plausible within a year.**
   Seams exist for embeddings, completions, rerankers, agent runners, agent backends,
   speech, tool renderers, and skill emitters. Everywhere else, concrete code
   stays concrete. The not-pluggable list in
   [docs/extending/README.md](docs/extending/README.md) is final.
3. **Skills orchestrate, the CLI executes.** Deterministic logic goes into a
   `brain` subcommand with `--json`; SKILL.md files hold interview logic and
   judgment only. This keeps skills short and re-runs reliable, and gives
   non-agent users a fallback.
4. **The machine surface is a versioned contract.** CLI `--json` shapes, MCP
   tool names and schemas, `schema_version`, and frontmatter semantics are
   covered by [docs/integration-contract.md](docs/integration-contract.md).
   Changing one needs a `CONTRACT:` commit prefix; breaking one needs a
   maintainer ruling first, and from 1.0 a major bump.
5. **Fail closed on exposure.** A publicly reachable chat UI without auth
   refuses to boot, the renderer is denied every egress channel, and
   `brain doctor` warns loudly on a public content remote.
6. **Your content repo stays yours.** brain-kit is infrastructure delivered by
   version bump; it never merges into your content, and your taxonomy is built
   by onboarding rather than shipped by us.
7. **Extension interfaces are `@experimental` until 1.0.**

Why each of these looks the way it does, and what was rejected on the way, is in
[docs/decisions/](docs/decisions/README.md).

## Deliberately not doing

- Pluggable storage, index engines, or protocol layers. SQLite + FTS5 +
  sqlite-vec, markdown + git, the chunking/ranking pipeline, the wire protocol,
  the Bun/Hono/React stack, and the `brain` CLI/MCP surface *are* the product.
- Anything requiring a daemon.
- Framework rewrites and editor plugins.
- A hosted service. Self-hosting is the model; see
  [docs/hosting/README.md](docs/hosting/README.md).

A request for one of these is a legitimate thing to open a
[discussion](https://github.com/schlessera/brain-kit/discussions) about, and not
a thing to open an issue about. The answer will probably still be no.

---

This is a statement of intent by a solo maintainer, not a commitment with dates.
