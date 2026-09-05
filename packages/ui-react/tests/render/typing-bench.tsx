// Typing-latency benchmark for the chat surface.
//
//   bun run tests/render/typing-bench.tsx [keystrokes]
//
// Seeds the chat store with N messages, mounts <ChatPage/>, types into the
// composer, and reports what one keystroke costs: React commit time (Profiler
// actualDuration), wall time, and how many commits React needed. The number
// that matters is how those scale with N — a composer that costs more to type
// in the longer the conversation gets is the regression this guards.
//
// Not a test (nothing is asserted), but it lives beside the render tests
// because it needs the same happy-dom registration contract — see dom.ts. It
// registers the DOM itself rather than importing dom.js, so running it can
// never leave a DOM behind for a test file.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Render cost is the subject; transport is not. Every request answers with an
// empty-but-well-shaped payload, and the socket never connects.
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

// console.error is React's act() channel; keep a clean handle for output.
const log = console.error.bind(console);
console.error = () => {};

const React = await import("react");
const { render, fireEvent, cleanup, act } = await import("@testing-library/react");
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

| col a | col b |
|-------|-------|
| 1     | 2     |

Trailing prose so the message resembles a real assistant turn.
`;

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

function measure(messageCount: number, keystrokes: number) {
  seed(messageCount);
  let commitMs = 0;
  let commits = 0;
  const onRender = (_id: string, _phase: string, actual: number) => {
    commitMs += actual;
    commits++;
  };

  const view = render(
    React.createElement(React.Profiler, { id: "chat", onRender }, React.createElement(ChatPage))
  );
  // useWebSocket's mount effect owns wsStatus, so force "connected" AFTER
  // mount — the composer is disabled until the socket is up.
  act(() => {
    useConnectionStore.setState({ wsStatus: "connected" } as never);
  });

  // Other textareas are on the page (the Add panel has one), so select the
  // composer by its auto-grow wrapper.
  const textarea = view.baseElement.querySelector<HTMLTextAreaElement>(
    ".composer-grow textarea"
  );
  if (!textarea) throw new Error("composer textarea not found");
  if (textarea.disabled) throw new Error("composer is disabled; nothing would be measured");

  // Mount cost is not typing cost.
  commitMs = 0;
  commits = 0;
  const t0 = performance.now();
  for (let i = 0; i < keystrokes; i++) {
    fireEvent.change(textarea, { target: { value: "x".repeat(i + 1) } });
  }
  const wallMs = performance.now() - t0;
  if (textarea.value.length !== keystrokes) {
    throw new Error(`composer never received input (value=${JSON.stringify(textarea.value)})`);
  }
  cleanup();

  return {
    messageCount,
    commitMs: commitMs / keystrokes,
    wallMs: wallMs / keystrokes,
    commits: commits / keystrokes,
  };
}

const KEYS = Number(process.argv[2] ?? 6);
measure(6, 4); // warm the JIT and the module graph

log("messages | commit ms/key | wall ms/key | commits/key");
log("---------|---------------|-------------|------------");
for (const n of [0, 10, 40, 100]) {
  const r = measure(n, KEYS);
  log(
    `${String(r.messageCount).padStart(8)} | ${r.commitMs.toFixed(2).padStart(13)} | ` +
      `${r.wallMs.toFixed(2).padStart(11)} | ${r.commits.toFixed(2).padStart(11)}`
  );
}
process.exit(0);
