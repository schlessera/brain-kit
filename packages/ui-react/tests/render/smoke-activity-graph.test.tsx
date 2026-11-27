// Render smoke tests for the Activity and Graph pages and the graph views: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeActivityGraphDom, unregisterSmokeActivityGraphDom } from "./smoke-activity-graph-dom.js";
registerSmokeActivityGraphDom();

import { installSmokeHarness, PageSocket, activityDetail, changeControlledInput, deferred, flushPromises, installActivityFetch, render, renderHook, setHash, useActivityStore, useGraphStore } from "./smoke-harness.js";
import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import type { ActivitySpan, GraphMaintenanceResponse, GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { useWebSocket } from "../../src/hooks/use-websocket.js";
import { Segmented, SwitchRow } from "../../src/components/graph/graph-form.js";
import { NodeCard } from "../../src/components/graph/node-card.js";

installSmokeHarness(unregisterSmokeActivityGraphDom);

function activityMessages(socket: PageSocket): unknown[] {
  return socket.sent
    .map((frame) => JSON.parse(frame) as { type: string })
    .filter((frame) => frame.type.startsWith("activity_"));
}

const graphNode = (id: number, title: string): GraphNodePayload => ({
  id,
  path: `notes/${title.toLowerCase().replaceAll(" ", "-")}.md`,
  title,
  type: "note",
  inDegree: 0,
  outDegree: 0,
  distance: 0,
});

function graphMaintenance(unreachable: GraphNodePayload[]): GraphMaintenanceResponse {
  return {
    orphans: [],
    unreachable,
    brokenLinks: [],
    stale: [],
    staleDays: 180,
  };
}

describe("ActivityPage lifecycle", () => {
  test("mount refreshes every read model and a socket reconnect re-establishes exactly one index subscription", async () => {
    const fetchCalls = installActivityFetch();
    PageSocket.instances = [];
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const reconnectTimers = new Map<number, { handler: () => void; delay: number }>();
    let nextTimer = 0;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
      const id = ++nextTimer;
      if (typeof handler === "function") {
        reconnectTimers.set(id, { handler: handler as () => void, delay: delay ?? 0 });
      }
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: number | NodeJS.Timeout) => {
      if (typeof id === "number") reconnectTimers.delete(id);
    }) as typeof clearTimeout;

    let socketOwner: ReturnType<typeof renderHook> | undefined;
    let page: ReturnType<typeof render> | undefined;
    try {
      socketOwner = renderHook(() => useWebSocket());
      const first = PageSocket.instances[0]!;
      act(() => {
        first.open();
        first.deliver({
          type: "server_hello",
          protocolRev: 3,
          capabilities: { activity: true },
        });
      });
      const inboxLoadsBeforeMount = fetchCalls.filter((url) =>
        url.includes("/activity/inbox")
      ).length;

      page = render(<ActivityPage />);
      await act(flushPromises);

      expect(activityMessages(first)).toEqual([
        { type: "activity_subscribe", view: "index" },
      ]);
      expect(fetchCalls.filter((url) => url.includes("/activity/runs?"))).toHaveLength(1);
      expect(fetchCalls.filter((url) => url.includes("/activity/rollups"))).toHaveLength(1);
      expect(fetchCalls.filter((url) => url.includes("/models/pricing"))).toHaveLength(1);
      expect(fetchCalls.filter((url) => url.includes("/activity/inbox"))).toHaveLength(
        inboxLoadsBeforeMount + 1
      );
      const inboxLoadsBeforeReconnect = fetchCalls.filter((url) =>
        url.includes("/activity/inbox")
      ).length;

      act(() => first.close());
      const scheduledReconnects = [...reconnectTimers.entries()].filter(
        ([, timer]) => timer.delay === 1_000
      );
      expect(scheduledReconnects).toHaveLength(1);

      const reconnect = scheduledReconnects[0]!;
      reconnectTimers.delete(reconnect[0]);
      act(() => reconnect[1].handler());
      const replacement = PageSocket.instances[1]!;
      act(() => {
        replacement.open();
        replacement.deliver({
          type: "server_hello",
          protocolRev: 3,
          capabilities: { activity: true },
        });
      });
      await act(flushPromises);

      expect(activityMessages(replacement)).toEqual([
        { type: "activity_unsubscribe", view: "index" },
        { type: "activity_subscribe", view: "index" },
      ]);
      expect(
        activityMessages(replacement).filter(
          (message) => (message as { type: string }).type === "activity_subscribe"
        )
      ).toEqual([{ type: "activity_subscribe", view: "index" }]);
      expect(fetchCalls.filter((url) => url.includes("/activity/runs?"))).toHaveLength(2);
      expect(fetchCalls.filter((url) => url.includes("/activity/rollups"))).toHaveLength(2);
      expect(fetchCalls.filter((url) => url.includes("/models/pricing"))).toHaveLength(2);
      expect(fetchCalls.filter((url) => url.includes("/activity/inbox"))).toHaveLength(
        inboxLoadsBeforeReconnect + 1
      );
      expect(
        [...reconnectTimers.values()].filter((timer) => timer.delay === 1_000)
      ).toHaveLength(0);

      act(() => replacement.close());
      expect(
        [...reconnectTimers.values()].filter((timer) => timer.delay === 1_000)
      ).toHaveLength(1);
      socketOwner.unmount();
      socketOwner = undefined;
      expect(
        [...reconnectTimers.values()].filter((timer) => timer.delay === 1_000)
      ).toHaveLength(0);
    } finally {
      page?.unmount();
      socketOwner?.unmount();
      reconnectTimers.clear();
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("unmount releases the index subscription, hash listener, and live-row ticker", async () => {
    installActivityFetch();
    PageSocket.instances = [];
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;

    const hashListeners = new Set<EventListenerOrEventListenerObject>();
    const realAddEventListener = window.addEventListener;
    const realRemoveEventListener = window.removeEventListener;
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === "hashchange") hashListeners.add(listener);
      realAddEventListener.call(window, type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      if (type === "hashchange") hashListeners.delete(listener);
      realRemoveEventListener.call(window, type, listener, options);
    }) as typeof window.removeEventListener;

    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const liveIntervals = new Set<unknown>();
    let nextInterval = 0;
    globalThis.setInterval = ((_handler: TimerHandler) => {
      const id = ++nextInterval;
      liveIntervals.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: number | NodeJS.Timeout) => {
      liveIntervals.delete(id);
    }) as typeof clearInterval;

    const root: ActivitySpan = {
      spanId: "root-live",
      runId: "run-live",
      name: "Live cron",
      kind: "turn",
      origin: "cron",
      startedAt: Date.now(),
    };
    useActivityStore.setState({
      supported: true,
      spans: { "run-live": { "root-live": root } },
    });

    let socketOwner: ReturnType<typeof renderHook> | undefined;
    let page: ReturnType<typeof render> | undefined;

    try {
      socketOwner = renderHook(() => useWebSocket());
      const socket = PageSocket.instances[0]!;
      act(() => socket.open());
      page = render(<ActivityPage />);
      await act(flushPromises);
      expect(hashListeners.size).toBe(1);
      expect(liveIntervals.size).toBe(1);
      expect(activityMessages(socket)).toEqual([
        { type: "activity_subscribe", view: "index" },
      ]);

      page.unmount();
      page = undefined;

      expect(hashListeners.size).toBe(0);
      expect(liveIntervals.size).toBe(0);
      expect(activityMessages(socket)).toEqual([
        { type: "activity_subscribe", view: "index" },
        { type: "activity_unsubscribe", view: "index" },
      ]);
    } finally {
      page?.unmount();
      socketOwner?.unmount();
      window.addEventListener = realAddEventListener;
      window.removeEventListener = realRemoveEventListener;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  test("initial and in-place activity hashes select the addressed run", async () => {
    installActivityFetch();
    history.replaceState(null, "", "#/activity/run%20one");

    const page = render(<ActivityPage />);
    await act(flushPromises);
    expect(page.getByRole("heading", { name: "run one" })).toBeTruthy();

    act(() => setHash("#/activity/run%2Ftwo"));
    await act(flushPromises);
    expect(page.getByRole("heading", { name: "run/two" })).toBeTruthy();
  });

  test("an older successful detail response cannot clobber the newer selection", async () => {
    const oldDetail = deferred<Response>();
    const newDetail = deferred<Response>();
    installActivityFetch((url) => {
      if (url.includes("/activity/runs/old?")) return oldDetail.promise;
      if (url.includes("/activity/runs/new?")) return newDetail.promise;
      return undefined;
    });
    history.replaceState(null, "", "#/activity/old");

    const page = render(<ActivityPage />);
    await act(flushPromises);
    expect(page.getByRole("heading", { name: "old" })).toBeTruthy();

    act(() => setHash("#/activity/new"));
    await act(flushPromises);
    newDetail.resolve(Response.json(activityDetail("new", "New detail")));
    await act(flushPromises);
    expect(page.getByRole("heading", { name: "New detail" })).toBeTruthy();

    oldDetail.resolve(Response.json(activityDetail("old", "Old detail")));
    await act(flushPromises);
    expect(Boolean(page.queryByRole("heading", { name: "Old detail" }))).toBe(false);
    expect(page.getByRole("heading", { name: "New detail" })).toBeTruthy();
  });

  test("a successful detail response cannot write to the activity store after unmount", async () => {
    const lateDetail = deferred<Response>();
    installActivityFetch((url) =>
      url.includes("/activity/runs/gone?") ? lateDetail.promise : undefined
    );
    history.replaceState(null, "", "#/activity/gone");

    const page = render(<ActivityPage />);
    await act(flushPromises);
    page.unmount();

    const lateSpan: ActivitySpan = {
      spanId: "late-root",
      runId: "gone",
      name: "Late write",
      kind: "turn",
      origin: "cron",
      startedAt: 1,
    };
    lateDetail.resolve(
      Response.json({
        ...activityDetail("gone", "Gone detail"),
        spans: [lateSpan],
        highWaterSeq: 1,
      })
    );
    await act(flushPromises);

    expect(useActivityStore.getState().spans.gone?.["late-root"]).toBeUndefined();
  });
});

describe("GraphPage lifecycle", () => {
  test("mount waits for a forced metadata refresh before requesting the scene", async () => {
    const metaGate = deferred<void>();
    const calls: string[] = [];
    useGraphStore.setState({
      mode: "local",
      fetchMeta: async (force) => {
        calls.push(`meta:${String(force)}`);
        await metaGate.promise;
      },
      fetchScene: async () => {
        calls.push("scene");
      },
    });

    const page = render(<GraphPage />);
    expect(calls).toEqual(["meta:true"]);

    metaGate.resolve();
    await act(flushPromises);
    expect(calls).toEqual(["meta:true", "scene"]);

    page.unmount();
  });

  test("the page does not start its scene request after unmount when metadata resolves late", async () => {
    const metaGate = deferred<void>();
    const calls: string[] = [];
    useGraphStore.setState({
      fetchMeta: async () => {
        calls.push("meta");
        await metaGate.promise;
      },
      fetchScene: async () => {
        calls.push("scene");
      },
    });

    const page = render(<GraphPage />);
    expect(calls).toEqual(["meta"]);
    page.unmount();

    metaGate.resolve();
    await act(flushPromises);
    expect(calls).toEqual(["meta"]);
  });

  test("a mounted page keeps a newer scene when the older response arrives last", async () => {
    const oldResponse = deferred<Response>();
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/graph/meta")) {
        return Response.json({
          available: true,
          schemaVersion: 8,
          computedAt: "2026-09-09T00:00:00Z",
          stale: false,
          nodeCount: 2,
          edgeCount: 0,
          communities: [],
          defaultRoot: null,
        });
      }
      if (url.includes("center=old.md")) return oldResponse.promise;
      if (url.includes("center=new.md")) {
        return Response.json({
          nodes: [],
          edges: [],
          truncated: false,
          unreachableCount: 22,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    useGraphStore.setState({
      mode: "local",
      local: { center: "old.md", depth: 1, direction: "both" },
    });

    const page = render(<GraphPage />);
    await act(flushPromises);
    expect(requests.some((url) => url.includes("center=old.md"))).toBe(true);

    act(() => useGraphStore.getState().setLocalParams({ center: "new.md" }));
    await act(flushPromises);
    expect(useGraphStore.getState().subgraph?.unreachableCount).toBe(22);

    oldResponse.resolve(
      Response.json({
        nodes: [],
        edges: [],
        truncated: false,
        unreachableCount: 11,
      })
    );
    await act(flushPromises);
    expect(useGraphStore.getState().subgraph?.unreachableCount).toBe(22);
    page.unmount();
  });

  test("UnreachableTray ignores an older maintenance response after its dependency changes", async () => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("staleDays=180")) return oldResponse.promise;
      if (url.includes("staleDays=30")) return newResponse.promise;
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    useGraphStore.setState({
      mode: "discovery",
      meta: {
        available: true,
        schemaVersion: 8,
        computedAt: "2026-09-09T00:00:00Z",
        stale: false,
        nodeCount: 1,
        edgeCount: 0,
        communities: [],
        defaultRoot: { path: "AGENTS.md", virtual: true },
      },
      metaState: "done",
      discovery: { root: null, maxDepth: 8 },
      subgraph: { nodes: [graphNode(1, "Root")], edges: [], truncated: false },
      dataState: "done",
      fetchMeta: async () => {},
      fetchScene: async () => {},
    });

    const page = render(<GraphPage />);
    await act(flushPromises);
    expect(requests.some((url) => url.includes("staleDays=180"))).toBe(true);

    act(() => useGraphStore.getState().setMaintenanceParams({ staleDays: 30 }));
    await act(flushPromises);
    expect(requests.some((url) => url.includes("staleDays=30"))).toBe(true);

    newResponse.resolve(
      Response.json(graphMaintenance([graphNode(2, "New unreachable")]))
    );
    await act(flushPromises);
    fireEvent.click(page.getByRole("button", { name: "1 unreachable" }));
    expect(page.getByText("New unreachable")).toBeTruthy();

    let staleReads = 0;
    const staleData = {
      ...graphMaintenance([]),
      get unreachable() {
        staleReads += 1;
        return [graphNode(3, "Stale unreachable")];
      },
    };
    oldResponse.resolve({
      ok: true,
      json: async () => staleData,
    } as Response);
    await act(flushPromises);

    expect(staleReads).toBe(0);
    expect(page.queryByText("Stale unreachable")).toBeNull();
    expect(page.getByText("New unreachable")).toBeTruthy();
  });

  test("unmount clears the note-picker search debounce before it can request", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const realWindowSetTimeout = window.setTimeout;
    const realWindowClearTimeout = window.clearTimeout;
    const pendingTimers = new Map<number, { handler: () => void; delay: number }>();
    let nextTimer = 0;
    const fakeSetTimeout = ((handler: TimerHandler, delay?: number) => {
      const id = ++nextTimer;
      if (typeof handler === "function") {
        pendingTimers.set(id, { handler: handler as () => void, delay: delay ?? 0 });
      }
      return id;
    }) as typeof globalThis.setTimeout;
    const fakeClearTimeout = ((id?: number | NodeJS.Timeout) => {
      if (typeof id === "number") pendingTimers.delete(id);
    }) as typeof globalThis.clearTimeout;
    globalThis.setTimeout = fakeSetTimeout;
    globalThis.clearTimeout = fakeClearTimeout;
    window.setTimeout = fakeSetTimeout as typeof window.setTimeout;
    window.clearTimeout = fakeClearTimeout as typeof window.clearTimeout;

    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ results: [] });
    }) as typeof fetch;
    useGraphStore.setState({
      mode: "local",
      meta: {
        available: true,
        schemaVersion: 8,
        computedAt: "2026-09-09T00:00:00Z",
        stale: false,
        nodeCount: 1,
        edgeCount: 0,
        communities: [],
        defaultRoot: null,
      },
      metaState: "done",
      local: { center: "current.md", depth: 1, direction: "both" },
      subgraph: { nodes: [], edges: [], truncated: false },
      dataState: "done",
      fetchMeta: async () => {},
      fetchScene: async () => {},
    });

    let page: ReturnType<typeof render> | undefined;
    try {
      page = render(<GraphPage />);
      const picker = page.getByPlaceholderText("Search notes…") as HTMLInputElement;
      act(() => picker.focus());
      expect(picker.value).toBe("");
      changeControlledInput(picker, "pending");
      await act(flushPromises);
      expect(picker.value).toBe("pending");

      expect([...pendingTimers.values()].filter((timer) => timer.delay === 250)).toHaveLength(1);
      expect(requests).toEqual([]);

      page.unmount();
      page = undefined;

      expect([...pendingTimers.values()].filter((timer) => timer.delay === 250)).toHaveLength(0);
      expect(requests).toEqual([]);
    } finally {
      page?.unmount();
      pendingTimers.clear();
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      window.setTimeout = realWindowSetTimeout;
      window.clearTimeout = realWindowClearTimeout;
    }
  });

  test("note-picker search aborts without reading its payload after unmount", async () => {
    const searchResponse = deferred<Response>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const realWindowSetTimeout = window.setTimeout;
    const realWindowClearTimeout = window.clearTimeout;
    const pendingTimers = new Map<number, { handler: () => void; delay: number }>();
    let nextTimer = 0;
    const fakeSetTimeout = ((handler: TimerHandler, delay?: number) => {
      const id = ++nextTimer;
      if (typeof handler === "function") {
        pendingTimers.set(id, { handler: handler as () => void, delay: delay ?? 0 });
      }
      return id;
    }) as typeof globalThis.setTimeout;
    const fakeClearTimeout = ((id?: number | NodeJS.Timeout) => {
      if (typeof id === "number") pendingTimers.delete(id);
    }) as typeof globalThis.clearTimeout;
    globalThis.setTimeout = fakeSetTimeout;
    globalThis.clearTimeout = fakeClearTimeout;
    window.setTimeout = fakeSetTimeout as typeof window.setTimeout;
    window.clearTimeout = fakeClearTimeout as typeof window.clearTimeout;

    const requests: { url: string; signal: AbortSignal | null }[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), signal: init?.signal ?? null });
      return Promise.race([
        searchResponse.promise,
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        }),
      ]);
    }) as typeof fetch;
    useGraphStore.setState({
      mode: "local",
      meta: {
        available: true,
        schemaVersion: 8,
        computedAt: "2026-09-09T00:00:00Z",
        stale: false,
        nodeCount: 1,
        edgeCount: 0,
        communities: [],
        defaultRoot: null,
      },
      metaState: "done",
      local: { center: "current.md", depth: 1, direction: "both" },
      subgraph: { nodes: [], edges: [], truncated: false },
      dataState: "done",
      fetchMeta: async () => {},
      fetchScene: async () => {},
    });

    let page: ReturnType<typeof render> | undefined;
    try {
      page = render(<GraphPage />);
      const picker = page.getByPlaceholderText("Search notes…") as HTMLInputElement;
      act(() => picker.focus());
      expect(picker.value).toBe("");
      changeControlledInput(picker, "late");
      await act(flushPromises);
      expect(picker.value).toBe("late");

      const debounce = [...pendingTimers.entries()].find(
        ([, timer]) => timer.delay === 250
      );
      expect(debounce).toBeTruthy();
      pendingTimers.delete(debounce![0]);
      act(() => {
        void debounce![1].handler();
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("/api/brain/search?q=late&limit=8");
      expect(requests[0]!.signal?.aborted).toBe(false);

      page.unmount();
      page = undefined;
      expect(requests[0]!.signal?.aborted).toBe(true);

      let resultReads = 0;
      searchResponse.resolve({
        ok: true,
        json: async () => ({
          get results() {
            resultReads += 1;
            return [{ path: "notes/late.md", title: "Late result" }];
          },
        }),
      } as Response);
      await act(flushPromises);

      expect(resultReads).toBe(0);
    } finally {
      page?.unmount();
      pendingTimers.clear();
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      window.setTimeout = realWindowSetTimeout;
      window.clearTimeout = realWindowClearTimeout;
    }
  });

  test("DiscoveryStart requests and consumes index-note candidates while mounted", async () => {
    const candidatesResponse = deferred<Response>();
    const requests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      requests.push(String(input));
      return candidatesResponse.promise;
    }) as typeof fetch;
    useGraphStore.setState({
      mode: "discovery",
      meta: {
        available: true,
        schemaVersion: 8,
        computedAt: "2026-09-09T00:00:00Z",
        stale: false,
        nodeCount: 1,
        edgeCount: 0,
        communities: [],
        defaultRoot: null,
      },
      metaState: "done",
      discovery: { root: null, maxDepth: 8 },
      dataState: "idle",
      fetchMeta: async () => {},
      fetchScene: async () => {},
    });

    const page = render(<GraphPage />);
    await act(flushPromises);
    expect(requests).toEqual(["/api/brain/list?type=index&limit=6"]);

    candidatesResponse.resolve(
      Response.json({
        results: [{ path: "notes/index.md", title: "Project index" }],
      })
    );
    await act(flushPromises);

    expect(page.getByRole("button", { name: /Project index/ })).toBeTruthy();
    expect(page.getByText("notes/index.md")).toBeTruthy();
  });

  test("DiscoveryStart releases its pending response on unmount", async () => {
    const candidatesResponse = deferred<Response>();
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (String(input).includes("/brain/list?")) return candidatesResponse.promise;
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    useGraphStore.setState({
      mode: "discovery",
      meta: {
        available: true,
        schemaVersion: 8,
        computedAt: "2026-09-09T00:00:00Z",
        stale: false,
        nodeCount: 1,
        edgeCount: 0,
        communities: [],
        defaultRoot: null,
      },
      metaState: "done",
      discovery: { root: null, maxDepth: 8 },
      dataState: "idle",
      fetchMeta: async () => {},
      fetchScene: async () => {},
    });

    const page = render(<GraphPage />);
    await act(flushPromises);
    expect(requests).toEqual(["/api/brain/list?type=index&limit=6"]);
    expect(page.getByRole("heading", { name: "Where should discovery start?" })).toBeTruthy();
    page.unmount();

    let resultReads = 0;
    candidatesResponse.resolve({
      ok: true,
      json: async () => ({
        get results() {
          resultReads += 1;
          return [{ path: "notes/index.md", title: "Index" }];
        },
      }),
    } as Response);
    await act(flushPromises);

    expect(resultReads).toBe(0);
  });
});

/* ── S7 (graph): the options form and the node card render from props ───── */

describe("graph views", () => {
  test("a segmented choice is a kit FilterRow and a switch is a named kit Toggle", () => {
    const onChange = mock((_v: string) => {});
    const seg = render(<Segmented options={[{ value: "in", label: "In" }, { value: "out", label: "Out" }, { value: "both", label: "Both" }]} value="out" onChange={onChange} />);
    expect(seg.getByRole("tab", { name: "Out" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(seg.getByRole("tab", { name: "Both" }));
    expect(onChange).toHaveBeenCalledWith("both");
    seg.unmount();
    const onToggle = mock((_v: boolean) => {});
    const sw = render(<SwitchRow checked={false} onChange={onToggle} label="Orphans" />);
    const control = sw.getByRole("switch", { name: "Orphans" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(onToggle).toHaveBeenCalledWith(true);
    sw.unmount();
  });

  test("the node card shows kind, topic, path and degrees, and offers only the actions that apply", () => {
    const h = { onOpen: mock(() => {}), onFocus: mock(() => {}), onExpand: mock(() => {}), onClose: mock(() => {}) };
    const view = render(<NodeCard kind="note" title="Lisbon venues" path="talks/lisbon.md" topic="travel" topicColor="#123456" inDegree={3} outDegree={1} distance={2} canOpen canFocus canExpand {...h} />);
    expect(view.getByText("note")).toBeTruthy();
    expect(view.getByText("topic: travel")).toBeTruthy();
    expect(view.getByText("talks/lisbon.md")).toBeTruthy();
    expect(view.getByText("2 hops")).toBeTruthy();
    expect(view.getByText("3 in")).toBeTruthy();
    expect(view.getByText("1 out")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Open note" }));
    fireEvent.click(view.getByRole("button", { name: "Focus here" }));
    fireEvent.click(view.getByRole("button", { name: "Expand" }));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect([h.onOpen, h.onFocus, h.onExpand, h.onClose].map((m) => m.mock.calls.length)).toEqual([1, 1, 1, 1]);
    view.unmount();
    const root = render(<NodeCard kind="root" title="root" path="" inDegree={0} outDegree={4} canOpen={false} canFocus={false} canExpand={false} {...h} />);
    expect(root.queryByRole("button", { name: "Open note" })).toBeNull();
    expect(root.queryByText(/hop/)).toBeNull();
    root.unmount();
  });
});
