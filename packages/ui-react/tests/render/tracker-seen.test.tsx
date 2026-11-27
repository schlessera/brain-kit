// The tracker-seen hook across renders (#4743): while an answer streams it
// queries nothing in the document, it keeps one MutationObserver and one
// scroll listener for as long as what they depend on holds, and a transcript
// that mounts late still gets its listener. Keyless: a root with no host,
// scripted frames, and Odysseus's voyage for the sessions. Queries come from
// `render()`, never `screen` (tests/render/dom.ts says why).
import { unregisterTrackerSeenDom } from "./tracker-seen-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

import { useTrackerSeen } from "../../src/hooks/use-tracker-seen.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";

const A = "odysseus-sirens";
const B = "odysseus-cyclops";
const MODAL = '[aria-modal="true"]';

const roots: BrainUiRoot[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0).reverse()) restore();
  for (const r of roots.splice(0)) r.dispose();
});
afterAll(unregisterTrackerSeenDom);

const frame = (r: BrainUiRoot, msg: Record<string, unknown>) => r.connection.handleServerMessage(msg as unknown as ServerMessage);

/** Session A in view, running turn-1, with a tracker left behind by a visit to B. */
function trackedAndRunning(): BrainUiRoot {
  const r = createBrainUiRoot({ storage: null, request: async () => Response.json({ error: "not found" }, { status: 404 }) });
  roots.push(r);
  r.stores.connection.setState({ wsStatus: "connected" });
  frame(r, { type: "server_hello", protocolRev: 5, principalKey: "pk-ithaca", capabilities: {} });
  const chat = r.stores.chat.getState();
  chat.setActiveSession(A);
  chat.setMessages(A, []);
  chat.addUserMessage(A, "Row past the Sirens");
  frame(r, { type: "session_info", sessionId: A, isNew: false, turnId: "turn-1" });
  frame(r, { type: "text_delta", sessionId: A, turnId: "turn-1", text: "Wax first." });
  r.connection.flushChatDeltas();
  chat.setActiveSession(B);
  chat.setActiveSession(A);
  r.stores.ui.setState({ activeView: "chat" });
  expect(r.stores.trackers.getState().records[A]).toBeDefined();
  return r;
}

const endTurn = (r: BrainUiRoot) =>
  frame(r, { type: "result", sessionId: A, turnId: "turn-1", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
const seen = (r: BrainUiRoot) => r.stores.trackers.getState().records[A]?.seen ?? null;

/** Puts the transcript's own geometry at the bottom of a scrolled transcript. */
function atBottom(el: HTMLElement): void {
  for (const [name, value] of [["clientHeight", 400], ["scrollHeight", 1000], ["scrollTop", 600]] as const) {
    Object.defineProperty(el, name, { configurable: true, value });
  }
}

/** Replaces a global with a stand-in; restores its complete descriptor in teardown. */
function standIn(name: "MutationObserver", value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restores.push(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
}

function countingObservers() {
  const Real = globalThis.MutationObserver;
  const count = { constructed: 0, disconnected: 0 };
  class Counting extends Real {
    constructor(callback: MutationCallback) {
      super(callback);
      count.constructed++;
    }
    override disconnect(): void {
      count.disconnected++;
      super.disconnect();
    }
  }
  standIn("MutationObserver", Counting);
  return count;
}

function modalQueries() {
  const calls: string[] = [];
  const original = Object.getOwnPropertyDescriptor(document, "querySelector");
  const real = document.querySelector.bind(document);
  Object.defineProperty(document, "querySelector", {
    configurable: true, writable: true,
    value: (selector: string) => { if (selector === MODAL) calls.push(selector); return real(selector); },
  });
  restores.push(() => { if (original) Object.defineProperty(document, "querySelector", original); else Reflect.deleteProperty(document, "querySelector"); });
  return calls;
}

function Transcript({ show = true }: { show?: boolean; tick?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useTrackerSeen(ref, false);
  return show ? <div data-testid="transcript" ref={ref} /> : <p>Nothing yet</p>;
}

describe("useTrackerSeen while an answer streams", () => {
  test("no modal query and one observer across renders; seen once the turn ends at the bottom", () => {
    const r = trackedAndRunning();
    const observers = countingObservers();
    const queries = modalQueries();
    const N = 20;
    const view = render(<BrainUiProvider root={r}><Transcript tick={0} /></BrainUiProvider>);
    for (let i = 1; i <= N; i++) view.rerender(<BrainUiProvider root={r}><Transcript tick={i} /></BrainUiProvider>);
    expect(queries).toEqual([]);
    expect(observers.constructed).toBe(1);

    const el = view.getByTestId("transcript");
    atBottom(el);
    // A modal open over Chat still prevents it.
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    act(() => endTurn(r));
    expect(queries.length).toBeGreaterThan(0);
    expect(seen(r)).toBeNull();
    modal.remove();
    view.rerender(<BrainUiProvider root={r}><Transcript tick={N + 1} /></BrainUiProvider>);
    expect(seen(r)).not.toBeNull();

    view.unmount();
    expect(observers.disconnected).toBe(1);
  });

  test("a transcript that mounts after the hook still hears its scroll", () => {
    const r = trackedAndRunning();
    const view = render(<BrainUiProvider root={r}><Transcript show={false} /></BrainUiProvider>);
    view.rerender(<BrainUiProvider root={r}><Transcript show /></BrainUiProvider>);
    act(() => endTurn(r));
    expect(seen(r)).toBeNull();
    const el = view.getByTestId("transcript");
    atBottom(el);
    act(() => { el.dispatchEvent(new Event("scroll")); });
    expect(seen(r)).not.toBeNull();
  });
});
