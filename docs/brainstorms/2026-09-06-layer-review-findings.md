# Layer review findings (2026-09-06)

Findings of an architecture, packaging and security review of brain-kit
0.31.0 as an OSS layer and brain-ui (main @ b8c8692) as the deployment shell
on top of it. Four review lanes plus one independent second-model pass; every
item marked **verified** was re-read in the code by the coordinator, the rest
is lane-reported and must be re-confirmed before it is fixed.

This document is the inventory. The release plan that schedules the fixes is
[docs/plans/2026-09-07-001-chore-hardening-roadmap-plan.md](../plans/2026-09-07-001-chore-hardening-roadmap-plan.md);
that plan references the ids below (S1…, B1…, K1…, M1…).

## Verdict

The layering is right and machine-enforced: the SDK is a leaf, backends see
only the SDK, the server peer-depends on backends, the React package never
touches the server. The publish pipeline defends against every past failure.
The auth boundary is strong in password mode.

Three things hold it back:

1. **One real security gap.** JSON POST routes are not CSRF-protected in the
   tailscale, proxy and none auth modes: the origin check only guards share
   uploads, and its premise that JSON forces a preflight is wrong.
2. **One structural gap.** The backend seam is honest in the SDK, but the
   registry in ui-server is a Claude+pi special case, and every browser-bridge
   tool is written twice.
3. **One boundary gap.** About 600 lines of generic app behaviour (cron span
   recording, crontab generation, hash routing, service-worker update logic)
   live in brain-ui, and any second consumer would copy them.

Scope note: prompt injection was excluded on purpose; SECURITY.md already
states it honestly. Nothing here reopens a binding decision in either repo.

## Security (ui-server unless noted)

| Id | Sev | Finding | Fix direction |
| --- | --- | --- | --- |
| S1 | P1 | **CSRF on every JSON POST in tailscale, proxy and none modes** (verified). `isSameOriginRequest` (`src/middleware/origin.ts`) is only called from the share route. Hono's `c.req.json()` is `text().then(JSON.parse)` with no content-type check, so a `<form enctype="text/plain">` carrying a JSON string is a simple request and parses. PUT and DELETE are safe (non-simple methods preflight). Password mode is safe only because the cookie is `SameSite=Strict`. Scenario: an authenticated owner opens any web page; it POSTs to `/api/skills` and a foreign SKILL.md lands in `.agents/skills/`. | Mount the same-origin check as `/api/*` middleware for every non-GET; require `Content-Type: application/json` before `c.req.json()`; add a `text/plain` form regression test (only share has one today). |
| S2 | P2 | **Login lockout DoS** (verified). Rate-limit tokens are consumed before the password is checked, so attempts count, not failures. The global cap is 20/min and passkey `login-verify` shares both the `ip:` and `global` buckets, so unauthenticated junk traffic locks the owner out of both paths. With `TRUST_PROXY` unset behind a reverse proxy every client shares one per-IP bucket; `loginBuckets` never evicts. | Count failures only; give passkeys their own budget (assertions are not guessable); raise the global cap; evict expired buckets. |
| S3 | P2 | **Sessions are a signed timestamp with no server state** (verified). Logout deletes the client cookie only; a password change or passkey revocation invalidates nothing; a stolen cookie is valid for 30 days. Only rotating `COOKIE_SECRET` helps. | Store a sessions epoch (or session ids) in SQLite; bump on logout and credential change; check it in `hasValidSession`. |
| S4 | P2 | **No privilege separation** (verified). Server, brain CLI, cron and the agent subprocess run as root with `{...process.env}`. `COOKIE_SECRET`, the password hash, `DEEPGRAM_API_KEY`, `GITHUB_TOKEN` and the OAuth token are one `env` away from any Bash the model runs; the server DB (passkeys, VAPID private key) is readable. SECURITY.md already says approvals are not a boundary; this makes auth itself agent-readable. | S4a: allowlist the env handed to the agent and CLI subprocesses. S4b: run the agent as a separate uid with no read on the server DB; drop root so the Chrome sandbox can stay on. |
| S5 | P3 | Share intake concurrency race (verified): `inFlight` is checked before two awaits and incremented after, so simultaneous uploads all pass at zero. Owner-only. | Increment before the first await; decrement in `finally`. |
| S6 | P3 | Render body is parsed before the cap applies (verified): `c.req.json()` buffers the whole body, then zod's `max()` counts UTF-16 code units, not bytes. The shell sets `maxPayloadLength` for WebSocket frames only; HTTP falls back to Bun's 128 MB default. Authenticated only. | Set `maxRequestBodySize` in `Bun.serve` (and say so in the ui-server README); measure bytes. |
| S7 | P3 | [brain-ui] Unpinned `curl \| bash` for bun and the Claude CLI in the Dockerfile (verified); rtk is version-pinned but not checksummed. | Pin bun by version or use the official image layer; pin the Claude installer; verify rtk's sha256. |
| S8 | P3 | [brain-ui] sshd inside the app container with `PermitRootLogin yes`, and a second ops-ssh container for the same purpose (verified). | Drop in-container sshd; keep the ops profile. |
| S9 | P3 | No `frame-ancestors` or `X-Frame-Options` anywhere. In tailscale and proxy modes a foreign page can frame the app and clickjack an approval card. | `frame-ancestors 'none'` on the SPA and raw file responses. |
| S10 | P3 | Authenticated WebSocket count is uncapped (verified): each connection gets its own limiter and joins an unbounded Set. The WS origin check compares host only, so scheme is ignored without `ALLOWED_ORIGINS`. | Cap connections per process; compare the full origin. |
| S11 | P3 | Share staging parent path is joined, not canonicalized, so a pre-existing symlink at `.brain-ui/inbox` redirects writes (needs prior repo influence). Separately, when `Sec-Fetch-Site` is present the `ALLOWED_ORIGINS` allowlist is never consulted, so a split-origin client can never upload shares (functional bug in a discouraged topology). | Canonicalize the parent; consult the allowlist after the fetch-metadata check. |
| S12 | P3 | Positional args reach the brain CLI verbatim; content beginning with `--` is parsed as a flag. Owner-only annoyance that compounds S1. | Pass `--` before positionals. |
| S13 | P3 | [brain-ui] `qs` moderate advisories via the Agent SDK and pi-ai's MCP SDK → express chain. Not on an exposed request path; brain-kit's own audit is clean. | Refresh the lockfile; B3 removes the direct Agent SDK dependency. |

What holds: auth config refuses unsafe boots inside `createApp`; the cookie is
HttpOnly, Secure, SameSite=Strict; argon2id; XFF parsed right-to-left with a
hop count. WS: origin checked in every mode, cookie auth on upgrade,
per-connection token bucket, byte and depth caps at the schema boundary,
binary frames rejected, host-minted turnId verified before resolving
approvals. Path containment via realpath-aware `safeResolve`; share staging
mints its own dir, sanitizes names, writes `wx` then renames; zip install
streams with inflate caps and refuses symlinks. Renderer: JS off, DNS blackhole
plus interception plus no new web contents, bounded queue and page caps.
Crontab materialization re-validates with anchored regexes before writing a
root cron line. All SQL parameterized; migrations transactional; brain.db
opened read-only; passkey challenges single-use with RP and origin binding.

## Shell boundary (brain-ui)

| Id | Sev | Finding | Fix direction |
| --- | --- | --- | --- |
| B1 | P1 | **Activity span choreography lives in the shell** (verified). `server/scripts/cron-run.ts` (275 LOC) does kind, origin, heartbeat, cascade close, rollup and sink ingestion, reaching four ui-server exports through an `any`-typed `optionalServerExport` shim that guards a version skew lockstep pinning makes impossible. ui-server ships no bin. A second consumer gets no cron observability unless they copy it. | ui-server ships `bin/brain-ui-cron-run` (with the digest as a subcommand); typed imports; delete the shim. |
| B2 | P1 | **The crontab generator is bash plus jq** in `scripts/entrypoint.sh`, including the newline-smuggling guard for root cron lines, with no test in either repo. | Emit the crontab from ui-server (typed, tested); the entrypoint writes its output. |
| B3 | P1 | **Tautological shell tests.** `protocol.test.ts`, `ws-handler.test.ts` and `tool-approval-result.test.ts` assert `JSON.parse(raw) as ClientMessage` field equality and a locally re-implemented `buildApprovalResult` that "mirrors" ui-server. The approval test is the only reason the Agent SDK is a direct shell dependency (no import in `server/src`), (the Dockerfile's musl prune stays either way: the SDK arrives transitively via `brain-backend-claude`). | Delete all three plus the dependency. |
| B4 | P2 | Hash routing (`client/src/app.tsx`), service-worker update-when-idle logic (`main.tsx`) and the worker's route policy (API NetworkOnly ordering, legacy cache purge, share-param stripping) are generic and copied verbatim by any second shell. The ui-react README's `AppShell + ChatPage` example never switches views when the rail changes `activeView`. | Export `useHashRoutes` / `registerServiceWorkerUpdates` from ui-react and a default-routes helper next to `share-target` in the SDK. |
| B5 | P2 | Integration tests re-test ui-server behaviour (tailscale guard, status behind guard, brain routes) against a personal brain by default and are not in CI. This is the set the roadmap admits rotted. | Keep SPA fallback, static serving, public health and branding-in-hello; delete the rest or point at a fixture brain. |
| B6 | P2 | The `@schlessera/*` packages are declared in three manifests (verified). Bun resolves one copy today, but root deps are noise for a fork. | Root keeps zero deps; each workspace declares only what it imports. |
| B7 | P2 | Stranger gaps: no path to create a brain repo (the template repo does not exist); `GITHUB_TOKEN` scope unstated; only `BRAIN_REPO_URL` marked required; the deploy shim pulls a hardcoded image name. | Add a "no brain yet?" section to hosting; make the image an argument. |
| B8 | P3 | No thin-shell assertion, so app logic can creep back (B1 proves it did). The invisibles gate and the leakage gate are hand-maintained twice across repos. `setup-vps.sh` references a compose file that does not exist (verified). | Add an import-allowlist test for `server/src/**`; publish the gates from the kit; delete `setup-vps.sh`. |

## Packaging and public surface (brain-kit)

| Id | Sev | Finding | Fix direction |
| --- | --- | --- | --- |
| K1 | P2 | `template/package.json` pins `"@schlessera/brain": "^0.1.0"` while everything ships at 0.31.0 (verified). The roadmap promises the template is pinned to the current version. | Bump in the release skill; assert equality in `release-manifest.test.ts`. |
| K2 | P2 | `packages/scrape` is the only package without a LICENSE file; the published tarball carries MIT metadata and no license text (verified). | Copy LICENSE in; add the check to the release manifest test. |
| K3 | P2 | `./share-target` and `./push-handlers` exist and are what a PWA shell must import, but the ui-sdk README lists only protocol, schemas, server and client. The same README still says protocol rev 2; source says 3 (verified). | Document both subpaths with the service-worker wiring snippet; fix the revision. |
| K4 | P2 | Third-party backends are second-class: `BACKEND_SPECIFIERS` hardcodes claude and pi, so a vendor backend needs a static registry that skips discovery, settings overrides and the boot resolvability assertion (verified). The ui-server README's `Bun.serve` example omits the HTTP body cap, the 255 s idle timeout, warm-up and shutdown that the shell supplies. | Accept an npm specifier in `AGENT_BACKEND` (canonicalized like module keys); document the full serve recipe. |
| K5 | P3 | ui-react `sideEffects: ["**/*.css"]` tells bundlers the JS is pure, but `registerBuiltinRenderers()` and `registerAsrClients()` run at module top level from `tool-call-timeline.tsx` and `use-dictation.ts` (verified). A consumer importing for types only can lose every builtin renderer. | Register on mount from the component and the hook (listing the definition modules in `sideEffects` would mark the wrong files). |
| K6 | P3 | Lockstep of all 13 packages: module-speaking has 41 releases, 24 of them dependency-only. Fine pre-1.0 for a solo maintainer, but stated nowhere. | State the policy, or split into core+modules and ui-* fixed groups. |
| K7 | P3 | React peer is `>=18` but CI only ever runs 19. The backend contract suite is unpublished; the guide tells outsiders to replicate its assertions by hand. | Narrow the peer or test on 18; publish the contract suite as a test helper export. |

What holds: exports maps expose only the root, documented subpaths and
`package.json`; zero undeclared and zero unused dependencies across all 13
packages; layering enforced by `allowed-edges.ts` and
`dependency-edges.test.ts`; per-package dist assertions, pack-to-verify pin
resolution, registry confirmation between publishes, changeset gate derived
from `files`; `check-dist-types.ts` typechecks emitted declarations as a
consumer would; `api-report/` snapshots make every export change a reviewable
diff.

## Maintainability and extensibility (brain-kit)

| Id | Sev | Finding | Fix direction |
| --- | --- | --- | --- |
| M1 | P1 | **`createBackendRegistry` is 350 lines of Claude and pi branching** (verified): profile parsing, thinking levels, OpenRouter hooks, billing overrides, all typed against a `"claude" \| "pi"` union. Every backend-specific env knob lands in ui-server rather than the backend package. This contradicts the "seam where a second implementation is plausible" rule. | Self-describing backend modules (`{ id, resolveFromEnv, profileSchema, settingsHooks }`); the registry iterates a list. |
| M2 | P1 | **Every browser-bridge tool is implemented twice**: once as an in-process MCP tool in ui-backend-claude, once as a pi `ToolDefinition`. The nonce delimiter wrapper is duplicated verbatim; descriptions must stay byte-equal for the shared system prompt to be truthful. Drift is already visible: Claude passes no geocode config, pi does. | Define once in `ui-sdk/server` as `{ name, inputSchema, handler(bridge, input) }`; adapters convert zod to MCP and to typebox. |
| M3 | P1 | **Both backends are one ~600-line factory closure**: profile resolution, hooks, permission gate, locks, stream mapping, history and usage accounting inline. Claude's confirm-bash gate is inline; pi extracted the same logic to `permission-gate.ts`. Backend tests are 2.6k and 1.7k lines of unit tests over injected fake runtimes, whole-factory rather than per-unit because units cannot be isolated. | Extract permission gate, turn runner and usage per backend; move the shared gate into the SDK next to `DEFAULT_CONFIRM_BASH_PATTERNS`. |
| M4 | P2 | `ws/run-session.ts` (the core turn loop: busy/queue, abort, budget) has no direct unit test; it is only exercised through observability side effects. Every other ui-server file has one. | `run-session.test.ts` with a fake registry and bridge: busy-reject, queue, abort, budget expiry. |
| M5 | P2 | `config/env-core.ts` is a deliberate copy (eight byte-identical copies, canonical in `packages/core`) kept in sync by a test, while `ui-sdk/server` already hosts shared server helpers. | Closed by decision in the plan: the move needs six new dependency edges and a wider env chokepoint; the sync test's header records why. |
| M6 | P2 | Hand-written protocol types (`protocol.ts`, ~1500 lines) and parallel zod schemas (`schemas.ts`, ~800 lines); nothing asserts they agree. A field added to one side passes typecheck and gets stripped or rejected at the boundary. | Derive types via `z.infer`, or a compile-time equality assertion per frame. |
| M7 | P2 | `use-websocket.ts` is one 15-case dispatcher writing to five stores. Adding a frame touches four to six files, which is acceptable, but this switch is where all stores meet and it grows with every feature. | Per-domain handler modules registered in a map. |
| M8 | P3 | `graph-page.tsx` (~1045), `activity-page.tsx` (~770), `brain-markdown.tsx` (~690) and ui-server `activity/store.ts` (~1070) are cohesive by feature, not god objects, but past the size a newcomer can navigate. brain-markdown mixes five unrelated text transforms; the activity store is one closure with inline SQL. | Split by sub-feature; hoist SQL constants. |
| M9 | P3 | `SpeechProvider` is token minting only. Voice phase 2 (bidirectional streaming, TTS, barge-in) needs a new seam, not an extension of this one. | Note for the voice phase 2 plan; no code change now. |

What holds: ui-react never imports ui-server or a backend; ui-server never
reaches into backend internals; the SDK's only hard dependency is zod. One env
chokepoint per package, AST-enforced; typed descriptors generate the docs.
`AgentBackend` is sufficient to write a backend from the SDK alone. The tool
renderer registry is real and wired. Test density: ui-server 50 test files for
67 source files, six of them spin a real `createApp`.

## Found while planning (2026-09-07)

| Id | Sev | Finding | Fix direction |
| --- | --- | --- | --- |
| F1 | P2 | [brain-ui] Which backends the image carries depends on bun's linker strategy. `Dockerfile:67` installs with `--filter='./server' --production`; `@schlessera/brain-backend-pi` is declared only in the root manifest and is an optional peer of ui-server. Under bun 1.4.2's isolated linker (the CI-built image, verified with a `--no-cache` stage rebuild) it lands in the `.bun` store and resolves from ui-server's real path; under bun 1.3.14's hoisted linker the same install yields no pi backend. The build stage uses the moving `oven/bun:1-alpine` tag. | Declare both backends in `server/package.json`; assert their presence in the CI Docker build; pin the build-stage bun (plan U12, U22). |
| F2 | P1 | `packages/core/src/cli/io.ts:68-93`: `parseArgs` treats a bare `--` as a flag with an empty key and consumes the next argument, so S12 cannot be fixed from ui-server alone; the brain repo pins its own core (0.13.1 today). | End-of-options support in core first (additive CLI contract note), a boot-time version probe in the brain client, then S12 (plan U9). |
| F3 | P2 | `POST /api/auth/logout` is public (`auth.ts:386`, mounted before the guard). Harmless today; once logout bumps a sessions epoch (S3) it becomes a deployment-wide sign-out DoS unless the bump requires a valid session. | Verify the caller's session before bumping (plan U3). |
| F4 | P2 | `getBackendForSession` silently substitutes the default backend for an unknown stored backend id (`ui-server/src/agent/backend.ts:1039`) — the silent-substitution shape brain-ui decision 3 forbids. | Fail explicitly on an unknown non-empty id; legacy null ids keep the default (plan U29b). |
| F5 | P2 | The pi backend builds its resource loader in-process with project trust on and loads repo-local `.pi/extensions` (`pi-coding-agent settings-manager.js:169`, `package-manager.js:1988`, `loader.js:473`); extension `exec()` bypasses any tool wrapper (`loader.js:320`). Agent-written extension code therefore runs as the server user with the server environment — a prerequisite problem for S4b. | Trust off with an owned extensions directory, or pi's runtime under the restricted uid; substitution tests in the container spike (plan U24, U32). |
| F6 | P3 | [brain-ui] The `ops` compose profile's `command: sshd -D` only works because the shared entrypoint ignores its arguments and execs supervisord, which starts sshd (`entrypoint.sh:311`, `supervisord.conf:30`). Removing the sshd program (S8) silently breaks ops SSH. | Dedicated ops entrypoint; connect test on the built ops container (plan U22). |
| F7 | P3 | Protocol/schema drift instance: `AskUserOption.preview?` exists in `protocol.ts:915` and is absent from `schemas.ts:652` — the M6 failure mode, live. | Caught by the key-set equality test (plan U17). |

## Roadmap readiness

| Planned item | Structural verdict |
| --- | --- |
| Module-contributed MCP tools | Needs a change in core (the manifest has no tools slot; the MCP server registers static tools) and in both backends, made worse by M2. Do the bridge-tool consolidation first. |
| Per-session backend switching | Ready: `sessions.backend_id` is persisted and `getBackendById` exists; remaining work is UI plus a switch guard. |
| Voice phase 2 | Needs a new `ConversationProvider` seam (M9); the dictation seam stays as is. |
| Third-party backend package | Possible from the SDK alone today, but second-class at the registry (K4). Self-describing modules (M1) make it a package rather than a fork. |
