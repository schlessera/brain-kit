# Package-Split / Personal-Data Review — 2026-07-18

Follow-up to `07-oss-readiness-review.md` (2026-07-17), focused on the split goal: brainform
properly separated, zero personal information, containing all reusable parts of `~/brain`
(CLI, scripts, skills) and brain-ui's frontend/server in reusable form. Five independent
passes: four Fable 5 agents (PII sweep incl. git history; package-structure re-verification;
brain-repo extraction inventory; brain-ui delta + extraction map) and one gpt-5.6-sol
read-only review via codex (typecheck passed; tests inconclusive under read-only /tmp).

## Verdict

Architecture and shipping-tree hygiene are in good shape; the separation itself has not
advanced since plan/07. **Nothing on the plan/07 blocker/debt list has been fixed** — the one
Gemini commit since (dd93085) re-characterized the permission no-op as intentional
auto-execute and left the capability flag lying. Two NEW high-severity findings surfaced
(Claude write-lock inert; capability/SECURITY.md dishonesty now flat-out false), the
containment problem is broader than plan/07 recorded, and the git history is confirmed
unpublishable. gpt-5.6-sol's verdict: no-go for a public cut (expected — sequencing agreed).

## 1. Personal information (the core goal) — status per surface

| Surface | Verdict |
|---|---|
| brainform shipping trees (packages/, template/, docs/, root docs, CI) | **CLEAN** |
| brainform strip-at-cut trees (plan/, research/, PROGRESS.md, AGENTS.md) | personal data present as designed; must be dropped at cut |
| brainform git history | **BLOCKER if pushed** — fresh-history cut mandatory |
| brain-ui shipping tree | clean except `Dockerfile:22,50` (schlessera) + one dev-only blurb |
| CI leakage gate | functional but minimal; harden with structural detectors |

Details:

- **Shipping trees are genuinely clean.** Fixtures verified fictional ("Alex Example" park-ranger
  corpus, Acme/Globex/Initech ledgers; `packages/core/fixtures/README.md:6` documents the
  policy). No emails, IPs, tokens, personal domains, personal paths, family/client names.
  Reverse-geocode UA genericized (`ui-backend-claude/src/reverse-geocode.ts:23`). Only
  deliberate hits: 7 × `schlessera` org references — `docs/quickstart.md:15`,
  `docs/hosting/README.md:16`, `template/README.md:28,71`,
  `template/README-template-dev.md:6,7,14` — all evaporate at rename (plan/07 §1.4).
- **Git history is NOT publishable.** 44 commits, all authored
  `Alain Schlesser <alain.schlesser@gmail.com>`. `plan/` + `research/` (VPS IP
  91.99.200.114, brain.schlesser.net, tailnet name, Coolify UUID pointers, family/client
  names) are committed from the first commits; deleting at cut does not remove blobs.
  Commit `b1984e8` scrubbed two real slugs out of SHIPPING paths — pre-scrub blobs still
  carry `talks/the-agentic-stack` (core/tests/taxonomy.test.ts) and `[[a-team]]`
  (core/fixtures/README.md). Good news: no secret material ever committed (token/key/history
  scan empty; only sensitive-named file ever added is `template/.env.example`).
  **Public repo must start from a fresh initial commit of the scrubbed tree** — already
  mandated by AGENTS.md + plan/06:44; now confirmed as hard requirement, not hygiene.
- **Leakage-gate hardening (recommended, zero-leak-risk):** add generic structural detectors
  that name no private string — IPv4 regex, UUID regex, email regex, token/key prefixes
  (`ghp_`, `AIza`, `sk-`, `-----BEGIN`). Current gate checks 5 names, allowlists the org
  spelling (tighten post-rename), scans working tree only, and the extended identifier set
  is manual-sweep-only by design.
- Untracked/stray files: clean; .gitignore adequate. `plan/07` + this file are untracked/
  strip-at-cut.

## 2. What changed since plan/07 (delta review)

- **brainform: zero fixes.** Every §1 blocker and §2 debt item re-verified OPEN (full table in
  pkg-review appendix below). dd93085 made Gemini auto-execute *documented* rather than
  gated — the blocker's core (dishonest `permissions: true`) is untouched and now flatly
  false per the capability's own contract (`ui-sdk/src/server/backend.ts:53`).
- **brain-ui: real auth work, orthogonal to the flagged items.**
  - 58111f5 (XFF right-to-left, `TRUST_PROXY` boot-gate) reviewed correct — but §1.9 is
    NOT resolved: `assertAuthConfig` still only called from `server/src/index.ts:13` (not
    `createApp()`), none-mode refusal still `NODE_ENV === "production"`-gated
    (`auth.ts:80`).
  - Passkeys (ce0a9d8 + 1acd732) reviewed end-to-end: **no auth bypass found**.
    Registration requires an authenticated session (routes mounted after guard,
    `app.ts:92`; re-checks mode). Challenges single-use, 120s TTL, type-tagged; RP-scoped
    assertions; UV+resident-key required; counter regression warns not revokes (right for
    cloud passkeys); rate-limit buckets shared with password (one online-guess budget).
    Lockout is possible but recoverable (`BRAIN_UI_ALLOW_PASSWORD=1`) and race-free.
    Minor: NODE_ENV-gated loopback widening in `resolveRp` (`passkeys.ts:138`) — replace
    with explicit dev flag at extraction; `/auth/methods` is a pre-auth posture oracle
    (needed by login screen); bounded challenge-eviction DoS.
  - Service worker STILL caches `/api` GET (NetworkFirst, 5-min TTL,
    `client/src/sw/service-worker.ts:53-65`) — now including passkey metadata. §1.9 asked
    for NetworkOnly. Puppeteer renderer unchanged (§1.8 intact). ws handler still exactly
    865 lines.
  - Passkey extraction posture: good seams (request-derived RP + `WEBAUTHN_RP_ID`/
    `WEBAUTHN_ORIGINS`, `PasskeyDeps` injection), but hardcoded `RP_NAME="Brain UI"` and
    `USER_ID="brain-ui-owner"` (`passkeys.ts:43-48`) — the user handle is a WebAuthn wire
    contract, changing it post-hoc orphans credentials → must be config-injected BEFORE
    real deployments accumulate credentials. Storage hardwired to `getDb()` + raw SQL;
    `migrations/005_passkey_credentials.sql` lives in the repo-root migrations dir
    (deployment shell owns a package-destined table's DDL).

## 3. New findings (not in plan/07)

1. **[HIGH] Claude backend write serialization never engages under defaults.**
   `Bash/Edit/Write/NotebookEdit` ∈ `DEFAULT_ALLOWED_TOOLS`
   (`ui-backend-claude/src/backend.ts:41-54`); Agent SDK auto-allows those without
   invoking the permission callback (sdk.d.ts: "auto-allowed without prompting … execute
   automatically") — but the WriteLock is acquired only inside `canUseTool`
   (`backend.ts:254`). Net: the documented cross-session write serialization is inert for
   the flagship backend. Static evidence is unambiguous (SDK d.ts verified); do one runtime
   confirmation, then fix (acquire the lock outside the permission path, or drop mutating
   tools from the allowlist).
2. **[HIGH] Capability honesty.** Gemini `permissions: true` with a no-op gate
   (`tools.ts:90-98`) contradicts `SECURITY.md:16` and the capability's definition; hosts
   render approval UI off this flag. Fix = wire `bridge.requestPermission` (copy pi,
   `ui-backend-pi/src/tools.ts:51-70`) or set `false` — and either way add Gemini to the
   contract suite (`backend-contract.test.ts:212`, still `[claude, pi]`) plus a capability-
   honesty test: `permissions:true` ⇒ a deny must actually block a mutation. Gemini also
   emits `error` then `result isError:false` (`backend.ts:433,464`) — the §2 terminal-
   outcome unification, still open.
3. **Containment is broader than plan/07 §1.7:** besides `ingestion.ts:210`,
   `import --stamp` deliberately falls back to unrestricted `resolve()`
   (`core/src/cli/commands/import.ts:36`); finance/jobs scaffolding trust
   `clientsDir`/`opportunitiesDir` (`module-finance/src/cli.ts:63`,
   `module-jobs/src/cli.ts:376`); `safe-path.ts:16` falls back to lexical containment for
   not-yet-existing files under symlinked parents; `resolveRoot` still falls back to any
   `.git` ancestor → cwd (`config.ts:197,216-220`), so mutating commands run and create
   `brain.db` anywhere. One repo-relative zod schema + safeResolve at every write boundary
   + refuse mutation without an initialized config.
4. **Module config split-brain is worse than "two-phase defineModule":** registry throws
   away already-validated module config (`cli/registry.ts:69`); finance CLI reloads
   everything and silently defaults on error (`module-finance/src/cli.ts:24`) — invalid
   config can redirect writes to the wrong tree. Jobs has the same fixed-taxonomy/movable-
   dir contradiction as finance (`module-jobs/src/module.ts:28`).
5. **[MED] `@brainform/core` hard-depends on `@google/genai`** (`^2.10.0`, non-optional,
   used only by default Gemini providers; skewed vs ui-backend-gemini's exact `2.12.0` —
   two copies in a full install). Lazy import + optional peer.
6. **Template/doc truthfulness:** template promises `brain whatsup`
   (`template/README.md:62`, `.env.example:4`) — command doesn't exist (skill wraps
   `brain briefing`); `bun install` auto-runs `brain setup` with global side effects (git
   hooks, skills, `~/.local/bin` symlink — `template/package.json:6`, `setup.ts:21`) —
   needs consent; `docs/hosting/README.md:14` claims brain-ui spawns the packaged CLI
   (false — it spawns vendored scripts); README package-layout table omits ui-sdk and all
   backends.
7. **Release infrastructure is fictional:** no build/pack/publish/version scripts, no
   `.changeset/` despite CONTRIBUTING claiming changesets, no LICENSE, no
   repository/bugs/homepage metadata, no per-package READMEs, no tarball-consumer CI.
   (Restates plan/07 §1.3/§1.6 with sharper edges: also decide Bun-source-only vs dist —
   current manifests imply compatibility the files don't provide.)
8. **ui-sdk still couples to React** (`client/renderers.ts:14`, react peerDep) — contra §3
   target; registries move to future ui-react.
9. **Renderer selection bug waiting at extraction:** client tool timeline hardcodes
   `BACKEND_ID = "claude"` (`client/src/components/chat/tool-call-timeline.tsx:24`) —
   wrong renderer packs for pi/gemini.
10. **Both sides still cast JSON** (`ws-client.ts:37`, `ws/handler.ts:690`) — §2 runtime-
    schema item, now with concrete extraction stakes; deployment backend registry accepts
    only claude|pi (`server/src/agent/backend.ts:91`), so the published Gemini backend
    isn't composable without editing source.

## 4. Extraction inventory — what brainform is still missing

### From ~/brain (drift frozen: nothing changed in scripts/ since 07-13; brainform ahead on every shared file)

Load-bearing (2):
1. **Jobs skills → `module-jobs/skills/`** + `skills:` manifest entry (mirror
   module-speaking): `jobs-review`, `research-opportunity`, `interview-scheduled` — with
   personal specifics generalized. module-speaking ships 8 skills; module-jobs and
   module-finance ship zero.
2. **OKF export/check → core** (`brain okf export`): complete design in
   `~/brain/scripts/docs/okf/`, implemented nowhere in brainform.

Functional gap (from codex, disputes brain-inventory's "superseded"):
3. **Unified api+browser scrape:** `jobs scrape` runs either mode, not both
   (`module-jobs/src/cli.ts:148`) — the module cron entry therefore omits browser sources,
   which `scripts/jobs/scrape-all.ts` covered. Port the unified mode; the script itself
   stays dead.

Decisions needed (not silently omit):
4. `whatsup`: keep private (plan/07 position) → then fix template's `brain whatsup`
   promises; or port the full command. Pick one.
5. `refresh-catalog.ts` → parameterized catalog module, or explicit personal-keep.
6. `linkedin-audit`/`linkedin-post`/`publish-post` → future content/career module or
   explicit out-of-scope. `generate-pdf`, `use-repo`, third-party skills-lock skills →
   explicit disposition (provenance/licensing).

Everything else: settled. Config schema is a strict superset (migration not blocked);
module-cron mechanism already supersedes the legacy cron line; whatsup/refresh-catalog/eval
correctly private today.

### From brain-ui (~14.8k LOC: server 4.7k, client 10.1k; reusable-with-rework ≈ 13.9k)

Targets per plan/07 §3 confirmed; full table in the brain-ui appendix. Highlights:
- **ui-server**: app factory (fold `assertAuthConfig` in), auth+passkeys+tailscale (862),
  ws coordinator (1,068 — decompose the 865-line handler during the move), routes, files,
  voice, agent registry, db. Blockers: `BRAIN_UI_*` env prefixes (6), `RP_NAME`/`USER_ID`,
  getDb-hardwired storage, migration ownership, brain/ CLI-spawning → ui-agent-tools seam.
- **ui-react**: components 6.6k (minus dev/ kitchen-sink — drop), stores 989 (fix
  chat-store single-active-buffer during move), lib 922, voice 747, hooks 451. Brand
  strings via props/tokens ("Brain UI" in `index.ts:92`, `login-screen.tsx:103`,
  `ws/handler.ts:686`, `passkeys.ts:43`).
- **Shell keeps**: Vite/PWA build, SW policy (after /api → NetworkOnly), main/app mount,
  compose/Docker (BRAINFORM_TOKEN machinery dies when packages publish), cron container
  glue. `shared/protocol.ts` dissolves into ui-sdk.

## 5. Updated priority order

Plan/07 §5 sequencing stands. Insertions marked ★:

1. Fix blockers while private: containment (now the §3.3 expanded list), Gemini
   permission/capability honesty ★+ Claude WriteLock inertness ★+ capability-honesty
   contract test, protocol debt (runtime schemas, handshake, turnId, terminal outcome,
   costUsd), two-phase defineModule ★+ config-into-CommandContext plumbing,
   ★ core's @google/genai → optional, brain-ui §1.9 (assertAuthConfig into createApp,
   kill NODE_ENV gates incl. passkey `resolveRp`, SW /api → NetworkOnly), §1.8 renderer
   decision, ★ config-inject passkey RP_NAME/USER_ID before credentials accumulate.
2. Rename + publish pipeline (LICENSE, changesets, engines, dist-or-declared-Bun-source,
   `brain mcp`/MCP bin, tarball-consumer CI, package metadata + READMEs,
   ★ template setup-consent fix, ★ true docs).
3. Migrate ~/brain onto published packages (+ retarget brain-ui spawn paths;
   ★ port jobs skills, OKF export, unified scrape in this window; ★ resolve whatsup/
   catalog/content-skill dispositions).
4. Extract ui-server/ui-react (boundary fixes during move; ★ migration ownership,
   ★ backend-id renderer fix, ★ registry composability for gemini).
5. Template/docs for UI deployment.
6. Public cut: **fresh git history** (hard requirement — §1 above), strip meta-docs,
   tighten leakage gate ★+ structural detectors, honest experimental README.

## Appendices

- pkg-review status table: every plan/07 §1/§2 item OPEN as of 2026-07-18; brain-access
  twins now byte-identical (167 lines each); layering otherwise verified clean
  (core ⊥ ui-sdk; claude → ui-sdk only; pi/gemini → core+ui-sdk; versions 0.1.0; zod ^4.4.3).
- Verification: gpt-5.6-sol ran `bun run typecheck` (pass) and `bun test` (204 pass, 88
  env-failures under read-only /tmp — inconclusive, rerun locally).
