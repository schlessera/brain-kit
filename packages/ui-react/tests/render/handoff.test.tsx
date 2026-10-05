// The cross-backend handoff review (#61), rendered against a real root whose
// socket is fake: what is asserted is the frames this client sent, what the
// sheet shows, and the store it leaves behind.
import { unregisterHandoffDom } from "./handoff-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

// `screen` binds to the document at import, before this file registers one.
const screen = { get q() { return within(document.body); } };
import { composeHandoffText } from "@schlessera/brain-ui-sdk/protocol";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { HandoffSheet } from "../../src/components/chat/handoff-sheet.js";
import { HandoffCard } from "../../src/components/chat/handoff-links.js";
import type { ChatMessage } from "../../src/stores/chat-state.js";

afterEach(cleanup);
afterAll(unregisterHandoffDom);

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor() { FakeSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  frames(): Array<Record<string, any>> { return this.sent.map((raw) => JSON.parse(raw)); }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => { globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket; });
afterEach(() => { globalThis.WebSocket = realWebSocket; });

const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); });

let n = 0;
const message = (role: "user" | "assistant", content: string): ChatMessage =>
  ({ id: `m${++n}`, role, content, toolCalls: [], parts: [], isStreaming: false, timestamp: 0 });

function setup(opts: { summarize?: boolean } = {}) {
  const root = createBrainUiRoot({ storage: null, storagePrefix: "handoff-test" });
  roots.push(root);
  Object.assign(root.api, {
    fileResolve: async (path: string) => ({ path, ancestors: [], exists: path !== "plans/missing.md", type: "file" }),
    sessions: async () => ({ sessions: [] }),
  });
  root.connection.connect();
  const socket = FakeSocket.instances.at(-1)!;
  act(() => socket.open());
  root.stores.provider.setState({
    available: [
      { id: "claude", label: "Claude Opus", backendId: "claude" },
      { id: "codex", label: "Codex", backendId: "pi", billingMode: "api" },
    ],
    backends: {
      claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false, autonomous: opts.summarize !== false } },
      pi: { id: "pi", capabilities: { concurrentSessions: true, followUp: true, autonomous: false } },
    },
    pinnedId: "claude",
    loaded: true,
  });
  const chat = root.stores.chat.getState();
  chat.setActiveSession("src");
  chat.setSessionBackend("src", "claude");
  chat.setMessages("src", [
    message("user", "Plan the return to Ithaca, see plans/ithaca.md."),
    message("assistant", "Sail past the Sirens."),
  ]);
  render(<BrainUiProvider root={root}><HandoffSheet /></BrainUiProvider>);
  return { root, socket };
}

function open(root: BrainUiRoot, handoffId = "h-ithaca-0001") {
  act(() => root.stores.handoff.getState().open("src", handoffId));
}

const textarea = () => screen.q.getByLabelText("Handoff · edit freely") as HTMLTextAreaElement;
const start = () => screen.q.getByRole("button", { name: /Start new chat on/ });
/**
 * React's input polyfill (see tests/render/dom.ts) reads a change through
 * the focused field on a key event, as a reader's typing produces.
 */
function typeInto(field: HTMLElement, value: string) {
  act(() => field.focus());
  fireEvent.change(field, { target: { value } });
  fireEvent.keyUp(field, { key: "a" });
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("opening the review", () => {
  test("drafts without a model first, then runs one summary on the source's backend and shows it, with its cost", async () => {
    const { root, socket } = setup();
    open(root);
    await flush();
    expect(textarea().value).toBe("Asked: Plan the return to Ithaca, see plans/ithaca.md.\n\nAnswer: Sail past the Sirens.");
    const prepare = socket.frames().filter((f) => f.type === "handoff_prepare");
    expect(prepare).toEqual([{ type: "handoff_prepare", handoffId: "h-ithaca-0001-p1", sourceSessionId: "src", messageCount: 2 }]);
    expect(screen.q.getByText("Drafting a summary with Claude Opus · spends")).toBeTruthy();
    // Nothing reaches a destination before Start.
    expect(socket.frames().some((f) => f.type === "chat_message")).toBe(false);

    act(() => socket.deliver({ type: "handoff_draft", handoffId: "h-ithaca-0001-p1", state: "ready", text: "Odysseus is sailing home.", costUsd: 0.03 }));
    expect(textarea().value).toBe("Odysseus is sailing home.");
    expect(screen.q.getByText("summarized by Claude Opus · $0.03")).toBeTruthy();
    expect(screen.q.getByText("plans/ithaca.md")).toBeTruthy();
    expect(screen.q.getByRole("combobox")).toBe(document.activeElement as HTMLElement);
    // Only other-backend profiles are offered.
    expect([...screen.q.getByRole("combobox").querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Codex · pi · spends"]);
  });

  test("an unknown cost reads unknown, never $0", async () => {
    const { root, socket } = setup();
    open(root);
    await flush();
    act(() => socket.deliver({ type: "handoff_draft", handoffId: "h-ithaca-0001-p1", state: "ready", text: "Sailing." }));
    expect(screen.q.getByText("summarized by Claude Opus · cost unknown")).toBeTruthy();
  });

  test("typing stops the run and keeps what was written; a late summary does not overwrite it", async () => {
    const { root, socket } = setup();
    open(root);
    await flush();
    typeInto(textarea(), "My own words.");
    expect(socket.frames().filter((f) => f.type === "handoff_prepare_cancel")).toEqual([{ type: "handoff_prepare_cancel", handoffId: "h-ithaca-0001-p1" }]);
    act(() => socket.deliver({ type: "handoff_draft", handoffId: "h-ithaca-0001-p1", state: "ready", text: "Late summary." }));
    expect(textarea().value).toBe("My own words.");
  });

  test("a backend that cannot summarize gets the labelled no-model draft and no run", async () => {
    const { root, socket } = setup({ summarize: false });
    open(root);
    await flush();
    expect(socket.frames().some((f) => f.type === "handoff_prepare")).toBe(false);
    expect(screen.q.getByText("drafted from the last 6 messages · no model")).toBeTruthy();
  });

  test("over the limit, Start is disabled with the reason", async () => {
    const { root } = setup({ summarize: false });
    open(root);
    await flush();
    typeInto(textarea(), "x".repeat(4001));
    expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.q.getByText(/shorten the handoff/)).toBeTruthy();
  });
});

describe("starting the new chat", () => {
  test("sends exactly the reviewed text and readable references, keyed by the handoff; a missing reference is listed, not sent", async () => {
    const { root, socket } = setup({ summarize: false });
    open(root);
    await flush();
    fireEvent.click(screen.q.getByRole("button", { name: "+ add a file" }));
    typeInto(screen.q.getByLabelText("Brain file path"), "plans/missing.md");
    fireEvent.submit(screen.q.getByLabelText("Brain file path").closest("form")!);
    await flush();
    expect(screen.q.getAllByText(/plans\/missing\.md/).length).toBeGreaterThan(1); // chip and Not carried over
    typeInto(textarea(), "Odysseus is sailing home.");
    fireEvent.click(start());
    const sent = socket.frames().filter((f) => f.type === "chat_message");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: "Odysseus is sailing home.", providerId: "codex", source: "handoff", draftId: "h-ithaca-0001",
      handoff: { handoffId: "h-ithaca-0001", sourceSessionId: "src", references: ["plans/ithaca.md"] },
    });
    expect(screen.q.getByText("Starting new chat on Codex…")).toBeTruthy();

    // The destination names itself: its buffer holds the reviewed message as a handoff, and the view follows.
    act(() => socket.deliver({ type: "session_info", sessionId: "dst", isNew: true, backendId: "pi", providerId: "codex", draftId: "h-ithaca-0001", requestId: sent[0]!.requestId }));
    const chat = root.stores.chat.getState();
    expect(chat.activeSessionId).toBe("dst");
    expect(chat.buffers.dst!.messages[0]).toMatchObject({ role: "user", source: "handoff", content: composeHandoffText("Odysseus is sailing home.", ["plans/ithaca.md"]) });
    // The source is untouched and gains a forward link.
    expect(chat.buffers.src!.messages).toHaveLength(2);
    expect(root.stores.handoff.getState().forward.src?.map((l) => l.sessionId)).toEqual(["dst"]);
    expect(root.stores.handoff.getState().sheet).toBeNull();
  });

  test("a refusal keeps the text and offers Try again with the same key", async () => {
    const { root, socket } = setup({ summarize: false });
    open(root);
    await flush();
    fireEvent.click(start());
    const first = socket.frames().find((f) => f.type === "chat_message")!;
    act(() => socket.deliver({ type: "error", code: "HANDOFF_REJECTED", message: "Not readable by pi: plans/ithaca.md.", requestId: first.requestId }));
    expect(screen.q.getByText(/Couldn't start the new chat: Not readable by pi/)).toBeTruthy();
    expect(textarea().value).toContain("Asked:");
    fireEvent.click(screen.q.getByRole("button", { name: "Try again" }));
    const sends = socket.frames().filter((f) => f.type === "chat_message");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.handoff.handoffId).toBe(first.handoff.handoffId);
    expect(sends[1]!.requestId).not.toBe(first.requestId);
  });

  test("a lost acknowledgement turns uncertain; Check again asks without creating and opens what it finds", async () => {
    const { root, socket } = setup({ summarize: false });
    open(root);
    await flush();
    fireEvent.click(start());
    act(() => socket.close(1006));
    expect(screen.q.getByText(/Didn't hear back/)).toBeTruthy();
    // The client reconnects; everything sent from here on is new.
    act(() => { root.connection.connect(); FakeSocket.instances.at(-1)!.open(); });
    const next = FakeSocket.instances.at(-1)!;
    const before = next.frames().length;
    fireEvent.click(screen.q.getByRole("button", { name: "Check again" }));
    const after = () => next.frames().slice(before);
    expect(after().filter((f) => f.type === "handoff_status")).toEqual([{ type: "handoff_status", handoffId: "h-ithaca-0001" }]);
    expect(after().some((f) => f.type === "chat_message")).toBe(false);
    act(() => next.deliver({ type: "handoff_receipt", handoffId: "h-ithaca-0001", state: "created", sessionId: "dst" }));
    expect(root.stores.chat.getState().activeSessionId).toBe("dst");
    expect(after().filter((f) => f.type === "session_resume")).toEqual([{ type: "session_resume", sessionId: "dst" }]);
    expect([...new Set([socket, next])].flatMap((s) => s.frames()).filter((f) => f.type === "chat_message")).toHaveLength(1);
  });

  test("Esc cancels and stops a running summary", async () => {
    const { root, socket } = setup();
    open(root);
    await flush();
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(root.stores.handoff.getState().sheet).toBeNull();
    expect(socket.frames().filter((f) => f.type === "handoff_prepare_cancel")).toHaveLength(1);
  });
});

describe("the destination's handoff card", () => {
  test("links back to its source and says what the chat knows", () => {
    const root = createBrainUiRoot({ storage: null, storagePrefix: "handoff-card" });
    roots.push(root);
    root.stores.chat.getState().setActiveSession("dst");
    root.stores.handoff.getState().addLink("src", { sessionId: "dst", title: null }, { sessionId: "src", title: "Ithaca return", backendId: "claude" });
    render(<BrainUiProvider root={root}><HandoffCard content={composeHandoffText("Odysseus is sailing home.", ["plans/ithaca.md"])} /></BrainUiProvider>);
    expect(screen.q.getByRole("button", { name: "Open source chat: Ithaca return" })).toBeTruthy();
    expect(screen.q.getByText("This chat only knows what is in this card.")).toBeTruthy();
    expect(screen.q.getByRole("list", { name: "References" }).textContent).toContain("plans/ithaca.md");
  });
});
