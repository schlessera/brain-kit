# Plan — The client half of the protocol

Move the wire protocol's client side into the package that owns the protocol,
give inbound server frames the same runtime validation outbound client frames
already get, and implement the two rev-2 features (`server_hello`, `turnId`
echo) that the server stamps and no client reads.

Status: not started. Written from the architecture review that produced F1–F6;
this is F3. Nothing here is a bug today — the server is the trusted peer and
the shipped client is the only client. It is the residue of the chat UI having
been extracted from `brain-ui` server-first: `ui-sdk` got the protocol types
and the server's validation, and the client's half stayed where it happened to
have been written.

## Finding

**F3 — the client half of the protocol lives in the wrong package and skips
validation.**

- `@schlessera/brain-ui-sdk` describes itself as owning the wire protocol, and
  its `./server` subpath carries real server-side machinery (`backend.ts`,
  `speech.ts`, `system-prompt.ts`, `transcript-store.ts`, `write-lock.ts`).
  Its `./client` subpath carries only two registries — `renderers.ts` and
  `asr.ts` — plus a re-export of `protocol.ts`. There is no client transport in
  the SDK at all.
- The actual transport is `packages/ui-react/src/lib/ws-client.ts` (108 lines:
  connect, exponential backoff to 30s, `reconnectNow`, send, close). It does
  `JSON.parse(evt.data) as ServerMessage` — a raw cast, on line 39.
- Dispatch is `packages/ui-react/src/hooks/use-websocket.ts` (438 lines), which
  handles 15 of the 16 `ServerMessage` members. `server_hello` is the one it
  does not read.
- `schemas.ts` validates client→server frames only. Its own header says so:
  "Server→client frames have no runtime schemas yet — the server is the trusted
  peer; clients ignore unknown frame types."
- `protocol.ts:209` on `ServerHello`: "ADVISORY for now — no shipped client
  reads it yet; servers must not gate anything on the client having seen it."
  The same is true of `turnId`: the host mints it and verifies an echo *when
  present*, and no client sends one.

Consequence: any non-React client — a CLI, a mobile shell, a Svelte port, an
integration test that wants to drive a real socket — reimplements reconnection,
framing, dispatch and validation from scratch, and gets no help from the SDK
that supposedly defines the protocol.

## What makes this cheap

The dispatch code is not entangled with React. Lines 19–405 of
`use-websocket.ts` are module-scope functions over a module-scope `wsClient`
singleton (`handleServerMessage`, `requestBrowserLocation`, `resyncIfNeeded`,
`coldResumeIfNeeded`, `handleStatusChange`, `sendClientMessage`). The actual
hook is 27 lines at the end: an effect that constructs the client, wires
`online` / `visibilitychange`, and tears down.

So the entanglement is with the **zustand stores**, not with React. That is the
seam to cut along, and it is a clean one: the transport does not need to know
what a store is, and the stores do not need to know what a socket is.

## Root cause

The extraction went server-first. `ui-sdk` was created to hold what the server
and the client both needed to agree on, and "agreeing" was read as "the types".
Validation was added on the server because the server is the side that takes
untrusted input. Nobody revisited the client side, because from inside a
same-origin deployment with one shipped client, there is nothing to revisit —
which is exactly how this kind of asymmetry survives.

## Decisions

These bound the work. Each rules out an approach that looks reasonable.

- **D1 — the SDK gets the transport, not the state.** `ui-sdk/client` gains a
  framework-agnostic `BrainUiClient`: socket lifecycle, backoff, validated
  parse, typed frame dispatch, `server_hello` capture, `turnId` echo. It never
  imports zustand, React, or anything from `ui-react`. `ui-react` keeps every
  store write and becomes a handler object handed to the client.
- **D2 — inbound validation is `parse-and-warn`, not `parse-or-throw`.** The
  protocol contract is additive: unknown object keys are preserved
  (`z.looseObject`), and unknown frame types are ignored by the receiver. A
  client that hard-fails an unrecognised frame would make every additive server
  change a breaking one. A frame that fails validation is dropped with a
  console warning and a counter, never thrown.
- **D3 — `ui-sdk` stays dependency-free apart from zod.** It has no internal
  edges at all in `tests/dependency-edges.test.ts` and that stays true. The
  transport uses the platform `WebSocket`, which means the browser's and Bun's
  and Node 22+'s alike.
- **D4 — no new package.** The obvious alternative is a `brain-ui-client`
  package. Rejected: the not-a-new-seam rule in AGENTS.md, and the fact that
  `ui-sdk` already has a `./client` subpath doing exactly this job, just
  incompletely. A subpath is not a package.
- **D5 — `turnId` echo ships as additive, and the server does not start
  requiring it.** The server already verifies an echo when present. Making it
  mandatory is a protocol-rev change and needs a deprecation window; that is
  out of scope here and belongs in a rev-3 discussion.
- **D6 — `ui-react`'s public surface does not change.** `useWebSocket()`,
  `sendClientMessage()`, `handleServerMessage()` and `runStateForFrame()` keep
  their names and signatures. `handleServerMessage` and `runStateForFrame` are
  exported and tested directly today; that is the regression net for the whole
  refactor and it must keep working unmodified.

## Workstreams

Ordered. Each lands on its own and leaves the tree green.

### W1 — Server→client schemas (`ui-sdk`)

Mirror `schemas.ts`'s existing shape for the other direction: one zod schema
per `ServerMessage` member, each bound to its interface with
`satisfies z.ZodType<…>` so the two cannot drift without a compile error, and a
discriminated union behind `parseServerMessage(raw)` returning the same
`ParseFrameResult<T>` the client-side parser returns.

Notes:

- Reuse `MAX_JSON_DEPTH` and the `exceedsDepth` guard. The frame-byte cap is a
  different number in this direction — `session_history` is chunked precisely
  because a full transcript replay does not fit one frame — so size it from the
  server's actual chunking bound rather than reusing `MAX_CLIENT_FRAME_BYTES`.
- `z.looseObject` throughout, per D2 and the additive contract.
- The union must accept `server_hello`, which no current client handles. That
  is the point: validation and handling are separate questions.

Done when: every `ServerMessage` member has a schema, the union round-trips
each of them, and a fixture of "next version's frame with an extra optional
field" survives with the extra field intact.

### W2 — `BrainUiClient` (`ui-sdk/client`)

Move `ws-client.ts` in, and grow it into the client the SDK should have had.

```ts
export interface BrainUiClientOptions {
  url: string;
  handlers: ServerFrameHandlers;   // one method per frame, all optional
  onStatusChange?(status: ConnectionStatus): void;
  onProtocolError?(error: string, raw: string): void;
  /** Injected for tests; defaults to the platform WebSocket. */
  socketFactory?: (url: string) => WebSocket;
}
```

Responsibilities, all of which exist today but are spread across two files and
one cast:

- connect / backoff (1s doubling to 30s) / `reconnectNow` / close — moved
  verbatim from `ws-client.ts`, which is already correct.
- `parseServerMessage` on every inbound frame; drop-and-report on failure.
- capture `server_hello` and expose `protocolRev` + `capabilities` as read-only
  state. This is the first client to read it.
- remember the `turnId` of the current turn and stamp it onto outbound
  turn-scoped frames, so the host's echo verification has something to verify.
- `send(msg: ClientMessage)` returning `boolean`, preserving the existing
  contract that a send with no open socket returns false rather than throwing
  (`sendClientMessage`'s header explains why: a caller that just staged an
  upload needs to know).

`socketFactory` is what makes W4 possible and is worth the parameter.

### W3 — `ui-react` becomes a handler set

`use-websocket.ts` keeps every store write and loses everything else. Its
module-scope functions become the `ServerFrameHandlers` object; the hook
constructs a `BrainUiClient` instead of a `WSClient` and keeps the `online` /
`visibilitychange` wiring, which is browser policy and does not belong in the
SDK. `requestBrowserLocation` stays here too — `navigator.geolocation` is a
browser API, not a protocol concern.

`ws-client.ts` is deleted. `handleServerMessage` and `runStateForFrame` keep
their exported signatures per D6.

Expect this file to end up under 250 lines.

### W4 — The test the repo does not have

ROADMAP names it: "No end-to-end test drives the auth boot refusal through a
real socket." Once `BrainUiClient` runs on any platform `WebSocket` and takes a
`socketFactory`, a test can drive a real `createApp()` over a real socket from
Bun, with no browser and no React. That closes the ROADMAP item as a
side-effect, and it is the first thing that would catch a client/server
protocol drift.

Two cases to cover first, both currently untested end to end: the auth boot
refusal, and a `turnId` echo being verified by the host.

### W5 — Documentation

- `docs/integration-contract.md`: server→client frames are now validated, and
  the drop-don't-throw policy is part of the contract a third-party client may
  rely on.
- `ROADMAP.md`: strike the two hardening bullets this closes (`ui-sdk` has
  schemas for client→server frames only; `server_hello` and `turnId` are
  advisory client-side), and the e2e-socket bullet if W4 lands with it.
- `packages/ui-sdk/README.md`: `./client` now means something.

## What this does not do

- Does not make `turnId` mandatory (D5).
- Does not change the protocol rev. Everything here is additive; a rev-2 server
  and a rev-2 client that predate it stay compatible in both directions.
- Does not add a `brain-ui-client` package (D4).
- Does not touch the tool-renderer or ASR registries already in
  `ui-sdk/client`. They are unrelated to transport and are fine where they are.

## Risks

- **R1 — a schema stricter than the server's actual output.** The server has
  been emitting these frames for a year with nothing checking them, so any
  place where the implementation drifted from the interface will surface as a
  dropped frame. Mitigation: D2 means dropped-and-warned rather than a crash,
  and W4's real-socket test exercises the frames end to end before this ships.
  Run the full `brain-ui` integration suite against a client with validation on
  before merging.
- **R2 — `session_history` chunking.** It is the one frame whose size is
  bounded by the transport rather than the content, and the one whose
  `append` semantics a naive schema could get wrong (first frame omits it,
  continuations set `true`). Write its schema against the server's chunker, not
  against the interface alone.
- **R3 — scope creep into state management.** The temptation while moving this
  code is to also fix the two known store races the ROADMAP lists (mid-stream
  delta drop, draft adoption binding to a stale session). Both are real; both
  are store bugs, not protocol bugs; both would make this diff unreviewable.
  Separate plan.
