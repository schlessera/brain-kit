// The Sessions list against typing (#4751): it selects the words it prints
// from the drafts, so a keystroke that changes none of them commits nothing,
// and a closed drawer computes no rows at all. Mounted on a real root with
// no host, 200 of Odysseus's sessions and the pinned clock; a Profiler
// counts the commits. Queries come from `render()`, never `screen`
// (tests/render/dom.ts says why).
import { unregisterSessionsPaneDom } from "./sessions-pane-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Profiler, useEffect, useReducer } from "react";

import { SessionDrawer } from "../../src/components/chat/session-drawer.js";
import { SessionsPane } from "../../src/components/chat/sessions-pane.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ListedSession } from "../../src/stores/session-list-state.js";

const NOW = new Date("2026-07-12T09:00:00Z").getTime();
const IN_VIEW = "odysseus-leg-0";

function voyage(count = 200): ListedSession[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `odysseus-leg-${i}`, title: `Leg ${i} of the voyage home`, createdAt: NOW - (i + 1) * 3_600_000,
    lastActiveAt: NOW - i * 3_600_000, totalCostUsd: 0, numTurns: 1,
  }) as ListedSession);
}

const roots: BrainUiRoot[] = [];
beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => {
  cleanup();
  for (const r of roots.splice(0)) r.dispose();
  setSystemTime();
});
afterAll(unregisterSessionsPaneDom);

const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
const noop = () => {};

function fixture(sessions: ListedSession[], activeSessionId: string | null = IN_VIEW): BrainUiRoot {
  const r = createBrainUiRoot({ storage: null, request: async (url) => Response.json(url.includes("/sessions") ? { sessions } : {}) });
  roots.push(r);
  r.stores.connection.setState({ wsStatus: "connected" });
  r.stores.sessions.setState({ sessions, loaded: true });
  r.stores.chat.getState().setActiveSession(activeSessionId);
  if (activeSessionId) r.stores.chat.getState().setMessages(activeSessionId, []);
  return r;
}

function commits() {
  let count = 0;
  return { onRender: () => { count++; }, count: () => count, reset: () => { count = 0; } };
}

async function pane(r: BrainUiRoot) {
  const c = commits();
  const view = render(<BrainUiProvider root={r}><Profiler id="pane" onRender={c.onRender}><SessionsPane empty={false} onResume={noop} onOpenTracker={noop} /></Profiler></BrainUiProvider>);
  await tick(); await tick();
  c.reset();
  return { view, c };
}

describe("the Sessions pane while the reader types", () => {
  test("a session's first draft edit marks its row once; further text edits commit nothing", async () => {
    const r = fixture(voyage());
    const { view, c } = await pane(r);
    const drafts = r.stores.drafts;
    const id = drafts.getState().idFor(IN_VIEW);
    act(() => drafts.getState().edit(id, IN_VIEW, { text: "S" }));
    expect(c.count()).toBe(1);
    expect(view.container.textContent).toContain("draft · now");
    c.reset();
    for (const text of ["Si", "Sir", "Sire", "Siren", "Sirens", "Sirens ", "Sirens a", "Sirens ah", "Sirens ahe", "Sirens ahead"]) {
      act(() => drafts.getState().edit(id, IN_VIEW, { text }));
    }
    expect(c.count()).toBe(0);
  });

  test("a new chat's draft title follows its first line; edits below it commit nothing", async () => {
    const r = fixture(voyage(), null);
    const { view, c } = await pane(r);
    const drafts = r.stores.drafts;
    const id = drafts.getState().fresh;
    act(() => drafts.getState().edit(id, null, { text: "Letter to Penelope" }));
    expect(view.container.textContent).toContain("Letter to Penelope");
    c.reset();
    let text = "Letter to Penelope\n";
    for (const word of ["The", " suitors", " eat", " the", " herds", ";", " hold", " the", " loom", "."]) {
      text += word;
      act(() => drafts.getState().edit(id, null, { text }));
    }
    expect(c.count()).toBe(0);
    act(() => drafts.getState().edit(id, null, { text: `Letter to Telemachus\n${text.split("\n")[1]}` }));
    expect(view.container.textContent).toContain("Letter to Telemachus");
  });
});

describe("the Sessions drawer while it is closed", () => {
  test("re-renders of its parent read no session's row data", async () => {
    let reads = 0;
    const sessions = voyage().map((session) => {
      const counted = { ...session };
      for (const field of ["title", "lastActiveAt", "totalCostUsd", "numTurns"] as const) {
        const value = session[field];
        Object.defineProperty(counted, field, { enumerable: true, get: () => { reads++; return value; } });
      }
      return counted;
    });
    const r = fixture(sessions);
    const parent = { rerender: () => {} };
    function Parent() {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      useEffect(() => { parent.rerender = bump; }, []);
      return <SessionDrawer open={false} onClose={noop} onResume={noop} />;
    }
    render(<BrainUiProvider root={r}><Parent /></BrainUiProvider>);
    await tick();
    reads = 0;
    for (let i = 0; i < 10; i++) act(() => parent.rerender());
    expect(reads).toBe(0);
  });
});
