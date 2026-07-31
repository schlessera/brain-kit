# Phase 2 (rename + publish pipeline) — 2026-07-30

> **STATUS 2026-07-31: the name "endoxa" is DEAD.** Alain's WIPO Global Brand
> Database pass found UK00003397309 — ENDOXA word mark, **class 9 "computer
> software" + class 42 "computer services"**, registered 2019, in force to 2029,
> held by ENDOXA LIMITED (active UK company; UK arm of the South African
> retail-automation vendor behind endoxa.co.za / EndoxaFlow). Identical mark,
> identical goods, active owner → double-identity risk; near-respellings are no
> escape (similar-mark infringement + the Ollama precedent). Name search reopened
> with a mandatory WIPO-GBD software-class screen. Everything else in this doc
> (pipeline, dist builds, publish mechanics) is name-independent and stands;
> the endoxa strings in the repos await the replacement name. Nothing external
> (domains, npm org, GitHub requests) was ever claimed for endoxa.

Continues [09-phase-1-handoff.md](09-phase-1-handoff.md). Phase 2's blocking decision
landed: **the public name is `endoxa`** (Alain, 2026-07-30 — ergonomics won), and the
packaging decision is **built dist/** (compiled JS + d.ts), not declared-Bun-source.

## Name facts (re-verified 2026-07-30)

- endoxa.app / .so / .me — RDAP-free. Bare npm name `endoxa` free (404).
- GitHub org `endoxa` — still the 2018 dead-squat (id 38348916, untouched). Support
  squat-release request drafted; fallback `endoxa-hq`.
- florilegium.app turned out registered (Namecheap, 2025-07-03, dormant) — the 07-17
  research never RDAP-swept it. Moot after the endoxa pick.
- Still Alain-only: `npm org create endoxa`, domain registrations, the GitHub support
  request, the 5-minute manual USPTO/EUIPO/UK-IPO wordmark pass.
- **USPTO pass done (Alain, 2026-07-31): one hit, assessed non-blocking.** ENDOXA,
  serial 98148643, Droit Operating Company LLC (droit.tech, NY fintech-compliance) —
  classes 35/36/41/45 (financial-industry association/regulatory/seminar services),
  NOT 9/42. Still unregistered: 1(b) intent-to-use from 2023-08, second SOU extension
  granted 2026-01, attorney withdrew 2026-05 (abandonment-shaped). Conclusion: use of
  endoxa for OSS knowledge-base software proceeds; revisit with a trademark attorney
  only if we ever file our own mark; check TSDR on the SOU clock (~6 months). Keep
  module-finance framed as personal bookkeeping, not financial-industry information.
- **EUIPO pass done (Alain, 2026-07-31): same owner, even narrower.** EUTM 018972609
  (Droit Operating Company, US priority from 98148643) is REGISTERED (2025-11-20, to
  2034) but in **class 45 only** — association services / regulatory-compliance
  concepts. The 35/36/41 classes were shed during prosecution after an opposition by
  Indexa Capital Group (likelihood of confusion, 2024). Classes 9/42 clear on both
  registers. Combined verdict unchanged: non-blocking for endoxa-the-software.

## What phase 2 changed (branch `phase-2/rename-endoxa`)

**Rename commit.** brainform → endoxa across the shipping tree (98 files): @endoxa/*
scope, MCP server name (`mcp__endoxa__*`), `ENDOXA_REVERSE_GEOCODE`
(`BRAIN_UI_REVERSE_GEOCODE` fallback intact), `endoxa-<kind>-<vendor>` provider
convention, docs/template, repo-URL placeholders (github.com/endoxa/endoxa +
endoxa/endoxa-template). plan/, research/, PROGRESS.md, AGENTS.md intentionally keep
the old name (strip-at-cut). The CI leakage gate dropped its org-spelling allowlist —
the surname is now caught in full (LICENSE files excluded: they carry the author's
name deliberately).

**Publish-pipeline commit.** Implemented by gpt-5.6-sol under Claude direction:

- Per-package `tsconfig.build.json` → `dist/` (JS + d.ts + declaration/source maps),
  ordered build script (core, ui-sdk first), `bun run build` / `clean` at the root.
- **Conditional exports** on every entry point:
  `{ "bun": src TS, "types": dist d.ts, "default": dist JS }`. Bun consumers (and the
  monorepo itself) keep executing live TS; tsc gets types; Node/bundlers get JS.
- core `bin.brain` → `dist/cli/brain.js` (bun shebang preserved); `brain --version`;
  `brain mcp` starts the existing stdio MCP server in-process (template `.mcp.json`
  and docs register through it).
- MIT LICENSE root + per package; changesets (`baseBranch main`, public);
  `publishConfig.access public`; `engines.bun` only where bun:* APIs are real
  (core, module-jobs, ui-backend-pi); repository/homepage/bugs/keywords;
  `sideEffects: false`.
- Template consent fix: `prepare` hook removed — `bun run setup` is explicit and its
  global side effects are documented. Docs truth fixes: `brain whatsup` claims
  corrected (skill wraps `brain briefing`), hosting doc now says brain-ui still spawns
  a vendored CLI until phase 3.
- CI `pack` job: build → `bun pm pack` all 8 → install the tarballs in a scratch
  consumer via overrides → import every entry → run the packed `brain --version`.

Verified locally: build clean, typecheck clean, 386 pass / 2 skip / 0 fail,
tarball-consumer smoke green (8 imports + `brain --version` → 0.1.0),
leakage gate clean. `changeset status` correctly demands a changeset vs main.

## brain-ui companion (branch `phase-2/endoxa-scope`)

Two commits: (1) scope flip @brainform/*→@endoxa/*, `mcp__endoxa__*` tool names,
branding (PWA manifest/titles/prose) — the private-build machinery (BRAINFORM_REF /
BRAINFORM_REPO / BRAINFORM_TOKEN, schlessera/brainform clone URL, /brainform path,
../brainform sibling link) deliberately keeps its names until packages publish.
(2) **Resolution fix discovered by running the real vite build** (predicate-test
lesson again): bun's `file:` copy is gitignore-aware, so the sibling's `dist/` never
reaches node_modules — tsc (`customConditions: ["bun"]`) and vite
(`resolve.conditions: ["bun", ...defaultClientConditions]`) now resolve the `bun`
condition, i.e. live TS source, same as the Bun runtime. No sibling build needed
anywhere in brain-ui. Baseline test failures unchanged (the 7 known from plan/09).

Still open in brain-ui: bump `BRAINFORM_REF` (both Dockerfile ARGs) to the brainform
merge commit once phase 2 merges to main.

## Publish-day runbook (blocked on Alain's npm org)

1. `npm org create endoxa` (+ `npm login` state) — the definitive scope claim.
2. `bunx changeset` → initial 0.1.0 entries for all 8 → `bun run version` → review →
   `bun run release` (build + `changeset publish`).
3. Then phase 3 (plan/08 §5): migrate ~/brain off vendored scripts/ onto the published
   packages, retarget brain-ui's spawn paths + kill the BRAINFORM_* machinery.

## Watch items

- The npm scope: bun's `workspace:*`/cross-dep rewriting at publish time was verified
  only via `bun pm pack` in the CI smoke — re-verify the published tarballs' manifests
  on the first real publish before announcing anything.
- github.com/endoxa/endoxa URLs in package metadata are placeholders until the org
  exists (support request or `endoxa-hq` fallback → sed then).
- The public cut still requires fresh git history (plan/08 §1 — hard requirement).
