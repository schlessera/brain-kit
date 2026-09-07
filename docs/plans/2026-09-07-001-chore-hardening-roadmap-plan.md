---
title: "chore: Hardening roadmap — four releases to close the 2026-09-06 layer review"
type: chore
status: draft
date: 2026-09-07
origin: docs/brainstorms/2026-09-06-layer-review-findings.md
---

# chore: Hardening roadmap — four releases to close the 2026-09-06 layer review

**Target repos:** brain-kit (primary — all app behavior) and brain-ui (shell:
container, bin entry, client glue). Paths are repo-relative to brain-kit unless
prefixed `[brain-ui]`. Finding ids (S1…, B1…, K1…, M1…) refer to the origin
document. Revision 3: the draft was reviewed adversarially by four independent passes
(two Claude, gpt-5.6-sol, gpt-6-astra); every blocker and should-fix they
raised is folded in below and the blockers were re-verified in code.

## Summary

Close every finding of the layer review in four tagged brain-kit releases,
each with one *runtime* blast radius so a regression is attributable and
revertible by redeploying the previous image: **0.32.0 Boundary** (the HTTP
boundary, auth, and a subprocess secret denylist — pure server code with
regression tests), **0.33.0 Kit owns the app** (cron bin, crontab and
environment emitters, client glue, protocol assertions and the typed
subprocess allowlist move into the packages; the shell shrinks; container
hygiene with no data step ships here too), **0.34.0 One backend seam** (the
refactor release: published contract harness first, then factory extraction,
bridge tools once, self-describing backends, and the maintainability splits)
and **0.35.0 Least privilege container** (toolchain out of `/root`, non-root
server, agent under its own uid — the only release with a data step, shipped
in a maintenance window). brain-ui takes each release as a deps bump plus its
own shell work and is tagged with the same version. A milestone may carry
more than one tagged release when two of its units share an execution path,
so a failure still names one release.

---

## Problem Frame

The review found one boundary crossing (S1), three auth-hardening gaps
(S2–S4), a shell that carries ~600 lines of generic app behaviour (B1–B4), a
backend seam that is honest in the SDK but special-cased in the server
(M1–M3), and a tail of packaging and docs drift. Nothing reopens a binding
decision. Shipping it as one release would make any regression
unattributable; four releases cover it if each keeps to one runtime blast
radius.

---

## Requirements

- R1. Every finding in the origin document lands in exactly one milestone
  with one owning unit (a prerequisite or a shell-side step may reference
  it), or is closed by decision with the reason recorded in this plan.
- R2. Each milestone is one brain-kit minor release plus one brain-ui
  deps-bump PR, both tagged, each independently revertible by redeploying the
  previous image (the data step in 0.35.0 has a written reverse runbook).
- R3. No milestone changes the wire protocol or an MCP tool name/schema in
  `docs/integration-contract.md` except additively.
- R4. Every security fix ships with a regression test that fails on the
  pre-fix code.
- R5. Behaviour-preserving refactors are guarded by golden, characterization
  or contract tests written **before** the code moves, at the layer that
  moves (a server test does not guard a backend refactor).
- R6. Docs are updated in the same PR as the change.
- R7. Anything with a runtime (container users, Chrome sandbox, cron) is
  verified in a real container, not by asserting Dockerfile text.

---

## Scope Boundaries

- Prompt injection stays out of scope (SECURITY.md states it honestly).
- No new pluggable seam beyond what the review names; the not-pluggable list
  in `docs/extending/README.md` is untouched. The backend descriptor (U25)
  is kept to what the two first-party backends need and is `@experimental`.
- Voice phase 2 is not planned here; M9 only leaves a note for that plan.
- Module-contributed MCP tools and per-session backend switching are not in
  scope; 0.34.0 removes their structural blockers and stops there.
- The `brain-template` repo (kit roadmap item) is not created here; B7 is
  fixed with the documentation that does not depend on it.

### Closed by decision, not by code

- **M5 env-core copies.** There are eight byte-identical copies, canonical in
  `packages/core`, held together by `tests/env-core-sync.test.ts`. Moving them
  into the SDK needs six new dependency edges (one to `brain-scrape`, which is
  explicitly forbidden a core edge), a wider `check-env-access` chokepoint
  regex, and a rewrite of the sync test — to share four fields and three
  functions. The sync test's header already records why. Decision: keep the
  copies; U11 adds one sentence to CONTRIBUTING.md pointing at that header.
- **M6 as `z.infer`.** `protocol.ts` has zero imports and its `.d.ts` is flat
  interfaces. Deriving the types from zod would make zod a type-level
  dependency of every consumer of `./protocol`. Decision: keep hand-written
  types as the published shape and add a type-level equality test in both
  directions (U17).
- **B8 "publish the gates from the kit".** The shell's invisible-character
  check is a 43-line dependency-free script precisely so it runs before
  `bun install` in CI; the leakage gate's patterns are deployment-specific by
  nature. Decision: keep both shell copies; the thin-shell import test (U12)
  is the part of B8 that was actually missing.
- **S4 "auth itself is agent-readable" is closed only for the server's own
  material.** `CLAUDE_CODE_OAUTH_TOKEN` is what the Claude CLI authenticates
  with and `GITHUB_TOKEN` / `BRAIN_UI_SYNC_GITHUB_TOKEN` are what `git push`
  needs, and the agent's shell is a child of that CLI with the same uid and
  env. Those stay one `env` away from the agent by construction. The
  denylist (U10) and allowlist (U21) remove `COOKIE_SECRET`, the password
  hash, Deepgram, the skills token, WebAuthn and proxy-auth settings; U32
  removes read access to the server DB. SECURITY.md says exactly this.

---

## Context & Research

### Relevant Code and Patterns

- `packages/ui-server/src/middleware/origin.ts:16` — `isSameOriginRequest`,
  only caller `routes/share.ts:130`; returns early on `Sec-Fetch-Site`, so the
  `ALLOWED_ORIGINS` branch is unreachable in any current browser. Near
  duplicate of `app.ts:141` `isAllowedWsOrigin` (host-only compare). No
  `X-Forwarded-Proto` handling exists anywhere in ui-server (only XFF in
  `middleware/tailscale.ts:56`), so the server never learns its external
  scheme.
- `packages/ui-server/src/app.ts` — registration order: request logger
  `:269`, `cors()` only with `ALLOWED_ORIGINS` `:290`, public health `:306`,
  share-target fallback `:309`, login/logout `:310-317`, public passkey
  routes `:318`, **then** `authGuard` on `/api/*` `:323`. Hono composes in
  registration order, so a middleware mounted "just before the guard" would
  not cover the public login POSTs. `:383-385` forbids header-modifying
  middleware on `/ws`.
- Every JSON-bodied client call sets `Content-Type: application/json`:
  `packages/ui-react/src/lib/api-client.ts:172-179` (`fetchJson`, used by
  login and all passkey calls), `lib/share.ts:130` (render), the service
  worker's re-subscribe in `packages/ui-sdk/src/client/push-handlers.ts:112-116`.
  Bodiless POSTs (`whatsup-modal.tsx:31`, `/api/voice/*`, logout, inbox ack)
  hit routes that never call `c.req.json()`. Multipart routes (`/api/share`,
  `/api/skills/install/zip`) must be origin-checked but not JSON-gated. The
  Web Share Target is a navigation to `/share-target`, outside `/api`.
- `[brain-ui] client/vite.config.ts:157-162` — the `/api` proxy sets
  `changeOrigin: true`, so in dev `Host` is `localhost:3000` while `Origin`
  is `http://localhost:5173`; only the `Sec-Fetch-Site: same-origin` branch
  carries dev traffic.
- `packages/ui-server/src/middleware/auth.ts` — `issueSessionCookie:212`
  (payload is `Date.now()`), `hasValidSession:226`, logout `:386` deletes the
  cookie only; `consumeLoginToken:269`, `loginBuckets:262` (no eviction),
  limits `:43-51`; tokens consumed at `:308-309` before the body is read.
  `passkeys.ts:329-330` shares both buckets; challenges are single-use and
  server-minted (`:114-133`, cap 100, oldest evicted first at `:120`);
  revocation `:530` deletes the row only. hono's `parseSigned` splits the
  cookie on `lastIndexOf(".")`. `ws/clients.ts` has no close-all and
  `isWsAuthorized` runs only at upgrade (`app.ts:390`).
- `packages/ui-server/migrations/006_settings.sql` + `src/db/settings.ts` —
  JSON-per-key settings table; a sessions epoch needs no migration.
- `packages/ui-server/src/routes/share.ts:110-168` (`inFlight` after two
  awaits), `routes/render.ts:14-45` (the only `.max()` among 19
  `c.req.json()` calls; counts UTF-16 units after the body is buffered), no
  `hono/body-limit` anywhere, `[brain-ui] server/src/index.ts:208-223` sets
  no `maxRequestBodySize` (the object and its explicit type annotation both
  need the field).
- `packages/ui-server/src/routes/files.ts:53-63` — the only security headers
  in the package; `hono/secure-headers` unused.
- `packages/ui-server/src/ws/clients.ts:26-31` — unconditional `add`;
  `ws/host.ts:188` mints a limiter per socket.
- `packages/ui-server/src/share/staging.ts:301-307` — `mkdir` follows
  symlinks in the parent chain; `files/walker.ts:69-71` has the realpath
  containment to reuse.
- **`packages/core/src/cli/io.ts:68-93`** — the hand-rolled `parseArgs`
  treats a bare `--` as a flag with key `""` and consumes the next argument
  as its value, so `["search", "--", query]` would search for nothing.
  Verified. Any `--` separator in ui-server (`brain/client.ts:111,149,181`)
  needs end-of-options support in core first.
- Subprocess env: `ui-server/src/config/env.ts:660` `subprocessEnv`
  (`{...process.env}`), `ui-backend-claude/src/config/env.ts:124`
  `envSnapshot` + `backend.ts:840` (the default profile sets no env, and the
  SDK's own default is `{...process.env}`), `ui-backend-pi/src/tools.ts:228,369`
  spawn with no `env`. `scripts/check-env-access.ts` allows `process.env`
  only in `packages/*/src/config/env(-core).ts`, so any new variable is read
  once per package. The existing allowlist to mirror: `[brain-ui]
  scripts/entrypoint.sh:300-303` (eleven vars, `ANTHROPIC_API_KEY` excluded
  on purpose). `BRAIN_UI_SKILLS_GITHUB_TOKEN` is used by `fetch`
  (`skills/install.ts:382`), never by a subprocess, so it is strippable;
  the git credential helper (`entrypoint.sh:19-20`) reads
  `BRAIN_UI_SYNC_GITHUB_TOKEN` / `GITHUB_TOKEN` from the git process env, so
  those must reach every subprocess that runs git.
- **Linker-dependent backend install (found while planning).**
  `[brain-ui] Dockerfile:67` installs with `bun install --filter='./server'
  --production`. `@schlessera/brain-backend-pi` is declared only in the root
  manifest and is an optional peer of ui-server. Under bun 1.4.2's isolated
  linker (the CI-built image, verified by a `--no-cache` rebuild of the
  stage) the package lands in the `.bun` store and is linked as ui-server's
  peer, so the registry's `createRequire(import.meta.url)` resolves it from
  ui-server's real path and prod boots with pi profiles. Under bun 1.3.14's
  hoisted linker (verified in a temp workspace) the same install produces no
  pi backend at all. The build stage uses the moving `oven/bun:1-alpine` tag,
  so the presence of a backend in the image depends on which bun the base
  image happens to ship. Not a live bug today; a fragility U12 and U22 close.
- `[brain-ui] server/scripts/cron-run.ts` (275), `script-lib.ts` (18;
  `any`-cast shim and a module-scope `process.env.DB_PATH` read that the kit's
  env gate would refuse), `brain-digest.ts` (42). `scripts/entrypoint.sh:194-303`
  generates `/etc/cron.d/brain-ui` with jq; zero tests; the wrapper command
  and the `PATH=` line (`:198`, hardcodes `/root/.local/bin:/root/.bun/bin`)
  are inputs the emitter must take as parameters. Three stale references to a
  `config/crontab` that does not exist (`supervisord.conf:11`,
  `entrypoint.sh:289`, `server/src/index.ts:177`).
- `[brain-ui] client/src/app.tsx` (60 of 117 lines generic routing),
  `main.tsx:44-152` (update-when-idle), `sw/service-worker.ts` (~120 of 155
  lines Workbox policy incl. the privacy invariants). The SDK has `zod` as its
  only dependency and CI imports every ui-sdk subpath under **node**
  (`ci.yml:155-166`) while `scripts/check-dist-types.ts:126-166` typechecks
  every subpath with `types: []`, `skipLibCheck: false` and no `webworker`
  lib — so no SDK subpath may import workbox or `bun:test`. Precedent:
  `src/client/share-target.ts` hand-declares its worker types.
- `[brain-ui] server/tests/unit/{protocol,ws-handler,tool-approval-result}.test.ts`
  — type-only imports, local re-implementations. `@anthropic-ai/claude-agent-sdk`
  is a direct dep imported by nothing else; the Dockerfile musl prune stays
  regardless (the SDK arrives transitively via `brain-backend-claude`).
- `packages/ui-server/src/agent/backend.ts` (1094 lines) — private
  `BACKEND_SPECIFIERS:318`, hand-mirrored module shapes `:27-49`, guarded by
  `tests/declaration-surface.test.ts` (no specifier in `src/` or emitted
  `.d.ts`; plus an `Assert<>` block binding the real modules to the mirrors,
  which must be rewritten when the mirrors move).
- Bridge tools: `ui-backend-claude/src/{location,activity,mask,ask-user}-tool.ts`
  (zod; Claude's `tool()` takes a raw zod **shape**, `sdk.d.ts:8590`) vs
  `ui-backend-pi/src/tools.ts:591-790` (typebox 1.1.38; the pi SDK pins
  1.3.7). pi-ai validates with `Compile` from `typebox/compile` and accepts
  plain JSON Schema without the TypeBox `Kind` symbol
  (`pi-ai/dist/utils/validation.js:285`); typebox's `TSchema` is an empty
  interface. `zod@4.5.4` exports `toJSONSchema` (pass `{ io: "input" }`,
  strip `$schema`). Three descriptions byte-identical; `ask_user` has drifted
  (pi lost the "never add an Other option" rule, `preview`, all cardinality
  bounds); mask filenames differ (`x-mask.png` vs `x.mask.png`); Claude passes
  no geocode config, pi does. `DEFAULT_ALLOWED_TOOLS` (claude, private) and
  `DEFAULT_PI_ALLOWED_TOOLS` are kept in sync by comment only.
- Factories: `ui-backend-claude/src/backend.ts:342` (~650 lines),
  `ui-backend-pi/src/backend.ts:255` (~635 lines), pi `permission-gate.ts`
  already separate. Tests are unit tests over injected fake runtimes.
  `packages/ui-sdk/tests/backend-contract.test.ts` (18.6K) is the shared
  contract, unpublished.
- `packages/ui-server/src/ws/run-session.ts` (354) — no direct test; ten WS
  tests reach it through `dispatch.ts`. It calls only `backend.startTurn()`,
  so a test for it does **not** guard a backend-internal refactor.
- `packages/ui-sdk/src/protocol.ts` (1501, zero imports) vs `schemas.ts`
  (787, `looseObject` ×50); `tests/server-schemas.test.ts` proves only
  "schema accepts a valid typed frame". `api-report/` records names only.
- Agent SDK 0.3.263: `pathToClaudeCodeExecutable` (`sdk.d.ts:1820`) is fed
  from `CLAUDE_CODE_PATH` (`ui-server env.ts:280,627` →
  `ui-backend-claude/src/backend.ts:826`); any path not ending in
  `.js/.mjs/.ts/.tsx/.jsx` is exec'd directly with three piped stdio; the SDK
  also exposes `spawnClaudeCodeProcess(options)` (`sdk.d.ts:2278`) so a uid
  switch can live in the backend package. Session transcripts live under
  `CLAUDE_CONFIG_DIR ?? ~/.claude` and `sdkOptions.resume` (`backend.ts:828`)
  reads them; the volume is mounted at `/root/.claude`
  (`[brain-ui] docker-compose.yml:36`).
- `[brain-ui]` container: no `USER`; `supervisord.conf:3` `user=root`,
  programs syslog/sshd/cron/brain-ui all root, brain-ui launched as
  `/root/.bun/bin/bun` (`:56`); bun installed to `/root/.bun`
  (`Dockerfile:229`), Claude CLI to `/root/.local/bin` + symlink
  `/usr/local/bin/claude` (`:234-237`), `/root/.pi` redirected to
  `/data/db/pi` (`entrypoint.sh:135-146`), `/var/log/brain-ui` to
  `/data/db/logs` (`:118-127`); `EXPOSE 22` (`:275`), sshd program
  (`supervisord.conf:30-40`); the `ops-ssh` compose profile builds the same
  image and runs `sshd -D` (`docker-compose.yml:70-83`). Build stages use the
  moving `oven/bun:1-alpine` tag (musl); runtime is glibc `ubuntu:24.04` by
  digest. rtk is version-pinned (`ARG RTK_VERSION`, `:216`) but not
  checksummed; bun (`:229`) and the Claude installer (`:234`) are unpinned
  `curl | bash`. Git safe.directory / sharedRepository / umask are set
  nowhere in either tree.
- Release: 13 packages, one changesets `fixed` group, tags
  `@schlessera/<pkg>@<version>`, no pre-release notion, 18 guards in
  `tests/release-manifest.test.ts`; nothing reads `template/package.json`; no
  LICENSE assertion; `scripts/check-dist.ts:19-27` has no assertion for
  `client/push-handlers.js`. brain-ui pins `^0.31.0` and has no tags.

### Institutional Learnings

- Fail loud, never substitute silently (brain-ui decision 3). An env
  allowlist fails as "no provider configured" rather than "missing variable"
  — the cron list already did this once. So the list is typed, audience-
  tagged, tested, and its failure mode documented.
- Predicate-only tests are not proof for anything with a runtime.
- A slow build is an outage: Dockerfile edits keep the layer order and cache
  mounts that `dockerfile-pipeline.test.ts` asserts.
- A rollback does not revert the database; every milestone states its data
  step (three have none).
- Capture every new release trap in the release skill or in
  `tests/release-manifest.test.ts` in the same commit.

### External References

- Hono `csrf` middleware only inspects form content types and does nothing
  for `application/json`; `c.req.json()` never checks content-type. Pattern:
  fetch-metadata resource isolation (`Sec-Fetch-Site` allow
  `same-origin`/`none`/absent, reject `cross-site`) OR-ed with an `Origin`
  check, plus a content-type gate on JSON routes.
  https://hono.dev/docs/middleware/builtin/csrf ·
  https://web.dev/articles/fetch-metadata
- `Bun.serve` `maxRequestBodySize` defaults to 128 MB, independent of the
  WebSocket `maxPayloadLength`.
  https://bun.com/reference/bun/Serve/BaseServeOptions/maxRequestBodySize
- OWASP Session Management: invalidate server-side on logout and credential
  change; a per-user epoch in the signed cookie is the minimal state.
  https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Authentication: count failures, not attempts; keep IP blocks
  temporary; an IP-only limiter is defeated by distribution, so the passkey
  path must not share the password budget (reasoned from FIDO2, not cited).
  https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- `Bun.spawn` has no `uid`/`gid`; the `node:child_process` shim silently
  ignores them (oven-sh/bun#20908). supervisord `user=` needs supervisord
  itself root and sets no `HOME`/`USER`. `sudo` applies `env_reset` and
  forks; `setpriv` needs `CAP_SETUID`, which a `brain`-owned process lacks.
  https://bun.sh/docs/runtime/child-process · https://supervisord.org/subprocess.html
- Chrome without `--no-sandbox` as non-root: the setuid `chrome-sandbox`
  helper is the portable path. https://pptr.dev/troubleshooting
- `frame-ancestors` supersedes `X-Frame-Options`; send both.
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors
- Pins: Debian `oven/bun:1` by digest (the alpine variant is musl and cannot
  run on the glibc base); `curl -fsSL https://claude.ai/install.sh | bash -s
  <version>` publishes no checksum — download the script to a file, verify a
  captured sha256, then run; `sha256sum -c` for the rtk tarball.
- Advisories at planning time: hono 2026 CVEs fixed at or below 4.12.34
  (installed 4.13.5/4.13.7); `@modelcontextprotocol/sdk` CVE-2026-25536 fixed
  in 1.26.0 (installed 1.30.0); `qs` GHSA-x5fp-wj9c-mxmx / GHSA-4mjr-xmp4-gh2g
  reachable only through brain-ui's stale lockfile (6.15.3; the kit resolves
  6.16.0); Claude Agent SDK / CLI CVE-2026-35022 lists no affected versions —
  keep the SDK pin current each release and re-check.

---

## Key Technical Decisions

1. **Risk-ordered by runtime blast radius, not by severity.** 0.32.0 is
   server code the suite can prove; 0.35.0 is the only release with a data
   step. The CSRF fix removes the remote path to the agent before the
   agent's own privileges are reduced. Container hygiene with no data step
   (pins, sshd) ships in 0.33.0, not 0.35.0.
2. **One origin policy, mounted first.** `isSameOriginRequest` is rewritten:
   accept when `Sec-Fetch-Site` is `same-origin`/`none`, **or** when `Origin`
   matches the expected origin, **or** when both headers are absent
   (non-browser client, still auth-gated); `Origin: null` is rejected; when
   `ALLOWED_ORIGINS` is set it is consulted after both. The expected origin's
   scheme comes from `X-Forwarded-Proto` only under `TRUST_PROXY`, else from
   the request URL; without `TRUST_PROXY` the compare is host+port, as
   today, and hosting.md says so. It is mounted right after the request
   logger, before every `/api` route including the public login and passkey
   POSTs, and replaces `isAllowedWsOrigin` on the upgrade. `requireJson()`
   parses the media type (so `; charset=utf-8` passes) and applies only to
   routes that call `c.req.json()`. decisions.md records that dev relies on
   the OR (the vite proxy rewrites `Host`), so nobody tightens it to AND.
3. **Sessions epoch, not a session table.** One integer in `settings`
   (`auth.sessionsEpoch`), embedded in the signed cookie as
   `<issuedAt>.<epoch>` (safe because hono splits on the last dot; asserted
   by a test); `hasValidSession` rejects a mismatch or a payload without an
   epoch. Logout and passkey revocation bump it **and close every open
   WebSocket** (new `ClientSet.closeAll`). **The bump requires a valid
   epoch-bearing session**: logout is a public route today (`auth.ts:386`,
   mounted before the guard), and a public epoch bump would let anyone log
   the owner out of everything in a loop. The epoch accessor is strict, not
   the fail-open settings getter: first initialization is distinguished from
   a corrupt row, which refuses. The epoch is authoritative auth state in
   `brain-ui.db`, not disposable derived state. The epoch is global, so the
   button reads "Sign out everywhere"; existing cookies are rejected once on
   upgrade. **Rollback below 0.32.0 revives revoked cookies** (the old
   verifier checks only signature and age), so the rollback step rotates
   `COOKIE_SECRET`.
4. **Secrets leave the subprocess env in two steps, from one audience-tagged
   descriptor.** `ui-sdk/server` gains `SUBPROCESS_ENV`: a map of variable
   name → audiences (`cron`, `agent`, `brainCli`) with the server-only set
   marked for none. 0.32.0 (U10) applies it as a denylist (strip what has no
   audience) — zero capability risk. 0.33.0 (U21) flips it to an allowlist
   per audience, with `BRAIN_UI_SUBPROCESS_ENV_EXTRA` as the operator escape
   hatch read in each package's env chokepoint, and the crontab emitter
   (U14) derives `/etc/environment` from the `cron` audience. One list, one
   owner, three subsets.
5. **Bridge tools are defined once in `ui-sdk/server` as zod objects.** The
   Claude adapter passes `schema.shape` to `tool()`; the pi adapter passes
   `z.toJSONSchema(schema, { io: "input" })` (with `$schema` stripped) as the
   `parameters` — plain JSON Schema satisfies pi's `TSchema` and is what
   pi-ai compiles; no typebox enters the SDK. Both adapters run
   `schema.parse(input)` before the shared handler, so zod is the canonical
   validator and JSON Schema is pi's advertisement layer. The shared
   description text and the shared zod schema identity are the equality
   proof; invalid-input behaviour is tested on both sides. `ask_user` on pi
   regains its description, `preview` and bounds (additive). The
   allowed-tools posture and the activity nonce wrapper become shared
   constants.
6. **Self-describing backend modules, minimal and `@experimental`, passed by
   value.** Each backend exports a `BackendModule` descriptor (`id`,
   `resolveFromEnv`, `profileSchema`, `settingsHooks`, and an optional
   `modelSource` that the Claude backend already implements today for
   Anthropic model discovery) — exactly what the two first-party backends
   need. The registry iterates a list of descriptors instead of a
   `claude | pi` union. `AGENT_BACKEND` keeps accepting only `claude` and
   `pi`: `docs/extending/README.md` binds "no plugin loader, no runtime
   discovery; custom implementations are imported and passed as values", so
   a third-party backend is first-class by handing its descriptor to
   `createApp({ registry })` from the consumer's bin, not by naming an npm
   specifier in the environment. The declaration-surface gate keeps
   forbidding specifiers in emitted types; its mirror-drift `Assert<>` block
   is rewritten in the same PR. Unknown non-empty stored backend ids fail
   explicitly (today `getBackendForSession` silently substitutes the
   default, `backend.ts:1039`, against brain-ui decision 3).
7. **Cron moves as a bin with a parameterised emitter and a golden test.**
   `brain-ui-cron` (`src/bin/brain-ui-cron.ts`, bun-only like the package)
   with `run`, `digest`, `crontab`, `environment` subcommands. The emitters
   are pure functions of the module list, `wrapperCommand`, `pathLine` and
   `user`; the golden is captured from today's bash with today's values, and
   the cutover changes parameters, not the emitter. `DB_PATH` and every env
   read move into the ui-server env chokepoint.
8. **Least privilege is a toolchain relocation first, then users.** bun, the
   Claude CLI, `CLAUDE_CONFIG_DIR`, the pi state dir and logs move out of
   `/root` to `/opt` and `/data` prefixes with explicit owners (U30); only
   then does `brain-ui` run as `brain` under supervisord `user=` and cron
   lines carry the user field (U31). The agent runs as `agent` through a
   wrapper reached via `CLAUDE_CODE_PATH` (Claude) and an argv wrapper for
   pi's two spawns; the uid switch is `sudo` with one exact rule and an
   explicit `env_keep` list, with signal relay proven by an abort test, or a
   setuid-root exec helper if sudo's fork breaks cancellation. The brain repo
   is group-shared (`core.sharedRepository=group`, setgid dir, umask 002,
   `safe.directory` for both users). Everything is decided by a container
   spike in 0.33.0 (U24), recorded here before 0.34.0 is cut so 0.35.0 is
   designed a release ahead.
9. **brain-ui gets tags.** Each milestone's deps-bump merge commit is tagged
   `v<kit version>`.
10. **The refactor release owns every refactor, as separately tagged
    releases.** Dispatcher, store and page splits (U33) ship in the 0.34.x
    train, never in the container release. Because U28 changes frame
    production (`ui-backend-claude/src/backend.ts:874`) and U33 changes frame
    consumption (`use-websocket.ts:219`), the same symptom could come from
    either, so they are **0.34.0** (seam) and **0.34.1** (splits), each its own
    image. For the same reason the cron bin and emitters (U13/U14) ship as
    **0.33.0** with the denylist unchanged and the allowlist (U21) as
    **0.33.1**: both change what a scheduled job sees at `cron-run.ts:218`.

---

## Open Questions

### Resolved During Planning

- Hono's `csrf` middleware is not sufficient for JSON routes; custom
  middleware, mounted before the public routes.
- No new migration for the sessions epoch.
- The Agent SDK direct dependency in brain-ui can go; the musl prune stays.
- `registerAsrClients()` and `registerBuiltinRenderers()` are the same
  pattern; the side effects live in `tool-call-timeline.tsx:25` and
  `use-dictation.ts:10`, so the fix is registration on mount, not a
  `sideEffects` entry for the definition modules.
- `Type.Unsafe` is unnecessary; plain JSON Schema is accepted by pi.
- `run-session` tests close M4 but do not guard M3; the contract harness
  and backend characterization tests do.

### Resolve During Implementation

- U6: whether `hono/secure-headers` defaults collide with inline styles or
  the service worker; if so, set the three headers by hand.
- U20: React 18 in the CI smoke test — if `@types/react` 18 fails on
  `RefObject` nullability, narrow the peer to `>=19` in the same release.
- U29a: mask filenames. Resolved: backend-specific names are **kept** during
  extraction. Both handlers overwrite with `writeFileSync`
  (`mask-tool.ts:61`, `tools.ts:735`), so unifying the name could overwrite a
  file the other backend previously left untouched, and an image rollback
  cannot restore those bytes. Unification, if wanted, is a separate change
  with `wx` writes and a collision test.
- U24 (spike): sudo vs setuid helper; whether a shared `CLAUDE_CONFIG_DIR`
  with group access lets `brain` read transcripts that `agent` writes.

### Deferred to Implementation

- Exact rate-limit numbers after U4.
- Whether the crontab emitter keeps the legacy `scrape-all.ts` fallback.
- Whether `hono/body-limit` or the zod `.max()` owns the render cap (one
  owner, bytes).

---

## High-Level Technical Design

```


0.32.0 Boundary            0.33.0 Kit owns the app      0.34.0 One seam            0.35.0 Least privilege
(ui-server; shell tests)   (ui-server, ui-sdk, ui-react, (ui-sdk, backends,         (brain-ui container,
                            core, brain-ui)               ui-server, ui-react)       backends)
origin policy              cron bin + emitters ─────────────────────────────────▶ cron user field flips
sessions epoch + closeAll  env allowlist (audiences) ◀── SUBPROCESS_ENV (U10)     toolchain out of /root
login limiter              SW policy + hash routes       contract harness first    non-root server
body limits, headers       protocol type equality        backend characterization  agent uid wrapper
secret denylist            core `--` + separator        factories → tools → registry  ownership data step
release guards             pins, sshd program out        dispatcher/page splits    runbook + docs
thin-shell test            uid spike ─────────────────────────────────────────────▶ design decided
```

Arrows are hard dependencies; everything else within a column is independent.

---

## Implementation Units

Status legend: `todo` · `in-progress` · `done` · `dropped`. Update the status
column as work lands; the progress log at the end records dates and PRs.



### Milestone 0.32.0 — Boundary

Runtime blast radius: HTTP request handling, auth, and the subprocess env
(denylist only). No schema change; one `Bun.serve` option. Units U11–U12
change tests, manifests and docs with no runtime effect. Rollback: redeploy
the previous image; the settings row the epoch writes is ignored by older
code and new-format cookies still parse there.

| Unit | Findings | Status |
| --- | --- | --- |
| U1. App-level test helper | — | todo |
| U2. Origin policy middleware + JSON content-type gate | S1, S10b, S11b | todo |
| U3. Sessions epoch + close-all | S3 | todo |
| U4. Login limiter counts failures; passkeys get their own budget; eviction; `TRUST_PROXY` guidance | S2 | todo |
| U5. Body limits and share `inFlight`; serve recipe documented; `maxRequestBodySize` set | S5, S6, K4b | todo |
| U6. `frame-ancestors 'none'` + `X-Frame-Options: DENY` (not on `/ws`) | S9 | todo |
| U7. WebSocket connection cap | S10a | todo |
| U8. Share staging canonicalizes the inbox parent | S11a | todo |
| U10. `SUBPROCESS_ENV` descriptor + server-only secrets stripped from every spawn | S4a (step 1) | todo |
| U11. Release guards and hygiene | K1, K2, K3, K6, M5, B8, M9 | todo |
| U12. `[brain-ui]` deps bump, tautological tests + Agent SDK dep out, manifests, thin-shell test, `setup-vps.sh` out, stale refs, lockfile, `maxRequestBodySize`, tag `v0.32.0` | B3, B6, B8, S13, S6 | todo |

(U9 moved to 0.33.0 — it needs `packages/core`.)

**U1. App-level test helper (ui-server).** `tests/helpers/test-app.ts`
wrapping the env-mutation pattern of `app-wiring.test.ts:26-47`: one
`createApp()` per suite with a temp DB, env restored in `afterAll`,
`fetch(path, init)` and `withHeaders`. U2, U5, U6, U7 use it.

**U2. Origin policy (ui-server).** Per decision 2. Mount after the request
logger (`app.ts:269`). `requireJson()` on every route that calls
`c.req.json()`; multipart and bodiless routes are origin-checked only. Delete
`isAllowedWsOrigin`. Tests (each must fail on 0.31.0): `text/plain`
form-shaped POST to `/api/skills/install/github`, `/api/brain/add`,
`/api/render`, `/api/auth/login`, `/api/auth/passkey/login-verify` → 403;
`Origin` mismatch → 403; `Origin: null` → 403; absent both → pass;
`Sec-Fetch-Site: same-origin` with mismatched `Host` **and** `Origin` → pass
(the dev proxy case); `ALLOWED_ORIGINS` split topology → one assertion on
`/api/share`; JSON route with `text/plain` → 415, with
`application/json; charset=utf-8` → pass; WS upgrade: `Sec-Fetch-Site:
cross-site` → 403, mismatched `Origin` without fetch metadata → 403,
`X-Forwarded-Proto: https` under `TRUST_PROXY` makes an `https://` origin
match. Docs: brain-ui SECURITY.md CSRF paragraph; brain-ui decisions.md
binding decision ("every non-GET under `/api/*` is origin-checked first; JSON
routes require `application/json`; dev depends on the fetch-metadata OR").

**U3. Sessions epoch (ui-server).** Per decision 3. `bumpSessionsEpoch(db)`
exported for the future password-change route; `ClientSet.closeAll(code,
reason)` called from it; logout and revocation verify the caller's session
(epoch included) before bumping. `authGuard` and `isWsAuthorized` gain the db
handle (api-report regenerated). Tests: logout invalidates the old cookie on
the next request and closes an open socket; revocation does the same; a
pre-epoch cookie is rejected; the dot-split assertion; **a request with no
cookie, a malformed cookie, an expired cookie or a previously revoked cookie
neither advances the epoch nor closes sockets**; a corrupt epoch row refuses
rather than reading as 0. ui-react: "Sign out everywhere" copy. Docs:
SECURITY.md; hosting.md upgrade note and the rollback step (rotate
`COOKIE_SECRET` when returning to a pre-epoch image).

**U4. Login limiter (ui-server).** `recordLoginFailure` / `isLoginBlocked`
plus a **bounded in-flight reservation**: today the token is consumed before
`Bun.password.verify` (`auth.ts:308,349`), which is also what stops a burst
of concurrent requests all entering argon2id at once; a failures-only policy
alone would remove that admission control. So: acquire a per-IP in-flight
slot before verification, release it in `finally`, and record failures after.
Successes count nothing; password failures count per IP and globally;
passkey `login-verify` counts in its own `pk:` bucket **only** when an
assertion matched an outstanding challenge and then failed signature or
counter verification — a body with no matching challenge is rejected without
counting; buckets evict on window expiry and a size cap. Boot log warns when
password mode sees `X-Forwarded-For` while `trustProxy` is off; hosting.md
says "set `TRUST_PROXY=1` behind a reverse proxy in password mode". Tests: 20
junk POSTs lock neither path; the passkey budget is independent; the map is
bounded; a concurrency test with a deliberately delayed verifier shows the
in-flight cap holds.

**U5. Body limits (ui-server, brain-ui).** `hono/body-limit` at 256 KB on
every JSON route and one owner for the render cap (5 MB, bytes); `share.ts`
increments `inFlight` before the first await, decrements in `finally`.
ui-server README shows the full `Bun.serve` recipe (`maxRequestBodySize`,
`idleTimeout: 255`, `maxPayloadLength`, warm-up probe, SIGTERM) — K4b.
`[brain-ui]` sets `maxRequestBodySize` to `SHARE_MAX_TOTAL_BYTES` plus
multipart headroom, in the object and its type annotation.

**U6. Frame headers (ui-server).** On the SPA fallback, static assets,
`/api/*` and the raw file route (appended to its CSP); `/ws` excluded
explicitly. Test: headers present on `/`, `/api/health`,
`/api/files/content`; the WS upgrade tests stay green.

**U7. WebSocket cap (ui-server).** `ClientSet.add` refuses past
`BRAIN_UI_WS_MAX_CONNECTIONS` (default 32); env descriptor added and README
regenerated (`bun run env-docs`).

**U8. Staging canonicalization (ui-server).** `stageShare` resolves the inbox
parent with the walker's realpath containment before `mkdir`; a symlinked
`.brain-ui/inbox` fails loudly. Test with a temp repo and a symlink.

**U10. Subprocess env, step 1 (ui-sdk, ui-server, both backends).**
`SUBPROCESS_ENV` in `ui-sdk/server` per decision 4. `subprocessEnv`,
`envSnapshot` (now set on `sdkOptions.env` for **every** profile, the default
included) and both pi spawns filter through it. Tests per package: a spawned
env never contains a no-audience key. SECURITY.md states what stays
agent-readable and why (see Closed by decision).

**U11. Release guards and hygiene (brain-kit).** `release-manifest.test.ts`
asserts the template pin equals the current version and every package
directory has a LICENSE; the release skill gains a "bump the template pin"
step; `packages/scrape/LICENSE` added; `check-dist.ts` asserts
`client/push-handlers.js`; ui-sdk README documents `./share-target` and
`./push-handlers` and says rev 3; CONTRIBUTING.md states the lockstep policy
(K6) and points at the env-core sync header (M5) and records the B8
decision; brain-ui ROADMAP gets the voice-phase-2 seam note (M9).

**U12. `[brain-ui]` shell work.** Bump to `^0.32.0`; delete the three
tautological tests and the `@anthropic-ai/claude-agent-sdk` dependency (musl
prune kept, comment corrected); root `package.json` keeps no `@schlessera/*`
deps and `server/` declares **both** backends explicitly, so the image no
longer depends on bun's linker strategy to carry the pi backend (see
"Linker-dependent backend install"); `tests/unit/thin-shell.test.ts` asserts
`server/src/**` imports only `@schlessera/*` public exports, `branding`, and
builtins, and that every backend the registry can load is declared by
`server/`; the Docker build in CI lists `server/node_modules/@schlessera`
after the install and fails if a declared backend is missing; delete
`scripts/setup-vps.sh`; fix the three `config/crontab` references; `bun
install` refresh clears the `qs` advisories; tag `v0.32.0`.

Verification: `bun run test`, `bunx tsc --noEmit`, `bun run lint` in
brain-kit; brain-ui `bun run test`; `bun run dev` round trip through the vite
proxy (login, chat turn, share upload, skill install); prod deploy, the
did-it-actually-ship check, one login and one turn per backend.

### Milestone 0.33.0 — Kit owns the app

Runtime blast radius: container boot (crontab, environment, installers,
sshd program), client routing and service-worker policy, and the brain CLI
parser (`--`). Two tagged releases: **0.33.0** ships everything except U21;
**0.33.1** ships the per-audience allowlist, so a scheduled job that fails
after the cron cutover and one that fails after the environment change are
different images. No schema change, no data step. Rollback: redeploy the
previous image; it regenerates its own crontab; rolling back the image does
not roll back the brain repo's core pin (U9).

| Unit | Findings | Status |
| --- | --- | --- |
| U9. Core `parseArgs` end-of-options + `--` before positionals in the brain client | S12 | todo |
| U13. `brain-ui-cron` bin in ui-server: `run`, `digest` | B1 | todo |
| U14. Crontab and environment emitters (`crontab`, `environment`), golden test, adversarial fixtures | B2, S4 prerequisite | todo |
| U15. SDK `./sw-policy` (registrars injected) + ui-react `useHashRoutes` / `useServiceWorkerUpdates` | B4 | todo |
| U16. Renderer and ASR registration on mount | K5 | todo |
| U17. Protocol/schema type-level equality test | M6 | todo |
| U18. `[brain-ui]` integration suite pruned and in CI against a temp brain | B5 | todo |
| U19. `[brain-ui]` entrypoint calls the bin; hosting.md first boot, token scope, required vars, `TRUST_PROXY`; deploy shim image owner as argument | B7 | todo |
| U20. React 18 in the CI smoke test, or peer narrowed | K7a | todo |
| U21. Subprocess env, step 2: per-audience allowlist + escape hatch (ships as 0.33.1) | S4a (final) | todo |
| U22. `[brain-ui]` pinned installers with checksums; sshd program and `EXPOSE 22` out | S7, S8 | todo |
| U23. `[brain-ui]` deps bump, tag `v0.33.0` | — | todo |
| U24. Container spike: uid design for 0.35.0 (throwaway image, outcome recorded here) | S4b design | todo |

**U9. `--` support (core, ui-server).** `parseArgs` stops flag parsing at a
bare `--` and treats the rest as positionals (validated and unvalidated
paths); `computeJson` and the help scan (`cli/brain.ts:159-160`) follow;
noted in `docs/integration-contract.md` as additive CLI behaviour. Then
`brain/client.ts` passes `--` before `search`, `read`, `add` positionals.
Tests in core and a brain-client test with a query beginning with `--`.
**Version skew:** the CLI ui-server talks to is the brain repo's own
install (`brain/client.ts:64-68` runs `<brainPath>/node_modules/.bin/brain`,
pinned by the brain repo's `package.json` and installed by the entrypoint's
stamp step, not by the image), so a 0.33.0 ui-server against an older core
would send `--` to a parser that eats it and every search would silently
return nothing. The brain client therefore probes `brain --version` at boot
and refuses to start below the core version that added end-of-options (fail
loud, decision 3); hosting.md and the release checklist say "bump the brain
repo's `@schlessera/brain` pin before deploying 0.33.0", and the 0.33.0
rollback note says rolling back the image does not roll back that pin.

**U13. Cron bin (ui-server).** `src/bin/brain-ui-cron.ts` (compiled,
typechecked and scanned like everything under `src/`), `package.json#bin`
pointing at the emitted file with the shebang preserved; `run <name> --
<cmd...>` is today's `cron-run.ts` with typed imports; `digest` is
`brain-digest.ts`. `DB_PATH` and every env read move into `src/config/env.ts`
(descriptor + env-parity). Tests move from brain-ui and test the functions
directly plus one subprocess smoke test; `files`, `release-manifest.test.ts`
and CI's pack smoke test learn about the bin.

**U14. Emitters (ui-server).** `emitCrontab({ modules, wrapperCommand,
digestCommand, pathLine, user })` and `emitEnvironment(env)` in
`src/cron/emit.ts`, pure functions; shape checks ported as `^…$` regexes
(JavaScript `$` matches only at true end of input) plus an explicit
newline-smuggling test. Fixtures: a valid module list, a name with a trailing
newline, a command with a smuggled second line, an empty list, a list without
`jobs` (legacy fallback). Two goldens: the **historical** one, byte-equal to
the bash generator captured with today's wrapper, digest script path
(`entrypoint.sh:229` embeds a second executable path), PATH line and `root`;
and the **production-cutover** one with the bin's `run` and `digest`
subcommands by absolute path (`cd /data/brain` has its own `node_modules`).
The built image executes the generated digest command once in CI, because the
digest advances the retention marker and a broken line loses more than
scheduling visibility. `emitEnvironment` derives its list from
`SUBPROCESS_ENV`'s `cron` audience.

**U15. Client glue (ui-sdk, ui-react).** `@schlessera/brain-ui-sdk/sw-policy`
exports `registerDefaultRoutes({ registerRoute, NetworkOnly, CacheFirst,
ExpirationPlugin, precacheAndRoute, ... })` — the workbox registrars are
injected, so the SDK gains no workbox dependency and the subpath imports
cleanly under node and under `check-dist-types` (worker types hand-declared,
as `share-target.ts` does). ui-react exports `useHashRoutes()` and
`useServiceWorkerUpdates({ isBusy })` (DOM probe injectable). README's
`AppShell + ChatPage` example uses them. Guard **before** extraction: a
real-browser test (production build, agent-browser) with seeded legacy
caches and IndexedDB metadata, an API response requested as an image, an
offline share and a busy tab, asserting the privacy invariants
(`service-worker.ts:29,94`) survive the move — registration-order assertions
with fake registrars do not prove them. Rollback is a worker-update and
cache-recovery procedure, not "redeploy": open tabs keep their bundle and
defer reload while busy (`main.tsx:102`), and persisted cache entries are not
undone by an image change.

**U16. Registration on mount (ui-react).** `registerBuiltinRenderers()` runs
from the timeline component's first render and `registerAsrClients()` from
the dictation hook, both idempotent; the top-level calls go. Test: a
tree-shaken type-only import registers nothing, mounting registers
everything.

**U17. Type-level equality (ui-sdk).** For each of the 14 client and 18
server frames, a recursive **key-set and optionality equality** between the
schema's output type and the protocol interface (nested objects and array
elements included), then value-type comparison — mutual assignability alone
misses optional members (`{ x }` and `{ x; preview? }` are mutually
assignable). The `looseObject` index signature is stripped by a key-remapped
mapped type (not `Omit`, which keeps it). A compile-time negative fixture
removes a member and must fail. Concrete drift to catch on day one:
`AskUserOption.preview?` exists in `protocol.ts:915` and is absent from
`schemas.ts:652`.

**U18. `[brain-ui]` integration suite.** Keep SPA fallback, static serving,
public health, branding-in-hello, cron bin invocation; delete route-ordering
and brain-route tests that re-test ui-server; survivors use a temp brain
created in `beforeAll`; CI runs `bun run test:integration`.

**U19. `[brain-ui]` entrypoint and docs.** `generate_crontab` and the
`/etc/environment` loop become two `brain-ui-cron` calls with the user field
as a variable (`root` for now, so 0.35.0 flips a value); hosting.md gains
"No brain yet?" (an empty private repo plus `brain init`; the template link
follows when that repo exists), the `GITHUB_TOKEN` scope, required-var
marking for password mode, and the `TRUST_PROXY` rule; `Dockerfile.deploy`
takes the registry/owner as an argument (the tag already is one).

**U20. React 18 (brain-kit CI).** Add an 18.x install to the pack smoke test;
budget for landing on the fallback (peer `>=19`).

**U21. Subprocess env, step 2 (ui-sdk, ui-server, both backends).** Per
decision 4: fresh env per spawn from the audience subset plus the
profile-declared `authTokenEnv` / `apiKeyEnv` names plus enabled web-search
keys; `BRAIN_UI_SUBPROCESS_ENV_EXTRA` read in each of the three chokepoints
(three descriptors, one list). Tests: a var outside the audience never
reaches a child; a var inside does; the U10 denylist test stays. hosting.md
documents the symptom of a missing var.

**U22. `[brain-ui]` installers and sshd.** bun from the Debian `oven/bun:1`
image pinned by digest (and the build stages' alpine tag pinned too — the
linker strategy that decides which backends the image carries comes from
this bun); the Claude installer downloaded to a file, checked against a
captured sha256, then run with an explicit version; rtk verified with
`sha256sum -c`; `dockerfile-pipeline.test.ts` asserts all three.
`[program:sshd]` and `EXPOSE 22` removed from the app container.
`openssh-server` stays because the `ops` compose profile runs from the same
image — but the shared entrypoint ignores its arguments and execs supervisord
(`entrypoint.sh:311`, `Dockerfile:279`), so today the ops container's
`command: sshd -D` only works because supervisord starts sshd. The ops
profile therefore gets its own entrypoint (host keys, then `exec sshd -D`)
that runs neither the app, cron, nor the repository install steps against
the shared volumes; verified by connecting to a built ops container.

**U24. Container spike (brain-ui, no shipping).** A throwaway image proving:
`brain-ui` as `brain` with the toolchain under `/opt`; the Claude CLI
launched through the wrapper as `agent` (sudo with `env_keep`, or a
setuid-root exec helper) with an abort that kills the CLI process; a shared
`CLAUDE_CONFIG_DIR` where `agent` writes and `brain` resumes; alternating
writes by both users to the brain repo followed by `brain sync`; Chrome with
its sandbox on. **Isolation prerequisite:** no higher-privilege process may
execute agent-writable code. Today the server runs
`/data/brain/node_modules/.bin/brain` (`brain/client.ts:64`) and the root
entrypoint runs `bun install` and `brain module list` in the repo
(`entrypoint.sh:79,202`); with a shared repo an `agent` process could replace
what `brain` or root executes next. The spike must show the brain CLI that
the server, cron and entrypoint run coming from a separately owned tree
(installed by the image or by root outside the repo), `core.hooksPath`
pointing at an owned directory, and pi's in-process extension loading not
importing repo-local `.pi/extensions` with project trust
(`pi-coding-agent settings-manager.js:169`, `package-manager.js:1988`,
`loader.js:473`; extension `exec()` bypasses any tool wrapper,
`loader.js:320`) — either trust off with an owned extensions dir, or pi's
runtime under the restricted uid. Tests: a substituted `brain` executable and
a git hook, via an API call and a container restart, must not run as `brain`
or root; a repo-local extension and an extension-spawned child must not run
as `brain`. Deliverables, as review artifacts before U24 is called resolved:
the audience assignment table for every variable in `SUBPROCESS_ENV`, the
exact sudoers rule or helper source, and the directory ownership map. An
alternating-writer sync proves function, not isolation.

### Milestone 0.34.0 — One backend seam (the refactor release)

Runtime blast radius: the agent turn path in both backends and the registry
(**0.34.0**), then the client dispatcher and page components (**0.34.1**).
Behaviour-preserving by construction (contract harness, characterization
tests, shared descriptions) except pi's `ask_user` schema, whose changes are
enumerated. No wire-protocol change, no data step. Rollback: previous image
of the same train.

| Unit | Findings | Status |
| --- | --- | --- |
| U25. Contract harness published as `@schlessera/brain-ui-sdk/testing` (test primitives injected) | K7b | todo |
| U26. Backend characterization tests (permission gate, stream mapping, usage, history) on both backends | M3 guard | todo |
| U27. `run-session.test.ts` | M4 | todo |
| U28. Shared permission gate in the SDK; factory extraction per backend | M3 | todo |
| U29a. Bridge tools once in `ui-sdk/server`; adapters; shared posture; nonce wrapper; equality and invalid-input tests | M2 | todo |
| U29b. Self-describing backend modules; registry iterates; `AGENT_BACKEND` accepts a validated npm specifier | M1, K4a | todo |
| U33. Dispatcher per-domain handlers; activity store type extraction and SQL hoist; graph/activity/markdown splits — mounted-page tests first; ships as 0.34.1 | M7, M8 | todo |
| U34. `docs/extending/agent-backends.md` rewritten; ui-server README; contract note | — | todo |
| U35. `[brain-ui]` deps bump, tag `v0.34.0` | — | todo |

Order is the table order: harness and characterization before any move.

**U25. Contract harness (ui-sdk).** `runBackendContract(factory, { describe,
test, expect })` — the primitives are parameters because CI imports every
subpath under node and `check-dist-types` typechecks it with `types: []`, so
the subpath cannot import `bun:test`. Added to `ci.yml`'s `nodePackages`.
Both first-party backends consume it; the extension guide stops asking
outsiders to replicate assertions by hand.

**U26. Characterization (both backends).** Tests pinning the current
behaviour of the confirm-bash gate, stream-to-frame mapping, usage
accounting and history reads, over the existing fake runtimes, written
against the unsplit factories so U28 has something to keep green.

**U27. run-session tests (ui-server).** Direct tests with a fake registry
and bridge: busy-reject, queue then run, abort mid-turn, queue budget expiry,
`droppedPin` surfaced.

**U28. Factories (ui-sdk, both backends).** `permission-gate.ts` moves to
`ui-sdk/server` next to `confirm-patterns.ts`; each backend keeps a
`turn-runner.ts`, `usage.ts`, and a `backend.ts` under ~250 lines. U26 stays
green unchanged; then tests are split to match.

**U29a. Bridge tools (ui-sdk, both backends).** Per decision 5.
`ui-sdk/src/server/bridge-tools/` with the four tools, `wrapUntrustedData`
(the nonce wrapper) and `BRIDGE_TOOL_POSTURE`. Containment through one
`resolveInRepo`; one error policy; the geocode-config drift closed and
asserted; mask filenames kept per backend (see open questions). **Claude's
MCP schema and result envelope are the shared definition and stay
byte-stable** (they are the versioned contract; no `CONTRACT:` ceremony is
needed as long as the per-adapter before/after snapshots show no change on
the Claude side). pi's side changes and the changelog enumerates them:
`multiSelect` becomes required (it defaulted to false, `tools.ts:755,774`),
cardinality bounds apply, `preview` is accepted, and the result gains the
echoed questions and annotations that Claude already returns
(`ask-user-tool.ts:99` vs `tools.ts:778`). Tests: description and schema
identity across adapters; valid, bound-violating and wrong-typed inputs
behave the same on both; zod 4.5's JSON Schema compiles under the typebox
pi-ai resolves (1.3.7); before/after snapshots per adapter.

**U29b. Registry (ui-sdk, ui-server, both backends).** Per decision 6.
Claude/pi-specific parsing, thinking levels, OpenRouter hooks, billing
classification and the codex credential probe move into the respective
backend package behind descriptor hooks (Anthropic model discovery stays in
`ui-backend-claude` and is reached through the descriptor's `modelSource`);
`declaration-surface.test.ts`'s `Assert<>` block rewritten in the same PR;
static registry kept for tests; `AGENT_BACKEND` unchanged (`claude` / `pi`);
a third-party descriptor arrives by value through `createApp({ registry })`
and the extension guide shows exactly that. `getBackendForSession` fails
explicitly on an unknown non-empty stored backend id (legacy null ids keep
the default). No new backend identity can be activated by environment, so
the image-only rollback claim holds.

**U33. Maintainability splits (ui-react, ui-server), shipped as 0.34.1.**
Guard first: mounted-page tests for `ActivityPage` and `GraphPage` covering
reconnect subscriptions, unmount cleanup, deep links and late asynchronous
responses (`activity-page.tsx:81`, `graph-page.tsx:774`) — the existing
helper and render-smoke suites do not characterize those lifecycles. Then:
per-domain handler maps (chat, activity, mask, provider, connection), each
owning a subset of `ServerMessage["type"]`, composed with an exhaustiveness
check; activity store types and pure helpers out first, then SQL constants
hoisted; the three pages split at the seams identified during planning. One
PR per split, no behaviour change, existing tests untouched. An M-sized unit
on its own.

### Milestone 0.35.0 — Least privilege container

Runtime blast radius: the container only (users, ownership, mounts, config
dirs). **Data step:** volume ownership, the Claude/pi state directories and
git repository config change on first boot (idempotent, marker file) and
must be reversed by the runbook on a rollback below 0.35.0. Ship in a
maintenance window with a backup taken. The design was decided by U24.

| Unit | Findings | Status |
| --- | --- | --- |
| U30. `[brain-ui]` toolchain relocation: bun, Claude CLI, `CLAUDE_CONFIG_DIR`, pi dir, logs out of `/root`; mounts updated in both compose files | S4b prerequisite | todo |
| U31. `[brain-ui]` non-root: `brain` user, supervisord `user=`, ownership migration, group-shared repo, cron user field, Chrome sandbox on | S4b | todo |
| U32. `[brain-ui]` + backends: agent uid wrapper (`CLAUDE_CODE_PATH`, pi argv wrapper), `/data/db` unreadable by the agent's shell | S4b | todo |
| U36. Docs: privilege model in both SECURITY.md files, hosting.md upgrade and rollback runbook, decisions.md; `[brain-ui]` tag `v0.35.0` | — | todo |

**U30. Relocation.** bun at `/opt/bun`, the Claude CLI as a real root-owned
executable at `/opt/claude/bin/claude` (not a symlink into `/root`),
`CLAUDE_CONFIG_DIR=/data/claude` (group `brain`, setgid), pi state at
`/data/db/pi` with its parent readable, logs at `/data/db/logs`; supervisord
and the crontab PATH line updated (U14 parameter); compose and the Coolify
example mount the new paths. Verified in a real container (R7).

**U31. Non-root.** `useradd brain`, `useradd agent`, group `brain` shared;
`[program:brain-ui] user=brain` with `HOME` and `USER` in `environment=`;
cron lines emitted with `brain`; entrypoint migrates ownership once (marker
file) and refuses to boot if any required path is not writable afterwards;
`/data/brain` gets `core.sharedRepository=group`, setgid, umask 002 in both
wrappers, `safe.directory` for both users; Chrome's setuid `chrome-sandbox`
kept so `BRAIN_UI_CHROME_NO_SANDBOX` leaves the image (fallback: keep
`--no-sandbox` for the renderer only, recorded). Verified by a real
container run: login, turn on each backend, render, cron job, share,
alternating-writer sync.

**U32. Agent uid.** The mechanism U24 chose. `CLAUDE_CODE_PATH` names the
wrapper (or `spawnClaudeCodeProcess` in the backend package if the spike
preferred it); pi's two spawns become `[wrapper, "bash", "-lc", cmd]` and
`[wrapper, "grep", ...]` via `BRAIN_UI_TOOL_EXEC_WRAPPER` (an executable
path, never a string prefix), and abort kills the process group. `/data/db`
is `brain:brain 0700`. Tests: abort kills the real CLI; the agent's shell
cannot read `/data/db`; `brain sync` succeeds after both users wrote.
Fallback recorded in decisions.md if the spike said same-uid.

---

## System-Wide Impact

- Wire protocol: unchanged in all four releases.
- MCP tool names and schemas: unchanged; pi's `ask_user` gains fields it
  should have had (additive). Core CLI gains `--` end-of-options (additive,
  noted in the integration contract).
- Env contract: new `BRAIN_UI_WS_MAX_CONNECTIONS` (0.32.0),
  `BRAIN_UI_SUBPROCESS_ENV_EXTRA` (0.33.0, three packages),
  `BRAIN_UI_TOOL_EXEC_WRAPPER` (0.35.0); `BRAIN_UI_CHROME_NO_SANDBOX` no
  longer set by the image (0.35.0). All through the descriptor chokepoints.
- Sessions: one forced re-login on 0.32.0; logout is global.
- Cron: 0.33.0 changes who emits the crontab, not what it says; 0.35.0
  changes which user runs it and where the toolchain lives.
- Third-party backends: from 0.34.0 an npm package can be named in
  `AGENT_BACKEND` and tested with the published harness.

---

## Risks & Dependencies

| Risk | Milestone | Mitigation |
| --- | --- | --- |
| Origin middleware rejects a legitimate client | 0.32.0 | Fetch-metadata OR Origin OR absent-both; explicit tests for the dev proxy, the worker's push POST, multipart routes and the public login POSTs; `bun run dev` round trip before release |
| Full-origin compare rejects production behind a TLS-terminating proxy | 0.32.0 | Scheme only from `X-Forwarded-Proto` under `TRUST_PROXY`; host+port otherwise; documented |
| Everyone is logged out once; logout is global | 0.32.0 | Changelog, hosting.md, "Sign out everywhere" copy |
| Failures-only limiter is weaker against a patient attacker | 0.32.0 | Global failure cap stays; passkeys are not guessable; challenge-flood residual documented with the `TRUST_PROXY` rule |
| Denylist strips something a subprocess needed | 0.32.0 | Only server-only material is stripped; the OAuth and git tokens are explicitly kept |
| Cron output drifts when the emitter replaces bash | 0.33.0 | Golden test captured with today's parameters before cutover; first prod boot's `/etc/cron.d/brain-ui` compared by hand |
| Allowlist hides a key the agent needs | 0.33.0 | Audience map with one owner; escape hatch var; symptom documented; the denylist test stays |
| SW policy moved into the SDK changes cache behaviour | 0.33.0 | Same registrars in the same order, injected; production build tested on a device; `skipWaiting` replaces a bad worker on the next deploy |
| `--` change in core alters a module command's argument handling | 0.33.0 | Tests for validated and unvalidated paths; contract note |
| Bridge tool consolidation changes model-visible text | 0.34.0 | Shared description constants; Claude's current text is the reference; pi's `ask_user` change is the intended fix |
| Factory extraction breaks a turn path only a live model exercises | 0.34.0 | Harness + characterization on both backends before the move; one manual turn per backend using every bridge tool after |
| Two units in one release share an execution path | all | Sub-tag: 0.33.0/0.33.1 (cron cutover vs environment), 0.34.0/0.34.1 (frame production vs consumption); one PR per unit |
| Public logout becomes a deployment-wide sign-out DoS | 0.32.0 | Epoch bump requires a valid session; negative tests for missing/malformed/expired/revoked cookies |
| Rollback below 0.32.0 revives revoked cookies | 0.32.0 | Rollback step rotates `COOKIE_SECRET` |
| Ops SSH silently stops working when the supervisord program goes | 0.33.0 | Dedicated ops entrypoint; connect test on the built ops container |
| A higher-privilege process executes agent-writable code (repo CLI, git hooks, pi extensions) | 0.35.0 | Owned tooling tree, `core.hooksPath`, pi extension trust off; substitution tests in the spike |
| Ownership/config migration strands a rollback | 0.35.0 | Backup first; idempotent migration; runbook reverses ownership, mounts, `CLAUDE_CONFIG_DIR` and git config |
| Chrome sandbox fails on the deploy host's kernel | 0.35.0 | Setuid helper path first; renderer-only fallback recorded |
| Agent uid switch breaks the SDK's stdio or cancellation | 0.35.0 | Decided by the 0.33.0 spike, not discovered in 0.35.0; same-uid fallback documented |
| Mixed-uid repository breaks the nightly sync | 0.35.0 | Group-shared repo config; alternating-writer container test |

Dependencies: U10 → U14, U21
(one descriptor); U9 core → brain repo pin bump → U9 client (boot probe); U24 → U30/U31/U32 (design decided);
U25/U26 → U28 (guards before moves); U28 → U29a → U29b (smaller adapters
before consolidation, consolidation before descriptors); U14 → U19 (emitter
before the entrypoint switches); U19's user variable → U31.

---

## Documentation / Operational Notes

Per milestone, in the same PRs:

- **0.32.0:** brain-ui SECURITY.md (CSRF posture, server-side logout, what
  the agent's environment contains and why the OAuth/git tokens stay),
  brain-ui decisions.md (origin decision), ui-server README (serve recipe),
  ui-sdk README (subpaths, rev 3), CONTRIBUTING.md (lockstep policy, env-core
  pointer, B8 decision), release skill (template pin), both ROADMAPs.
- **0.33.0:** ui-server README (bin, emitters, `BRAIN_UI_SUBPROCESS_ENV_EXTRA`),
  hosting.md (first boot, token scope, required vars, `TRUST_PROXY`, cron
  ownership, SSH via the ops profile, missing-var symptom), ui-react README
  (hooks), ui-sdk README (`./sw-policy`), `docs/integration-contract.md`
  (`--`), this plan (spike outcome in decision 8).
- **0.34.0:** `docs/extending/agent-backends.md`, ui-server README
  (`AGENT_BACKEND` specifier), `docs/integration-contract.md` (bridge tools
  defined in the SDK; names unchanged).
- **0.35.0:** both SECURITY.md files (privilege model), hosting.md (upgrade
  and rollback runbook), decisions.md (uid design and any fallback), the
  `.env.example` entries for the new vars.

Release mechanics per milestone: changesets for every touched package;
`bun run version`; read the version; `bunx tsc --noEmit && bun run test &&
bun run build`; human `bun run release`; brain-ui deps-bump PR; prod deploy;
did-it-actually-ship check; tag brain-ui; update the progress log below and
the memory note.

---

## Review record

- 2026-09-07, revision 1 → 2. Three adversarial passes (Claude Fable
  document reviewer, Claude Opus feasibility reviewer, gpt-5.6-sol
  investigation). Blockers found and verified: the core CLI parser eats a
  bare `--` (U9 moved to 0.33.0 with a core prerequisite); the full-origin
  compare had no source for the scheme (decision 2 rewritten); the
  production image ships without the pi backend (H0 added). Should-fixes
  folded in: middleware mounted before the public routes; dev-proxy truth
  table; passkey failure definition and `TRUST_PROXY` guidance; epoch closes
  sockets and is global; plain JSON Schema for pi and raw shape for Claude;
  no `Type.Unsafe`; no `setpriv` from a non-root caller; sudo `env_keep`;
  toolchain relocation before `user=`; `CLAUDE_CONFIG_DIR` and mixed-uid git
  as data steps; pi wrapper as argv; SDK subpaths must not import workbox or
  `bun:test`; K5 targets the call sites; U13 source under `src/` and env
  reads in the chokepoint; emitter parameters; rtk already pinned; sshd
  package stays for the ops profile; alpine bun is musl; U33 moved to the
  refactor release; S4 closure stated honestly; B8 half closed by decision.

- 2026-09-07, revision 2 → 3. Fourth pass (gpt-6-astra) on top of the
  second-pass verification. Folded in: public logout must not be able to
  bump the epoch; rollback below 0.32.0 rotates `COOKIE_SECRET`; strict
  epoch accessor; in-flight admission reservation kept in the limiter;
  sub-tagged releases where two units share an execution path (0.33.1
  allowlist, 0.34.1 splits); the isolation prerequisite that no
  higher-privilege process executes agent-writable code (repo CLI, git
  hooks, pi in-process extensions with project trust); ops profile needs its
  own entrypoint; real-browser guard before the service-worker extraction;
  mounted-page tests before the page splits; key-set equality instead of
  mutual assignability (with the `preview` drift as the first catch); pi's
  `ask_user` changes enumerated as breaking on the pi side with Claude's
  contract byte-stable; mask filenames kept per backend; the npm-specifier
  backend loader dropped (it reopened "no plugin loader"); unknown stored
  backend ids fail explicitly; digest command as an emitter parameter with a
  production-cutover golden. H0 downgraded: the pi backend does resolve in
  the CI-built image (bun 1.4 isolated linker, verified with a `--no-cache`
  stage rebuild and a real-path resolve); the fragility is closed by U12/U22.

## Progress log

| Date | Milestone | Event |
| --- | --- | --- |
| 2026-09-07 | — | Plan drafted from the layer review (four exploration lanes, one web-research lane); three adversarial passes → revision 2; second-pass check and a gpt-6-astra pass → revision 3; the suspected pi-backend gap was re-verified in the CI-built image and downgraded to a linker fragility |
