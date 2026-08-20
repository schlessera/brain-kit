# Roadmap

Where brain-kit stands, what binds future work, and what is planned next.
Everything here is a statement of intent by a solo maintainer, not a commitment
with dates.

## Where this stands

Thirteen packages ship in lockstep on npm under `@schlessera/brain-*`:

| Package | What it is |
| --- | --- |
| `brain` | Core: CLI, MCP server, hybrid search, indexer, config/taxonomy, skills |
| `brain-module-jobs` / `-speaking` / `-finance` / `-images` | First-party content modules |
| `brain-ui-sdk` | Chat-UI wire protocol, runtime schemas, `AgentBackend`/`SpeechProvider` seams |
| `brain-backend-claude` / `brain-backend-pi` | Agent backends (Claude Agent SDK / pi coding-agent SDK) |
| `brain-render-template` | Shared markdown/HTML → print-ready document shell |
| `brain-render-puppeteer` | Optional HTML→PNG/PDF renderer, network-denied and scriptless |
| `brain-scrape` | Scraping base: polite HTTP, robots.txt, headless Chrome, site-adapter seam |
| `brain-ui-server` | Hono app factory: WS turn coordinator, auth, session catalog, routes |
| `brain-ui-react` | React chat/files/voice components, stores, WS transport |

What that means in practice:

- **The whole stack is consumable from the registry.** No sibling checkout, no
  build secret, no source overrides. Packages ship both `src/` and a built
  `dist/` behind conditional exports, so Bun resolves TypeScript source while
  tsc and bundlers get the compiled output — all generated from one source.
- **The chat UI is a thin deployment shell.** `brain-ui` (separate repo) owns
  the Dockerfile, the bin entry, and branding; every line of app behavior lives
  in `brain-ui-server` and `brain-ui-react` here.
- **It is dogfooded.** The maintainer's own brain runs the published packages
  as dependencies — there is no vendored copy of the toolchain anywhere.
- **Sessions run in parallel** (protocol rev 2), capped by configuration, with
  per-turn permission gating and host-minted turn ids.
- **Search degrades gracefully.** FTS5 works with no keys at all; embeddings
  are additive.

Test baseline: 1512 pass / 24 skip / 0 fail in this repo (`bun run test`),
104 pass / 3 skip / 0 fail in `brain-ui`. Integration tests are keyless and run
against the fixture corpus in `packages/core/fixtures/corpus/`.

Run the suite through `bun run test`, not a bare `bun test packages tests` — the
script supplies `--timeout 30000`, and the CLI onboarding tests spawn a real
`brain` process per assertion, which does not fit the 5s default.

## What binds future work

These decisions are settled. Reopening one needs a reason that did not exist
when it was made — not a preference.

1. **Markdown is the source of truth; the index is disposable.** `brain index
   --force` regenerates everything. This is also the upgrade story: there is no
   such thing as a data migration for derived state.
2. **A seam only where a second implementation is plausible within a year.**
   Seams exist for embeddings, completions, agent runners, agent backends,
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
   Breaking one needs a `CONTRACT:` commit prefix and a major bump.
5. **Fail closed on exposure.** A publicly reachable chat UI without auth
   refuses to boot, the renderer is denied every egress channel, and
   `brain doctor` warns loudly on a public content remote.
6. **Your content repo stays yours.** brain-kit is infrastructure delivered by
   version bump; it never merges into your content, and your taxonomy is built
   by onboarding rather than shipped by us.
7. **Extension interfaces are `@experimental` until 1.0.**

## Next

Roughly in order. Items move down as they land.

- **A real `brain-template` repo.** `docs/quickstart.md`, `template/README.md`,
  and this repo's README all point users at `schlessera/brain-template`, which
  does not exist yet — `template/` here is its source. Publishing it (marked as
  a GitHub template repo, pinned to the current package version) is the single
  biggest gap between the docs and reality.
- **Integration and e2e tests in CI.** CI currently runs typecheck, unit tests,
  the keyless Tier-0 e2e funnel, and the leakage gate. The `brain-ui`
  integration suite additionally needs a populated brain; its spawns now honor a
  `BRAIN_PATH` override, so pointing them at a fixture corpus is the remaining
  work. Until that lands, those suites only run locally.
- **Hardening follow-ups** carried over from the security review rounds, none
  currently exploitable:
  - No end-to-end test drives the auth boot refusal through a real socket.
  - Renderer browser-crash recovery is verified by inspection only; testing it
    needs an injection seam in `brain-render-puppeteer`.
  - No WebSocket rate limiting. Frames are size-, cardinality-, and
    depth-bounded, so cheap CPU amplification is closed, but a flood of
    individually valid frames is unmetered behind the auth guard.
  - `ui-sdk` has schemas for client→server frames only; the client casts
    inbound server frames, and the transport itself lives in `ui-react` rather
    than in the package that owns the protocol. `server_hello` and `turnId` are
    advisory client-side: the server stamps both and verifies an echo when
    present, but no shipped client reads `protocolRev` or echoes `turnId`. All
    of it is additive, and planned in
    [.agents/plans/client-protocol-half.md](.agents/plans/client-protocol-half.md).
- **Voice phase 2** — streaming conversation rather than tap-to-dictate. Open
  questions (turn-taking, TTS provider, how a live conversation maps onto turn
  approval) are tracked in the `brain-ui` roadmap.
- **Rough edges named by the extraction review**, ported verbatim rather than
  fixed at the time, and not re-verified since:
  - A follow-up message sent mid-stream can drop deltas once the user message
    is appended to the buffer.
  - The file store has a stale-response race between overlapping fetches.
  - `whatsup` streams stderr through a pipe nothing drains — a chatty run can
    deadlock.
  - The SPA fallback builds its index path with `join()` against a configured
    static root; correct for the shipped layout, fragile for others.
  - Draft adoption can bind to a stale session's result — `chat_message` frames
    carry no correlation id.

## Later

Not scheduled, and each needs a driving use case before it starts.

- Additional modules: travel as a standalone module, a content/publishing
  module.
- Module-contributed MCP tools.
- Per-session backend switching in the chat UI.
- A community provider promoted to a built-in — that only happens once one has
  real users.

## Deliberately not doing

- Pluggable storage, index engines, or protocol layers. SQLite + FTS5 +
  sqlite-vec, markdown + git, the chunking/ranking pipeline, the wire protocol,
  the Bun/Hono/React stack, and the `brain` CLI/MCP surface *are* the product.
- Anything requiring a daemon.
- Framework rewrites and editor plugins.
- A hosted service. Self-hosting is the model; see
  [docs/hosting/README.md](docs/hosting/README.md).
