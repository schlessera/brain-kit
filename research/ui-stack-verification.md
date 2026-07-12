# Research: UI-Stack Verification (verified live 2026-07-12)

Method: npm registry, extracted tarball `.d.ts` diffs, official docs. For the
phase-5 work (ui-sdk, backends, brain-ui PR). Extends research/pi-omp.md.
Companion with deeper SDK API notes: research/ui-stack-versions.md.

## @anthropic-ai/claude-agent-sdk

- Latest **0.3.207** (2026-07-11). brain-ui pins `^0.2.92` → resolves 0.2.96 —
  a full minor behind; caret on 0.x never picks up 0.3.
- `.d.ts` diff 0.2.96 → 0.3.207: **no breaking changes** to anything brain-ui
  uses. `query({prompt, options})`, Options keys (canUseTool, settingSources,
  mcpServers, resume vs sessionId (distinct!), env, includePartialMessages,
  abortController, allowed/disallowedTools, model, cwd,
  pathToClaudeCodeExecutable), canUseTool options `toolUseID` (capital ID),
  `listSessions({dir,…})`, `getSessionMessages(sessionId,{dir,…})` all present
  in both. 0.3.x additive: requestId/decisionReason on canUseTool options,
  deleteSession.
- → ui-backend-claude pins **^0.3.207**.
- SDK internally uses zod v4; `createSdkMcpServer`/`tool` unchanged.

## Bun.password

- `Bun.password.hash/verify` current; default **argon2id** ($argon2id$v=19$
  m=65536,t=2,p=1$…), verify auto-detects from the hash string, salt embedded.
- Hash generation one-liner (documented in the PR/docs):
  `bun -e 'console.log(await Bun.password.hash(process.argv[1]))' 'pw'`
- `BRAIN_UI_PASSWORD_HASH` stores the full PHC string. argon2id chosen; no
  reason for bcrypt. https://bun.com/docs/api/hashing

## hono

- Latest 4.12.29; brain-ui `^4` fine. WS pattern already in use
  (`hono/bun` upgradeWebSocket + Bun.serve websocket).
- Guarding the upgrade: auth middleware BEFORE the WS route; never put
  header-modifying middleware (CORS) on the WS path ("immutable headers"
  throw). Signed cookies: `setSignedCookie(c, name, value, secret)` /
  `getSignedCookie(c, secret, name)` — async, HMAC-SHA256, returns false on
  tamper. Note the differing arg orders.

## Deepgram

- Token-based browser auth current: `POST /v1/auth/grant` with
  `{ttl_seconds}` → `{access_token, expires_in}`. Default TTL 30s, max 3600.
- **Discrepancy vs brain-ui comment**: the grant key needs at least *Member*
  project permission, NOT `keys:write` (that scope belongs to the older
  temporary-API-key flow). Fix the comment when porting.
- nova-3 still the recommended streaming model.

## pi 0.80.6 host-integration specifics (beyond research/pi-omp.md)

- **Events**: `session.subscribe(listener) → unsubscribe`. text/thinking
  deltas are NESTED: `message_update.assistantMessageEvent.type ===
  "text_delta"|"thinking_delta"` with `.delta` + `.contentIndex`;
  `tool_execution_start {toolCallId, toolName, args}` / `_update
  {…, partialResult}` / `_end {…, result, isError}` are top-level.
- **Model is an object**: `createAgentSession({model?: Model<any>})`; list via
  `ModelRegistry.create(authStorage)` → `.getAvailable()` / `.find(provider,
  modelId)`; `session.setModel(model)`.
- **Abort**: `session.abort(): Promise<void>` (+ `waitForIdle()`), no per-turn
  signal; custom-tool `execute()` receives an AbortSignal.
- **Prompting**: `session.prompt(text, {streamingBehavior?, images?, source?})`
  — images option exists (attachments path).
- **Custom tools**: `execute(toolCallId, params, signal, onUpdate, ctx) →
  AgentToolResult {content: (Text|Image)[], details, terminate?}`; onUpdate
  streams partials. TypeBox schemas.
- `session.getSessionStats()` — candidate for usage/cost reporting.
