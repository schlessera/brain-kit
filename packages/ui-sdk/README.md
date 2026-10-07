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

Use `parseServerMessage` for inbound server frames. It preserves valid own
sequence-map entries in Inbox and Activity snapshots, including `__proto__`,
without changing the map's prototype. It validates these values with the
existing snapshot rules. Direct parsing with the exported Zod record schemas
retains upstream Zod's behavior of dropping `__proto__`; the server-frame
boundary restores that entry safely.

Durable Queue/Actions definitions are additive: `InboxThread`, `InboxItem`,
`InboxChange`, `InboxSnapshot`, `InboxDelta`, separate Queue/Action statuses,
and the six-kind `ResolutionEffect`. New `inbox_resolve`, `inbox_snooze`,
`inbox_subscribe` and `inbox_unsubscribe` commands pass through the actual parser
with strict unknown-field rejection. Existing frames and server projections
keep their additive parsing policy. Subscribe only when `server_hello`
advertises `capabilities.inbox`; the current host/client do not wire the stream.

Model-submitted effects use `resolutionEffectSchema`; v1 creation/application
uses `v1ResolutionEffectSchema` or `validateResolutionEffect` with server-owned
exact permitted operations. `write_policy` and `open_session` are deferred data
variants and fail v1 validation. Neither a parsed effect nor an operation
request grants authority. See the [durable wire contract](../../docs/integration-contract.md#durable-queue-and-actions-additive)
for payloads, state vocabularies and ordering.

## Backend seam (`./server`)

`AgentBackend` is the interface a model integration implements
([`@schlessera/brain-backend-pi`](../ui-backend-pi), [`@schlessera/brain-backend-claude`](../ui-backend-claude)):
`startTurn` streams protocol frames, the host owns the per-turn
`AbortController`, and mutating tools gate through `bridge.requestPermission`.
`BackendCapabilities` is honest by contract — `permissions: true` means a deny
actually blocks a mutation, and the shared contract test suite enforces it for
every in-tree backend. The transcript store persists session metadata without
prescribing storage for the transcripts themselves (backends own those).

`BackendModule.probeRuntime?(context): Promise<BackendRuntimeReport>` is the
optional asynchronous startup check. The host awaits it before opening app
resources. `BackendRuntimeReport.runtime` is present for separately spawned
executables; an in-process backend may report only its `sdk` identity. Pi uses
that SDK-only report without inventing an executable or measurement result. Descriptor authors migrating from the synchronous signature use
`async probeRuntime(context)` and reject to refuse startup. The shared
`probeVersionCommand` runs a version argv with the five-second deadline,
250 ms cleanup budget and explicit `cleanupWarnings`; it does not decide the
backend's version policy. Its optional `signal` lets an invocation check
share a request's cancellation/deadline, with the same bounded cleanup. `killWrapped` accepts optional bounded helper
handling for these probes; omitting it retains turn cancellation behavior.

`BackendModuleContext.versionRequirements?: BackendVersionRequirements`
carries the host's optional `{ sdk?: string; runtime?: string }` full SemVer
minima to probing and construction. Compose these with package-owned bounds
using `assertVersionRequirements({ identity, version, requirements, phase,
action, unknownReason? })`. Each requirement retains its `owner`, original
`declaration` and `kind: "range" | "minimum"`. The helper rejects invalid
declarations, conflicting requirements, unknown identities and versions that
do not satisfy every owner. It preserves range upper bounds, OR grouping,
build metadata precedence and each declaration's prerelease tuple opt-in.
`validateVersionMinimum(value, owner, identity)` validates full ASCII minima
without coercion. Both helpers ship in `./server` with a runtime dependency on
node-semver; they perform no I/O or package resolution. Resolve the actual SDK
copy beside the importing backend, and probe the executable that will run.

The supported permission toolkit is `decideToolPermission`,
`createToolPermissionRequest`, `requestToolPermission`, `checkEditedApproval`
and `compileConfirmPatterns`, with their signature types. Use the
[authoring workflow](../../docs/extending/agent-backends.md#the-public-permission-toolkit)
to gate execution and check approved edits. The toolkit is experimental until
1.0; its documented behavior and reachable types are included in the supported
surface. Bundled defaults and subprocess-policy helpers moved to `/internal`,
which has no compatibility guarantee. The
[classification and migration table](../../docs/decisions/backend-authoring-toolkit.md#inventory)
names every affected import. Subscription-auth helpers remain protocol API.

The existing coastline geometry helpers/types and `fetchCoastline` under `./server`
are compatibility exports from [`@schlessera/brain-geo`](../geo). The geometry
pipeline and result-or-empty shape are preserved; service requests now share its
disk cache and aggregate operator admission. Existing endpoint/User-Agent/timeout
settings still work. `CoastlineConfig.geo` can supply canonical endpoint/cache
settings, and `admissionDir` can select the shared runtime admission path.
`enabled:false` always prevents requests. The [geo guide](../geo/README.md#coastline-land-and-roads)
documents bounds, refusal handling, attribution and caller responsibilities.

`reverseGeocode(coords, config)` also uses the shared client and retains its
`{displayName, summary, address} | null` result. Required `enabled`, `url` and
`userAgent` settings remain; optional `geo` supplies canonical configuration.
`enabled:false` always prevents requests. Public Nominatim requires explicit
`publicServiceEligible:true` (or the canonical geocoding setting), after checking
the [public-service policy](https://operations.osmfoundation.org/policies/nominatim/).
This flag grants no permission: bulk/autocomplete/systematic use and generic
LLM-platform offerings are excluded. Configure a suitable endpoint for such uses.
Without eligibility, or after a service/validation failure, the wrapper returns
`null` and the location bridge still returns raw coordinates. Successful responses
share the endpoint/exact-coordinate disk cache; transient failures are not cached
as empty locations. Reverse addresses describe a nearby mapped object and have
unverified accuracy.

`GeoConfig`, `GeoConfigInput` and `geoConfigSchema` are re-exported from `./server`
for canonical adapter authoring/validation. They are the geo library's concrete
configuration, with no additional provider seam.

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
  permission: (scenario) => createExamplePermissionProbe(scenario),
  scripted: (script) => createExampleBackend({ runtime: scriptedRuntime(script) }),
  hanging: () => createExampleBackend({ runtime: hangingRuntime() }),
  failing: (script) => createExampleBackend({ runtime: failingRuntime(script) }),
  unknownProfileId: "no-such-profile",
};

runBackendContract(harness, { describe, test, expect });
```

`permission(scenario)` is required. Its scripted runtime attempts one tool
through the adapter's actual permission path: `mutation` is off the allowlist,
`shortcut` is off it but the runtime would normally auto-approve it, and
`command` is allowlisted but requires command confirmation. Return the backend,
its `toolName` and `toolUseId`, and `starts()`, `attempts()` and `effects()` observations. Observe
the tool body's effect on a fixture; a denial frame alone cannot prove it did
not run. An allowing bridge must let that same body run.

The suite checks both restricted-turn fields for every backend, independently
of capability flags. A backend must enforce them or reject an unsupported turn
with `BackendRequestError` before starting its runtime, emitting frames or
producing effects. `noGrantSurface` requires `enforceAllowedTools: true`, denies
both tool grants and command confirmations promptly, and never waits on an
unanswerable bridge request. Ordinary turns keep their existing defaults.
Both first-party adapters additionally prove actual enforcement; rejecting all
restricted turns is not enough for them.

`runBackendModuleContract` also checks a descriptor passed through
`defineBackendModule`: supply the actual `module`, a nonempty
`validProfilesJson` with backend-specific fields, its expected `profileIds`, and
a keyless `context()` without profiles. It checks parsing, resolution with
default (`null`) and disabled (`[]`) confirmation patterns, profile preservation,
typed invalid-JSON errors and collisions with an occupied profile id. No live
turn is started by descriptor tests.

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

### Supporting files in an answer

`show_block` accepts `{block:{kind:"files",items:[{path:"knowledge/scylla.md",reason:"Names the cost in men."}]}}`. The list has 1–20 entries; paths are exact brain-relative strings (1–1024 characters), and optional plain-text reasons have at most 240 characters. Reasons are the agent's claims. The tool validates and echoes data without reading a file or inventing retrieval scores; the reader can open a permitted local path in the current root.

`show_block` also accepts `graph`: two to twenty labelled nodes and zero to
forty index-pair edges. The agent supplies topology, optional brain paths,
focus and tones; the client chooses coordinates. Self-loops and invalid
indices are refused, duplicates are removed, and the first focus wins.
The host echoes these claims without looking them up.
