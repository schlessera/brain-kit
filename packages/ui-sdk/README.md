# @schlessera/brain-ui-sdk

The contract layer between an brain-kit chat UI and the agent that powers it.
Everything a host, a backend, or a client needs to agree on lives here — and
nothing else does: no HTTP framework, no UI, no model vendor.

```
@schlessera/brain-ui-sdk            → the wire protocol types (root re-export)
@schlessera/brain-ui-sdk/protocol   → same, explicit
@schlessera/brain-ui-sdk/schemas    → zod runtime schemas + parseClientMessage
@schlessera/brain-ui-sdk/server     → AgentBackend / SpeechProvider seams, transcript store
@schlessera/brain-ui-sdk/testing    → published AgentBackend contract test harness
@schlessera/brain-ui-sdk/client     → tool-renderer + AsrClient registries (React peer)
@schlessera/brain-ui-sdk/share-target → Web Share Target service-worker handler
@schlessera/brain-ui-sdk/push-handlers → web-push service-worker handlers
@schlessera/brain-ui-sdk/sw-policy   → default service-worker route/cache policy
```

Import the submodules explicitly — the root export carries the protocol only,
so server bundles never touch client code (and the `react` peer dependency is
only exercised by `./client`).

## The wire protocol (`./protocol`)

Protocol **rev 4**: sessions run in parallel, every turn-scoped frame carries a
host-minted `turnId`, servers greet with `server_hello`, and every turn ends in
**exactly one** terminal `result` frame with a unified `outcome`. A client that
declares rev 3 or later in `client_hello` echoes `turnId` on its interactive
replies, and rev 4 adds `message_blocks`, the blocks classified out of an
assistant message. The TypeScript
interfaces are the compatibility contract consumed by both sides; additive
evolution only.

## Runtime validation (`./schemas`)

`parseClientMessage` is the single boundary for inbound client frames: payload
size cap, byte cap, then a zod discriminated union bound to the protocol types
via `satisfies`. A compile-time equality test checks exact keys, optionality,
and nested values in both directions so the schemas cannot drift from the
interfaces. Hosts should never cast a client frame; binary frames are rejected.

## Backend seam (`./server`)

`AgentBackend` is the interface a model integration implements
([`@schlessera/brain-backend-pi`](../ui-backend-pi), [`@schlessera/brain-backend-claude`](../ui-backend-claude)):
`startTurn` streams protocol frames, the host owns the per-turn
`AbortController`, and mutating tools gate through `bridge.requestPermission`.
`BackendCapabilities` is honest by contract — `permissions: true` means a deny
actually blocks a mutation, and the shared contract test suite enforces it for
every in-tree backend. The transcript store persists session metadata without
prescribing storage for the transcripts themselves (backends own those).

## Backend contract tests (`./testing`)

Backend packages can run the same `startTurn` assertions as the first-party
implementations by supplying fake runtimes through a `BackendContractHarness`:

```ts
import { describe, expect, test } from "bun:test";
import {
  runBackendContract,
  type BackendContractHarness,
} from "@schlessera/brain-ui-sdk/testing";

const harness: BackendContractHarness = {
  name: "example",
  scripted: (script) => createExampleBackend({ runtime: scriptedRuntime(script) }),
  hanging: () => createExampleBackend({ runtime: hangingRuntime() }),
  failing: (script) => createExampleBackend({ runtime: failingRuntime(script) }),
  unknownProfileId: "no-such-profile",
};

runBackendContract(harness, { describe, test, expect });
```

The caller owns fake-runtime setup and per-test cleanup; the published subpath
does not import a test runner or Node/Bun filesystem APIs.

## Client registries (`./client`)

Registries mapping tool names to renderers and ASR providers to `AsrClient`
implementations, so a chat UI can render unknown tools with a generic fallback
and add specialized views without touching its timeline component. React is a
peer dependency of this submodule only.

## Service-worker handlers (`./share-target`, `./push-handlers`, `./sw-policy`)

The share-target and web-push handlers are separate export subpaths so a
service worker can import them without dragging in the renderer and ASR
registries from `./client`:

```ts
/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkOnly } from "workbox-strategies";
import { CacheExpiration, ExpirationPlugin } from "workbox-expiration";
import { registerShareTarget } from "@schlessera/brain-ui-sdk/share-target";
import { registerPushHandlers } from "@schlessera/brain-ui-sdk/push-handlers";
import { registerDefaultRoutes } from "@schlessera/brain-ui-sdk/sw-policy";

declare let self: ServiceWorkerGlobalScope;

registerShareTarget();
registerPushHandlers(self as unknown as Parameters<typeof registerPushHandlers>[0]);
registerDefaultRoutes({
  registerRoute,
  NetworkOnly,
  CacheFirst,
  ExpirationPlugin,
  CacheExpiration,
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  manifest: self.__WB_MANIFEST,
  scope: self as unknown as Parameters<typeof registerDefaultRoutes>[0]["scope"],
});
```

`registerShareTarget` intercepts the manifest's `POST /share-target`, stashes
the payload locally, and redirects to the app. That payload is untrusted input:
the share flow must show it to the user for confirmation and must never act on
it automatically. Its optional argument sets `path` and `landingPath`.
`registerPushHandlers` wires push notifications, notification clicks, and
subscription renewal; its optional second argument sets `subscribeUrl` and
`defaultUrl`.
`registerDefaultRoutes` owns the lifecycle and route policy while keeping
Workbox in the deployment shell: the shell injects its registrars, strategies,
expiration classes and precache manifest. It purges legacy API bodies and
Workbox expiration metadata, keeps `/api` network-only ahead of the asset
cache, and falls back from navigation network to the precached shell to the
offline page.

## Versioning

The protocol is a compatibility contract: additive changes only, unknown fields
must be preserved, and `server_hello.protocolRev` announces the revision.

## Speaking the protocol

`@schlessera/brain-ui-sdk/client` exports `BrainUiClient`: socket lifecycle
(1s-doubling backoff to 30s, `reconnectNow`), validated inbound frames,
`server_hello` capture, `turnId` echo on turn-scoped replies, and an optional
`onClose` report with the close code, reason, and whether that attempt ever
opened. It has no React, no DOM beyond `WebSocket`, and takes a `socketFactory`
so it is testable with no network.

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
