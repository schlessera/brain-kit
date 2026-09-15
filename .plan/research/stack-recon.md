# brain-kit stack recon — for adding a Storybook instance

Paths are repo-relative (the leakage gate bans absolute paths containing the home dir).

Read-only survey, 2026-09-15, main @ c6f7a6e. Absolute paths throughout.

---

## 1. packages/ui-server — how the React app is served

**There is no bundler and no HTML entry in this repo.** `ui-server` is a Hono
app factory that optionally serves a *pre-built* SPA directory handed to it by
the deployment shell.

`packages/ui-server/src/app.ts:78-83`:

```ts
  /**
   * Directory of a built SPA to serve at `/*` with an index.html fallback.
   * The deployment shell decides whether (and what) to serve — the package
   * has no client build of its own and no NODE_ENV heuristics.
   */
  staticRoot?: string;
```

It imports `serveStatic` from `hono/bun` and nothing else client-side. Entry
export is `createApp(options): BrainUiApp` returning
`{ fetch, websocket, config, authMode, db, wsHost, observability, ... }`.

`packages/ui-react/src/index.ts:1-9`:

```
 * The deployment shell owns the document: index.html, the mount point, the
 * Vite/PWA build, the service worker, and the theme entry (import ./theme.css
 * into a Tailwind v4 build together with an @source pointing at this package's
 * src, or use the precompiled ./styles.css export). The shell composes the
 * pieces below and calls configureBrainUi() before mounting.
```

ROADMAP confirms: *"The chat UI is a thin deployment shell. `brain-ui`
(separate repo) owns the Dockerfile, the bin entry, and branding; every line of
app behavior lives in `brain-ui-server` and `brain-ui-react` here."*

**Consequence for Storybook:** there is no existing Vite config, dev server, or
HMR setup to reuse or fight. A Storybook here would be the first bundler in the
repo. `ui-react` is built with plain `tsc` (`tsconfig.build.json`, `outDir:
dist`, `declaration: true`) plus a `@tailwindcss/cli` pass — see §5.

Grep for `Bun.build`, `vite.config`, `index.html` in non-node_modules source:
only hits are `render-template`'s printable HTML shell
(`packages/render-template/src/template.ts:161`) and the service-worker policy
string `"/index.html"` in `packages/ui-sdk/src/client/sw-policy.ts:258`.

---

## 2. packages/ui-sdk — the contract types Storybook fixtures must satisfy

Package `@schlessera/brain-ui-sdk` v0.35.0. Export map:
`.` (= `./protocol`), `./protocol`, `./schemas`, `./server`, `./testing`,
`./client`, `./share-target`, `./push-handlers`, `./sw-policy`.

`src/protocol.ts` (1513 lines) is **the compatibility contract** — additive
only, listed as explicitly-not-pluggable in `docs/extending/README.md`.
`PROTOCOL_REV = 3`.

### Chat / transcript

```ts
export type ClientMessage =
  | ClientHello | ClientChatMessage | ClientToolApproval | ClientToolDenial
  | ClientCancelRequest | ClientSessionResume | ClientAskUserResponse
  | ClientAskUserCancel | ClientLocationResponse | ClientLocationError
  | ClientMaskResponse | ClientMaskError
  | ClientActivitySubscribe | ClientActivityUnsubscribe;

export type ServerMessage =
  | ServerHello | ServerTextDelta | ServerThinkingDelta
  | ServerToolUseStart | ServerToolInputDelta | ServerToolUseComplete
  | ServerToolResult | ServerToolApprovalRequest | ServerResultMessage
  | ServerError | ServerStatus | ServerSessionInfo | ServerSessionHistory
  | ServerAskUserRequest | ServerLocationRequest | ServerMaskRequest
  | ServerActivitySnapshot | ServerActivityDelta;
```

```ts
export type MessagePart =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; toolIndex: number };

export interface SessionHistoryMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown>;
                     output?: string; isError?: boolean }>;
  parts?: MessagePart[];
  attachmentCount?: number;
}
```

Tool-call frames (all extend `SessionScoped` = optional `sessionId`):

```ts
ServerToolUseStart   { type:"tool_use_start";  toolUseId; toolName; parentToolUseId? }
ServerToolInputDelta { type:"tool_input_delta"; toolUseId; partialJson }
ServerToolUseComplete{ type:"tool_use_complete"; toolUseId; toolName; input; parentToolUseId? }
ServerToolResult     { type:"tool_result"; toolUseId; output: string; isError: boolean }
ServerToolApprovalRequest { type:"tool_approval_request"; toolUseId; toolName;
                            input; description?; kind?: "tool" | "command" }
```

`parentToolUseId` (rev 3) nests a call under the `Agent` call that spawned it.

Turn terminal frame:

```ts
ServerResultMessage {
  type:"result"; sessionId; outcome?: "success"|"error"|"cancelled";
  costUsd?: number; durationMs: number; numTurns: number; isError: boolean;
  usage?: TurnUsage; outcomeDetail?: string;
}
export interface ModelUsage { inputTokens?; outputTokens?; cacheReadTokens?;
                              cacheCreationTokens?; costUsd?: number }
export interface TurnUsage extends ModelUsage { perModel?: Record<string, ModelUsage> }
```

`ServerStatus.status: "thinking" | "tool_executing" | "idle" | "cancelled" | "queued"`.

### Sessions / profiles

```ts
ChatSession { id; title: string|null; createdAt; lastActiveAt;
              totalCostUsd; numTurns; backendId? }
ProviderInfo { id; label; vendor?; backendId?; contextWindow?;
               thinkingLevel?; source?: "builtin"|"declared"|"discovered";
               billingMode?: "subscription"|"api" }
ModelCatalogEntry extends ProviderInfo { hidden; billingOverride?; thinkingOverride? }
ModelCatalogResponse { models; defaultModelId?; resolvedDefaultId?; customModels?;
                       refreshedAt: number|null; stale; discovery{enabled,error?} }
ThinkingLevel = "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"
```

### Ask-user bridge

```ts
AskUserOption   { label; description; preview? }
AskUserQuestion { question; header; multiSelect: boolean; options: AskUserOption[] }
AskUserAnnotation { preview?; notes? }
ServerAskUserRequest { type:"ask_user_request"; requestId; questions: AskUserQuestion[] }
```

### Files

```ts
FileEntry { name; path; type:"dir"|"file"; size?; mtime? }
FileTreeResponse { path; entries: FileEntry[] }
FileContentKind = "markdown" | "html" | "text" | "binary"
FileContentResponse { path; kind; size; mtime; mime?; content? }
FileResolveResponse { path; ancestors: string[]; exists; type? }
FILE_SIZE_CAP_BYTES = 10_485_760
WikilinkMapResponse { generatedAt; count; slugs: Record<string,string> }
```

### Graph

```ts
GraphNodePayload { id: number; path; title; type; inDegree; outDegree;
                   community?; pagerank?; x?; y?; distance?; virtual? }
GraphEdgePayload { source: number; target: number }
GraphBrokenLink { sourcePath; target }
GraphCommunityPayload { community; size; label: string|null; topTerms: string[] }
GraphMetaResponse { available; reason?: "schema"|"not_computed"; schemaVersion;
                    computedAt: string|null; stale; nodeCount; edgeCount;
                    communities; defaultRoot: {path;virtual}|null; layoutSkipped? }
GraphSubgraphResponse { nodes; edges; truncated; reachableCount?; unreachableCount? }
GraphMaintenanceResponse { orphans; unreachable; brokenLinks;
                           stale: (GraphNodePayload & {updated:string})[]; staleDays }
```

### Activity / runs

```ts
ActivitySpanKind    = "turn" | "tool" | "subagent" | "cron"
ActivitySpanOrigin  = "session" | "cron"
ActivityPrincipalKind = "owner" | "agent" | "ambient" | "system"
ActivitySpanOutcome = "success"|"error"|"timeout"|"cancelled"|"denied"|"interrupted"
isFailureOutcome(o)  // error | timeout | interrupted

ActivitySpan { spanId; runId; parentSpanId?; name; toolName?; kind; origin;
               sessionId?; jobName?; principalId?; startedAt; waitUntil?;
               endedAt?; outcome?; outcomeReason?;
               usage?: ModelUsage & {model?}; 
               subagent?: {type?;description?;summary?;totalTokens?};
               attrs?: Record<string,unknown> }
ActivitySpanEvent { spanId; eventIndex; ts; eventType; payload?; truncated? }
ServerActivitySnapshot { type:"activity_snapshot"; view; sessionId?; runId?;
                         spans; events; highWaterSeq: Record<string,number>; append? }
ServerActivityDelta { type:"activity_delta"; runId; seq; span?; event? }

ActivityRunSummary / ActivityRunRollup / ActivityRunDetail /
ActivityAggregate / ActivityRollups / ActivityDigest / ActivityIntent
```

Span-name convention constants: `SPAN_OP_EXECUTE_TOOL = "execute_tool"`,
`SPAN_OP_INVOKE_AGENT = "invoke_agent"`, `SPAN_TOOL_NAME_PREFIX = "execute_tool "`.

### Voice, share, render, misc

`MessageSource = "typed"|"voice-dictate"|"voice-conversation"`,
`VoiceMode`, `Keyterm`, `VoiceSessionResponse`, `SpeechCapabilities`,
`AsrEvent = AsrPartial | AsrFinal`;
`SharedFileMeta`, `ShareIntakeResult`, `ShareStagingManifest`,
`SHARE_STAGING_DIR = ".brain-ui/inbox"`;
`RenderRequest { content; contentType:"markdown"|"html"; format:"png"|"pdf"; title? }`;
`PasskeySummary`, `BrainSearchResult`, `BrainStats`, `SystemStatus`, `CronJobStatus`.

`src/schemas.ts` (800 lines) carries the zod runtime validators mirroring these
(`clientMessageSchema`, `parseClientMessage`, `MAX_CLIENT_FRAME_BYTES =
12_000_000`, `MAX_SERVER_FRAME_BYTES = 2_000_000`, `MAX_PROMPT_CHARS =
200_000`). `packages/ui-sdk/tests/protocol-schema-types.test-d.ts` pins
type↔schema equality.

### `@schlessera/brain-ui-sdk/client` — the renderer seam Storybook stories

`packages/ui-sdk/src/client/renderers.ts`:

```ts
export interface ToolCallView {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  inputJson?: string;
  status?: "streaming"|"pending_approval"|"approved"|"denied"|"complete";
  startedAt?: number;
  endedAt?: number;
}

export interface ToolSemantics {
  command?(tool: ToolCallView): string | null;
  writePath?(tool: ToolCallView): string | null;
  unsandboxed?(tool: ToolCallView): boolean;
}

export interface ToolRenderer {
  match: string | ((tool: ToolCallView, backendId: string) => number);
  icon?: ComponentType<{ className?: string }>;
  summary?(tool): string | null;
  meta?(tool): string | null;
  label?: string | ((tool) => string);
  touchedFile?(tool): string | null;
  subagentRows?: boolean;
  semantics?: ToolSemantics;
  Input?: ComponentType<{ tool: ToolCallView }>;
  Output?: ComponentType<{ tool: ToolCallView }>;
}

export interface RendererPack { backend?: string; renderers: ToolRenderer[] }
registerToolRenderers(pack) / resolveToolRenderer(tool, backendId) / resetToolRenderers()
```

Resolution order: backend-scoped exact name → global exact name → scored
predicate → `null` (caller's generic). `resetToolRenderers()` exists as a test
helper and is exactly what a Storybook decorator needs.

Also exported from `/client`: `AsrClient` / `AsrClientFactory` /
`AsrClientOptions` / `speechUiHints` / `resetAsrClients`, and
`BrainUiClient` / `createBrainUiClient` / `BrainUiClientOptions` /
`ServerFrameHandlers` / `ConnectionStatus` / `ProtocolError` / `WebSocketClose`.

### ui-react's own store types (what components actually take)

`packages/ui-react/src/stores/chat-store.ts` —
`ChatMessage`, `ToolCall`, `AskUserExchange`, `SessionChat`, `ChatKey`,
`MessageAttachment`. `ToolCall` is a *superset* of `ToolCallView`
(`inputJson: string` required, `status` required, plus `approvalKind?:
"tool"|"command"`). The renderer packs widen with
`const asToolCall = (tool: ToolCallView) => tool as unknown as ToolCall;`.

```ts
export interface ChatMessage {
  id; role: "user"|"assistant"; content: string; thinking?: string;
  toolCalls: ToolCall[]; parts: MessagePart[]; isStreaming: boolean;
  timestamp: number; source?: MessageSource;
  askUserExchanges?: AskUserExchange[];
  attachments?: MessageAttachment[]; attachmentCount?: number;
}
export interface ToolCall {
  id; name; input: Record<string,unknown>; inputJson: string;
  output?: string; isError?: boolean;
  status: "streaming"|"pending_approval"|"approved"|"denied"|"complete";
  approvalKind?: "tool"|"command"; startedAt?: number; endedAt?: number;
}
```

Stores (all zustand): `chat-store`, `activity-store` (+`activity-store-types`),
`file-store`, `graph-store`, `connection-store`, `mask-store`,
`principal-store`, `provider-store`, `share-store`, `ui-store`,
`voice/voice-store`.

---

## 3. ui-backend-claude / ui-backend-pi — tool-call flow, tool schemas

Both implement `AgentBackend` from `@schlessera/brain-ui-sdk/server`
(`AgentBackend`, `BackendBridge`, `BackendCapabilities`, `StartTurnRequest`,
`FollowUpRequest`, `PermissionRequest`, `PermissionDecision`, `AskUserResult`,
`LocationFix`, `BackendActivityEvent`, `defineBackendModule`).

**Flow:** backend SDK stream → adapter → `ServerMessage[]` → ws host → browser
store → renderer registry → React view.

`packages/ui-backend-claude/src/stream-adapter.ts` — `class StreamAdapter`,
per-session, converts `SDKMessage` from `@anthropic-ai/claude-agent-sdk` into
protocol `ServerMessage`s; subagent messages carry `parent_tool_use_id` which
becomes `parentToolUseId`; subagent *text* goes only to the activity side
channel, never to `text_delta`.
`packages/ui-backend-pi/src/event-adapter.ts` is its pi counterpart.

### Tool registries / schemas declared to an LLM

**(a) The four bridge tools, defined once in the SDK** —
`packages/ui-sdk/src/server/bridge-tools/`:

| tool | file | name const | schema const |
| --- | --- | --- | --- |
| `ask_user` | `ask-user.ts` | `ASK_USER_TOOL_NAME` | `ASK_USER_INPUT_SCHEMA` (zod) |
| `get_current_location` | `location.ts` | `GET_CURRENT_LOCATION_TOOL_NAME` | `GET_CURRENT_LOCATION_INPUT_SCHEMA` |
| `request_image_mask` | `mask.ts` | `REQUEST_IMAGE_MASK_TOOL_NAME` | `REQUEST_IMAGE_MASK_INPUT_SCHEMA` |
| `query_activity` | `activity.ts` | `QUERY_ACTIVITY_TOOL_NAME` | `QUERY_ACTIVITY_INPUT_SCHEMA` |

Each also exports a `*_DESCRIPTION` (the LLM-facing prose) and a `handle*`.
`BRIDGE_TOOL_POSTURE` maps a name to its per-adapter visible name:
`claude` → `mcp__brain-ui__<name>`, `pi` → `<name>`. These four are
auto-allowed.

**(b) Claude backend auto-allow policy** —
`packages/ui-backend-claude/src/tool-policy.ts`, `DEFAULT_ALLOWED_TOOLS`:
`Bash, Read, Write, Edit, Glob, Grep, LSP, WebSearch, WebFetch, Agent, Skill,
NotebookEdit` plus `mcp__brain__{brain_search, brain_context, brain_read,
brain_list, brain_graph, brain_add, brain_update}`. `brain_archive` is
deliberately excluded (keeps its approval card);
`DEFAULT_CONFIRM_BASH_PATTERNS` closes the `brain archive` bash bypass.

**(c) pi backend curated toolset** — `packages/ui-backend-pi/src/tools.ts`
(typebox schemas), with a risk table `RiskClass = "read" | "mutate"`:
read → `read_file, grep, brain_search, brain_context, brain_read, brain_list,
brain_graph, ask_user, get_current_location, query_activity`;
mutate → `write_file, edit_file, bash, brain_add, brain_update, brain_archive,
request_image_mask`.

**(d) System prompt that describes the UI to the model** —
`packages/ui-sdk/src/server/system-prompt.ts`:
`BRAIN_UI_SYSTEM_PROMPT_APPEND` (mermaid renders natively, paths/wikilinks are
tap targets, **no raw HTML**, the `<share format=… title=…>` block, "don't
narrate tool use") plus `buildSystemPromptAppend()` / `ExecutionBrief` /
`SurfaceTools`. This is the only place that tells an LLM what the UI can render
— relevant if Storybook is meant to become a source of truth for it.

### Client-side renderer packs (ui-react)

`packages/ui-react/src/components/chat/renderers/index.ts`
registers three packs at build time via `registerBuiltinRenderers()` (idempotent):

- `claudeToolPack` (`backend: "claude"`) — names: `Bash, Edit, Write, Read,
  Grep, Glob, WebSearch, WebFetch, Agent, Skill, NotebookEdit, LSP,
  mcp__brain-ui__get_current_location`. `Agent` sets `subagentRows: true`.
- `piToolPack` (`backend: "pi"`) — `bash, read_file, write_file, edit_file,
  grep, brain_search, brain_context, brain_add`.
- `genericToolPack` — a single `GENERIC_RENDERER` with `match: () => 0.1`,
  sniffing input **shape** (`old_string`/`new_string` → diff;
  `file_path|path` + `content` → write; `command|cmd` → bash; else key/value)
  and output shape (error → `ClampedPre`; `path:line:` rows → `FileRowsView`).

Shared view components in
`packages/ui-react/src/components/chat/tool-views.tsx`
(776 lines): `ToolInputView`, `ToolOutputView`, `EditDiffView`,
`WriteFileView`, `BashCommandView`, `KeyValueView`, `ClampedPre`,
`FileRowsView`, plus helpers `getToolIcon/Label/Summary`, `getOutputMeta`,
`getTouchedFile`, `toRepoRelative`, `formatDuration`, `formatTokenCount`,
`splitGrepRow`, `safeSearchRegex`, `parseWebSearchResults`.

`packages/ui-react/src/lib/tool-names.ts`:
`ASK_USER_TOOL_NAME = "mcp__brain-ui__ask_user"`,
`GET_LOCATION_TOOL_NAME = "mcp__brain-ui__get_current_location"`,
`normalizeToolName`, `isAskUserTool`, `isLocationTool`.

---

## 4. MCP surface

One MCP server: `packages/core/src/mcp-server.ts`
(639 lines), `new McpServer({ name: "brain", version })`. Eight
`server.registerTool` calls, with zod `inputSchema` objects:

| line | tool |
| --- | --- |
| 163 | `brain_search` |
| 232 | `brain_context` |
| 277 | `brain_read` |
| 313 | `brain_list` |
| 377 | `brain_graph` |
| 480 | `brain_add` |
| 521 | `brain_update` |
| 596 | `brain_archive` |

MCP tool **names and schemas are contract-stable** (`docs/integration-contract.md`,
ROADMAP bind #4; `docs/mcp.md`). Exposed to Claude as `mcp__brain__<tool>` when
the brain repo registers the CLI's MCP server under the key `brain` in
`.mcp.json` (`template/.mcp.json`).

`defineModule` (the module seam, `packages/core/src/lib/module-types.ts:109`)
does **not** currently contribute MCP tools — "Module-contributed MCP tools" is
in ROADMAP's *Later* list. Current modules: `module-jobs`, `module-images`,
`module-finance`, `module-speaking`.

So: an LLM can call the 8 `brain_*` MCP tools + the 4 SDK bridge tools + its
backend's built-in file/shell tools. Nothing declares UI components to an LLM
today except the prose in `system-prompt.ts`.

---

## 5. Root build / test / lint tooling, and what a new package must satisfy

### Root `package.json`

Workspaces: `["packages/*"]` — **a new dir under `packages/` with a
`package.json` is auto-included**. Scripts: `build`, `test`
(`bun test packages tests --timeout 30000`), `typecheck` (`tsc --noEmit`),
`lint`, `version` (`changeset version && rm -f bun.lock && bun install`),
`release`, `api-report`, `env-docs`, `check-dist-types`, `clean`.
Dev deps: `@changesets/cli`, `@types/bun`, `oxlint@^1.79`, `typescript@^6.0.3`.

`bunfig.toml`: `[install] linker = "hoisted"` (isolated linker breaks
root-level workspace resolution and has catalog bugs).

### Root `tsconfig.json`

`target/module ESNext`, `moduleResolution: "bundler"`,
**`customConditions: ["bun"]`** (cross-package imports resolve to sibling
`src/`, never `dist/.d.ts`), `types: ["bun"]`, `jsx: "react-jsx"`,
`allowImportingTsExtensions`, `strict`, `noEmit`.

```json
"include": [
  "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx",
  "packages/*/tests/**/*.ts", "packages/*/tests/**/*.tsx",
  "scripts/**/*.ts", "tests/**/*.ts"
]
```

Anything outside those globs (e.g. a `.storybook/` dir at a package root) is
**not** typechecked by `bun run typecheck`.

### `scripts/build.ts`

Hardcoded `const packages = [...]` (13 entries, dependency-first), each built
with `bunx tsc -p packages/<name>/tsconfig.build.json`. Two special cases:
`ui-react` additionally runs
`bunx @tailwindcss/cli -i src/styles.css -o dist/styles.css --minify` and copies
`src/theme.css` → `dist/theme.css`; `core` copies `src/hooks` → `dist/hooks`.

### `scripts/publish.ts`

Its own hardcoded, dependency-ordered `const packages = [...]`, plus
`assertPublishArtifacts` and `assertPublishPins`, and an idempotent
`planRelease()` that probes the npm registry so a partial release resumes.

### `scripts/lint.ts` — five gates, explicit list (a glob was rejected on purpose)

1. `check-invisibles.ts` — raw control/invisible chars. Scans `git ls-files -z`
   (tracked files), skipping a binary-extension list. **This is CI's
   "invisible-character gate" step, which literally runs `bun run lint`.**
2. `check-env-access.ts` — globs `packages/*/src/**/*.{ts,tsx}`
   **unconditionally, private packages included**. Refuses ambient
   `process.env` and `import.meta.env` outside per-package chokepoints.
3. `check-module-casts.ts` — globs only `packages/module-*/src/**`.
4. `check-leakage.ts` — **whole working tree, untracked files included, no
   directory exemptions** (only a file literally named `LICENSE` is exempt).
   Patterns: the maintainer's first name, surname, two other personal names,
   a codename, a deploy-host identifier, and a VPS IP. Every pattern is
   assembled from split string literals so the file doesn't trip itself.
5. `check-oxlint.ts` — oxlint with `.oxlintrc.json`.

`.oxlintrc.json`: plugins `eslint, typescript, unicorn, oxc`,
`categories: { correctness: "error" }`, five rules disabled with inline
reasons. One override: `files: ["packages/ui-react/**"]` adds the `react`
plugin with `react-hooks/rules-of-hooks: error`,
`react-hooks/exhaustive-deps: warn`, and `react/{set-state-in-effect, refs,
purity, static-components}: off`. `ignorePatterns: ["**/dist/**",
"**/node_modules/**", "**/fixtures/**"]`.

### CI — `.github/workflows/ci.yml`, four jobs

- **test**: `bun install --frozen-lockfile` → `bunx tsc --noEmit` →
  `bun run lint` (the invisible-character gate step) → `bun run test` with
  `GEMINI_API_KEY=""`/`ANTHROPIC_API_KEY=""` → `bun scripts/env-docs.ts --check`.
- **pack**: `bun run build` → `check-publish-pins.ts` → packs all 13 packages
  (hardcoded `for package in` loop, asserts `package/dist/index.js` in each
  tarball) → installs them into a temp consumer and smoke-imports under Bun and
  Node → `check-dist-types.ts` → a second consumer pinned to React 18 that
  imports `@schlessera/brain-ui-react` and typechecks its emitted `.d.ts`.
- **changeset**: `check-changeset.ts` — requires a changeset for any change to
  a package's *shipped* files, derived from each manifest's `files` field.
- **leakage**: `bun scripts/check-leakage.ts`, no `bun install` (the gate must
  not depend on dependencies to fire).

### The decisive fact for a new non-published package: `private: true`

`tests/release-manifest.test.ts` and the sibling gates all enumerate packages
via `readdirSync(packages/)` **`.filter(p => !p.manifest.private)`**. Same
filter in `scripts/check-changeset.ts:38`, `scripts/check-dist-types.ts:88`,
`scripts/api-report.ts:46`, `tests/dependency-edges.test.ts:45`.

So a package marked `"private": true` is automatically exempt from:
- `scripts/build.ts` / `scripts/publish.ts` hardcoded-list membership
- the CI pack loop, the override map, and both smoke-import lists
- the changesets `fixed` group and version lockstep
- the LICENSE-file requirement
- `api-report`, `dependency-edges`, `check-dist-types`
- the "every prose package count agrees with the glob" test (which reads
  ROADMAP.md, CONTRIBUTING.md and `.agents/skills/release/SKILL.md` and asserts
  every "N packages" numeral equals the publishable count)
- the changeset gate

**But a private package under `packages/` still has to satisfy:**

| gate | why it still applies |
| --- | --- |
| `bunx tsc --noEmit` | root `include` covers `packages/*/src/**` and `packages/*/tests/**`, with `types: ["bun"]` and `customConditions: ["bun"]` |
| `bun run test` | `bun test packages tests` picks up any `*.test.ts(x)` under `packages/` |
| `check-env-access.ts` | globs `packages/*/src/**` with no private filter — **no `import.meta.env`, no ambient `process.env`** |
| `check-invisibles.ts` | any tracked text file |
| `check-leakage.ts` | whole tree, untracked included, no exemptions |
| `check-oxlint.ts` | correctness category repo-wide |
| `tests/docs-paths.test.ts` | any doc path referenced must exist |
| bun workspace resolution | `packages/*` glob makes it a workspace member; its deps land in the hoisted root `node_modules` |
| `bun.lock` | `bun run version` does `rm -f bun.lock && bun install`, so new deps must not break a clean resolve |

Two practical traps for a Storybook package:
- Storybook config conventionally lives in `.storybook/` at the package root —
  **outside** the tsconfig `include`, so it gets no typecheck. Putting stories
  under `src/` puts them *inside* `include` and inside `check-env-access`'s glob.
- `*.stories.tsx` files are safe from `bun test`; a `*.test.ts` under a new
  package is not.

A directory outside `packages/` (e.g. `apps/storybook/` or `tools/storybook/`)
dodges the workspace glob, the tsconfig include and `check-env-access`
entirely, at the cost of not resolving `@schlessera/brain-ui-react` through the
workspace — it would need an explicit workspace entry or a relative path.

---

## 6. Existing storybook / vite / playwright / chromatic presence

**None.** Full-tree grep (excluding `node_modules`) for `storybook`,
`chromatic`, `vite`, `playwright`, `.storybook`:

- `storybook`, `chromatic`, `.storybook` — **zero hits anywhere** (source,
  docs, ROADMAP, package manifests, CHANGELOGs).
- `vite` — prose only: `packages/ui-react/src/index.ts` and `README.md` ("the
  Vite/PWA build" owned by the deployment shell), `config.ts` explaining why
  `import.meta.env` is banned, `src/hooks/use-service-worker-updates.ts` docs,
  `packages/ui-server/README.md`. **No Vite dependency, no vite config file.**
- `playwright` — only inside `node_modules` (a happy-dom fixture and a
  transitive dep). Not a repo dependency.
- Matches in `packages/ui-server/src/middleware/*`, `config/env.ts`, `scrape`
  etc. are the substring "invite"/"private"/"activity" style false positives
  from the case-insensitive grep, plus `.agents/plans/android-share-target.md`
  and `docs/plans/2026-09-07-001-chore-hardening-roadmap-plan.md` mentioning
  the shell's Vite build.

**Closest prior art that exists today:**

- `packages/ui-react/tests/render/` — happy-dom + `@testing-library/react`.
  `tests/render/dom.ts` registers happy-dom at *import* time and documents that
  **all render tests must live in one file** (`render-smoke.test.tsx`) because
  `bun test` shares one process and the DOM must be unregistered afterwards.
  Also two benches: `tests/render/streaming-bench.tsx`,
  `tests/render/typing-bench.tsx`.
- `packages/ui-react/src/components/dev/share-harness.tsx` — `ShareHarness`, a
  dev-only stand-in for the system share sheet, exported for a shell dev route.
- `configureBrainUi({ devTools: true })` installs `window.__chatStore` /
  `window.__graphStore` "fixture-injection handles ... let browser automation
  inject fixture messages without a live agent session"
  (`packages/ui-react/src/config.ts:40-46`, `registerDevHandle`). This is the
  existing, sanctioned seam for driving the UI with fixtures.
- `BrainMarkdown` is exported from the package root with the comment "also
  useful standalone, e.g. **for a dev kitchen sink**"
  (`packages/ui-react/src/index.ts:22`).

**Design tokens** live in `packages/ui-react/src/theme.css` (493 lines): a
Tailwind v4 `@theme` block — a dark, warm palette (`--color-background
#0c0e12`, `--color-surface #141619`, `--color-foreground #e8e4df`, amber
primary `#e09f3e`, teal accent `#5bb5a2`, `--radius 0.5rem`) and fonts
DM Serif Text / Plus Jakarta Sans / JetBrains Mono, plus component classes
(`.filament`, etc.). `src/styles.css` is four lines:
`@import "tailwindcss" source(none"); @source "./"; @import "./theme.css";`.
There is **no documented light theme** and no design-system doc.

---

## 7. ROADMAP.md — "What binds future work" (verbatim)

> ## What binds future work
>
> These decisions are settled. Reopening one needs a reason that did not exist
> when it was made — not a preference.
>
> 1. **Markdown is the source of truth; the index is disposable.** `brain index
>    --force` regenerates everything. This is also the upgrade story: there is no
>    such thing as a data migration for derived state.
> 2. **A seam only where a second implementation is plausible within a year.**
>    Seams exist for embeddings, completions, agent runners, agent backends,
>    speech, tool renderers, and skill emitters. Everywhere else, concrete code
>    stays concrete. The not-pluggable list in
>    [docs/extending/README.md](docs/extending/README.md) is final.
> 3. **Skills orchestrate, the CLI executes.** Deterministic logic goes into a
>    `brain` subcommand with `--json`; SKILL.md files hold interview logic and
>    judgment only. This keeps skills short and re-runs reliable, and gives
>    non-agent users a fallback.
> 4. **The machine surface is a versioned contract.** CLI `--json` shapes, MCP
>    tool names and schemas, `schema_version`, and frontmatter semantics are
>    covered by [docs/integration-contract.md](docs/integration-contract.md).
>    Breaking one needs a `CONTRACT:` commit prefix and a major bump.
> 5. **Fail closed on exposure.** A publicly reachable chat UI without auth
>    refuses to boot, the renderer is denied every egress channel, and
>    `brain doctor` warns loudly on a public content remote.
> 6. **Your content repo stays yours.** brain-kit is infrastructure delivered by
>    version bump; it never merges into your content, and your taxonomy is built
>    by onboarding rather than shipped by us.
> 7. **Extension interfaces are `@experimental` until 1.0.**

### UI / design / component items elsewhere in ROADMAP

- *Where this stands*: "The chat UI is a thin deployment shell. `brain-ui`
  (separate repo) owns the Dockerfile, the bin entry, and branding; every line
  of app behavior lives in `brain-ui-server` and `brain-ui-react` here."
- Test baseline: 1512 pass / 24 skip / 0 fail here; 104 pass / 3 skip / 0 fail
  in `brain-ui`.
- *Next*: the four-release hardening roadmap (0.32.0 Boundary shipped
  2026-09-08; 0.33.0 Kit owns the app shipped 2026-09-09; 0.33.1; 0.34.0 One
  backend seam, 0.34.1 dispatcher/store/page splits; **Least privilege
  container ships as 0.36.0** because 0.35.0 went to session principals).
  Also: a real `brain-template` repo; integration/e2e tests in CI (the
  `brain-ui` integration suite needs a populated brain — `BRAIN_PATH` override
  already honored); **Voice phase 2** (streaming conversation), whose open
  questions are tracked in the `brain-ui` roadmap.
- *Later*: module-contributed MCP tools; per-session backend switching in the
  chat UI; a community provider promoted to built-in.
- *Deliberately not doing*: "Pluggable storage, index engines, or protocol
  layers. SQLite + FTS5 + sqlite-vec, markdown + git, the chunking/ranking
  pipeline, **the wire protocol, the Bun/Hono/React stack**, and the `brain`
  CLI/MCP surface *are* the product." Also: anything requiring a daemon;
  framework rewrites and editor plugins; a hosted service.

**Nothing in ROADMAP, docs/, CONTRIBUTING.md or README.md mentions a design
system, component library, Storybook, or a kitchen sink** beyond the one
parenthetical in `ui-react/src/index.ts`.
