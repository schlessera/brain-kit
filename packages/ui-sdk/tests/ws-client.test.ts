/**
 * `BrainUiClient` (F3 / W2), driven through an injected fake socket.
 *
 * The `socketFactory` option exists for exactly this: the whole client is
 * exercisable with no network, no browser and no React, which is the property
 * that made moving it out of `ui-react` worth doing.
 */
import { describe, expect, test } from "bun:test";

import {
  BrainUiClient,
  PROTOCOL_REV,
  type ProtocolError,
  type ServerMessage,
  type WebSocketClose,
} from "../src/client/index.js";

/** A WebSocket stand-in the test drives directly. */
class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  /** Test helper: complete the handshake. */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Test helper: deliver a frame. */
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  /** Test helper: deliver raw text that may not be JSON. */
  deliverRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function setup(handlers: Parameters<typeof makeClient>[0] = {}) {
  return makeClient(handlers);
}

function makeClient(handlers: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const errors: ProtocolError[] = [];
  const closes: WebSocketClose[] = [];
  const client = new BrainUiClient({
    url: "ws://test/ws",
    handlers: handlers as never,
    onStatusChange: (s) => statuses.push(s),
    onProtocolError: (e) => errors.push(e),
    onClose: (close) => closes.push(close),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  client.connect();
  const socket = sockets[0];
  socket.open();
  // The client announces itself on open (rev 3). Assertions are about what the
  // test sent, so the handshake is filtered out rather than counted.
  const replies = () =>
    socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type !== "client_hello");
  return { client, socket, sockets, statuses, errors, closes, replies };
}

describe("socket closes", () => {
  test("reports the close code and reason when an attempt never opened", () => {
    const sockets: FakeSocket[] = [];
    const closes: WebSocketClose[] = [];
    const client = new BrainUiClient({
      url: "ws://test/ws",
      onClose: (close) => closes.push(close),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    client.connect();
    sockets[0]!.close(1006, "upgrade refused");

    expect(closes).toEqual([{ code: 1006, reason: "upgrade refused", opened: false }]);
    client.close();
  });

  test("reports that an opened socket reached open before closing", () => {
    const { client, socket, closes } = setup({});

    socket.close(4008, "Connection limit reached");

    expect(closes).toEqual([
      { code: 4008, reason: "Connection limit reached", opened: true },
    ]);
    client.close();
  });
});

describe("dispatch", () => {
  test("a valid frame reaches its typed handler", () => {
    const seen: ServerMessage[] = [];
    const { socket } = setup({ text_delta: (f: ServerMessage) => seen.push(f) });

    socket.deliver({ type: "text_delta", text: "hello", sessionId: "s1" });

    expect(seen).toEqual([{ type: "text_delta", text: "hello", sessionId: "s1" }]);
  });

  test("onAny sees every frame, before the typed handler", () => {
    const order: string[] = [];
    const { socket } = setup({
      onAny: () => order.push("any"),
      status: () => order.push("typed"),
    });

    socket.deliver({ type: "status", status: "idle", sessionId: "s1" });

    expect(order).toEqual(["any", "typed"]);
  });

  test("an onAny-only consumer is never told its frames went unhandled", () => {
    // ui-react dispatches this way: one handler with a shared preamble that
    // resolves which session buffer the frame belongs to.
    const seen: string[] = [];
    const { socket, errors } = setup({ onAny: (f: ServerMessage) => seen.push(f.type) });

    socket.deliver({ type: "status", status: "idle", sessionId: "s1" });
    socket.deliver({ type: "text_delta", text: "x", sessionId: "s1" });

    expect(seen).toEqual(["status", "text_delta"]);
    expect(errors).toEqual([]);
  });

  test("a frame with no handler is reported, not thrown", () => {
    const { socket, errors } = setup({});

    socket.deliver({ type: "status", status: "idle", sessionId: "s1" });

    expect(errors).toEqual([
      { reason: "unhandled", detail: "no handler registered", frameType: "status" },
    ]);
  });
});

describe("validation", () => {
  test("a malformed frame is dropped and reported, never thrown", () => {
    const seen: unknown[] = [];
    const { socket, errors } = setup({ onAny: (f: unknown) => seen.push(f) });

    expect(() => socket.deliverRaw("{not json")).not.toThrow();

    expect(seen).toEqual([]);
    expect(errors[0].reason).toBe("parse_error");
  });

  test("an unknown frame type is dropped rather than crashing an old client", () => {
    // The additive contract: a rev-3 server must not break a rev-2 client.
    const { socket, errors } = setup({ onAny: () => {} });
    socket.deliver({ type: "invented_later", payload: 1 });
    expect(errors[0].reason).toBe("parse_error");
  });

  test("the reported detail never carries the frame body", () => {
    const { socket, errors } = setup({});
    socket.deliverRaw('{"type":"text_delta","text":"SECRET-PAYLOAD"');
    expect(JSON.stringify(errors)).not.toContain("SECRET-PAYLOAD");
  });
});

describe("server_hello", () => {
  test("is captured, so protocolRev stops being advisory", () => {
    const { client, socket } = setup({});
    expect(client.protocolRev).toBeNull();

    socket.deliver({
      type: "server_hello",
      protocolRev: 2,
      capabilities: { multiSession: true, askUser: false },
    });

    expect(client.protocolRev).toBe(2);
    expect(client.capabilities.multiSession).toBe(true);
    expect(client.capabilities.askUser).toBe(false);
  });

  test("is forgotten on disconnect — a new connection re-negotiates", () => {
    const { client, socket } = setup({});
    socket.deliver({ type: "server_hello", protocolRev: 2, capabilities: { a: true } });
    socket.close();

    expect(client.protocolRev).toBeNull();
    expect(client.capabilities).toEqual({});
    client.close();
  });
});

describe("turnId echo", () => {
  test("a reply carries the turn id the server stamped", () => {
    // The host verifies an echo when present; before this, no shipped client
    // sent one, so the check could never fire.
    const { client, socket, replies } = setup({ tool_approval_request: () => {} });

    socket.deliver({
      type: "tool_approval_request",
      toolUseId: "t1",
      toolName: "Write",
      input: {},
      sessionId: "s1",
      turnId: "turn-9",
    });
    client.send({ type: "tool_approval", toolUseId: "t1" } as never);

    expect(replies()).toEqual([
      { type: "tool_approval", toolUseId: "t1", turnId: "turn-9" },
    ]);
  });

  test("frames that are not replies are left alone", () => {
    const { client, socket, replies } = setup({ text_delta: () => {} });
    socket.deliver({ type: "text_delta", text: "x", sessionId: "s1", turnId: "turn-9" });

    client.send({ type: "chat_message", content: "hi" } as never);

    expect(replies()[0].turnId).toBeUndefined();
  });

  test("a reply echoes ITS OWN request's turn, not the latest one seen", () => {
    // Parallel sessions: an unrelated turn's frames arrive between the request
    // and the answer. Tracking only "the most recent turn id" sent the wrong
    // one, the host's echo check refused it, and the turn waited for an
    // approval that could never be accepted — invisible until the timeout.
    const { client, socket, replies } = setup({ tool_approval_request: () => {}, text_delta: () => {} });

    socket.deliver({
      type: "tool_approval_request",
      toolUseId: "tool-A",
      toolName: "Write",
      input: {},
      sessionId: "session-A",
      turnId: "turn-A",
    });
    // Session B is streaming at the same time.
    socket.deliver({ type: "text_delta", text: "b", sessionId: "session-B", turnId: "turn-B" });

    client.send({ type: "tool_approval", toolUseId: "tool-A" } as never);

    expect(replies()[0].turnId).toBe("turn-A");
  });

  test("two concurrent requests each get their own turn back", () => {
    const { client, socket, replies } = setup({ tool_approval_request: () => {}, ask_user_request: () => {} });

    socket.deliver({
      type: "tool_approval_request",
      toolUseId: "tool-A", toolName: "Write", input: {},
      sessionId: "sA", turnId: "turn-A",
    });
    socket.deliver({
      type: "ask_user_request",
      requestId: "req-B",
      questions: [{ question: "q", header: "h", multiSelect: false, options: [{ label: "l", description: "d" }] }],
      sessionId: "sB", turnId: "turn-B",
    });

    client.send({ type: "ask_user_response", requestId: "req-B", answers: {} } as never);
    client.send({ type: "tool_approval", toolUseId: "tool-A" } as never);

    expect(replies()[0].turnId).toBe("turn-B");
    expect(replies()[1].turnId).toBe("turn-A");
  });

  test("a reply to an unknown request carries no id rather than a wrong one", () => {
    const { client, socket, replies } = setup({ text_delta: () => {} });
    socket.deliver({ type: "text_delta", text: "x", sessionId: "s1", turnId: "turn-9" });

    client.send({ type: "tool_approval", toolUseId: "never-requested" } as never);

    expect(replies()[0].turnId).toBeUndefined();
  });

  test("an explicit turnId on the outbound frame wins", () => {
    const { client, socket, replies } = setup({ text_delta: () => {} });
    socket.deliver({ type: "text_delta", text: "x", sessionId: "s1", turnId: "turn-9" });

    client.send({ type: "tool_approval", toolUseId: "t1", turnId: "explicit" } as never);

    expect(replies()[0].turnId).toBe("explicit");
  });
});

describe("the client hello", () => {
  test("is the first frame out, declaring the revision this client speaks", () => {
    // Without it a host cannot tell a current client from an old one, and so
    // could never require a field without breaking the old one.
    const { socket } = setup({});
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "client_hello",
      protocolRev: PROTOCOL_REV,
    });
  });
});

describe("lifecycle", () => {
  test("send reports failure rather than dropping silently", () => {
    // A caller that just staged an upload needs to know it did not go out.
    const { client, socket } = setup({});
    expect(client.send({ type: "cancel", sessionId: "s1" } as never)).toBe(true);

    socket.readyState = 3;
    expect(client.send({ type: "cancel", sessionId: "s1" } as never)).toBe(false);
  });

  test("status transitions are reported in order", () => {
    const { statuses } = setup({});
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  test("a deliberate close does not reconnect", () => {
    const { client, sockets } = setup({});
    client.close();
    expect(sockets.length).toBe(1);
  });
});

describe("form turn echo", () => {
  test("a form response and dismissal echo their own requests despite interleaved sessions", () => {
    const { client, socket, replies } = setup({ ask_user_form_request: () => {}, text_delta: () => {} });
    const nodes = [{ id: "n", kind: "text", prompt: "Why?" }];
    socket.deliver({ type: "ask_user_form_request", requestId: "form-A", prompt: "Notes", nodes, sessionId: "A", turnId: "turn-A" });
    socket.deliver({ type: "ask_user_form_request", requestId: "form-B", prompt: "Notes", nodes, sessionId: "B", turnId: "turn-B" });
    socket.deliver({ type: "text_delta", text: "Other", sessionId: "C", turnId: "turn-C" });
    client.send({ type: "ask_user_form_response", requestId: "form-A", answers: { n: "Useful" } });
    client.send({ type: "ask_user_cancel", requestId: "form-B", reason: "Dismissed" });
    expect(replies()).toEqual([
      { type: "ask_user_form_response", requestId: "form-A", answers: { n: "Useful" }, turnId: "turn-A" },
      { type: "ask_user_cancel", requestId: "form-B", reason: "Dismissed", turnId: "turn-B" },
    ]);
    client.close();
  });
});
