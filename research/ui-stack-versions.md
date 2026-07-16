# UI-stack verification (phase 5)

Verified live 2026-07-12 (npm registry, `npm view`, shipped `sdk.d.ts`, official docs). Do not trust training data — re-verify before release. Companion to `research/tooling-versions.md`.

Local toolchain: bun 1.3.14, node v22.18.0.

## Versions to pin

| pkg | pin | notes |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | **0.3.207** | latest; published 2026-07-11 (very fresh, fast-moving — re-check before release). `latest` == `next`. Node engine `>=18`; runs on Bun. |
| `@anthropic-ai/sdk` (base) | 0.111.0 | transitive/peer of the agent SDK; pin only if used directly. |
| `hono` | **4.12.29** | latest (published 2026-07-10); engine node `>=16.9`. |
| `@deepgram/sdk` | 5.5.0 | only needed server-side to mint tokens; browser uses the raw WS + token. |
| `Bun.password` | built into bun 1.3.14 | argon2id default — no dep. |

## @google/genai — Gemini AgentBackend update (verified 2026-07-16)

- npm `latest` is **2.12.0**; `@brainform/ui-backend-gemini` pins it exactly.
- `FunctionDeclaration.parametersJsonSchema` accepts plain JSON Schema and is
  the field used by the current README example. The backend passes declarations
  as `config.tools = [{ functionDeclarations }]`.
- `generateContentStream()` yields `GenerateContentResponse` chunks; streamed
  parts are at `chunk.candidates?.[0]?.content?.parts`. `GenerateContentConfig`
  carries `abortSignal`, `systemInstruction`, and
  `thinkingConfig.includeThoughts`.
- `Part` includes `thought`, `text`, `functionCall`, `functionResponse`, and
  opaque `thoughtSignature`. Raw response parts must be retained in order so
  Gemini 3 tool-call signatures are echoed unchanged.
- The SDK's own automatic-function-calling implementation appends one
  `Content` with role **`user`** for all function-response parts.
  `FunctionResponse.id` can echo the provider's optional `FunctionCall.id`.

Sources:
https://www.npmjs.com/package/@google/genai ;
https://googleapis.github.io/js-genai/ ;
https://ai.google.dev/gemini-api/docs/generate-content/function-calling ;
https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures

## @anthropic-ai/claude-agent-sdk — query() / canUseTool

This is the **Claude Agent SDK** (Claude Code as a library), distinct from the base `@anthropic-ai/sdk`. Import from the root export; a server-side Bun backend uses `.` (there is also a `./browser` build and a `./bridge` export — not needed for our host-side backend).

Exports (from `sdk.d.ts`): `query`, `tool` (Zod-schema custom tool helper), `createSdkMcpServer` (in-process MCP server — how we'd wire brainform's own tools into a Claude turn without spawning a separate MCP process).

### query()
```ts
function query({ prompt, options }: {
  prompt: string | AsyncIterable<SDKUserMessage>;   // string OR async-iterable = streaming input mode
  options?: Options;
}): Query;   // extends AsyncGenerator<SDKMessage, void> + methods
```
Iterate the returned `Query` for `SDKMessage`s (`assistant` / `user` / `result` / `system` / partial `stream_event`). `options.includePartialMessages: true` surfaces token-level `stream_event` deltas — that's the hook for our streaming protocol frames.

`Options` fields relevant to the backend seam (verified in `sdk.d.ts`): `model?`, `systemPrompt?` (string | string[] | preset+append object), `mcpServers?: Record<string, McpServerConfig>`, `allowedTools?` / `disallowedTools?: string[]`, `permissionMode?`, `canUseTool?`, `cwd?`, `includePartialMessages?`, and session control **`resume?: string`** (resume by session id), `resumeSessionAt?: string`, `continue?: boolean` (continue most recent). So SDK-native resume exists — our "unsupported resume" `BackendRequestError` is a host-policy choice, not an SDK limitation.

### canUseTool (host permission gate — the auth-relevant seam)
```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string;
             decisionReason?: string; toolUseID: string; agentID?: string; requestId: string; }
) => Promise<PermissionResult | null>;
```
- Passed inside `options` to `query()`. **Only available in streaming-input mode** (prompt is an async iterable) — same for `setPermissionMode()`, `setModel()`, `streamInput()`. If we want per-tool gating we must drive the query with an async-iterable prompt, not a bare string.
- Invoked **only when the permission flow resolves to a prompt** — not for tools already cleared by `allowedTools`/allow-rules/`acceptEdits`. So a deny-by-default posture needs `permissionMode` + `disallowedTools`, not just this callback.
- Handle `requestId` idempotently (may repeat).

### PermissionResult — GROUND TRUTH (docs example is WRONG, but brain-ui is already correct)
The published TS reference example shows `return { approved: true }`. That is **incorrect** — the shipped `sdk.d.ts` type is a `behavior` discriminated union (identical in 0.2.96 and 0.3.207, cross-checked by ui-research from both tarballs). Use this:
```ts
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[]; toolUseID?: string; decisionClassification?: ... }
  | { behavior: 'deny'; message: string; interrupt?: boolean;
      toolUseID?: string; decisionClassification?: ... };
```
`allow` may rewrite the tool input via `updatedInput`; `deny` requires a `message` and can `interrupt` the turn. Returning `null` defers to the normal flow. Do not ship `{ approved }` — it would be silently wrong.

**brain-ui already implements this correctly** (`server/src/ws/handler.ts:438-461` returns `{ behavior: "allow", updatedInput }` / `{ behavior: "allow" }` / `{ behavior: "deny", message }`). The only `approved` in the codebase is an internal client-side boolean (`client/src/stores/chat-store.ts`) that the server maps to `behavior`. So for the P5.2 port this is **"keep the existing server shape," not "fix a bug"** — nothing is stubbed wrong today. The warning stands only against the SDK's published doc example.

### PermissionMode (verified union)
`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
- `dontAsk` = deny anything not pre-approved, never prompt (good headless default).
- `bypassPermissions` = skip checks (explicit ask-rules still prompt).
- `auto` = model classifier decides per call.

No breaking changes to `query()`/`canUseTool` documented for 2026 — but 0.3.x is pre-1.0 and shipping fast; treat the API as unstable and re-verify the two types above at release.
Docs: https://code.claude.com/docs/en/agent-sdk/typescript

## AUTH_MODE=password — Bun.password (argon2id)

`Bun.password` is suitable and needs no dependency. Live test on bun 1.3.14 (deterministic across 3 runs, matches current Bun docs):
```ts
const hash = await Bun.password.hash("pw");            // "$argon2id$v=19$m=65536,t=2,p=1$..."
const ok   = await Bun.password.verify("pw", hash);    // true
```
- **Default algorithm is argon2id with `m=65536,t=2,p=1`** (the current OWASP-recommended password KDF), confirmed against the full PHC string on bun 1.3.14 (brain-ui's runtime). The params are embedded in the hash, so `verify` needs only the stored string — the exact cost params don't need to be re-supplied and can be re-tuned later without breaking existing hashes. `bcrypt` is also available via `Bun.password.hash(pw, "bcrypt")` if a 72-byte-limited legacy format is needed — prefer argon2id.
- `hash()`/`verify()` are async and run off the main thread; the algorithm+params are embedded in the encoded hash, so `verify` needs only the stored string. Tune cost via `{ algorithm: "argon2id", memoryCost, timeCost }` if the defaults are too light/heavy for the deploy target.
- Store the encoded hash; never the password. Pair with a constant-time compare only if you compare anything outside `verify` (verify is already constant-time).
Docs: https://bun.com/docs/api/hashing (`Bun.password`)

## hono + WebSocket upgrade auth

- Pin **hono 4.12.29**. WS helper is available on the Bun adapter.
- **API change:** `createBunWebSocket()` is **deprecated** — import `upgradeWebSocket` and `websocket` directly from `hono/bun`. Update any plan sketch that calls `createBunWebSocket`.
- **Upgrade-auth pattern (the important gotcha):** browsers cannot set custom headers (no `Authorization`) on the `WebSocket` handshake, so bearer-token-in-header auth does **not** work from a browser client. For our same-origin design, authenticate the upgrade with the **session cookie** (sent automatically same-origin) — run the auth check in the route handler *before* returning the `upgradeWebSocket` response, and reject (401) there if unauthenticated. Known rough edges to design around:
  - Hono's JWT middleware has been reported to not reliably read cookies on the `upgradeWebSocket` path — do the cookie→session lookup explicitly in the handler rather than relying on `jwt()` middleware for the WS route.
  - CORS middleware can crash the WS endpoint with immutable-header errors — don't apply the `cors()` middleware to the WS route (same-origin doesn't need it anyway).
  - If a cookie isn't viable, the fallbacks are a short-lived token in the query string or the `Sec-WebSocket-Protocol` subprotocol — but for our same-origin host, the cookie is the clean path.
Docs: https://hono.dev/docs/helpers/websocket ; adapter source: https://github.com/honojs/hono/blob/main/src/adapter/bun/websocket.ts ; auth discussion: https://github.com/orgs/honojs/discussions/2534

## Deepgram token-mint (browser STT)

Current and correct pattern for keeping the Deepgram API key out of the browser:
- **Mint a short-lived token server-side via `POST /v1/auth/grant`.** Returns a **JWT with a default 30-second TTL** and `usage:write` scope. The API key used to call `/auth/grant` needs **Member or higher** permission.
- Browser then opens the Deepgram streaming WS using that JWT as `Authorization: Bearer <jwt>` (token scheme on the grant call, Bearer on downstream calls). Because the TTL is ~30s, mint on demand right before the browser opens the socket (our backend already brokers the voice session, so it mints + hands off).
- Deepgram's own guidance: proxy/broker through your server and pass temporary tokens to the client — matches our host-brokered voice-session design. `@deepgram/sdk` 5.5.0 can mint server-side; the browser needs no SDK, just the token + WS.
Docs: https://developers.deepgram.com/reference/token-based-auth-api/grant-token ; https://developers.deepgram.com/guides/fundamentals/token-based-authentication

## Actionable deltas for P5.2 / P5.5

1. Claude backend `canUseTool` returns `{ behavior: 'allow' | 'deny', ... }`, not `{ approved }` (the SDK doc example is wrong, but brain-ui's `server/src/ws/handler.ts` already uses `behavior` — port = keep that shape, nothing to fix).
2. To gate tools at all, drive `query()` with an **async-iterable prompt** (streaming input) — `canUseTool` is inert with a string prompt. Use `includePartialMessages: true` for streaming frames.
3. SDK has native `resume`/`continue`; the backend's `unsupported resume` rejection is a host policy, keep it deliberate.
4. Replace any `createBunWebSocket` usage with direct `hono/bun` imports; authenticate the WS upgrade via session cookie in the handler (not `jwt()` middleware), and keep `cors()` off the WS route.
5. Deepgram: mint `POST /v1/auth/grant` JWTs (30s TTL, Member+ key) server-side per voice session; never ship the API key.
