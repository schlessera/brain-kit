// The conversation-task row in the real ChatPage (#4752). Its bubble gets a
// primitive session and a stable reveal callback, never an element, so the
// MessageBubble memo holds for it while a later answer streams; it still
// gains "View result" once the result's entry appears, and each recognition
// row's introduction stays the first row of its activation. Mounted on a
// real root with no host; Odysseus's crew supplies the voice. Queries come
// from `render()`, never `screen` (tests/render/dom.ts says why).
import { registerTaskContextRowDom, unregisterTaskContextRowDom } from "./task-context-row-dom.js";

registerTaskContextRowDom();

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, forwardRef, type ReactNode } from "react";

import { ChatPage } from "../../src/components/chat/chat-page.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ChatMessage } from "../../src/stores/chat-state.js";
import type { ConversationRecognition } from "../../src/voice/conversation-client.js";

// As in store-subscriptions.test.tsx: motion elements are plain DOM wrappers.
const motionElements = new Map<string, ReturnType<typeof motionElement>>();
function motionElement(tag: string) {
  return forwardRef<HTMLElement, Record<string, unknown>>(
    ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) => createElement(tag, { ...props, ref })
  );
}
mock.module("framer-motion", () => ({
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  motion: new Proxy({}, {
    get: (_target, tag: string) => {
      const existing = motionElements.get(tag);
      if (existing) return existing;
      const element = motionElement(tag);
      motionElements.set(tag, element);
      return element;
    },
  }),
}));

const SESSION = "odysseus-aeolus";

function host(url: string): Response {
  if (url.includes("/activity/rollups")) return Response.json({ timeZone: "UTC", days: [] });
  if (url.includes("/models/pricing")) return Response.json({ stale: false, error: null });
  if (url.includes("/activity/inbox")) return Response.json({ intents: [] });
  if (url.includes("/activity/runs")) return Response.json({ live: [], history: [] });
  return Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] });
}

/** A socket that never opens: the page is fed through its stores, not a host. */
class DeadSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url = "") {}
  send(): void {}
  close(): void { this.readyState = 3; }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const roots: BrainUiRoot[] = [];
const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
beforeEach(() => {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: DeadSocket });
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true,
    value: async (input: RequestInfo | URL) => host(String(input)) });
});
afterEach(() => {
  cleanup();
  for (const r of roots.splice(0)) r.dispose();
  if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor); else Reflect.deleteProperty(globalThis, "fetch");
  if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor); else Reflect.deleteProperty(globalThis, "WebSocket");
});
afterAll(unregisterTaskContextRowDom);

const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

function fixture(): BrainUiRoot {
  const r = createBrainUiRoot({ storage: null, request: async (url) => host(url) });
  roots.push(r);
  r.stores.connection.setState({ wsStatus: "connected" });
  const chat = r.stores.chat.getState();
  chat.setActiveSession(SESSION);
  chat.setMessages(SESSION, []);
  return r;
}

/** The host's receipt for the contextual task the voice row asked for. */
function receipt(r: BrainUiRoot) {
  r.connection.conversation.state.setState({ work: { "bag-request": {
    conversationId: "odysseus-voice", epoch: 1, sessionId: SESSION, requestId: "bag-request", turnId: "bag-turn", taskId: "bag-task",
    nativeHandle: "bag-native", provenance: "contextual", state: "running", delivery: "pending", submitted: "Keep the bag of winds shut.", recognized: "",
  } as never } });
}

/**
 * Adds the conversation-task row and counts its bubble's renders: the bubble
 * reads a user message's `thinkingLevel` once per render, and nothing else on
 * the page reads it.
 */
function taskRow(r: BrainUiRoot) {
  act(() => r.stores.chat.getState().addUserMessage(SESSION, "Keep the bag of winds shut.", "voice-context", undefined, { requestId: "bag-request" }));
  const row = r.stores.chat.getState().buffers[SESSION]!.messages.at(-1)!;
  let reads = 0;
  Object.defineProperty(row, "thinkingLevel" satisfies keyof ChatMessage, { configurable: true, enumerable: false, get: () => { reads++; return undefined; } });
  return { reads: () => reads, reset: () => { reads = 0; } };
}

describe("the conversation-task row", () => {
  test("does not re-render while a later answer streams", async () => {
    const r = fixture();
    receipt(r);
    const row = taskRow(r);
    const view = render(<BrainUiProvider root={r}><ChatPage /></BrainUiProvider>);
    await tick();
    expect(view.container.querySelector("[data-conversation-task]")?.textContent).toContain("Conversation task");
    expect(row.reads()).toBeGreaterThan(0);
    act(() => r.stores.chat.getState().startAssistantMessage(SESSION, "bag-turn", "bag-request"));
    act(() => r.stores.chat.getState().appendText(SESSION, "The winds"));
    await tick();
    row.reset();
    for (let i = 0; i < 10; i++) act(() => r.stores.chat.getState().appendText(SESSION, ` stay bound ${i}`));
    await tick();
    expect(view.container.textContent).toContain("stay bound 9");
    expect(row.reads()).toBe(0);
  });

  test("gains its View result button when the result's entry appears", async () => {
    const r = fixture();
    receipt(r);
    taskRow(r);
    const view = render(<BrainUiProvider root={r}><ChatPage /></BrainUiProvider>);
    await tick();
    const task = () => view.container.querySelector("[data-conversation-task]")!;
    expect(task().textContent).not.toContain("View result");
    act(() => r.stores.chat.getState().startAssistantMessage(SESSION, "bag-turn", "bag-request"));
    act(() => r.stores.chat.getState().appendText(SESSION, "The winds stay bound."));
    await tick();
    expect(task().textContent).toContain("View result");
  });
});

describe("recognition rows", () => {
  test("introduce an activation on its first row only, counting every fragment of the rows before", async () => {
    const r = fixture();
    const view = render(<BrainUiProvider root={r}><ChatPage /></BrainUiProvider>);
    await tick();
    let sequence = 0;
    const fragment = (utteranceId: string, activation: number): ConversationRecognition => ({
      kind: "input_fragment", utteranceId, sequence: sequence++, text: `Eurylochus speaks ${sequence}`, finalization: "final", certainty: "unknown",
      sessionId: SESSION, conversationId: "odysseus-voice", epoch: 1, providerId: "gemini-live", activation, contextual: false,
    } as ConversationRecognition);
    // Rows by utterance; the fifth row holds fragments of two activations.
    const recognition = [
      fragment("u1", 1), fragment("u2", 1), fragment("u3", 2), fragment("u4", 1),
      fragment("u5", 2), fragment("u5", 3), fragment("u6", 3), fragment("u7", 4),
    ];
    act(() => r.connection.conversation.state.setState({ recognition }));
    await tick();
    const rows = [...view.container.querySelectorAll("[data-conversation-recognition]")];
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.textContent!.startsWith("Voice · Gemini Live"))).toEqual([true, false, true, false, false, false, true]);
  });
});
