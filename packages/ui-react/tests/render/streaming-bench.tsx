// Streaming-latency benchmark for the chat surface.
//
//   bun run tests/render/streaming-bench.tsx [deltas]
//
// Seeds the chat store with N already-finished messages, mounts <ChatPage/>,
// then streams text deltas into a new assistant turn the way the WebSocket
// does — one store write per delta, each in its own act() because socket
// frames arrive in separate macrotasks and React cannot batch across them.
//
// It reports what one delta costs. The number to watch is how that scales with
// N: only the streaming message changes, so a delta that costs more the longer
// the conversation gets means finished messages are re-rendering for nothing.
//
// Not a test. See typing-bench.tsx for the happy-dom containment note.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({ entries: [], providers: [], backends: {}, slugs: {}, models: [] }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;
class DeadSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  constructor(_url: string) {}
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { WebSocket?: unknown }).WebSocket = DeadSocket;

const log = console.error.bind(console);
console.error = () => {};

const React = await import("react");
const { render, cleanup, act } = await import("@testing-library/react");
const { ChatPage } = await import("../../src/components/chat/chat-page.js");
const { useChatStore } = await import("../../src/stores/chat-store.js");
const { useConnectionStore } = await import("../../src/stores/connection-store.js");

const BODY = `## Section heading

Prose with \`inline code\`, a [link](https://example.com) and a path \`docs/decisions.md\`.

- bullet one
- bullet two with **bold** and _emphasis_

\`\`\`ts
export function foo(a: number, b: string): string {
  const xs = [1, 2, 3].map((n) => n * a);
  return xs.join(b);
}
\`\`\`

Trailing prose so the message resembles a real assistant turn.
`;

// Roughly one model token per delta.
const CHUNKS = [
  "The ",
  "brain ",
  "repo ",
  "tracks ",
  "notes ",
  "under ",
  "`docs/`",
  ".\n\n",
  "- one\n",
  "- two\n",
];

function seed(count: number): void {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: i % 2 === 0 ? `Question number ${i} about docs/decisions.md` : BODY,
    toolCalls: [],
    parts: [{ kind: "text", text: i % 2 === 0 ? `Question ${i}` : BODY }],
    isStreaming: false,
    timestamp: 0,
  }));
  useChatStore.setState({
    activeSessionId: null,
    draft: { messages, isStreaming: false, askUser: null, lastTouched: 0 },
  } as never);
}

function measure(messageCount: number, deltas: number) {
  seed(messageCount);
  let commitMs = 0;
  let commits = 0;
  const onRender = (_id: string, _phase: string, actual: number) => {
    commitMs += actual;
    commits++;
  };

  render(
    React.createElement(React.Profiler, { id: "chat", onRender }, React.createElement(ChatPage))
  );
  act(() => {
    useConnectionStore.setState({ wsStatus: "connected" } as never);
    useChatStore.getState().startAssistantMessage(null);
  });

  commitMs = 0;
  commits = 0;
  const t0 = performance.now();
  for (let i = 0; i < deltas; i++) {
    // One act() per delta: socket frames do not share a macrotask, so React
    // gets no chance to batch them.
    act(() => {
      useChatStore.getState().appendText(null, CHUNKS[i % CHUNKS.length]);
    });
  }
  const wallMs = performance.now() - t0;
  cleanup();

  return {
    messageCount,
    commitMs: commitMs / deltas,
    wallMs: wallMs / deltas,
    commits: commits / deltas,
  };
}

const DELTAS = Number(process.argv[2] ?? 20);
measure(6, 5); // warm the JIT and the module graph

log("messages | commit ms/delta | wall ms/delta | commits/delta");
log("---------|-----------------|---------------|--------------");
for (const n of [0, 10, 40, 100]) {
  const r = measure(n, DELTAS);
  log(
    `${String(r.messageCount).padStart(8)} | ${r.commitMs.toFixed(2).padStart(15)} | ` +
      `${r.wallMs.toFixed(2).padStart(13)} | ${r.commits.toFixed(2).padStart(13)}`
  );
}
process.exit(0);
