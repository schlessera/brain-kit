---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

**Breaking (types, #3389):** `pong` is no longer a frame a consumer can handle. `BrainUiClient` answers its own liveness probes and never handed a `pong` on, so `ServerFrameHandlers` (from `@schlessera/brain-ui-sdk/client`) is now keyed on the new `ConsumerServerMessage` union, which is every `ServerMessage` except `ServerPong`, and its `onAny` receives a `ConsumerServerMessage`.

Migration: delete any `pong` handler you pass in `handlers`; it was never called. A consumer that types its frame handling as `ServerMessage` keeps compiling. To call such code from `onAny`, nothing changes, because a `ConsumerServerMessage` is a `ServerMessage`. Code that switches exhaustively over the frames a handler receives can drop its `pong` case.

Nothing changes on the wire. The host still answers `ping` with `pong`, and `ServerMessage`, `ServerPong` and `parseServerMessage` still include it.

In `@schlessera/brain-ui-react`, the server-frame handler map is now the only router for the voice conversation's own frames: `dialogue_history`, `tool_resolution` and the six `conversation_*` frames reach the conversation client through their map entries, not through its prefilter. The conversation client (`root.connection.conversation`) gains `receive(frame)` for those frames, and `frame()` now passes them through unchanged. Its `permissions` gains `resolution(frame)` for `tool_resolution`, which `permissions.frame()` no longer reads. Nothing changes for the person using voice.
