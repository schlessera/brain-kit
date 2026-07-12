# 04 — Extensibility: Seams, Interfaces, the pi Decision

Status: approved plan · Date: 2026-07-12 · Prereq reading: 00-overview.md (decisions 8–9), research/pi-omp.md, research/brain-ui-analysis.md

Guiding rule: **a seam is only introduced where a second implementation is plausibly wanted within a year** (embeddings, completions, agent runner, agent SDK backend, STT, tool renderers, skill emitters). Everywhere else concrete code stays concrete. See §8 for the explicit not-pluggable list.

## 0. The meta-mechanism (one pattern for every seam)

*Typed interface in a core package → config accepts a built-in name (string) OR a passed-in implementation (value) → optional npm package to share it.* No plugin loader, no DI container, no runtime discovery.

Interface homes:
- `@brainform/core` — `EmbeddingProvider`, `CompletionProvider`, `AgentRunner`, `SkillEmitter`, module manifest types.
- `@brainform/ui-sdk` — `/server`: `AgentBackend`, `SpeechProvider`, wire-protocol re-export; `/client`: `ToolRenderer`, `AsrClient`.

```ts
// brain.config.ts — the dual convention IS the mechanism
import { ollamaEmbeddings } from "brainform-embeddings-ollama"; // 3rd-party pkg

export default defineConfig({
  embeddings: { provider: "gemini" },                                  // built-in: string
  // embeddings: { provider: ollamaEmbeddings({ model: "nomic-embed-text" }) }, // custom: value
  completions: { provider: "gemini-flash", fallback: "anthropic-haiku" },
  agentRunner: "claude",
});
```

Strings resolve against a static registry compiled into core (plain `Record<string, factory>`). Values are used as-is. Third parties never touch the registry — they export a factory the user imports. Graduating a community provider to built-in = one PR.

**Contributor story (≤3 steps)**: (1) implement via typed helper — `export const myThing = defineEmbeddingProvider({id, dimensions, embed, embedQuery, …})`; (2) reference it in config — it works; (3) optionally publish as `brainform-<kind>-<vendor>`.

**Capability discovery/degradation**: every interface carries a `capabilities` object + optional methods; core degrades and reports through the existing warnings envelope (`brain search --json` already returns `{results, warnings}` flagging "no vectors / model mismatch / missing key" — `INTEGRATION.md:27-31`, `search-engine.ts:350`).

**Versioning**: "Extension interfaces" section in the INTEGRATION.md successor; breaking interface changes = `CONTRACT:` commit + major bump; all seams `@experimental` until a second real implementation lands (the Codex skill-emitter, ui-backend-pi vs ui-backend-claude, and one non-Gemini embedder are the proving grounds — see 00-overview verification).

## 1. Core LLM seams — two, not one, not three

Verified coupling: `EmbeddingProvider` (`types.ts:112-125`) bundles embeddings with *generation* (`describeAsset`, `generateChunkContext`); the contextual-retrieval and asset-description prompts live inside the Gemini provider (`embedder.ts:189,282-287`). `agent-commands.ts:25` hardcodes `claude --print`. `whatsup.ts:99-235` has four inline backends behind flags. The three call shapes collapse into (a) plain completion and (b) agentic run in a repo.

```ts
// @brainform/core
export interface CompletionProvider {
  id: string;
  capabilities: { vision: boolean };
  complete(req: { system?: string; prompt: string;
                  parts?: ContentPart[]; maxTokens?: number }): Promise<string>;
}

export interface AgentRunner {
  id: string;                                  // "claude" | "pi" | "codex" | "gemini" | custom (e.g. "omp")
  capabilities: { streaming: boolean; skills: boolean };
  run(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<string>;
  runStreaming?(prompt: string, opts: { cwd: string;
    onEvent: (e: { kind: "tool" | "text"; label: string }) => void }): Promise<string>;
}

export interface EmbeddingProvider {           // trimmed
  id: string;                                  // e.g. "gemini:gemini-embedding-2"
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  embedImage?(buffer: Buffer, mimeType: string, description: string): Promise<Float32Array>;  // optional multimodal
  embedPdf?(buffer: Buffer, description: string): Promise<Float32Array>;
}
```

Decisions:
- **Split enrichment out of EmbeddingProvider**: `describeAsset`/`generateChunkContext` move into `core/enrichment.ts`, which owns the prompts (product logic, not per-provider) and calls the configured CompletionProvider. Providers without vision degrade to title-only asset descriptions (fallback already exists, `embedder.ts:197`); providers without `embedImage` degrade to embedding the text description.
- **CompletionProvider default implementation backed by upstream `@earendil-works/pi-ai`** — a standalone package (no fork, no CLI dependency) giving multi-provider completions (Anthropic/OpenAI/Google/OpenRouter/local) selected by model string; our thin interface remains as insurance against pi-ai itself. Embeddings: verify pi-ai embedding support at implementation time; if absent keep dedicated EmbeddingProvider impls (gemini built-in #1; contributor path for openai/ollama).
- **AgentRunner** built-ins are plain CLI shell-outs (claude/pi/codex/gemini; `omp` works as a config value) for skill-invoking flows (`smartAdd`, `brainSync`). `processNote`/`auditFix` are text-in/JSON-out — migrate them to CompletionProvider (cheaper, no CLI dep), keep `--agent` as override. whatsup's inline backends → configured CompletionProvider + `--agent <runner-id>` (old flags kept as aliases).
- **Reindex on provider change**: indexer compares `provider.id` + `dimensions` against `index_metadata` (`embedding_model`/`embedding_dimensions` already persisted — `indexer:750`, `db.ts:145`); mismatch → drop/recreate `vec_chunks` and require explicit `brain index --embeddings --force` with a printed cost warning. Never silently re-embed. Context/asset sidecar caches are content-hash-keyed and survive provider switches.

## 2. Skills agnosticism — canonical home + emitters + lint (no abstraction)

`.agents/skills/<name>/SKILL.md` stays canonical. **Upstream pi discovers `.agents/skills/` natively** (its `DefaultResourceLoader` scans `.agents/skills/` and `.pi/skills/`) and **OMP auto-reads `.claude` dirs** — the pi family needs zero emitters. `brain skills sync` runs an ordered emitter list for the rest:

```ts
export interface SkillEmitter {
  agent: string;                                // "claude" | "codex" | "gemini" | "opencode"
  emit(skills: SkillManifest[], repoRoot: string): { written: string[]; removed: string[] };
}
```

Built-ins: **claude** (symlink into `.claude/skills/` — today's sync-skills behavior verbatim, incl. Windows junction fallback); **codex** (`.codex/prompts/<name>.md` with Claude-specific frontmatter keys stripped + a fenced machine-managed "Skills index" block in AGENTS.md); **gemini/opencode** (same index-block strategy into GEMINI.md / `.opencode/command/`). Emitters are ~40 lines each — this is the contributor path.

**Skill lint rules** (in `brain skills lint`, folded into `module lint`) instead of a skill abstraction — verified baseline: all 22 existing skills have `name`+`description`; only 3 have Claude-only body references:

| Rule | Severity |
|---|---|
| Frontmatter has `name` + `description`; `name` matches directory | error |
| Body references Claude-only tools (AskUserQuestion, TodoWrite, Task(, EnterPlanMode) | error, unless inside a `<!-- agent:claude -->` fenced section |
| "Claude" as the acting agent ("Claude should…") — suggest "the agent" | warning |
| Shell commands must be `brain …` or declared in a `requires:` frontmatter list | warning |
| `allowed-tools` / `disable-model-invocation` present | info ("claude-specific, ignored elsewhere") |
| Absolute paths in body | warning |

## 3. brain-ui `AgentBackend` — promotion, not invention; two built-in backends

Verified: the wire protocol (`shared/protocol.ts`) is already ~90% agent-neutral — `text_delta`, `thinking_delta`, `tool_use_start/input_delta/complete`, `tool_result`, `tool_approval_request`, `result` (cost/turns), `error`, `status`, `session_info`, `session_history`, neutral `MessagePart`. Claude-shaped residue: `ProviderInfo.provider` union (`protocol.ts:210`) and an AskUser doc-comment (`:386` — the shape itself is generic). SDK→protocol translation is already isolated in `server/src/claude/stream-adapter.ts`. **The wire protocol stays the contract every backend targets — it is NOT pluggable.**

```ts
// @brainform/ui-sdk/server
export interface AgentBackend {
  id: string;                                    // "pi" | "claude" | future
  capabilities: { resume: boolean; permissions: boolean; thinking: boolean;
                  attachments: boolean; askUser: boolean; costReporting: boolean };
  listProfiles(): ProviderInfo[];                // model/provider profiles (§6)
  startTurn(req: { prompt: string; attachments?: ChatImageAttachment[];
                   sessionId?: string; profileId?: string;
                   signal: AbortSignal; bridge: BackendBridge }): Promise<void>;
  listSessions(): Promise<ChatSession[]>;
  getHistory(sessionId: string): Promise<SessionHistoryMessage[]>;
  cancel(): void;
}

export interface BackendBridge {                 // backend → server plumbing
  emit(msg: ServerMessage): void;                // the existing protocol IS the event stream
  requestPermission(toolUseId: string, toolName: string,
    input: Record<string, unknown>, description?: string):
    Promise<{ behavior: "allow"; updatedInput?: object } | { behavior: "deny"; message: string }>;
  askUser?(questions: AskUserQuestion[]): Promise<AskUserResponse>;
  getLocation?(opts?: GeoRequestOptions): Promise<LocationResult>;
}
```

`ws/handler.ts` keeps everything it does today (pending-approval maps, attachment validation, broadcast, chunked history) but calls `backend.startTurn` instead of `runClaudeQuery` and `backend.getHistory` instead of its inline `buildSessionHistory`.

### `ui-backend-pi` (OSS default — purpose-built on upstream pi, NOT the OMP fork)

- `createAgentSession` from `@earendil-works/pi-coding-agent` with built-ins disabled (`noTools`/`excludeTools`) and a **curated brain tool set** via `defineTool()`: read/write/edit/bash/grep scoped to the brain repo + native `brain_search`/`brain_context`/`brain_add` wrappers.
- **Permission gating lives inside our tool wrappers** — each `execute()` awaits `bridge.requestPermission()` according to its risk class. No interception mechanism needed (upstream has none); structurally cleaner than both OMP's block-hook and Claude's canUseTool bridge. The small tool surface is also the better SECURITY.md story for a knowledge-base agent.
- Events map ~1:1: `message_update` (`text_delta`/`thinking_delta`), `tool_execution_start/update/end` → protocol messages. `SessionManager` JSONL (list/open/fork) = history.
- Skills: `.agents/skills/` discovered natively. Agent context: AGENTS.md generated from the CLAUDE.md Layer-1 contract (02 §4).
- Providers: pi-ai model list via `listProfiles()` — API keys or local models; the shakeup-proof path.
- Phase-5 spike items: attachment/image input path, MCP client support, cost/usage reporting (capability flags degrade if absent).

### `ui-backend-claude`

Extraction of `server/src/claude/` — session.ts + stream-adapter.ts unchanged inside the package; `buildSessionHistory` (`ws/handler.ts:512-650`) moves in as `getHistory`. The Claude Max/Pro flat-rate path (subscription OAuth is Claude-Code-only per Anthropic policy since 2026-04). Alain's deployment keeps this backend → **both backends get dogfooded** (his = claude, OSS default = pi).

### Shared decisions

- **History: the backend owns raw transcripts; brain-ui normalizes at read time.** No brain-ui-owned normalized store (second source of truth, write-sync bugs). brain-ui keeps its lightweight `sessions` metadata table (title, cost aggregate, provider pin) and gains a `backend_id` column NOW to avoid a later migration. `ui-sdk` ships an optional `createTranscriptStore()` JSONL helper so persistence-less backends (a plain API tool-loop) get list/history in ~10 lines.
- **One active backend per deployment in v1**; per-session switching deferred (cross-backend resume semantics).
- Protocol cleanups: `ProviderInfo.provider` union → `vendor?: string` (icon hint); AskUser doc-comment neutralized.
- Backend contract test (runs against BOTH backends in CI): start turn → tool-approval round-trip → history fetch.

## 4. Tool-renderer registry (client)

Verified: `tool-views.tsx` dispatches on Claude tool names (icon map `:84-98`, summary switch `:117-166`, input `:228-250`, output `:585-606`) but graceful fallbacks already exist (`KeyValueView:548`, `ClampedPre:613`, MCP name demangling `:108-114`); consumed only via `tool-call-timeline.tsx` against the neutral `ToolCall` store type.

```ts
// @brainform/ui-sdk/client
export interface ToolRenderer {
  match: string | ((tool: ToolCall, backendId: string) => number);  // name, prefix, or scored predicate
  icon?: LucideIcon;
  summary?(tool: ToolCall): string | null;
  meta?(tool: ToolCall): string | null;
  Input?: React.FC<{ tool: ToolCall }>;
  Output?: React.FC<{ tool: ToolCall }>;
}
export function registerToolRenderers(pack: { backend?: string; renderers: ToolRenderer[] }): void;
```

Resolution: backend-scoped exact → global exact → **shape-sniffing capability fallbacks** → generic. The fallback tier is where "unknown tools render decently" lives, and it is mostly extraction of existing code: diff view on `{old_string,new_string}`/unified-diff (reuse `computeDiffRows:364`), file view on `{file_path|path, content}`, terminal on `{command|cmd}` (reuse `BashCommandView`), file-rows on `path:line:` output (reuse `splitGrepRow:730`), markdown when prosey, JSON tree/key-value otherwise.

Registration is **build-time**: `client/src/renderers/index.ts` imports packs (`claude-tools` = today's switch bodies, `pi-tools` for the curated pi set, `generic` = fallbacks); a contributor adds one import line, `React.lazy` for heavy packs. Runtime plugin loading in a compiled PWA = explicitly rejected over-abstraction. Renderer priority rules need tests (name collisions across backends, e.g. `bash` vs `Bash`).

## 5. STT seam

Verified: `voice/keyterm-builder.ts` is already provider-agnostic (reads brain.db, emits generic keyterms); `asr-deepgram.ts` hardcodes the Deepgram WS URL/params but its surface (`start/stop/drainAndStop`, `AsrEvent`) is neutral and `AsrEvent` lives in the shared protocol (`protocol.ts:295-301`).

```ts
// @brainform/ui-sdk/server
export interface SpeechProvider {
  id: string;
  capabilities: { streaming: boolean; interimResults: boolean; keyterms: boolean; endpointing: boolean };
  createSession(opts: { keyterms: string[] }): Promise<{
    url: string;                 // wss endpoint the client connects to
    token?: string;              // omitted for local/browser providers
    params?: Record<string, string>;
    expiresAt: number;
  }>;
}
// @brainform/ui-sdk/client — AsrClient = DeepgramClient's existing surface with url/params injected
```

`POST /voice/session` (replaces `/voice/token`) returns `{providerId, url, token, params, capabilities}`; client picks the matching `AsrClient` factory from a small registry. Built-ins: `deepgram` (today's class, URL/params injected), `webspeech` (no server session; browser SpeechRecognition; `interimResults: true`, `keyterms: false`). whisper.cpp = a server-side provider whose `url` points at the brain-ui server, which proxies WS to the local whisper process (keeps it off the public network). Degradation is UI-level: no interim → skip live partials; no endpointing → manual Done button; no keyterms → skip fetch. Keyterm-builder + pronunciation overrides stay shared infrastructure — inputs, not provider logic.

## 6. Inference profiles = a Claude-backend detail, not a top-level seam

Verified: `server/src/claude/providers.ts` hardcodes five configs that work by env-var remapping of the Claude Code process (`ANTHROPIC_BASE_URL`/`AUTH_TOKEN`, `:15-42`), injected in `session.ts:134,161-163`.

- Rename `ProviderConfig` → `InferenceProfile`, move inside `ui-backend-claude`, make the list config-driven (`agent.claude.profiles: [{id, label, model, baseUrl?, apiKeyEnv?}]`) — arbitrary Anthropic-compatible endpoints without code changes. Availability = declared `requiredEnvKeys`.
- The generic layer sees only `backend.listProfiles(): ProviderInfo[]` and passes an opaque `profileId` into `startTurn` — exactly how `providerId` already flows through the protocol. The pi backend lists pi-ai models the same way.
- Risk: env-remap depends on undocumented Claude Code behavior — pin SDK versions, one smoke test per profile type in CI.

## 7. Migration deltas (rough, per existing file)

| Area | Change |
|---|---|
| `scripts/lib/types.ts:112-125` | Trim EmbeddingProvider; add `id`; optional multimodal methods |
| `scripts/lib/embedder.ts` | → `core/providers/embeddings/gemini.ts`; prompts (`:189,282-287`) → `core/enrichment.ts`; retry/backoff (`:37-73`) → `core/llm-util.ts` |
| `scripts/lib/models.ts` | Defaults only; overridable per provider config |
| `scripts/lib/incremental-indexer.ts:750,776,960,996-1091` | Provider from resolved config; enrichment calls; dimension-mismatch → forced vec rebuild path |
| `scripts/lib/agent-commands.ts:25-122` | `callClaude*` → AgentRunner registry; processNote/auditFix → CompletionProvider |
| `scripts/whatsup.ts:99-235` | Inline backends → CompletionProvider + `--agent`; old flags aliased |
| `scripts/hooks/sync-skills` | Logic → `brain skills sync` + emitters; hook = thin caller |
| `server/src/claude/*` | → `packages/ui-backend-claude`; `buildSessionHistory` moves in |
| `server/src/ws/handler.ts` | Swaps `runClaudeQuery` → `backend.startTurn`; sessions table + `backend_id` |
| `server/src/routes/sessions.ts`, `providers.ts` | Delegate to `backend.listSessions()` / `listProfiles()` |
| `shared/protocol.ts:210,386` | Provider union → `vendor?`; AskUser comment neutralized |
| `client/.../tool-views.tsx` | Split into registry + packs (claude-tools / pi-tools / generic) |
| `server/src/voice/*`, `routes/voice.ts` | `/voice/token` → `/voice/session`; Deepgram = built-in SpeechProvider |

## 8. Explicitly NOT pluggable (state verbatim in README/CONTRIBUTING)

- SQLite + FTS5 + sqlite-vec as the index engine, and brain.db's schema. No StorageProvider, no Postgres/pgvector surface.
- Markdown files + git as the source of truth, including the frontmatter model — modules may extend taxonomy values, but the file-first model is fixed.
- The chunking strategy and hybrid-search ranking pipeline (fusion weights, heuristic reranker). Tunable constants, not interfaces.
- The wire protocol (`shared/protocol.ts`) — it is the contract every backend targets.
- Bun + Hono server, React PWA client — no framework adapters.
- The `brain` CLI surface and MCP tool names (contract-stable per INTEGRATION.md).

## 9. Risks

1. Non-pi/non-Claude backends feel second-class (Claude uniquely auto-loads CLAUDE.md/skills/MCP; pi loads `.agents/skills`/AGENTS.md) — publish a capability matrix; accept backends #1/#2 are richest.
2. Claude env-remap provider switching is fragile — pin SDK versions + smoke tests.
3. History normalize-at-read flattens exotic content (subagent trees) — document `parts` as additive.
4. Re-embed cost on provider switch — explicit `--force` + cost warning, never automatic.
5. Renderer collisions across backends — backend-scoped packs + shape-sniffing tier + priority tests.
6. Interface churn pre-1.0 — `@experimental` markers; resist promoting community providers to built-ins until the proving-ground implementations exist.
7. Single-maintainer upstream (pi) — thin interfaces + version pinning + Claude backend as maintained alternative; worst case the pi backend re-targets `pi-agent-core` directly or another runtime, interface unchanged.
