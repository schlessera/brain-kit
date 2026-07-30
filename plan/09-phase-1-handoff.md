# Phase 1 (fix-blockers-while-private) — Handoff — 2026-07-30

Phase 1 of the sequencing in [07-oss-readiness-review.md](07-oss-readiness-review.md) §5 /
[08-package-split-review.md](08-package-split-review.md) §5 is **done and merged**. This file
is the state-of-the-world for whoever picks up phase 2.

| repo | main | tests | notes |
|---|---|---|---|
| brainform | `ea73e1c` | 386 pass, 2 skip, 0 fail | typecheck clean |
| brain-ui | `e0f6ab5` | 450 pass, 0 fail (unit+client) | typecheck clean; `BRAINFORM_REF` pins `ea73e1c` |

`BRAINFORM_REF` appears twice in brain-ui's `Dockerfile` (both build stages) and CI derives its
sibling checkout from that same ARG — one edit covers both. **Every brainform change needs a
pin bump until the packages are published.**

## What phase 1 actually changed

Grouped by the blocker it closes. Commit hashes are on brainform `main` unless noted.

**Dropped `@brainform/ui-backend-gemini`** (`58cd846`). It advertised `permissions: true` with a
no-op gate. brain-ui had already unwired it; the code stays in private history if a gated
Gemini backend is ever wanted. Resolves plan/07 §1.1.

**Write serialization now engages** (`9802345`). The Claude Agent SDK auto-allows tools listed
in `allowedTools` without ever calling `canUseTool` — it even warns
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — so the WriteLock, which lived inside `canUseTool`, was
inert for the flagship backend. It now lives in an awaited `PreToolUse` hook. Runtime-confirmed
against the real SDK, not inferred.

**Filesystem containment** (`0c78982`, `171fa5b`, `d921039`, `7b6a2a6`, `ea73e1c`). Repo-relative
path schema across config and module config; symlink-aware `safeResolve` (dangling links,
chained links, symlinked roots, control characters); archive destinations; finance/jobs write
paths; mutating commands refuse an uninitialized directory; module keys canonicalized before
`import()`.

**Two-phase `defineModule`** (`c644e89`). `{ name, configSchema, setup(config) }`; contributions
are schema-validated at load; `CommandContext` carries `{ root, json, config, taxonomy }` so
module commands never re-read `brain.config` (the old path silently fell back to defaults on
error). `@google/genai` became an optional peer of core.

**`@brainform/ui-render-puppeteer`** (`5e59e61`, `ac66ead`, `68eb2f6`). Optional package. The
page gets no network (DNS blackholed at the browser — the load-bearing layer, since request
interception cannot see WebSocket handshakes, prerender, preconnect, iframes, or popups), no
JavaScript, Chrome's sandbox on by default, bounded time and concurrency, clamped output
geometry, terminal `shutdown()`, crash recovery.

**Protocol rev 2** (`eafb688`, `de9b27c`, `d7fd3e4`, `f8f4e3d`). Runtime zod schemas bound to the
TS interfaces via `satisfies`; `parseClientMessage` as the single boundary; `server_hello`;
`turnId`; `SessionRef`; optional `costUsd`; and **exactly one terminal frame per turn** across
both backends.

**brain-ui** (`33734dd`, `962ed46`, `a317a54`, `0e332d1`, `8da18a5`, `b9803e8`): auth validation
inside `createApp()` and fail-closed regardless of `NODE_ENV`; service worker never caches
`/api` (and purges what older versions cached, including workbox-expiration's IndexedDB rows,
which store full URLs); WebAuthn RP name/user handle config-injected with a boot-time length
check; WS frames validated with a socket-level payload cap; host-minted `turnId` verified on
inbound echoes; session ownership persisted on `session_info`.

## How this was reviewed, and what that cost

Two adversarial rounds, four reviewers per round (opus ×2, gpt-5.6-sol ×2), each round
attacking the *previous* round's fixes. **Round 2 found more severe bugs than round 1** — in
the round-1 fixes. Anyone continuing should assume the same of phase 2's work.

Bugs found in fixes, worth internalizing as patterns:

- **A lexical check is not a containment check.** The `..`/absolute rejection on module keys
  looked sufficient; a symlink inside the root made `./link` schema-clean while the loader
  imported and ran code from outside the root. Same root cause as the dangling-symlink bypass
  in `safeResolve` (`realpathSync` throws ENOENT for a link whose target is missing, which the
  first fix read as "doesn't exist yet").
- **Anything interpolated into a generated file needs its own validation.** Module cron
  `name`/`schedule`/`command` were constrained; the module *key*, which reaches the same root
  crontab line via the logger tag, was not — a newline in it injected a root cron command.
- **Predicate tests hide integration holes.** `shouldAllowRequest` was unit-tested and passing
  the entire time the renderer was reachable over WebSocket. The test that caught it launches
  real Chrome against a live listener; that test now ships (`tests/runtime.test.ts`).
- **Terminal-frame invariants need "exactly one" assertions.** The contract suite asserted
  `.at(-1)` of a filtered list, which tolerated both zero and two terminal frames.

Process note: three of the four top-level opus agents never returned a consolidated report
(their sub-agents did, reliably). brain-ui's round-2 reviewer returned nothing at all, and its
scope — covered by hand afterwards — is where the root-cron injection was found. **Do not treat
a missing reviewer as coverage.** Prefer spawning specialists directly over nesting them under
a coordinator.

## Phase 2 — rename + publish (next)

Blocked on a decision only Alain can make: **the name**. `endoxa` vs `florilegium` (full record
in [08-name-research.md](08-name-research.md) §6). "brainform" is burned — brainform.ai is an
active commercial AI-agent startup and the GitHub org is taken. The CLI stays `brain` and the
config stays `brain.config.ts` either way; the name is scope + org + site only.

Name-day checklist (do these together, they interact):
1. `npm org create <name>` while logged in — anonymous scope probing is blocked, so this is the
   real availability check.
2. GitHub org. For `endoxa`, `github.com/endoxa` is a dead-squat (created 2018, 0 repos) — one
   Support name-squatting request is worth trying; fallbacks `endoxa-hq`, `getendoxa`, etc.
3. Domain: `endoxa.app` anchor + `endoxa.so` alternate (`.com`/`.ai` are taken and dormant —
   never a launch gate; Astro never owned astro.com).
4. One manual USPTO/EUIPO word-mark pass (the automated UIs were blocked during research).

Then the publish pipeline, per plan/08 §5.2: LICENSE (MIT — manifests already claim it, the
file does not exist), changesets, `engines.bun`, the dist-vs-declared-Bun-source decision, a
real `brain mcp` command or bin, package metadata + per-package READMEs, tarball-consumer CI,
and the template `bun install` consent fix (it currently auto-runs `brain setup`, which has
global side effects: git hooks, skills, a `~/.local/bin` symlink).

## Phases 3-6 (unchanged from plan/08 §5)

3. Migrate `~/brain` off its vendored `scripts/` onto published packages; retarget brain-ui's
   spawn paths in the same window; port jobs skills, OKF export, unified api+browser scrape;
   resolve the whatsup / refresh-catalog / content-skill dispositions.
4. Extract `ui-server` + `ui-react` (not wholesale — decompose the 865-line ws handler and fix
   the chat-store single-active-buffer bug during the move).
5. Template + docs for the UI deployment.
6. Public cut: **fresh git history is a hard requirement** (pre-scrub blobs and `plan/` leak
   personal data), strip meta-docs, tighten the leakage gate with structural detectors.

## Known-open, deliberately not done in phase 1

- **Residual test gaps** the reviewers named: no end-to-end test drives `createApp()`'s auth
  refusal through a real socket; renderer browser-crash recovery is verified by inspection only
  (the `Browser` handle is private to `createRenderer` — testing it needs an injection seam);
  no test asserts a render leaves the browser usable after a timeout.
- **No server-frame schemas in ui-sdk.** The client still casts inbound frames. Correct while
  the server is the trusted peer; revisit if a shared or multi-tenant host ever fronts the SDK.
- **`server_hello` and `turnId` are advisory.** The server stamps both; no shipped client reads
  `protocolRev` or echoes `turnId` back. The server verifies an echo when present, so
  implementing the client half is additive. Documented as reserved in `protocol.ts`.
- **No WebSocket rate limiting in brain-ui.** Only login has buckets. Frames are size- and
  cardinality-bounded now, so the cheap CPU-amplification paths are closed, but a flood of
  valid frames is unmetered.
- **brain-ui pre-existing test failures** (5 deterministic, unrelated to this work): a
  route-ordering test asserts `/api/status` sits before the guard, contradicted by a deliberate
  comment in `app.ts`; plus health, two production-serving, and one build-manifest case. Two
  further SSE timeouts are environmental. Baselined on `main` before this branch.
