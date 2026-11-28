// What a store write re-renders (#4750, #4893): the composer, the voice Start
// card and conversation field, the Actions page, a run's orbit and the
// tracker announcer select only what they draw, so a
// streamed frame or a recognition fragment that changes none of it commits
// none of them. Mounted on a real root with no host; a Profiler counts the
// commits of a component mounted on its own, and inside the real ChatPage a
// component's re-render is read from its hook state in React's committed
// tree (a re-render replaces it, a skipped one keeps it). Odysseus's voyage
// supplies the sessions. Queries come from `render()`, never `screen`
// (tests/render/dom.ts says why).
import { registerStoreSubscriptionsDom, unregisterStoreSubscriptionsDom } from "./store-subscriptions-dom.js";

registerStoreSubscriptionsDom();

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, forwardRef, Profiler, type ReactNode } from "react";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { useOrbitAgents } from "../../src/components/activity/run-orbit.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { Composer } from "../../src/components/chat/composer.js";
import { ConversationField } from "../../src/components/voice/conversation-field.js";
import { ConversationStartCard } from "../../src/components/voice/start-card.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";

// As in answer-suggestions.test.tsx: motion elements are plain DOM wrappers,
// so an animation that outlives its element cannot fail a test.
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

const IN_VIEW = "odysseus-sirens";
const AWAY = "odysseus-cyclops";

/** The host's answers: empty lists for everything the pages ask on mount. */
function host(url: string): Response {
  if (url.includes("/activity/rollups")) return Response.json({ timeZone: "UTC", days: [] });
  if (url.includes("/models/pricing")) return Response.json({ stale: false, error: null });
  if (url.includes("/activity/inbox")) return Response.json({ intents: [] });
  if (url.includes("/activity/runs")) return Response.json({ live: [], history: [] });
  return Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] });
}

/** A socket that never opens: these pages are fed through their stores, not a host. */
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
afterAll(unregisterStoreSubscriptionsDom);

const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
const send = () => true;

function fixture(): BrainUiRoot {
  const r = createBrainUiRoot({ storage: null, request: async (url) => host(url) });
  roots.push(r);
  r.stores.connection.setState({ wsStatus: "connected" });
  const chat = r.stores.chat.getState();
  chat.setActiveSession(IN_VIEW);
  chat.setMessages(IN_VIEW, []);
  chat.setMessages(AWAY, []);
  return r;
}

/** Twenty streamed text deltas into `sessionId`, one store write each. */
function stream(r: BrainUiRoot, sessionId: string) {
  act(() => r.stores.chat.getState().startAssistantMessage(sessionId, "turn-1"));
  for (let i = 0; i < 20; i++) act(() => r.stores.chat.getState().appendText(sessionId, ` stroke ${i}`));
}

function commits() {
  let count = 0;
  return { onRender: () => { count++; }, count: () => count, reset: () => { count = 0; } };
}

type Fiber = { type: unknown; elementType: unknown; memoizedState: unknown; child: Fiber | null; sibling: Fiber | null; stateNode: unknown };

/** The committed fiber of the first component `match` names, from the root container. */
function committedFiber(container: HTMLElement, match: (fiber: Fiber) => boolean): Fiber | null {
  let host: Element | null = container;
  let key: string | undefined;
  while (host && !(key = Object.keys(host).find((k) => k.startsWith("__reactContainer$")))) host = host.parentElement;
  if (!host || !key) return null;
  const rootFiber = (host as unknown as Record<string, { stateNode: { current: Fiber } }>)[key]!.stateNode.current;
  const stack: Fiber[] = [rootFiber];
  while (stack.length) {
    const fiber = stack.pop()!;
    if (match(fiber)) return fiber;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return null;
}

/** Counts the re-renders of a component inside a mounted tree: each one gives it new hook state. */
function rerenders(container: HTMLElement, match: (fiber: Fiber) => boolean) {
  let last = committedFiber(container, match)?.memoizedState;
  expect(last).toBeDefined();
  let count = 0;
  return {
    observe() { const now = committedFiber(container, match)?.memoizedState; if (now !== last) { count++; last = now; } },
    count: () => count,
  };
}

describe("the composer", () => {
  test("recognition fragments of a conversation that is not live commit nothing", async () => {
    const r = fixture();
    const c = commits();
    render(<BrainUiProvider root={r}><Profiler id="composer" onRender={c.onRender}><Composer send={send} /></Profiler></BrainUiProvider>);
    await tick();
    c.reset();
    const conversation = r.connection.conversation.state;
    for (let i = 0; i < 20; i++) act(() => conversation.setState({ recognition: [...conversation.getState().recognition, { id: `f-${i}`, text: "Sing, Muse" } as never] }));
    expect(c.count()).toBe(0);
  });

  test("a live conversation swaps the composer for the conversation field", async () => {
    const r = fixture();
    const view = render(<BrainUiProvider root={r}><Composer send={send} /></BrainUiProvider>);
    await tick();
    expect(view.container.querySelector("[data-composer]")).not.toBeNull();
    expect(view.container.querySelector("[data-conversation-field]")).toBeNull();
    act(() => r.connection.conversation.state.setState({ available: true, active: true }));
    expect(view.container.querySelector("[data-conversation-field]")).not.toBeNull();
    expect(view.container.querySelector("[data-composer]")).toBeNull();
  });
});

describe("a live conversation", () => {
  /** Twenty recognition fragments: the one write each that retains it, as the client makes. */
  function fragments(r: BrainUiRoot, field: "recognition" | "unassigned") {
    const conversation = r.connection.conversation.state;
    for (let i = 0; i < 20; i++) act(() => conversation.setState({ [field]: [...conversation.getState()[field], { id: `f-${i}`, text: "Sing, Muse" } as never] }));
  }
  function live(r: BrainUiRoot, disclosureOpen: boolean) {
    // The card resolves its host from the page's own origin.
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://127.0.0.1/");
    act(() => r.connection.conversation.state.setState({ available: true, active: true, connection: "Connected", capture: "listening", sessionId: IN_VIEW, disclosureOpen }));
  }

  test("recognition fragments commit nothing in the Start card", async () => {
    const r = fixture();
    live(r, true);
    const c = commits();
    const view = render(<BrainUiProvider root={r}><Profiler id="start" onRender={c.onRender}><ConversationStartCard backend="claude" onLeave={() => {}} /></Profiler></BrainUiProvider>);
    await tick();
    expect(view.container.querySelector(".bk-voice-start")).not.toBeNull();
    c.reset();
    fragments(r, "recognition");
    expect(c.count()).toBe(0);
  });

  test("recognition the field does not draw commits nothing; its held text still does", async () => {
    const r = fixture();
    live(r, false);
    const c = commits();
    const view = render(<BrainUiProvider root={r}><Profiler id="field" onRender={c.onRender}><ConversationField backend="claude" onLeave={() => {}} /></Profiler></BrainUiProvider>);
    await tick();
    expect(view.container.querySelector("[data-conversation-field]")).not.toBeNull();
    c.reset();
    fragments(r, "recognition");
    fragments(r, "unassigned");
    expect(c.count()).toBe(0);
    act(() => r.connection.conversation.state.setState({ text: "Sing, Muse" }));
    expect(c.count()).toBeGreaterThan(0);
    expect(view.container.textContent).toContain("Sing, Muse");
  });
});

describe("the composer's resting mic", () => {
  test("live conversation becoming available turns the disabled mic into the resting one", async () => {
    const r = fixture();
    // The host names no dictation service.
    r.stores.voice.setState({ discovery: { snapshot: { providers: [], dictation: { saved: null, savedUsable: false, host: null, effective: null, source: "none", smart: false, revision: "r1" } }, at: Date.now() } });
    const view = render(<BrainUiProvider root={r}><Composer send={send} /></BrainUiProvider>);
    await tick();
    // No dictation service here: the mic is drawn disabled and says why.
    const unset = () => view.container.innerHTML.includes("Dictation isn\u0027t set up on this host.");
    expect(unset()).toBe(true);
    act(() => r.connection.conversation.state.setState({ available: true }));
    expect(unset()).toBe(false);
  });
});

describe("the Actions page", () => {
  test("streamed text that changes no approval commits nothing; an approval away shows and resolves", async () => {
    const r = fixture();
    const c = commits();
    const view = render(<BrainUiProvider root={r}><Profiler id="actions" onRender={c.onRender}><ActivityPage /></Profiler></BrainUiProvider>);
    await tick(); await tick();
    c.reset();
    stream(r, AWAY);
    expect(c.count()).toBe(0);

    act(() => r.stores.chat.getState().requestToolApproval(AWAY, "tool-wax", "Bash", { command: "melt wax" }, "Melt the wax for the crew's ears", "tool", true, "turn-1"));
    await tick();
    expect(view.container.textContent).toContain("melt wax");
    act(() => r.stores.chat.getState().resolveToolApproval(AWAY, "tool-wax", false));
    await tick();
    expect(view.container.textContent).not.toContain("melt wax");
  });
});

describe("a run's orbit", () => {
  const spans = [
    { spanId: "run", runId: "run-1", kind: "run", name: "voyage", sessionId: AWAY, startedAt: 1, endedAt: null },
    { spanId: "agent", runId: "run-1", kind: "subagent", parentSpanId: "run", name: "lookout", sessionId: AWAY, startedAt: 2, endedAt: null, subagent: { type: "lookout" } },
    { spanId: "tool-wax", runId: "run-1", kind: "tool", parentSpanId: "agent", name: "Bash", sessionId: AWAY, startedAt: 3, endedAt: null },
  ] as unknown as ActivitySpan[];
  function Orbit() {
    const agents = useOrbitAgents(spans);
    return <ul>{agents.map((a) => <li key={a.id}>{`${a.name} ${a.meta ?? ""}`}</li>)}</ul>;
  }

  test("streamed text that changes no approval commits nothing; a pending approval still marks its agent", async () => {
    const r = fixture();
    const c = commits();
    const view = render(<BrainUiProvider root={r}><Profiler id="orbit" onRender={c.onRender}><Orbit /></Profiler></BrainUiProvider>);
    await tick();
    c.reset();
    stream(r, AWAY);
    expect(c.count()).toBe(0);
    act(() => r.stores.chat.getState().requestToolApproval(AWAY, "tool-wax", "Bash", { command: "melt wax" }, undefined, "tool", true, "turn-1"));
    expect(view.container.textContent).toContain("needs approval");
  });
});

describe("inside the chat page", () => {
  test("streamed text into the session in view re-renders neither the composer nor the tracker announcer", async () => {
    const r = fixture();
    const view = render(<BrainUiProvider root={r}><ChatPage /></BrainUiProvider>);
    await tick();
    const composer = rerenders(view.container, (f) => f.elementType === Composer);
    const announcer = rerenders(view.container, (f) => typeof f.type === "function" && (f.type as { name?: string }).name === "TrackerAnnouncer");
    act(() => r.stores.chat.getState().startAssistantMessage(IN_VIEW, "turn-1"));
    composer.observe(); announcer.observe();
    const afterStart = { composer: composer.count(), announcer: announcer.count() };
    for (let i = 0; i < 20; i++) {
      act(() => r.stores.chat.getState().appendText(IN_VIEW, ` stroke ${i}`));
      composer.observe(); announcer.observe();
    }
    expect(view.container.textContent).toContain("stroke 19");
    expect(composer.count() - afterStart.composer).toBe(0);
    expect(announcer.count() - afterStart.announcer).toBe(0);
  });

  test("an announcement for a session the list does not have is worded from its transcript", async () => {
    const r = fixture();
    act(() => r.stores.chat.getState().addUserMessage(AWAY, "Blind the Cyclops\nthen row"));
    const view = render(<BrainUiProvider root={r}><ChatPage /></BrainUiProvider>);
    await tick();
    act(() => r.stores.trackers.getState().announce({ sessionId: AWAY, state: "done", outcome: "success" }));
    const region = view.container.querySelector("[data-working-live]")!;
    expect(region.textContent).toContain("Blind the Cyclops");
  });
});
