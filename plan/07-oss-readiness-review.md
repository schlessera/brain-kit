# OSS-Readiness Review — 2026-07-17

Full architecture/design review of `schlessera/brain`, `schlessera/brainform`, `schlessera/brain-ui`
before open-sourcing brainform. Four independent passes: two Fable 5 reviews (seam design; drift/gap
analysis), one gpt-5.6-sol review (codex, read-only, typechecked + ran client tests), one web-research
pass (naming, prior art, packaging norms). Decisions locked during review: brain-ui end state = thin
app shell; distribution = npm packages + website + scaffolding/onboarding skills; bar = public but
experimental; license MIT.

## Verdict

The three-repo architecture is right and every reviewer independently endorsed it: product repo
(brainform), personal deployment shell (brain-ui), personal data (brain). Package layering is right
(core ⊥ ui-sdk; claude → ui-sdk only; pi/gemini → core + ui-sdk) and proven by a cross-backend
contract test suite. The codebase in `packages/` is already well-scrubbed (fictional fixtures, CI
leakage gate, keyless/offline tests). What remains is not redesign — it is finishing the separation:
two consumers still bypass the packages (brain vendors `scripts/`, brain-ui spawns them), ~14k LOC of
reusable UI code has no target package, npm artifacts are source checkouts, and the name is burned.

gpt-5.6-sol's one-line verdict: "The architecture is sound; the implementation has not yet completed
the separation."

## 1. Launch blockers (must fix before anything is public)

1. **Gemini backend permission bypass (security).** `ui-backend-gemini` advertises
   `permissions: true` but the mutation gate is a no-op — file writes and shell commands execute
   without approval (`packages/ui-backend-gemini/src/backend.ts:55`, `src/tools.ts:80`, `:376`).
   Pi has the real approval path to copy. Gemini is also missing from the backend contract suite
   (`packages/ui-sdk/tests/backend-contract.test.ts:31`). Fix or drop the backend before release;
   replace the boolean with `permissionMode: "interactive" | "automatic" | "unsupported"`.
2. **Name.** "brainform" is burned: brainform.ai is an active commercial AI-agent startup (MCP-based,
   adjacent niche), github.com/brainform org is taken. Rename while private — see §6.
3. **LICENSE file missing.** Manifests and README say MIT; no LICENSE text exists.
4. **`schlessera` org hardcoded in shipping trees**: `docs/quickstart.md:15`,
   `docs/hosting/README.md:16`, `template/README.md:28,71`, `template/README-template-dev.md`,
   plus brain-ui `Dockerfile:22,50` (`BRAINFORM_REPO` default). Neutral org or placeholder.
   The CI leakage-gate pattern deliberately allows the org name — tighten after rename.
5. **Strip `plan/`, `research/`, `PROGRESS.md`, `AGENTS.md`** at the public cut (already planned;
   they hold the real personal data — VPS IP, domain, Coolify UUID, family names).
6. **Publish real package artifacts, not source checkouts.** Today: raw `.ts` exports, `.ts` bins,
   no `dist/`, no `.d.ts`, **no `engines` field anywhere**, template reaches into
   `node_modules/@brainform/core/src/mcp-server.ts`, and docs promise a `brain mcp` command that
   does not exist. Fix: build ESM + `.d.ts` (tsup/bunchee), conditional exports with `types` first,
   `engines: { bun: ">=1.x" }`, keep `#!/usr/bin/env bun` shebangs, add a real `brain mcp` command
   or MCP bin, and a CI job that `npm pack`s every workspace and installs the tarballs into clean
   consumers (CLI, MCP, brain, UI, Vite). Web research confirms: Bun-only is normalized (ElysiaJS),
   but `engines` is advisory and npx-instead-of-bunx confusion is a known footgun — add a friendly
   early-exit when invoked under node. Any future client-facing package must be prebuilt from day
   one (Vite does not transpile `.ts` from node_modules).
7. **Taxonomy/config paths can escape the brain root.** Config accepts arbitrary dir strings;
   ingestion resolves them against root without the existing safe-path helper
   (`packages/core/src/lib/config.ts:20`, `lib/ingestion.ts:195`, `lib/safe-path.ts:11`).
   One repo-relative-path zod schema, applied at every read/write boundary.
8. **Puppeteer render = SSRF/isolation hazard** (brain-ui today, future ui package): Chromium with
   `--no-sandbox`, arbitrary HTML, network unrestricted (`server/src/render/renderer.ts:29,69`).
   Either drop server-side rendering for the first release, or isolate as optional
   `@<scope>/ui-render-puppeteer` with network denied by default + resource limits.
9. **Auth posture must not depend on `NODE_ENV`** — `AUTH_MODE=none` on non-loopback is only
   rejected in production, and the check lives in the executable, not the app factory
   (`server/src/middleware/auth.ts:60`, `src/index.ts:8`). Move into `createApp()` with an explicit
   `dangerously…` escape hatch. Related: the service worker caches all API GET responses
   (personal search/session/file data into Cache Storage — `client/src/sw/service-worker.ts:51`);
   make `/api` NetworkOnly.

## 2. Design debt — fix while the protocol is still private (cheap now, breaking later)

- **Protocol version handshake.** "rev 2" exists only in comments; add a `server_info`/hello frame
  with `protocolRev` + coarse capabilities now, while additive.
- **Runtime-validated protocol.** Both sides cast JSON to interfaces. Make exported runtime schemas
  (zod) the source of truth; enforce frame/prompt/attachment size limits at the boundary.
- **Turn correlation.** Host-generated `turnId` on every frame; approvals/ask-user/location
  correlated by `turnId + requestId`; composite `SessionRef { backendId, nativeSessionId }`.
  Session metadata currently persists only after a terminal result — failed/cancelled sessions end
  up unowned (`server/src/ws/handler.ts:286`); persist on `session_info`.
- **Unify terminal outcome.** Backends disagree on error endings (Claude: error + no result;
  pi/gemini: error then `result isError:false`). One terminal frame,
  `outcome: success | error | cancelled`; intermediate errors are diagnostics. Run the contract
  suite against all backends.
- **`costUsd: 0` conflates free with unknown** (`protocol.ts:215`) — make optional pre-publication.
- **Hoist shared brain access.** `ui-backend-pi/src/brain-access.ts` ≈ `ui-backend-gemini/src/brain-access.ts`
  are drifting twins. New package `@<scope>/ui-agent-tools`: canonical brain tools, risk
  classification, approval gating, one write lock per brain root injected by the host. This also
  becomes the blessed in-process seam replacing brain-ui's CLI-spawning (`server/src/brain/client.ts`).
- **Two-phase module definition.** Manifests are static, so module config can't shape taxonomy —
  finance hardcodes `dir: "clients"` with an apologetic comment
  (`packages/module-finance/src/module.ts:34`); finance CLI silently defaults on config errors.
  `defineModule` → static `name/configSchema` + `setup(parsedConfig)` returning
  taxonomy/commands/cron/skills; validate the full contributed manifest; pass parsed config into
  `CommandContext` (and unify `CommandContext` vs `CliContext` naming).
- **AgentRunner seam is lossy** (`seams.ts:37-48`): add `AbortSignal` + structured result.
- **Small ones:** `resolveRoot` cwd fallback lets `brain index` create `brain.db` anywhere — gate
  mutating commands on a found config; `withFallback` swallows primary provider errors bare —
  add a warn hook; ui-sdk client registries are module-scope singletons — declare ui-sdk as
  peerDependency in renderer packs + `Symbol.for` guard; document `.strict()` config schema
  forward-compat behavior; stale build test expects "Brain UI" (`server/tests/e2e/build.test.ts:45`).

## 3. Target package layout (converged across reviewers)

| Package | Owns |
|---|---|
| `core` | as today: CLI, index/search, config/taxonomy, seams, module loader, MCP (+ real `brain mcp`) |
| `module-*` | as today, after two-phase `defineModule` |
| `ui-sdk` | runtime protocol schemas + types, `AgentBackend`, `SpeechProvider`, errors, write-lock. **No React** — move renderer/ASR registries out |
| `ui-server` | Hono app factory (`createApp`), ws/turn coordinator, auth middleware, session catalog, brain/files/voice routes, injected BrainService. No Vite, no Puppeteer |
| `ui-react` | React components, transport, per-session state, chat/files/voice UI, renderer + ASR registries, base CSS + theme tokens. **Prebuilt JS + d.ts + precompiled CSS with CSS-variable hooks** |
| `ui-agent-tools` | shared pi/gemini brain tools, risk policy, approvals, mutation execution |
| `ui-backend-{claude,pi,gemini}` | as today; gemini only after the permission fix |
| `ui-render-puppeteer` | optional, only if rendering survives the security review |
| template(s) | the app shell: `index.html`, mount, Vite config, PWA manifest/icons, service worker, theming, compose files |

Build ownership: the Vite/PWA build stays in the deployment shell (URLs, manifest, SW policy,
branding are deployment concerns). "Thin shell" honestly means ~10 files of build scaffolding, not
zero. Tailwind v4: ship precompiled CSS from ui-react; document
`@source "../node_modules/@<scope>/ui-react"` as the customization escape hatch.

Do NOT move brain-ui's directories wholesale: the ws handler concentrates orchestration/approvals/
persistence/broadcast in one 865-line file, and the client keeps a single active message buffer that
discards scoped background frames despite the multi-session contract
(`client/src/stores/chat-store.ts:72`). Extract behind explicit host objects and fix the
multi-session model during the move, while everything is still experimental.

## 4. Drift audit: brain/scripts vs packages/core

brainform is ahead in every shared area; **zero brain-side changes pending flow-back** (phase-1 was
the sync point). But the gap is widening: indexer already 796 changed lines apart, mcp-server
near-total rewrite; both `SCHEMA_VERSION = 7`, existing `brain.db` is drop-in. `~/brain/brain.config.ts`
already validates against core's zod schema — adoption is mechanical.

Migration blockers: packages unpublished (chicken-and-egg → publish first); finance-type collision
semantics (brain.config declares `finance` AND module-finance contributes it — verify merge rule);
brain-ui spawns vendored paths (`server/src/brain/client.ts` → `scripts/brain-cli.ts`,
`routes/brain.ts` → `scripts/whatsup.ts --gemini`, entrypoint cron → `scripts/jobs/scrape-all.ts`)
— all must retarget the `brain` bin / module cron / a whatsup skill in the same window; verify
indexer sidecar-cache compat (`.asset-cache.jsonl`, `.context-cache.jsonl`) to avoid a paid
re-enrichment; re-base brain's 424-line CLAUDE.md on core's CONTRACT.md import. Keep
`whatsup.ts`, `refresh-catalog.ts`, `eval/` private (relocate to e.g. `local/`).

## 5. Sequencing (minimizes double-maintenance)

1. **Fix launch-blocker code issues** (§1.1, 6–9) + design debt that breaks the protocol (§2) —
   everything is cheapest while both consumers are private.
2. **Rename + publish pipeline**: new scope, LICENSE, changesets + npm OIDC trusted publishing with
   `--provenance` (current ecosystem default), tarball-consumer CI.
3. **Migrate `~/brain` off `scripts/`** — kills the largest drift surface; brain becomes the live
   integration test. Retarget brain-ui's spawn paths in the same window.
4. **Extract ui-server → ui-react** (with boundary fixes, not wholesale); brain-ui becomes the thin
   shell on published packages; `BRAINFORM_TOKEN` git-clone Docker machinery disappears.
5. **Template/docs for the UI deployment** — today the template covers core only; an outsider cannot
   get the chat UI running (no compose, no auth env surface, hosting docs point at a private repo).
   Add compose + published image (ghcr) or a `create-<name>` scaffold (`bun create` convention:
   publishing `create-<name>` makes `bun create <name>` work; `giget` for template pulls).
6. **Public cut**: strip meta-docs, tighten leakage gate, publish template repo, honest experimental
   README.

## 6. Name

Full record — context, method, all directions, raw check data — in
[08-name-research.md](08-name-research.md). Condensed version below.

"brainform" burned (brainform.ai active in adjacent AI-agent space; GitHub org taken). "ua-brain"
rejected (ua- prefix = User-Agent parsing genre on npm; UA = Ukraine; pun needs explaining).

Hunt: ~34 candidates batch-checked (npm bare name, GitHub, npm-similar), 8 survivors web-vetted for
companies/trademarks/connotations:

| Name | Verdict | Notes |
|---|---|---|
| **florilegium** | CLEAN | medieval excerpt-anthology = exact concept fit; uncontested in software; long (12), spelling learnable. GitHub user also free |
| **zibaldone** | minor noise | Leopardi's notebook; one dormant 3-star repo; punchy, needs one-line explainer |
| **endoxa** | minor noise | Aristotle's "reputable opinions"; shortest/easiest; unrelated federal contractor exists |
| **kashkul** | clean-ish | dervish gathering-bowl; best metaphor, worst transliteration/SEO variance |
| forebrain | risky | three live tech companies (US/India/Brazil) |
| cajal | near-dead | Cajal Technologies, trending YC W26 AI startup, asserts trademark |
| hortus | risky | saturated + HortusFox (self-hosted OSS, same deployment story) |
| ollam | dead | Ollama one-letter near-miss; precedent: Ollama-WebUI forced rename |

Recommendation: **endoxa** if typing ergonomics win (`@endoxa/core` daily), **florilegium** if
distinctiveness wins. CLI stays `brain`, config stays `brain.config.ts` — platform name is scope +
org + site only. Manual steps before locking: create the npm org (anonymous scope probing is
blocked), register GitHub org + domain same day, cursory USPTO/EUIPO word-mark search.

### endoxa domain/trademark deep-dive (2026-07-17): MANAGEABLE, leaning non-issue

Registered: `.com` (since 1998, Hetzner-hosted dormant WP site, registrant redacted, no sale
signal), `.ai` (registered but dormant — RDAP record exists, zero DNS), `.net`, `.org` (redirects
to Endoxa Learning), `.io` (IONOS parked). **Available: endoxa.dev, .app, .sh, .so, .xyz, .build,
.tools, .run, getendoxa.com, endoxahq.com** — the entire dev-native TLD family.

Entities: Endoxa Corp (US federal B2G data/ML consultancy, no product, no located mark); Endoxa
Learning Ltd (UK K-12 EdTech SaaS — closest software use; asserts compound mark "Endoxa Learning",
no confirmed bare-word registration); Endoxa retail-automation (ZA, distant market); two dissolved
UK Endoxas. No bare "ENDOXA" wordmark found in class 9/42 via Trademarkia/WIPO-adjacent search;
official USPTO/EUIPO/UK-IPO UIs blocked automation — do one manual pass before filing anything.

Precedent: Astro never owned astro.com (thriving unrelated astrology business) — zero friction at
framework scale; Bun built pre-1.0 adoption entirely on bun.sh. `.dev/.sh/.build` is the expected
home for 2026 dev tooling.

Strategy (revised — .dev too developer-coded for the audience): anchor **endoxa.app** (product is
an installable PWA; consumer-credible, HTTPS-enforced) with **endoxa.so** as alternate/redirect
(notion.so precedent — the personal-knowledge-product TLD). Also free: .me, .co, .id, .one, .page,
.space, .site, .world, .life, .systems, .software, .digital, .zone, .cc, .ink, .sh, .build, .tools,
.run, .xyz. Ignore `.com`/`.ai` — broker inquiry at most, never a launch gate.

Handles: npm — bare `endoxa` package free; zero `@endoxa/*` packages and zero maintainer:endoxa
packages (scope unused; npmjs.com blocks anonymous scope checks — confirm with `npm org create
endoxa` while logged in). GitHub — `github.com/endoxa` is a dead-squat Organization (created
2018-04-13, untouched since, 0 repos, 0 followers): try one GitHub Support name-squatting release
request (empty org = best case); fallbacks all free: `endoxa-hq`, `endoxahq`, `getendoxa`,
`endoxa-app`, `endoxa-os`, `endoxa-project`.

## 7. Do NOT do (unanimous reviewer restraint list)

Do not merge the three repos (privacy boundary is the feature). No DI container, plugin marketplace,
or runtime hot-loading. No Node/Deno neutrality rewrite — declare Bun, keep browser packages
runtime-neutral. No multi-tenancy/RBAC/collab. No ORM over SQLite/FTS5/sqlite-vec. No universal
conversation database — routing catalog + normalize-on-read. No more than the package split above.
No design-system/theming engine — CSS variables + one stylesheet. No offline personal-data promise.
Keep 0.x; document the small supported contracts; label the rest experimental.

## 8. Positioning (validated)

No surveyed project combines: git+markdown as canonical versioned source of truth, single self-host
container with chat-first PWA, pluggable agent backends, domain-module system. Nearest: Khoj (34k★,
imports markdown but owns the DB), basic-memory (markdown-canonical MCP plugin, not a product),
AnythingLLM (generic RAG). The gap is real; expect competitive attention once visible.

## What's genuinely good (calibration)

Backend contract suite executed against both production backends — the seam is proven, not just
documented. AgentBackend doc comment is a model contract spec. "A seam exists only where a second
implementation is plausible within a year" — written down and followed. Taxonomy as data with a
single resolver + owner/collision semantics. Module restraint (no fs scanning, one CLI word,
collisions are load errors). Keyless/offline/deterministic test policy enforced in CI. CI leakage
gate. Chunked byte-bounded history replay. Additive-only protocol discipline. gpt-5.6-sol:
typecheck passed across all repos, 223 client tests passed.
