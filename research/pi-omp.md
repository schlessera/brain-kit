# Research: pi framework & oh-my-pi (OMP)

Date: 2026-07-12.

> **2026-07-12 implementation-time verification (live, from 0.80.6 tarballs + GitHub):**
> - Pin all three packages at **0.80.6** (lockstep, published 2026-07-09). Repo now
>   `earendil-works/pi`; maintainers badlogic + mitsuhiko; ~69.7k stars, very active.
> - **pi-ai has NO embeddings API** (chat + image-gen only; "only includes models that
>   support tool calling"). → Open item resolved: EmbeddingProvider built-ins stay
>   hand-rolled (gemini first); pi-ai is a completions-only foundation.
> - pi-ai ~0.80 split its global API onto `@earendil-works/pi-ai/compat`; root now
>   favors `createModels()` + provider factories. Build against the factory API.
> - **No built-in MCP client** in pi-coding-agent (intentional). ui-backend-pi wraps
>   brain tools via `customTools`/`defineTool` (TypeBox schemas) as planned; core's MCP
>   server is for Claude Code / other MCP hosts, not pi.
> - `createAgentSession` options confirmed: `noTools: "all"|"builtin"`, `tools`/
>   `excludeTools`, `customTools`, `resourceLoader`. Overrides (`skillsOverride`,
>   `agentsFilesOverride`, `systemPromptOverride`, …) live on `DefaultResourceLoaderOptions`
>   — construct a `DefaultResourceLoader` and pass it as `resourceLoader`.
> - Skills discovery confirmed: `.agents/skills/` in cwd **and all ancestors to git root**,
>   plus `~/.agents/skills/`, `.pi/skills/`, `~/.pi/agent/skills/`; dirs with SKILL.md;
>   AGENTS.md **and** CLAUDE.md both read as context files.
> - Anthropic subscription-OAuth: earlier hard block resolved; OAuth login works in
>   third-party harnesses BUT bills per-token from "extra usage", NOT against Pro/Max
>   plan limits (providers.md verbatim). → Decision 9 (two backends) unchanged: flat-rate
>   economics still require the Claude Agent SDK backend.
> - SessionManager confirmed: JSONL append-only trees; `list()` then `open(path)`. Question: should brainform build on the pi agent framework instead of the Claude Agent SDK, and is the full OMP fork needed or only subsystems? Conclusion: **build on upstream pi subsystems (no fork); keep Claude Agent SDK as backend #2; OMP optional post-v1.** Decision recorded in plan/00-overview.md (decision 9); architecture in plan/04-extensibility.md.

## Upstream pi (`earendil-works/pi`, formerly `badlogic/pi-mono`)

- Author Mario Zechner (badlogic); MIT; very active (v0.80.6 released 2026-07-09; 243 releases, ~4,900 commits); TypeScript.
- Packages (npm scope `@earendil-works/`):
  - **`pi-ai`** — unified multi-provider LLM API (OpenAI, Anthropic, Google, more; standalone).
  - **`pi-agent-core`** — agent runtime: loop, tool calling, state management.
  - **`pi-coding-agent`** — interactive coding agent CLI **and SDK**.
  - **`pi-tui`** — terminal UI (custom differential renderer, no Ink/blessed).
- Design ethos: minimal (~1,000-token system prompt, 4 built-in tools: read/write/edit/bash), extensions as TypeScript modules (lifecycle events, custom tools, commands).
- **No built-in permission system** (documented) — host process permissions; containerize to sandbox.
- AGENTS.md supported for project rules.

### Upstream SDK surface (verified from `packages/coding-agent/docs/sdk.md`)

- `createAgentSession(options?)` → `{session: AgentSession, extensionsResult, modelFallbackMessage?}`; also `createAgentSessionRuntime()` (newSession/switchSession/fork/importFromJsonl).
- `session.subscribe(event => …)` — event names: `message_update` (with `assistantMessageEvent.type`: `text_delta`, `thinking_delta`), `tool_execution_start/update/end`, `message_start/end`, `agent_start/end`, `turn_start/end`, `queue_update`, `compaction_start/end`, `auto_retry_start/end`.
- **Custom tools**: `customTools` array via `defineTool()` (TypeBox schema + async `execute()`); built-ins controllable via `tools` allowlist / `excludeTools` / `noTools: "all"`. → Host can own the complete tool set; **a permission gate can live inside the host's tool wrappers** (no interception hook exists, and none is needed).
- **No pre-execution tool interception/approval mechanism documented** (events fire during/after execution).
- Sessions: `SessionManager.{inMemory, create(cwd), continueRecent(cwd), open(path), list(cwd), listAll(cwd)}`; JSONL files with tree structure (id/parentId), `navigateTree()`.
- **Skills discovery**: `DefaultResourceLoader` scans `.pi/skills/`, **`.agents/skills/`** (project) and `~/.pi/agent/skills/`, `~/.agents/skills/` (global); `skillsOverride` hook. → brainform's canonical `.agents/skills/` home is natively understood.
- AGENTS.md discovered walking up from cwd; `agentsFilesOverride` hook.
- MCP: not mentioned in the SDK doc (verify in a spike).
- `session.agent` exposes the pi-agent-core `Agent` (direct state access, `waitForIdle()`).

## OMP (`can1357/oh-my-pi`)

- Fork of pi by Can Bölük, substantially rewritten. MIT (© Zechner 2025, © Bölük 2025–2026). ~17.3k stars, ~13k commits, 520 releases, latest v16.4.5 July 2026 — **monthly-major cadence**. Contribution requires vouching.
- Scope: 32 built-in tools (files incl. `ast_edit`, bash/eval/ssh/browser, LSP + DAP debugging, task/irc/todo/job/ask, GitHub, web_search across 25 backends, image gen); hash-anchored edits ("hashline" — patches reference content hashes, not line numbers); persistent Python/JS eval kernels; headless-Chromium browser automation; subagents with workspace isolation + IRC coordination; time-traveling stream rules; advisor mode (second model watches turns); collaborative sessions with client-side encryption; "Hindsight" agent-curated cross-session memory; ~55k lines of Rust core (search, shell, AST via tree-sitter, PTY, image decode in-process).
- Monorepo: 13 packages (`@oh-my-pi/` — pi-ai fork, pi-agent-core, pi-coding-agent SDK, pi-tui, pi-natives, catalog, utils, wire, hashline, mnemopi, snapcompact, swarm-extension, collab-web) + 6 Rust crates. Packages are published but **version-locked to the fork's fast release train**.
- Embedding: Node SDK (`@oh-my-pi/pi-coding-agent`: ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage, typed events); **RPC mode** (`--mode rpc`, NDJSON over stdio); **RPC-UI** (`--mode rpc-ui`, tool cards/selectors/dialogs as `extension_ui_request` frames the host must answer); **ACP** (`omp acp`, Agent Client Protocol for editors).
- Extension API (verified from docs/extensions.md): `pi.on(event, handler)` with tool lifecycle `tool_call` (**pre-exec, may block: return `{block: true, reason}`**), `tool_result` (patchable), `tool_execution_*`, `tool_approval_requested/resolved`, plus full session/turn/message/compaction event set; `ctx.ui` dialogs (select/confirm/input/editor) + notify/setStatus/setWidget.
- Config interop: reads `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, `.vscode` — rules, skills, MCP servers transfer automatically. Destructive tools pause for permission prompts (answer-once).
- Providers: 50+ (Anthropic, OpenAI direct + Codex, Google, xAI, Mistral, Groq, Fireworks, Together, HF, NVIDIA, OpenRouter, coding-plan routers: Cursor/Copilot/GitLab Duo/Kimi/MiniMax/Qwen/Alibaba; local: Ollama, LM Studio, llama.cpp, vLLM). Mid-session `/model` switch.
- `pi.dev` — package registry for pi extensions/themes/skills (e.g. `pi-claude-auth`, `@ayulab/oh-my-pi` reliability bundle — note: a different project than can1357's OMP, same name).

## The decisive auth constraint

Since **2026-04-04, Anthropic disallows third-party agents from using Claude Pro/Max subscription OAuth for inference**. Claude models through pi/OMP are billed at API rates (or as "extra usage" per-token), not against plan limits; Anthropic's docs state OAuth for Free/Pro/Max is for Claude Code and Anthropic's native apps only. Community workarounds (proxy projects like meridian, pi-anthropic-oauth extensions) exist but violate ToS — not something brainform can build on. Upstream issue: earendil-works/pi #3372 ("pi can apparently no longer work with Claude subscription").

**Consequence**: flat-rate Claude economics (Max $100–200/mo) require the Claude Agent SDK path; provider freedom (any API key, OpenRouter, $0 local models) requires the pi path. → Two backends behind one seam, both first-class.

## Decision rationale (answers to the two user questions)

**"Is pi a better agent SDK to build everything else off of?"** — Yes for the foundation layer, with the two-backend nuance: pi-ai gives provider-agnostic completions (the literal "survive shakeups" requirement); the upstream pi SDK gives a minimal, controllable agent loop where brainform owns the tool surface. But dropping the Claude backend would forfeit subscription economics and Claude-specific strengths (auto-loaded CLAUDE.md/skills/MCP maturity), so it stays as backend #2 (and Alain's daily driver → both dogfooded).

**"Is the full OMP needed? Are subsystems usable without the fork?"** — Full OMP is NOT needed:
- Completions seam needs only standalone `@earendil-works/pi-ai` (upstream).
- The brain-ui backend needs only the upstream `pi-coding-agent` SDK: `createAgentSession` + `defineTool()` + built-ins disabled → curated ~8-tool surface with the permission gate inside our tool wrappers (structurally cleaner than OMP's block-hook or Claude's canUseTool) — and a knowledge-base agent doesn't want 32 coding tools (smaller attack surface, better SECURITY.md story).
- `.agents/skills/` is discovered natively by upstream — no fork needed for skills.
- OMP subsystems are published packages but ride the fork's v16 monthly-major train — fine to cherry-pick *ideas* (hashline) or add an optional `ui-backend-omp` adapter post-v1 (its RPC/SDK + block-hook make that straightforward), wrong to build the foundation on.
- AgentRunner (core CLI shell-outs) can invoke `omp` as a config value with zero library coupling.

## Risks

- Upstream pi and OMP are both effectively single-maintainer. Mitigation: brainform's own thin `AgentBackend`/`CompletionProvider` interfaces, version pinning, the Claude backend as a maintained alternative; worst case the pi backend re-targets `pi-agent-core` or another runtime with the interface unchanged.
- Upstream SDK gaps to confirm in a phase-5 spike: attachment/image input path, MCP client support, cost/usage reporting (backend capability flags degrade gracefully if absent).

## Sources

- Upstream pi repo: https://github.com/badlogic/pi-mono (redirects to https://github.com/earendil-works/pi)
- Upstream SDK docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Upstream providers/extensions docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md , https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- OMP repo: https://github.com/can1357/oh-my-pi (releases: https://github.com/can1357/oh-my-pi/releases)
- OMP SDK doc: https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md
- OMP extensions doc: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- pi.dev registry: https://pi.dev (e.g. https://pi.dev/packages/pi-claude-auth)
- Claude-subscription restriction discussion: https://github.com/earendil-works/pi/issues/3372
- Third-party OAuth-bridge projects (ToS-problematic, listed for awareness only): https://github.com/rynfar/meridian , https://github.com/leohenon/pi-anthropic-oauth
- Ecosystem color: https://akitaonrails.com/en/2026/05/25/first-impressions-using-oh-my-pi-and-opencode/ , https://medium.com/@joe.njenga/i-tried-oh-my-pi-free-claude-code-alternative-that-just-exploded-50-providers-114227324b53 , https://www.alexdunlop.com/writing/pi-vs-claude-code-which-ai-coding-agent-in-2026
- Note: `@mariozechner/pi-coding-agent` (npm) is the older package name; `@earendil-works/*` is current. `@ayulab/oh-my-pi` on pi.dev is an unrelated same-named extension bundle.
