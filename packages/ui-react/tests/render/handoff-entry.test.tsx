// The handoff entry points (#61 §1) when the other backend is set up but
// cannot run (#1090): the locked model picker, a session row's overflow and
// the desktop palette, each mounted as the app mounts it on a root whose
// socket is fake. The entry stays disabled and names what to fix; pressing
// it opens no review, so no `handoff preparation` summary is asked for.
import { unregisterHandoffEntryDom } from "./handoff-entry-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createElement, forwardRef, type ReactNode } from "react";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { HandoffSheet } from "../../src/components/chat/handoff-sheet.js";
import { SessionsPane } from "../../src/components/chat/sessions-pane.js";
import { DesktopPalette } from "../../src/components/layout/desktop-palette.js";
import { HandoffCard, useBackendName } from "../../src/components/chat/handoff-links.js";
import { composeHandoffText } from "@schlessera/brain-ui-sdk/protocol";

// happy-dom rejects an animation's `finished` promise when an element
// unmounts mid-animation, and the rejection fails whichever test is running.
// These tests are about the entry, not the animation engine, so motion
// elements are plain DOM wrappers, as in answer-suggestions.test.tsx.
const motionElements = new Map<string, ReturnType<typeof motionElement>>();
function motionElement(tag: string) {
  return forwardRef<HTMLElement, Record<string, unknown>>(
    ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) =>
      createElement(tag, { ...props, ref })
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

afterEach(cleanup);
afterAll(unregisterHandoffEntryDom);

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
  frames(): Array<Record<string, any>> { return this.sent.map((raw) => JSON.parse(raw)); }
}

const AVAILABLE = [{ id: "claude", label: "Claude Opus", backendId: "claude" }];
const CODEX = { id: "codex", label: "Codex", backendId: "pi" };
const BACKENDS = {
  claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false, autonomous: true } },
  pi: { id: "pi", capabilities: { concurrentSessions: true, followUp: true, autonomous: false } },
};
// Set up on pi, but missing its credential (#1044).
const PROXY = { id: "ithaca-proxy", label: "Ithaca proxy", reason: "needs-credentials" as const, backendId: "pi" };
const SESSION = { id: "ithaca", title: "Return to Ithaca", lastActiveAt: Date.now(), numTurns: 1, backendId: "claude" };

let unavailable: Array<typeof PROXY> = [PROXY];
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  unavailable = [PROXY];
  // The roster loads on mount: answer it with the same fixture the store holds.
  globalThis.fetch = (async () => Response.json({
    entries: [], providers: AVAILABLE, backends: BACKENDS, unavailable, slugs: {}, models: [], sessions: [SESSION],
  })) as unknown as typeof fetch;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
});

const roots: BrainUiRoot[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.dispose(); });

const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

/**
 * A root with a stored, settled session on claude and the socket open. The
 * review sheet is mounted beside every entry point, so an entry that opened
 * it would also send its `handoff_prepare`.
 */
async function mount(ui: React.ReactNode) {
  const root = createBrainUiRoot({ storage: null, storagePrefix: "handoff-entry-test" });
  roots.push(root);
  Object.assign(root.api, { sessions: async () => ({ sessions: [SESSION] }) });
  root.connection.connect();
  const socket = FakeSocket.instances.at(-1)!;
  act(() => {
    socket.open();
    root.stores.provider.setState({ available: AVAILABLE, unavailable, backends: BACKENDS, pinnedId: "claude", loaded: true });
    const chat = root.stores.chat.getState();
    chat.setActiveSession(SESSION.id);
    chat.setSessionBackend(SESSION.id, "claude");
    chat.addUserMessage(SESSION.id, "Plan the return to Ithaca.", "typed");
    chat.startAssistantMessage(SESSION.id);
    chat.appendText(SESSION.id, "Sail past the Sirens.");
    chat.finishAssistantMessage(SESSION.id);
  });
  const view = render(<BrainUiProvider root={root}>{ui}<HandoffSheet /></BrainUiProvider>);
  await tick();
  return { root, socket, view };
}

/** Nothing asked for the review's priced summary, and nothing opened it. */
function expectNoReview(root: BrainUiRoot, socket: FakeSocket) {
  expect(socket.frames().filter((f) => f.type === "handoff_prepare"), "no handoff preparation summary").toEqual([]);
  expect(root.stores.handoff.getState().sheet).toBeNull();
  expect(document.querySelector('[aria-label="Cancel handoff"]'), "the review sheet is not drawn").toBeNull();
}

const entryPoints = {
  async "the locked model picker"() {
    const ctx = await mount(<ChatPage />);
    const chip = ctx.view.container.querySelector<HTMLElement>("[data-model-trigger]");
    expect(chip, "the composer offers its model picker").not.toBeNull();
    fireEvent.click(chip!);
    await tick();
    const entry = ctx.view.container.querySelector<HTMLElement>("button[data-locked-action]")!;
    return { ...ctx, entry };
  },
  async "a session row's overflow in the Sessions pane"() {
    // The wide Sessions pane: the drawer below 1280 draws the same rows from
    // the same `useSessionListProps`, inside a sliding panel.
    const ctx = await mount(<SessionsPane empty={false} onResume={() => {}} onOpenTracker={() => {}} />);
    const body = within(document.body);
    fireEvent.click(body.getByRole("button", { name: `More for ${SESSION.title}` }));
    await tick();
    const entry = body.getByRole("menuitem");
    return { ...ctx, entry };
  },
  async "the desktop palette"() {
    const ctx = await mount(<DesktopPalette />);
    act(() => ctx.root.stores.ui.getState().setPaletteOpen(true));
    await tick();
    const entry = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes("Continue on another backend"))!;
    return { ...ctx, entry };
  },
};

for (const [where, open] of Object.entries(entryPoints)) {
  describe(`${where}, with the other backend set up but unable to run`, () => {
    test("stays disabled and names the backend with what it needs", async () => {
      const { root, socket, entry } = await open();
      expect(entry, "the entry is offered").toBeTruthy();
      expect(entry.textContent).toContain("Continue on another backend");
      expect(entry.textContent).toContain("Ithaca proxy needs credentials");
      expect(entry.textContent).not.toContain("no other backend set up");
      expect(entry.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(entry);
      await tick();
      expectNoReview(root, socket);
    });

    test("with no profile on any other backend, it still reads no other backend set up", async () => {
      unavailable = [];
      const { root, socket, entry } = await open();
      expect(entry.textContent).toContain("no other backend set up");
      expect(entry.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(entry);
      await tick();
      expectNoReview(root, socket);
    });

    test("with a runnable profile on another backend too, it is enabled as before", async () => {
      AVAILABLE.push(CODEX);
      try {
        const { entry } = await open();
        expect(entry.textContent).toContain("Continue on another backend");
        expect(entry.getAttribute("aria-disabled")).toBeNull();
        expect(entry.textContent).not.toContain("credentials");
      } finally {
        AVAILABLE.pop();
      }
    });
  });
}

describe("useBackendName", () => {
  function Names({ ids }: { ids: Array<string | undefined> }) {
    const name = useBackendName();
    return <ul>{ids.map((id) => <li key={String(id)}>{name(id)}</li>)}</ul>;
  }
  const claudeProxy = { ...PROXY, id: "claude-proxy", label: "Claude proxy", backendId: "claude" };

  test("a runnable profile's label first, then one that cannot run, then the id", () => {
    const root = createBrainUiRoot({ storage: null, storagePrefix: "handoff-entry-names" });
    roots.push(root);
    root.stores.provider.setState({ available: AVAILABLE, unavailable: [claudeProxy, PROXY] });
    const view = render(<BrainUiProvider root={root}><Names ids={["claude", "pi", "codex", undefined]} /></BrainUiProvider>);
    expect([...view.container.querySelectorAll("li")].map((li) => li.textContent))
      .toEqual(["Claude Opus", "Ithaca proxy", "codex", "another backend"]);
  });

  test("the handoff card names its source's backend as before when a profile there can run", () => {
    const root = createBrainUiRoot({ storage: null, storagePrefix: "handoff-entry-card" });
    roots.push(root);
    root.stores.provider.setState({ available: AVAILABLE, unavailable: [claudeProxy] });
    root.stores.chat.getState().setActiveSession("dst");
    root.stores.handoff.getState().addLink("src", { sessionId: "dst", title: null }, { sessionId: "src", title: "Ithaca return", backendId: "claude" });
    const view = render(<BrainUiProvider root={root}><HandoffCard content={composeHandoffText("Odysseus is sailing home.", [])} /></BrainUiProvider>);
    expect(view.container.textContent).toContain("Ithaca return · Claude Opus");
    expect(view.container.textContent).not.toContain("Claude proxy");
  });
});
