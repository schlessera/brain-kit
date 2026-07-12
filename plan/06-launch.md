# 06 — Launch: Docs, Versioning, CI, Community, Publishing Checklist

Status: approved plan · Date: 2026-07-12 · Prereq reading: 00-overview.md

## Docs architecture

Docs live in the core repo (`docs/`), versioned with the code; template README = thin quickstart linking to core docs at the pinned version; brain-ui keeps its own README + docs (it versions independently against the integration contract).

- **README positioning**: "A private, file-first knowledge base your AI agent actually operates — not a note app with an AI plugin." Differentiators to state explicitly: (1) markdown as source of truth with a disposable, regenerable index (genuinely distinct property — also the upgrade story); (2) one versioned contract across CLI + hybrid search + MCP + skills + optional chat UI (INTEGRATION.md); (3) onboarding that builds *your* taxonomy instead of shipping one; (4) provider-agnostic by architecture (04-extensibility). Honest contrast with Obsidian+plugins (editor-centric, plugin patchwork) and LLM-wiki experiments (no maintenance loop: validate/audit/briefing/hygiene). Include the explicit NOT-pluggable list (04 §8).
- Structure: `docs/quickstart.md`, `docs/concepts.md` (frontmatter schema, types, `_index` convention, wiki-links, notes inbox), `docs/cli.md`, `docs/mcp.md`, `docs/hosting/` (self-host guide + Hetzner/fly.io/Tailscale variants + cost table), `docs/modules/*.md`, `docs/extending/` (one page per seam: interface, built-ins, 3-step how-to, capability matrix), INTEGRATION.md successor promoted to the public compatibility contract.

## SECURITY.md (both repos; brain-ui's is the critical one)

Threat model in plain words:
1. This system grants an LLM read access to everything you put in it, and write access to the repo.
2. Prompt injection via ingested/imported/scraped content can steer the agent — mitigations (untrusted-content framing in skills, tool permission gating, container isolation) and residual risk stated honestly.
3. brain-ui is a remote surface to an agent that can run Bash in a container holding your data and tokens — auth is mandatory; `AUTH_MODE=none` refuses production (03 §1).
4. Keep the content repo private; `brain doctor` checks remote visibility.
5. Key handling and what each key can spend.
6. Encryption modes and exactly what each does/doesn't protect (03 §3) — including that true E2E is incompatible with a server-side agent.

## Versioning & release discipline

- One semver for `@brainform/*` (lockstep) covering CLI + skills + db schema + MCP together: `schema_version` bump or contract-breaking change = major; new module/tool/skill = minor; fixes = patch. Tooling: changesets.
- `CONTRACT:` commit-prefix convention (already exists in INTEGRATION.md) kept and documented.
- Extension interfaces marked `@experimental` until 1.0 (04 §0).
- Because brain.db is fully derived, "db migration" is usually `brain index --force` — document regenerability as the upgrade story.
- CHANGELOG.md, keep-a-changelog format.

## CI

- **core**: `tsc --noEmit`; `bun test` (unit + fixture-corpus integration + contract tests); keyless e2e — scaffold a synthetic brain from the template fixture → `brain init --default` → `index` → FTS search assert → `validate` → `doctor` all-green (exercises the entire Tier-0 funnel); **leakage grep gate** (`alain|schlesser|carole|buffy|wyvern|<client names>`).
- **template**: instantiate + `bun install` + `brain doctor --json` green.
- **brain-ui**: typecheck, unit tests, `docker build`, live contract test against pinned `@brainform/core`, backend contract test against BOTH backends (04 §3), one smoke test per Claude inference-profile type.

## Community surface (lean — solo maintainer)

- MIT license both repos (user content in their own repos is theirs; template ships no license-encumbered content).
- Issue templates: bug (requires pasted `brain doctor --json` output — doctor doubles as the support tool), feature request; pinned "maintained by one person" note. GitHub Discussions on; no Discord at launch.
- CONTRIBUTING.md: how to run tests, contract-change rules, the seam contributor how-to (04 §0), solo-maintainer expectations, OMP-style vouching not needed at this scale.

## Publishing checklist (final sweep before any repo goes public)

**Fresh-history repos for everything public. No filtered forks.** The private `schlessera/brain` stays private forever. Public repos' initial commit = the already-scrubbed tree ("audit one tree" instead of "audit all history").

1. Rotate the Deepgram key in brain-ui working-tree `.env` (phase 0 — done early).
2. `docs/DEPLOYMENT.md` → generic `docs/hosting/`; personal infra (VPS IP 91.99.200.114, Coolify URL/UUID, tailnet) → private brain `infrastructure/`.
3. `client/src/lib/backend.ts` comments (`brain.schlesser.net`, tailnet hostname) — rewritten with same-origin change.
4. `server/src/app.ts:32` CORS domain → `ALLOWED_ORIGINS`.
5. `Dockerfile:40` LABEL; `docker-compose.prod.yml` `BRAIN_REPO_URL` default (`schlessera/brain.git`).
6. `.env.example` line-by-line re-read; genericize GIT_USER_NAME + tailnet examples.
7. Test fixtures + `scripts/eval/queries.jsonl` (personal queries: names, hotels, routers) → synthetic fixture corpus only in public repos; personal eval stays in the private brain.
8. Template `.gitignore` derived from current one minus personal entries (dsa-prep, ccmux, talk-deck paths — documented as "examples of local extensions").
9. Sidecar caches ship EMPTY in the template (`.context-cache.jsonl` currently 822 KB of content descriptions in the private repo — never copied).
10. `jobs.db`, `brain.db` never copied (gitignored anyway).
11. Client PWA manifest name/icons, page titles.
12. Personal skills (linkedin-*, conference variants, use-repo, send-to-tickitoff, jobs-review personal config) stay in the private brain's `.agents/skills/` overlay.
13. Final gate: leakage grep across both public trees + one manual read of every file under 200 lines in template + docs.

## Launch order

1. Tag `@brainform/*` 0.1.0 (npm scope claimed in phase 0).
2. Publish core monorepo + template (template pins 0.1.0).
3. Publish brain-ui public repo.
4. Alain's brain merge (phase 4 gate) — dogfood proof.
5. Announce (positioning per README; honest scope: early, `@experimental` seams, solo-maintained).
