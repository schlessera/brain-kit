---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-server": minor
---

Move the client half of the wire protocol into the SDK, and validate both
directions.

`ui-sdk` described itself as owning the protocol while its `./client` subpath
held only two registries: the actual transport was `ui-react`'s
`ws-client.ts`, which cast every inbound frame, and dispatch handled 15 of the
16 server frame types inside a React hook. Any non-React consumer — a CLI, a
mobile shell, an integration test — reimplemented reconnection, framing and
validation from scratch.

- **`parseServerMessage`** validates server→client frames, with one schema per
  member bound to its interface by `satisfies` so the two cannot drift. The
  receiving policy is softer than the server's on purpose: a frame that fails
  is DROPPED and reported, never thrown, because the protocol is additive and a
  client that hard-fails an unrecognised frame turns every additive server
  change into a breaking one. Unknown keys survive the boundary.
- **`BrainUiClient`** (`@schlessera/brain-ui-sdk/client`) is the transport:
  the same backoff and `reconnectNow` as before, plus validation,
  `server_hello` capture — so `protocolRev` and capabilities are readable
  rather than advisory — and `turnId` echo on turn-scoped replies, which finally
  gives the host's echo verification something to verify. A `socketFactory`
  option makes it testable with no network.
- **`ui-react`** keeps every store write and becomes a handler set.
  `ws-client.ts` is deleted; `handleServerMessage` and `runStateForFrame` keep
  their signatures.
- **`error` frames are no longer dropped outside a turn.** The old handler only
  appended to a streaming transcript, so an error between turns went nowhere —
  no console, no store, no UI. `useConnectionStore` gained `lastError`, and
  protocol-level drops land there too.
- **A real-socket integration test** drives `BrainUiClient` against a real
  `createApp()`, closing the ROADMAP item about the auth boot refusal never
  being exercised through a socket. It is also the first test that would catch
  a client/server protocol drift, since both shipped implementations are on
  opposite ends of it.

The frame parsers no longer use Node's `Buffer` — they accept
`string | ArrayBufferView | ArrayBuffer` and measure UTF-8 length with
`TextEncoder`. Both parsers now run on both ends of the socket, and the client
end is a browser bundle; the build caught this the moment `ui-react` imported
the SDK client.

`turnId` is still not REQUIRED — that is a protocol-rev change with a
deprecation window, deliberately out of scope.
