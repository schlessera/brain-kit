# 02 — Onboarding: Skill Suite, First-Run Funnel, CLAUDE.md Layering

Status: approved plan · Date: 2026-07-12 · Prereq reading: 00-overview.md, 01-core-architecture.md §5

Principle (from 00): **skills orchestrate, CLI executes.** Skills live in the core package (`packages/core/skills/`) so they update with version bumps; `brain skills sync` distributes them (01 §1).

## 1. `/brain-init` — the interview

CLI support: `brain init --check` (preflight JSON: bun version, git repo, hooksPath, existing brain.config, existing content dirs, key presence) and `brain init --default` (non-interactive default taxonomy — the keyless fallback and the CI smoke path).

**Stage 0 — Preflight.** Run `brain init --check`. If brain.config already exists → switch to **amend mode** (offer: add a domain, regenerate CLAUDE.md sections, re-validate). Never proceed as if fresh.

**Stage 1 — Identity interview.**
1. Name, and what to call the user.
2. "In one or two sentences, what do you do?" (seeds `me/identity.md` AND the later search smoke test)
3. Content language (non-English brains are a real case).
4. Assistant tone/interaction preferences → CLAUDE.md overlay.

**Stage 2 — Domains interview.** Open question first ("What parts of your life should this system track?"), then the module menu with recognizable one-liners: work projects / career & job search / speaking & conferences / clients & freelancing / content & social presence / travel / health / hobbies / home & household / studies. 1–2 follow-ups per selected domain to size the structure (e.g. speaking: "do you track CFP submissions per conference?").

**Stage 3 — Taxonomy proposal.** Present proposed directory tree (literal ASCII block) + type list; iterate until approved. Core types always present: `identity`, `context`, `note`, `index`.

**Stage 4 — Generation.** Writes: `brain.config.ts` (taxonomy, enabled modules, profile, providers); directories with an `_index.md` each (type index, one-line purpose, empty registry table); seeded `me/identity.md`; CLAUDE.md (see §4); `.env` stub from `.env.example` (keys commented); ensures empty sidecar caches exist. One git commit after showing a summary (`brain-init: personalized structure (N domains)`).

**Stage 5 — Validation ladder.** In order, plain-language reporting:
1. `brain index` → doc count ≥ number of generated files
2. `brain validate` → zero errors
3. `brain search "<user's name>" --mode fts --json` → `me/identity.md` in results
4. Offer GEMINI_API_KEY ("optional — enables semantic search; free tier is fine"). If provided: write to `.env`, `brain index --embeddings`, then a **semantic smoke query using a paraphrase of their identity sentence (not literal words)** and show the hit — the "wow" moment.
5. MCP registration: `claude mcp add brain -- bun <path>/mcp-server.ts` (automates what is manual today), verify with an in-session `brain_search` call.

**Stage 6 — Handoff.** Point to `/brain-import` (if they mentioned existing notes in Stage 2 — remember that answer), `/brain-host`; demo one `brain add "…"` capture.

**Idempotency**: amend mode; never overwrite files with user content; regenerable sections are marker-delimited (§4); everything funnels through git commits, so re-run damage is revertable — tell the user so.

## 2. `/brain-doctor`

Backed by `brain doctor --json` → `{ checks: [{id, status: pass|warn|fail, detail, fix?}] }`.

| Check | Detects | Auto-fix |
|---|---|---|
| runtime | bun missing / too old | no (explain install) |
| git-hooks | `core.hooksPath` not set | yes |
| symlinks | `~/.local/bin/brain`, `.claude/skills/*` broken/stale | yes (re-run skills sync) |
| config | brain.config missing/invalid vs schema | no (point to /brain-init) |
| db | brain.db missing, `schema_version` mismatch, stale vs file mtimes | yes (`brain index [--force]`) |
| embeddings | model mismatch / missing coverage / no API key | partial (reindex; key needs user) |
| mcp | brain not registered (`claude mcp list`) | yes |
| deps | node_modules missing / lockfile drift | yes (`bun install`) |
| version | core package vs brain.config compat range | no (explain upgrade) |
| privacy | **git remote exists and is PUBLIC** (`gh repo view --json visibility`) | no — loud warning |

Skill flow: run doctor, group results, explain failures in plain language ("your search index is older than 12 of your files — I'll rebuild it"), apply fixes one at a time with consent, re-run to all-green. The `warnings` array in `search --json` already models degraded modes — doctor reuses those signals. Doctor output doubles as the required bug-report artifact in issue templates (06-launch).

## 3. `/brain-import`

Interview: source type (Obsidian vault / plain markdown folder / Notion export / Apple Notes export), path, approximate volume, copy-or-move.

Staged, mechanical-first:
1. **Bulk copy** into `import/{source-slug}/` preserving the original tree; mechanical frontmatter pass via `brain import --stamp <dir>` (type: note, status: draft, title from H1/filename, created/updated from mtime). Nothing lossy, one commit, fully resumable.
2. **Structure mapping**: propose taxonomy mappings per top-level source folder ("your Obsidian `Work/` → `projects/`"), move wholesale on approval; leftovers stay note-typed — a brain works fine with everything typed `note`.
3. **Optional LLM enrichment** in ~20-file batches (proper type/tags/summary); an import manifest (`.import-manifest.jsonl`, content-hash-keyed like the sidecar caches) records completed files so re-runs skip them.
4. Validate: `brain index && brain validate`, report counts, one search smoke on known content.

Obsidian specifics: `[[wikilinks]]` are already native syntax; ignore `.obsidian/`; flag Dataview/Templater syntax as inert; attachments go through the existing asset pipeline. **Prompt-injection**: imported content is untrusted input read by an LLM during enrichment — the SKILL.md instructs treating file contents as data, never instructions; SECURITY.md documents the residual risk.

## 4. CLAUDE.md generation — layered (recommended)

- **Layer 1 — core agent contract**, shipped in the package (`node_modules/@brainform/core/CONTRACT.md`), never user-edited: frontmatter schema, wiki-link resolution semantics, notes-inbox convention, CLI/MCP surfaces, "never write brain.db directly". Pulled into the user's CLAUDE.md via Claude Code's `@path` import on the first line → infra updates reach every user via version bump with zero CLAUDE.md merges. (For the pi backend, the same contract is emitted into AGENTS.md context — see 04 §3.)
- **Layer 2 — personal overlay**, the user repo's CLAUDE.md: LLM-written by `/brain-init` from the interview, into a fixed skeleton (Quick Navigation table, Key Conventions, Directory Structure block, Personal Rules) whose generated regions are delimited `<!-- brain:generated:{section} -->`. Re-runs of `/brain-init`/`/brain-module` rewrite only marked regions; anything the user adds outside markers is permanent. Alain's current 350-line CLAUDE.md is the reference implementation of Layer 2.

Rejected: pure fill-in-template (personalization too shallow) and fully-LLM-written (structure variance, diff noise, per-user drift of contract rules).

## 5. `/brain-module`

Reads brain.config `modules`; lists available modules with one-liners. Enabling = create dirs + `_index.md` + config entry + regenerate CLAUDE.md marked sections + note that container cron picks it up on next deploy. Disabling flips config off, **never deletes content**. Config is the state → idempotent by construction.

## 6. First-run funnel

**GitHub template repo = primary path**; `bunx create-brainform` deferred post-v1. The public-repo foot-gun is mitigated three ways (documented one-liner, init preflight, doctor privacy check):

```
gh repo create my-brain --template schlessera/brainform-template --private --clone
```

Happy path (zero → working brain, two shell commands and one conversation):
1. Create private repo from template, clone.
2. `bun install` — the `prepare` script runs idempotent `brain setup`.
3. Open the coding agent in the repo — bootstrap CLAUDE.md says "run `/brain-init`".
4. `/brain-init`: interview → structure → validation → MCP → first capture.

**Degradation ladder** (verified against code — see research/brain-repo-analysis.md):

| Tier | Requires | Works |
|---|---|---|
| 0 | nothing (bun only) | FTS search (auto-degrades with warnings), index, validate, audit, `brain briefing` (mechanical, no LLM), `brain add` (heuristic classification), MCP tools degraded |
| 1 | coding-agent auth | all skills incl. `/brain-init`, conversational use |
| 2 | + embeddings API key | vector/hybrid search, asset descriptions, whatsup |
| 3 | + DEEPGRAM_API_KEY (brain-ui) | voice input |

Tier 0 is real for the CLI; the flagship onboarding needs Tier 1 — hence `brain init --default` as the keyless fallback. Template contents: see 01 §1.
