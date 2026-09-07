# @schlessera/brain-ui-sdk

The contract layer between an brain-kit chat UI and the agent that powers it.
Everything a host, a backend, or a client needs to agree on lives here — and
nothing else does: no HTTP framework, no UI, no model vendor.

```
@schlessera/brain-ui-sdk            → the wire protocol types (root re-export)
@schlessera/brain-ui-sdk/protocol   → same, explicit
@schlessera/brain-ui-sdk/schemas    → zod runtime schemas + parseClientMessage
@schlessera/brain-ui-sdk/server     → AgentBackend / SpeechProvider seams, transcript store
@schlessera/brain-ui-sdk/client     → tool-renderer + AsrClient registries (React peer)
@schlessera/brain-ui-sdk/share-target → Web Share Target service-worker handler
@schlessera/brain-ui-sdk/push-handlers → web-push service-worker handlers
```

Import the submodules explicitly — the root export carries the protocol only,
so server bundles never touch client code (and the `react` peer dependency is
only exercised by `./client`).

## The wire protocol (`./protocol`)

Protocol **rev 3**: sessions run in parallel, every turn-scoped frame carries a
host-minted `turnId`, servers greet with `server_hello`, and every turn ends in
**exactly one** terminal `result` frame with a unified `outcome`. The TypeScript
interfaces are the compatibility contract consumed by both sides; additive
evolution only.

## Runtime validation (`./schemas`)

`parseClientMessage` is the single boundary for inbound client frames: payload
size cap, byte cap, then a zod discriminated union bound to the protocol types
via `satisfies` — so the schemas cannot drift from the interfaces without a
type error. Hosts should never cast a client frame; binary frames are rejected.

## Backend seam (`./server`)

`AgentBackend` is the interface a model integration implements
([`@schlessera/brain-backend-pi`](../ui-backend-pi), [`@schlessera/brain-backend-claude`](../ui-backend-claude)):
`startTurn` streams protocol frames, the host owns the per-turn
`AbortController`, and mutating tools gate through `bridge.requestPermission`.
`BackendCapabilities` is honest by contract — `permissions: true` means a deny
actually blocks a mutation, and the shared contract test suite enforces it for
every in-tree backend. The transcript store persists session metadata without
prescribing storage for the transcripts themselves (backends own those).

## Client registries (`./client`)

Registries mapping tool names to renderers and ASR providers to `AsrClient`
implementations, so a chat UI can render unknown tools with a generic fallback
and add specialized views without touching its timeline component. React is a
peer dependency of this submodule only.

## Service-worker handlers (`./share-target`, `./push-handlers`)

The share-target and web-push handlers are separate export subpaths so a
service worker can import them without dragging in the renderer and ASR
registries from `./client`:

```ts
/// <reference lib="webworker" />
import { registerShareTarget } from "@schlessera/brain-ui-sdk/share-target";
import { registerPushHandlers } from "@schlessera/brain-ui-sdk/push-handlers";

declare let self: ServiceWorkerGlobalScope;

registerShareTarget();
registerPushHandlers(self as unknown as Parameters<typeof registerPushHandlers>[0]);
```

`registerShareTarget` intercepts the manifest's `POST /share-target`, stashes
the payload locally, and redirects to the app. That payload is untrusted input:
the share flow must show it to the user for confirmation and must never act on
it automatically. Its optional argument sets `path` and `landingPath`.
`registerPushHandlers` wires push notifications, notification clicks, and
subscription renewal; its optional second argument sets `subscribeUrl` and
`defaultUrl`.

## Versioning

The protocol is a compatibility contract: additive changes only, unknown fields
must be preserved, and `server_hello.protocolRev` announces the revision.

## Speaking the protocol

`@schlessera/brain-ui-sdk/client` exports `BrainUiClient`: socket lifecycle
(1s-doubling backoff to 30s, `reconnectNow`), validated inbound frames,
`server_hello` capture, and `turnId` echo on turn-scoped replies. It has no
React, no DOM beyond `WebSocket`, and takes a `socketFactory` so it is testable
with no network.

```ts
import { BrainUiClient } from "@schlessera/brain-ui-sdk/client";

const client = new BrainUiClient({
  url: "wss://host/ws",
  handlers: { text_delta: (f) => render(f.text) },
  onProtocolError: (e) => report(e.reason, e.detail),
});
client.connect();
```

A frame that fails validation is dropped and passed to `onProtocolError`, never
thrown — the protocol is additive, so an unrecognised frame must not break an
older client. Register `onAny` instead of per-type handlers when your dispatch
shares a preamble; it counts as handling.
