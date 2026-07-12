# 01 — Core Architecture: Topology, Config, Modules, Testing

Status: approved plan · Date: 2026-07-12 · Prereq reading: 00-overview.md, research/brain-repo-analysis.md

## 1. Repo / package topology

```
github.com/schlessera/brainform           (monorepo, bun workspaces, FRESH git history)
├── packages/core             → @brainform/core
│   ├── src/lib/…              db, search-engine, chunker, reranker, embedder(→ providers/),
│   │                          context-assembler, frontmatter, safe-path, archiver,
│   │                          taxonomy.ts [NEW], config.ts [NEW], module-loader.ts [NEW],
│   │                          enrichment.ts [NEW — see 04-extensibility §1]
│   ├── src/cli/…              command registry + core commands; bin: brain
│   ├── src/mcp-server.ts
│   ├── src/hooks/…            pre-commit/post-commit/post-checkout/post-merge, skills-sync
│   ├── skills/                core skills: add, process-notes, audit, content-hygiene,
│   │                          whatsup, sync, brain-init, brain-doctor, brain-import,
│   │                          brain-module, brain-host, new-module
│   ├── CONTRACT.md            agent contract layer (see 02-onboarding §CLAUDE.md)
│   ├── fixtures/corpus/       fake brain for tests (§6)
│   └── tests/
├── packages/module-jobs       → @brainform/module-jobs      (scraper, scoring, 11 adapters, jobs.db, 3 skills)
├── packages/module-speaking   → @brainform/module-speaking  (8 skills; talk/conference/travel taxonomy)
├── packages/module-finance    → @brainform/module-finance   (AR engine, ledger scaffold, finance CLI cmd)
└── docs/                       quickstart, concepts, cli, mcp, hosting/, modules/, extending/,
                                INTEGRATION.md successor

github.com/schlessera/brainform-template  (GitHub "Use this template")
├── brain.config.ts             minimal default: me/, context/, notes/ only
├── package.json                pinned @brainform/core; `prepare` runs idempotent `brain setup`
├── CLAUDE.md                   ~20-line bootstrap ("uninitialized brain — run /brain-init"), marker-delimited
├── README.md                   quickstart + "KEEP THIS REPO PRIVATE" banner
├── .mcp.json                   stdio → brain mcp
├── .env.example                GEMINI_API_KEY only, commented, "optional" framing
├── me/.gitkeep, context/.gitkeep, notes/hello-brain.md    (one example note; pre-init smoke test)
├── .context-cache.jsonl, .asset-cache.jsonl               committed EMPTY (sidecar contract)
├── .claude/settings.json       sensible default permissions
└── .agents/skills/             user-local skills overlay

schlessera/brain (private)     → consumer #1, stays private forever
brain-ui                       → see 03-brain-ui.md
```

Key choices:

- **Modules = separate packages, versioned in lockstep** (Babel-style fixed versioning). Forces the module API to be honest — first-party modules use exactly the API user-authored modules get. Moves heavyweight deps out of core (playwright → module-jobs). `bun update` moves all `@brainform/*` together, keeping "update infra via one version bump" true.
- **Skills distribution: `brain skills sync`** — core command (port of `scripts/hooks/sync-skills`, which already handles Unix symlinks, Windows junction fallback, stale-link pruning). Collects skills from: core package skills → enabled module skills → repo-local `.agents/skills/` (**local overrides same-named package skills** — how Alain keeps personal variants like his plan-travel). Then runs per-agent emitters (04-extensibility §2). Triggered by shipped git hooks (post-checkout/post-merge) + `brain setup`.
  - Rejected: npm postinstall (Bun blocks postinstall for untrusted deps via `trustedDependencies`); Claude Code plugin marketplace as primary channel (a second update channel that drifts from the npm version — skills reference CLI flags and must version WITH core; revisit as an additional channel post-v1).
- CLI bin stays `brain`; MCP tools stay `brain_*` (INTEGRATION.md contract; brain-ui spawns `bun scripts/brain-cli.ts` today and will spawn the packaged bin after migration).

## 2. `brain.config.ts` — the single config source

TS-first via `defineConfig()` (typed; Bun runtime), with `brain.config.json` accepted for no-code users. Zod-validated; `brain validate` runs config validation first and refuses on schema errors; `brain config check` standalone. `BRAIN_ROOT` env override preserved (current behavior: `scripts/lib/types.ts:3`).

```ts
import { defineConfig } from "@brainform/core";

export default defineConfig({
  profile: { name: "Alain Schlesser", cliTitle: "Alain Schlesser's personal knowledge base" },

  taxonomy: {
    // ONE entry per type replaces the three unsynchronized maps
    // (ingestion.ts:34 TYPE_DIRECTORIES, auditor.ts:21 TYPE_DIR_MAP, indexer:53 inferAssetType):
    //   dir   = canonical creation dir; match = accepted path prefixes (default [dir]);
    //   asset-type inference = longest-prefix match over match[]
    types: {
      identity:       { dir: "me", staleDays: 180 },
      context:        { dir: "context", staleDays: 30, staleSeverity: "warning" },
      project:        { dir: "projects/active", match: ["projects/"], staleDays: 90, staleSeverity: "warning" },
      infrastructure: { dir: "infrastructure", match: ["infrastructure/", "home/"] },
      note:           { dir: "notes", inbox: true },
      index:          { dir: null },                       // any dir; skip dir checks
      expertise: { dir: "expertise" }, opinion: { dir: "opinions" },
      career: { dir: "career" }, network: { dir: "network" },
      strategy: { dir: "content-strategy" },
      // conference/travel/talk/finance/opportunity come from modules — NOT listed here
    },
    dirAnchors: ["_index.md"],                    // modules append status.md/itinerary.md/outline.md
    canonical: { identity: "me/identity.md", currentFocus: "context/current-focus.md" },
    propagation: [                                 // generalizes auditor.ts:101 FACTS.md check
      { source: "me/bios/FACTS.md", derivatives: "me/bios/*.md" },
    ],
    assetTitleRules: [                             // generalizes indexer:68 deriveAssetTitle
      { prefix: "me/media-kit", label: "Media Kit" },
      { pattern: "talks/*/slides/**", label: "Slide", slugFrom: 1 },
    ],
    classifierHints: { /* type → keyword lists; modules contribute theirs */ },
  },

  exclude: { dirs: [/* types.ts:19 */], files: ["CLAUDE.md", "README.md"], segments: [/* types.ts:23 */] },

  embeddings:  { provider: "gemini", model: "gemini-embedding-2", apiKeyEnv: "GEMINI_API_KEY" },
  completions: { provider: "gemini-flash", fallback: "anthropic-haiku" },   // see 04 §1
  agentRunner: "claude",                                                    // see 04 §1

  modules: {
    "@brainform/module-jobs":     { criteria: "career/opportunities/search-criteria.md",
                                    opportunitiesDir: "career/opportunities", boards: ["remoteok"] },
    "@brainform/module-speaking": { travelParty: [{ name: "Carole", role: "partner" },
                                                  { name: "Buffy", role: "assistance-dog",
                                                    requirementsDoc: "me/family/buffy.md" }] },
    "@brainform/module-finance":  { clientsDir: "clients", feeTolerance: 30 },
    "./modules/catalog":          { owners: ["schlessera", "brightnucleus", "mwpd", "php-composter"] },
  },
});
```

**Effective taxonomy** = core built-ins ⊕ module contributions ⊕ user overrides. Collisions (two owners for one type or dir prefix) are **hard validation errors**.

New `packages/core/src/lib/taxonomy.ts` is the single resolver — `dirForType(type)`, `typeForPath(path)`, `stalenessFor(path)`, `anchorsFor(dir)` — imported by ingestion, auditor, indexer, and validate. `generateBriefing` (`brain-cli.ts:338`) and context-assembler (`:68,:76`) read `taxonomy.canonical.*` instead of literals; **both degrade gracefully (skip section) when a canonical file is unset** — essential for fresh templates.

Type-safety note: `DocumentType` is currently a compile-time union derived from `VALID_TYPES` (`types.ts:6-15`). Config-driven taxonomy replaces it with `string` + runtime zod validation; interfaces in core use `string` and validation happens at config load + document validation.

## 3. Module system

A **module** is an npm package (or local directory referenced by path) whose entry default-exports a manifest via `defineModule()`. No plugin daemon, no lifecycle beyond load-time registration — pure data plus lazy command imports.

```ts
// packages/module-jobs/src/module.ts
export default defineModule({
  name: "jobs",
  taxonomy: {
    types: { opportunity: { dir: "career/opportunities" } },
    classifierHints: { /* … */ },
  },
  skills: "./skills",                          // research-opportunity, interview-scheduled, jobs-review
  commands: { jobs: () => import("./cli") },   // `brain jobs scrape|triage|scaffold|…`
  hygieneChecks: [checkStaleOpportunities],    // (ctx: {db, config, root}) => AuditIssue[]
  indexRules: { dirAnchors: ["status.md"] },
  cron: [{ name: "scrape", schedule: "0 6 * * *", command: "jobs scrape --all" }],  // advisory;
                                               // consumed by container entrypoint + `brain doctor`
  configSchema: z.object({ criteria: z.string(), opportunitiesDir: z.string() }),
});
```

- **Discovery/loading**: the `modules:` keys in brain.config ARE the registry — package name → `import(key + "/module")`; `./local/path` → `import(resolve(root, key, "module.ts"))`. No filesystem scanning. Load order = config order; command bodies lazy-load.
- **CLI integration**: refactor `brain-cli.ts`'s 976-line switch (`:913-961`) into a command registry (`Map<string, {summary, helpBlock, run(ctx)}>`). Core registers search/context/read/list/briefing/add/index/validate/audit/process/archive/accept-mtime/maintain/stats/sync + new setup/doctor/init/import/skills/module/config. Modules register ONE namespaced top-level word each (matches existing `finance`/`jobs` shape). Help text generated from the registry (kills the personal header at `brain-cli.ts:103`). Collision with a core name = load error.
- **Module-contributed MCP tools: deferred to v2.** The 8 `brain_*` tools are content-generic; module workflows are skill-driven and skills call the CLI.
- **Infrastructure providers (embeddings/STT/backends) are NOT module contributions** — modules contribute content-domain things; providers are standalone packages implementing core interfaces (04-extensibility).

### `/new-module` authoring skill (ships in core)

1. Interview: what domain, which types/dirs it owns, which lifecycle moments need skills, whether a CLI command is warranted.
2. Collision-check the effective taxonomy BEFORE scaffolding.
3. Scaffold `modules/<name>/{module.ts, skills/<skill>/SKILL.md, README.md, tests/module.test.ts}` + add the brain.config entry.
4. Quality gates before declaring done: `brain module lint <name>` (new core command — zod-validates manifest, checks skill frontmatter, runs skill lint rules from 04 §2, detects command/type/dir collisions, verifies configSchema parses the user's config block), `brain validate` green, `brain skills sync` picks the skills up, taxonomy roundtrip test (`typeForPath(dirForType(t)+"/x.md") === t`).
5. Write the module README documenting contributed types, index-sync rules, hygiene checks — same doc structure as first-party modules (they are the reference examples).

## 4. Genericizing the three modules (rethink, not find-replace)

**Jobs (`@brainform/module-jobs`)** — from `scripts/jobs/` (13 files, 11 board adapters, own gitignored jobs.db):
- Keyword groups in `score.ts` (AI_STRONG/MODERATE/WEAK, ARCH_TERMS, SENIOR_TITLES, PROTO_TERMS, TECH_TERMS, US_ONLY_MARKERS, EU_MARKERS) → a **weighted criteria definition** sourced from the criteria markdown file's frontmatter (criteria stay brain content — preserves the existing `career/opportunities/search-criteria.md` convention; ship a documented starter template). Score breakdown output keyed by the user's group names.
- Scrape queries + enabled boards → module config. `career/opportunities/…` literals (`cli.ts:115,580,587`) → `dirForType("opportunity")`. jobs.db path from config. playwright becomes a dependency of this package only.
- Ship publicly with scraping-ToS caveats documented; Chrome weight motivates the slim/full Docker discussion (03-brain-ui §2).

**Speaking (`@brainform/module-speaking`)** — 8 skills + taxonomy `talk`, `conference`, `travel`:
- plan-travel's hardcoded "Alain + Carole + Buffy" party → `travelParty[]` config with optional per-member `requirementsDoc`; the assistance-dog checklist generalizes to "traveler requirements docs" (kids, accessibility, visas) — genuinely more useful.
- Conference dir anchors (`status.md`, `itinerary.md`, `outline.md` — currently `indexer:160`) contributed via `indexRules.dirAnchors`. CONFERENCE/TRAVEL classifier regexes (`ingestion.ts:89-90`, includes `wordcamp|cloudfest`) move into module `classifierHints`.
- conference-aftermath currently ends in a LinkedIn post — make the publishing handoff pluggable: "if a content workflow is configured, hand off; else write a plain retro note". Example slugs in skill bodies replaced with fictional ones.
- Travel stays inside speaking for v1 (standalone module = post-v1 open item).

**Finance (`@brainform/module-finance`)** — from `scripts/lib/finance.ts` (540 lines, already the most generic engine):
- `CLIENTS_DIR` (`finance.ts:17`) → `modules.finance.clientsDir`; `FEE_TOLERANCE` (`:27`) → config; Wise/Revolut-era comments (`:52-55`, `:459`) rewritten generic; currency/terms defaults → config.
- Add `brain finance new-client <slug>` scaffolding a ledger.md from a template — the ledger frontmatter conventions currently live only in comments/CLAUDE.md; the template + module README become the spec.
- Contributes type `finance` + a hygiene check "ledger generated block out of date" (reuses existing sync logic in check mode).

**Dispositions**:
- `refresh-catalog.ts` (DEFAULT_OWNERS = Alain's GitHub orgs, `:26-33`) → tiny **local** module in Alain's private repo (`./modules/catalog`), proving the local-module path.
- LinkedIn/content skills (linkedin-post, linkedin-audit, publish-post) + `strategy` type → stay personal overlay for v1; candidate 4th module later.
- use-repo, send-to-tickitoff, etc. → stay personal, demonstrating the overlay mechanism.

## 5. Onboarding CLI primitives (execution layer for the skills in 02)

New core commands, all with `--json`, all added to the integration contract:
- `brain setup` — idempotent: hooksPath config + `skills sync` + bin symlinks (consolidates today's manual steps + package.json setup script).
- `brain init --check` / `brain init --default` — preflight JSON / non-interactive default taxonomy.
- `brain doctor --json` — check battery (02-onboarding §doctor).
- `brain import --stamp <dir>` — mechanical frontmatter stamping for imports.
- `brain module lint <name>`, `brain skills lint`, `brain config check`.

## 6. Testing strategy

- **Fixture corpus** `packages/core/fixtures/corpus/` (~30 files, fictional persona "Alex Example", own brain.config): every core type incl. a `dir: null` case; full wikilink resolution matrix (qualified `[[a/b]]`, unique basename, ambiguous-resolved-by-sibling, unresolved, alias, dir-anchor — mirrors the cases `scripts/tests/wikilinks.test.ts:27-101` exercises on personal files); frontmatter edge cases; a note-inbox item; an archived doc; staleness fixtures with pinned `updated:` dates; a propagation source+derivative pair; canonical identity/current-focus; one tiny PNG and PDF.
- Modules carry their own fixtures: finance (ledgers covering partial payment, fee tolerance, write-off), jobs (seed rows + fixture criteria file so score tests port), speaking (conference tree with status.md/itinerary.md anchors).
- **Layers**: (1) unit tests move with code (chunker/frontmatter/reranker as-is); (2) integration — index the fixture corpus into a temp db → FTS-only golden queries (deterministic, keyless; same pattern as `search-golden.test.ts:8-10`); (3) **contract tests** — assert the `--json` envelope shapes from INTEGRATION.md (search `{results, warnings}`, audit, briefing, index stats, exit codes) against the fixture corpus. The contract becomes executable in core CI.
- **Alain's repo keeps consumer tests**: current personal goldens, wikilink cases, `eval/queries.jsonl` + `eval/run.ts` — re-pointed at the installed package. They double as his pre-upgrade gate: `bun test && bun run eval` before accepting any `@brainform/*` bump.
