---
"@schlessera/brain-ui-react": minor
---

Chat surface performance: typing and streaming no longer scale with the length of the conversation.

Typing a character re-rendered every message in the transcript, and each one rebuilt its markdown from scratch — react-markdown constructs a new unified processor per render. Streaming had the same shape, once per token. Both costs grew linearly with the conversation.

- The composer is its own component, so a keystroke never reaches the message list. The command palette is derived during render rather than through an effect, and the textarea grows by CSS instead of reading `scrollHeight` (a forced document layout on every keystroke).
- `MessageBubble` and the markdown renderer are memoized, and the remark/rehype plugin lists are module constants.
- Streamed text and thinking deltas are coalesced into one store write per animation frame. Ordering is preserved on both sides: a kind change starts a new chunk, and any non-delta frame flushes the queue before it is handled.
- Closed panels render nothing, and the file panel no longer keeps the file tree mounted behind the chat page.
- Offscreen message bodies get `content-visibility: auto`.
- The transcript renders a window of 40 messages with a "show earlier" control that preserves scroll position.
- Syntax highlighting, the graph and activity surfaces, the settings tabs and the file panel load on first use. `GraphPage` and `ActivityPage` carry their own Suspense boundary, so consumers need no change.

Measured per keystroke at 100 messages: 118.69 ms of React commit time down to 0.15 ms. Per streamed delta at 100 messages: 107.90 ms down to 0.84 ms. Mounting a 400-message transcript: 510 ms down to 65 ms. Entry bundle: 344 KB gzipped down to 265 KB.
