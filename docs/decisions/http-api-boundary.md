# Supported HTTP routes and internal UI transport

The [maintainer's 2026-09-28 ruling on #343 Q6](https://github.com/schlessera/brain-kit/issues/343#issuecomment-5865944205)
chooses an explicit supported HTTP API before 1.0. A route's mount prefix or
unauthenticated accessibility does not decide compatibility. Independent
clients need documented authentication, inputs, outputs, errors and behavior;
freezing every UI transport would make ordinary implementation changes into
API migrations.

## Selection policy

[docs/http-api.md](../http-api.md) is the complete method/path inventory and
supported specification, incorporated by the
[integration contract](../integration-contract.md#ui-server-http-routes).
It selects 47 of 85 currently declared method/path pairs; 38 are internal,
alongside the conditional static fallback. Selection rests on two grounds:

1. Preserve an existing documented machine or SDK promise. This includes
   stats and runtime status, owner/delegated credentials, model catalog and
   visibility, the renderer seam, SDK HTTP payloads, push renewal, share-target
   behavior, map geometry and WebSocket admission. Runtime/client mismatch
   does not silently erase the promise.
2. Deliberately offer a coherent independent read/capture interface: corpus
   search/list/briefing, file content, sessions/history, execution reads, index
   recovery and the existing sync stream. Specify their actual current
   limitations rather than promising a redesign or uniform error framework.

Presentation and administrative transports remain internal where an independent
HTTP integration role has not been selected: graph view assembly, file-browser
navigation, digest/inbox presentation, skill editing, backend OAuth/configuration,
model preferences/pricing freshness, remembered-grant settings, the reachability
hint and the repo-local whatsup script. An internal designation excludes the
raw HTTP method/path/payload from independent-consumer guarantees. It does not
remove an existing CLI/MCP/SQL, module, permission, content-format or ordinary
public TypeScript guarantee.

The React package's published `createBrainApi` and embedding services remain
public functions. They use some internal transports and must keep working when
those transports change; client and server implementation move together, with
the public function signature/behavior assessed separately. A documentation
label cannot hide an ordinary export or waive a public API break: #534 owns
that separate export audit. SDK service-worker and socket dependencies are
explicit supported rows, not silently excluded by this distinction.

## Evidence behind the boundary

The source audit on 2026-09-30 used
`e0875269b21b707482545be9e94901acb897893b`. The public health mount precedes auth
(`createHealthRoutes`, `packages/ui-server/src/app.ts:484`), the API guard follows
public ceremonies (`authGuard`, `packages/ui-server/src/app.ts:504`), and the
WebSocket admission is separate (`"/ws"`, `packages/ui-server/src/app.ts:599`).
Static serving is conditional (`if (options.staticRoot)`,
`packages/ui-server/src/app.ts:619-645`). That order establishes access;
it does not select compatibility status.

A hermetic real-app launch, with temporary brain root, in-memory database,
recording observability, disabled pricing discovery and fake backend registry,
observed 85 unique declared method/path pairs. A staticRoot launch added only
normalized `GET /*` (the source declares `"*"`); wildcard middleware was
accounted for separately. The app answered
public health 200, bodyless health HEAD 200, share-target 303 without reading
its payload, and authenticated non-upgrade `/ws` 400. The specification also
accounts for Hono's implicit HEAD and configured CORS preflight behavior.
These counts describe this audit, not a rule preventing additive endpoints.

The SDK worker itself fetches its configured subscription endpoint
(`subscribeUrl`, `packages/ui-sdk/src/client/push-handlers.ts:72`), and the
share handler's default is explicit (`DEFAULT_SHARE_TARGET_PATH`,
`packages/ui-sdk/src/client/share-target.ts:45`). The published React entry
exports its REST adapter (`createBrainApi`, `packages/ui-react/src/index.ts:72`).
Tracing those consumers prevented a supported feature's dependency being
mistaken for an unpromised private route.

## Versioning and changes

Supported HTTP methods, paths, authorization requirements, accepted inputs,
response shapes, status/error semantics and specified behavior follow the
[existing machine-contract rules](contract-versioning.md). Additions ship in
minors. Before 1.0, a break requires a prior maintainer ruling on its issue,
`breaking`, a changeset naming the break, `CONTRACT:` and a same-commit contract
update; it ships in a minor. From 1.0 a break requires a major. Internal
transport can evolve while its paired published functionality keeps working.

This inventory neither freezes all routes nor schedules 1.0. It introduces no
runtime change, new auth mode, URL version namespace or API framework. #539
expressly authorizes a documentation spike without a changeset. Proposed
consolidations or fixes that break an inherited promise still need their own
ruling before implementation. The tracker owns incomplete implementation and
verification work; the specification records observed limitations beside the
preserved promise.

## Alternatives rejected

- **Everything under /api is supported.** Prefixing establishes middleware,
  not purpose. It would freeze backend settings editors and presentation
  queries and miss the SDK's /share-target and /ws dependencies outside it.
- **Only unauthenticated routes are public contracts.** Authentication protects
  corpus and execution data; it says nothing about whether an independent
  authenticated client can rely on that data's API.
- **All HTTP is internal because the UI ships in lockstep.** Independent socket,
  PWA and monitoring clients already have documented SDK/HTTP promises. Shared
  package versions do not remove them.
- **List URLs now and define semantics later.** A client needs to distinguish
  sync's admitted SSE failure from a pre-stream 409, a pruned run from a 404,
  and a disabled renderer from a malformed request. URL-only stability would
  leave those compatibility questions unanswered.
- **Redesign routes to make this audit uniform.** Existing quirks and errors
  can be specified and tracked. Changing them during an inventory would exceed
  the ruling and conceal the compatibility decision that implementation needs.
