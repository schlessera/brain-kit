# Research: Prior Art, Distribution Models, Naming

Date: 2026-07-12.

## Prior-art landscape ("AI second brain" starters)

Several projects occupy adjacent space; none combine brainform's integrated stack (CLI + SQLite FTS5+vector hybrid search + MCP + skills + maintenance loop + self-hosted chat UI):

- https://github.com/ar9av/obsidian-wiki — framework for agents maintaining an Obsidian wiki (Karpathy "LLM Wiki" pattern).
- https://github.com/jamesmcroft/obsidian-ai-second-brain — starter template: Obsidian + CODE/PARA + AI skills.
- https://github.com/NicholasSpisak/second-brain — LLM-maintained Obsidian KB; **has a setup wizard** (naming, location, domain, tooling → installs skills) — validates the wizard-as-onboarding pattern.
- https://github.com/eugeniughelbur/obsidian-second-brain — cross-CLI skill (Claude Code/Codex/Gemini/OpenCode…), 44 commands, hybrid semantic search, scheduled agents.
- https://github.com/charlie947/ai-second-brain — Claude Code skill building a KB from chat/research history.
- https://github.com/ddmanyes/second-brain-mcp — MCP + DuckDB KB.
- https://github.com/AgriciDaniel/claude-obsidian — self-organizing Obsidian second brain for Claude Code.
- https://github.com/flepied/second-brain-agent — earlier LangChain-era approach.
- Topic pages: https://github.com/topics/second-brain , https://github.com/topics/personal-knowledge-management , https://github.com/topics/ai-second-brain
- https://github.com/tabbykatz/claude-knowledge-base , https://github.com/whoabuddy/claude-knowledge — dev-knowledge capture for Claude Code.
- Writeups: https://www.joekarlsson.com/blog/my-personal-claude-code-skills-repo-accidentally-became-internal-tooling/ , https://louiswang524.github.io/blog/llm-knowledge-base/

Differentiators to claim in the README (see plan/06-launch.md): markdown source of truth with a disposable regenerable index; one versioned contract across CLI/search/MCP/skills/UI; onboarding that builds *your* taxonomy; maintenance loop (validate/audit/briefing/hygiene); provider-agnostic seams.

## Distribution-model research (template vs package)

- GitHub template repos have no upstream relationship — divergence is unmanaged; sync workflows and manual merges are the known workarounds and they hurt once user content diverges. Sources: https://www.sharetribe.com/developer-blog/template-upstream-updates/ , https://github.com/orgs/community/discussions/23528 , https://github.com/orgs/community/discussions/168227 , https://www.mslinn.com/git/700-propagating-git-template-changes.html , https://medium.com/geekculture/how-to-use-git-to-downstream-changes-from-a-template-9f0de9347cc2
- Scaffolder CLIs (create-*) vs batteries-included templates tradeoff: https://dev.to/ke_jia_24bb2f9f84f14f728a/scaffoldx-vs-vite-vs-create-react-app-which-project-scaffolder-is-right-for-you-in-2026-4bfk
- Dotfiles ecosystem (install-script + symlink patterns that inspired `brain setup`/`skills sync`): https://dotfiles.github.io/ , https://github.com/anishathalye/dotfiles_template , https://www.atlassian.com/git/tutorials/dotfiles

→ Confirmed choice: **core package + thin template**; infra updates via version bump; template divergence limited to content + config (plan/00-overview decision 1).

## Naming (checked 2026-07-12 via npm registry / GitHub API)

User direction: "formative"-derived. Final pick: **brainform**.

- `brainform`: npm bare name FREE (404), `@brainform/core` unpublished (404), GitHub `schlessera/brainform` free (404). Claim npm scope + name in phase 0.
- Checked and taken (npm 200): formative, formant, formata, formativ, formwork, exoform, mneme, mnemon, noema, noesis, informe, neuroform, forme, formable, formeta, eidos, morphe, informary, noos, nous, noosphere, informant, formatik.
- Checked and free (npm 404) but not chosen: formind, mindform, knowform, formary, formatia, formaton, noosfera, eidoform, formos, formacore, formative-kb, formative-brain, formata-kb, reformative.
- Rejected earlier candidates: engram / exocortex / hippocamp (user preference moved to formative-family).

Note: npm scope ownership can only be conclusively verified authenticated at publish time; unpublished `@brainform/core` (404) is a strong but not certain signal. Fallback chain if scope is blocked: `@schlessera/brainform-*` or bare `brainform` package.
