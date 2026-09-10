// Render smoke tests: mount the highest-traffic components in happy-dom and
// assert the DOM they produce, not just their pure helpers. Fixtures are
// minimal and keyless; nothing here touches the network.
//
// The dom.js import MUST stay first — it registers the happy-dom globals
// before the component module bodies run, and its header documents why every
// render test lives in this one file and why `screen` must not be used.
import { unregisterDom } from "./dom.js";

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import type {
  ActivityRunDetail,
  ActivityRunRollup,
  ActivitySpan,
  GraphMaintenanceResponse,
  GraphNodePayload,
} from "@schlessera/brain-ui-sdk/protocol";

import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { MarkdownContent } from "../../src/components/chat/markdown-content.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { AskUserCard } from "../../src/components/chat/ask-user-card.js";
import { ZoomViewer } from "../../src/components/viewer/zoom-viewer.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import { useHashRoutes } from "../../src/hooks/use-hash-routes.js";
import {
  hasUnsentText,
  useServiceWorkerUpdates,
} from "../../src/hooks/use-service-worker-updates.js";
import { useFileStore } from "../../src/stores/file-store.js";
import { useActivityStore } from "../../src/stores/activity-store.js";
import {
  clearGraphSceneCache,
  useGraphStore,
} from "../../src/stores/graph-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import { useWebSocket } from "../../src/hooks/use-websocket.js";

// Page lifecycle tests need SceneBody's overlay effects, not Sigma/WebGL. The
// production canvas is already runtime-tested in a real browser; happy-dom has
// no WebGL globals and cannot even evaluate Sigma's module body.
mock.module("../../src/components/graph/graph-canvas.js", () => ({
  default: () => <div data-testid="graph-canvas" />,
}));

afterEach(cleanup);
afterAll(unregisterDom);

const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
const realGraphFetchMeta = useGraphStore.getInitialState().fetchMeta;
const realGraphFetchScene = useGraphStore.getInitialState().fetchScene;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = RealWebSocket;
  history.replaceState(null, "", "/");
  clearGraphSceneCache();
  useActivityStore.setState({
    supported: false,
    subscribed: {},
    connectionEpoch: 0,
    spans: {},
    events: {},
    highWater: {},
    deltaSeq: {},
    spanRun: {},
    inbox: [],
  });
  useGraphStore.setState({
    mode: "clusters",
    meta: null,
    metaState: "idle",
    local: { center: null, depth: 1, direction: "both" },
    discovery: { root: null, maxDepth: 8 },
    clusters: { community: null, isolates: false },
    maintenance: { staleDays: 180 },
    subgraph: null,
    findings: null,
    dataState: "idle",
    error: null,
    sceneQuery: "",
    selectedId: null,
    hoveredId: null,
    fetchMeta: realGraphFetchMeta,
    fetchScene: realGraphFetchScene,
  });
  useUIStore.setState({
    activeView: "chat",
    filePanelOpen: false,
    settingsPanelOpen: false,
  });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function changeControlledInput(input: HTMLInputElement, value: string): void {
  // happy-dom's input value tracker does not drive React's synthetic onChange
  // in this shared-process harness. Invoke the mounted element's current prop
  // so the component still owns the state transition and effects under test.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React input props were not attached");
  const props = (input as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
    propsKey
  ];
  if (!props?.onChange) throw new Error("React input has no onChange handler");
  act(() => props.onChange!({ target: { value } }));
}

class PageSocket {
  static instances: PageSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor() {
    PageSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

function installActivityFetch(
  detailResponse?: (url: string) => Response | Promise<Response> | undefined
): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const detail = detailResponse?.(url);
    if (detail) return detail;
    if (url.includes("/activity/runs?")) {
      return Response.json({ live: [], history: [] });
    }
    if (url.includes("/activity/rollups")) {
      return Response.json({ timeZone: "UTC", days: [] });
    }
    if (url.includes("/models/pricing")) {
      return Response.json({ stale: false, error: null });
    }
    if (url.includes("/activity/inbox")) {
      return Response.json({ intents: [] });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  return calls;
}

function activityMessages(socket: PageSocket): unknown[] {
  return socket.sent
    .map((frame) => JSON.parse(frame) as { type: string })
    .filter((frame) => frame.type.startsWith("activity_"));
}

function activityRollup(name: string): ActivityRunRollup {
  return {
    origin: "cron",
    name,
    sessionId: null,
    jobName: null,
    startedAt: 1,
    endedAt: 2,
    outcome: "success",
    durationMs: 1,
    spanCount: 0,
    costUsd: null,
    failureReason: null,
  };
}

function activityDetail(runId: string, name: string): ActivityRunDetail {
  return {
    runId,
    detailPruned: false,
    spans: [],
    events: [],
    highWaterSeq: 0,
    rollup: activityRollup(name),
  };
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

function setHash(hash: string): void {
  history.replaceState(null, "", hash || "/");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

describe("useHashRoutes", () => {
  const originalOpenFile = useFileStore.getState().openFile;
  const originalOpenDir = useFileStore.getState().openDir;

  afterEach(() => {
    history.replaceState(null, "", "/");
    act(() => {
      useUIStore.setState({ activeView: "chat", filePanelOpen: false });
      useFileStore.setState({
        openFile: originalOpenFile,
        openDir: originalOpenDir,
      });
    });
  });

  test("opens file and directory hash routes", async () => {
    const openedFiles: string[] = [];
    const openedDirs: string[] = [];
    useFileStore.setState({
      openFile: async (path) => {
        openedFiles.push(path);
      },
      openDir: async (path) => {
        openedDirs.push(path);
      },
    });
    history.replaceState(null, "", "#/files/notes/example.md");
    renderHook(() => useHashRoutes());

    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(openedFiles).toEqual(["notes/example.md"]);

    act(() => setHash("#/files/projects/current/"));
    expect(openedDirs).toEqual(["projects/current"]);
  });

  test("selects graph and activity routes while preserving activity deep links", () => {
    history.replaceState(null, "", "#/graph");
    renderHook(() => useHashRoutes());
    expect(useUIStore.getState().activeView).toBe("graph");

    act(() => setHash("#/activity/run-42"));
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(window.location.hash).toBe("#/activity/run-42");
  });

  test("store-driven replaceState sync is silent and does not loop", () => {
    history.replaceState(null, "", "/");
    const originalReplaceState = history.replaceState.bind(history);
    const replacements: string[] = [];
    history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      replacements.push(String(url));
      originalReplaceState(data, unused, url);
    }) as typeof history.replaceState;

    const { rerender } = renderHook(() => useHashRoutes());
    act(() => useUIStore.getState().setActiveView("graph"));
    expect(window.location.hash).toBe("#/graph");
    expect(replacements).toEqual(["#/graph"]);

    rerender();
    expect(replacements).toEqual(["#/graph"]);

    const chatRoute = window.location.pathname;
    act(() => useUIStore.getState().setActiveView("chat"));
    expect(window.location.hash).toBe("");
    expect(replacements).toEqual(["#/graph", chatRoute]);

    history.replaceState = originalReplaceState;
  });

  test("an activity deep-link change does not swallow the next view switch", () => {
    // `#/activity/one` -> `#/activity/two` keeps the SAME active view, so
    // setActiveView is a no-op and the store-sync effect never runs. If the
    // hash effect armed its suppression flag anyway, the flag would still be
    // set when the user later switches to Chat, and the URL would be left
    // pointing at Activity while the app shows Chat — a refresh would jump
    // back to Activity.
    history.replaceState(null, "", "#/activity/one");
    renderHook(() => useHashRoutes());
    expect(useUIStore.getState().activeView).toBe("activity");

    act(() => {
      history.replaceState(null, "", "#/activity/two");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(window.location.hash).toBe("#/activity/two");

    act(() => useUIStore.getState().setActiveView("chat"));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(window.location.hash).toBe("");
  });
});

class FakeServiceWorker extends EventTarget {
  state: ServiceWorkerState = "installing";

  install(): void {
    this.state = "installed";
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeServiceWorkerRegistration extends EventTarget {
  constructor(readonly installing: ServiceWorker) {
    super();
  }
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: ServiceWorker | null = null;
  readonly worker = new FakeServiceWorker();
  readonly registration = new FakeServiceWorkerRegistration(
    this.worker as unknown as ServiceWorker
  );
  registerCalls: string[] = [];

  async register(path: string): Promise<ServiceWorkerRegistration> {
    this.registerCalls.push(path);
    return this.registration as unknown as ServiceWorkerRegistration;
  }

  takeControl(): void {
    this.controller = this.worker as unknown as ServiceWorker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

describe("useServiceWorkerUpdates", () => {
  test("the default DOM probe finds non-empty text fields", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    expect(hasUnsentText()).toBe(false);
    textarea.value = "draft";
    expect(hasUnsentText()).toBe(true);
    textarea.remove();
  });

  test("does not reload on first install", async () => {
    const serviceWorker = new FakeServiceWorkerContainer();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    let reloads = 0;
    renderHook(() =>
      useServiceWorkerUpdates({
        isBusy: false,
        hasUnsentText: () => false,
        reload: () => reloads++,
      })
    );
    await act(async () => Promise.resolve());

    act(() => {
      serviceWorker.worker.install();
      serviceWorker.takeControl();
    });

    expect(serviceWorker.registerCalls).toEqual(["/service-worker.js"]);
    expect(reloads).toBe(0);
  });

  test("defers an update takeover until idle and reloads at most once", async () => {
    const serviceWorker = new FakeServiceWorkerContainer();
    serviceWorker.controller = {} as ServiceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    let reloads = 0;
    const { rerender } = renderHook(
      ({ isBusy }) =>
        useServiceWorkerUpdates({
          isBusy,
          hasUnsentText: () => false,
          reload: () => reloads++,
        }),
      { initialProps: { isBusy: true } }
    );
    await act(async () => Promise.resolve());

    act(() => {
      serviceWorker.worker.install();
      serviceWorker.takeControl();
    });
    expect(reloads).toBe(0);

    rerender({ isBusy: false });
    expect(reloads).toBe(1);

    act(() => serviceWorker.takeControl());
    rerender({ isBusy: false });
    expect(reloads).toBe(1);
  });
});

describe("MarkdownContent", () => {
  test("renders heading, list, and code from markdown source", () => {
    const { getByRole, getAllByRole, baseElement } = render(
      <MarkdownContent
        content={"# Field Notes\n\n- first item\n- second item\n\n`inline code`"}
      />
    );
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Field Notes");
    expect(getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "first item",
      "second item",
    ]);
    expect(baseElement.querySelector("code")?.textContent).toBe("inline code");
  });
});

describe("ToolCallTimeline", () => {
  const completedRead: ToolCall = {
    id: "tool-1",
    name: "Read",
    input: { file_path: "/data/brain/notes/example.md" },
    inputJson: JSON.stringify({ file_path: "/data/brain/notes/example.md" }, null, 2),
    status: "complete",
    output: "file contents here",
  };

  test("non-live completed run mounts as the collapsed summary row only", () => {
    const { getByRole, queryByText, baseElement } = render(
      <ToolCallTimeline toolCalls={[completedRead]} onApproval={() => {}} />
    );
    // Summary row present…
    expect(getByRole("button").textContent).toContain("1 step");
    // …and the per-entry detail subtree is NOT mounted: no tool label, no
    // input JSON, no output.
    expect(queryByText("Read")).toBeNull();
    expect(baseElement.textContent).not.toContain("file_path");
    expect(baseElement.textContent).not.toContain("file contents here");
  });

  test("expanding the summary row mounts the per-tool entries", () => {
    const { getByRole, getByText } = render(
      <ToolCallTimeline toolCalls={[completedRead]} onApproval={() => {}} />
    );
    fireEvent.click(getByRole("button"));
    expect(getByText("Read")).toBeTruthy();
  });
});

describe("AskUserCard", () => {
  const questions: AskUserQuestion[] = [
    {
      question: "Which draft should I keep?",
      header: "Draft",
      multiSelect: false,
      options: [
        { label: "Alpha", description: "the longer draft" },
        { label: "Beta", description: "the shorter draft" },
      ],
    },
  ];

  test("renders every option and submits the clicked one", () => {
    const submitted: unknown[] = [];
    const { getByText } = render(
      <AskUserCard
        requestId="req-1"
        questions={questions}
        onSubmit={(requestId, answers) => submitted.push([requestId, answers])}
        onCancel={() => {}}
      />
    );
    expect(getByText("Alpha")).toBeTruthy();
    expect(getByText("Beta")).toBeTruthy();

    fireEvent.click(getByText("Alpha"));
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([
      ["req-1", { "Which draft should I keep?": "Alpha" }],
    ]);
  });

  test("cancelled card collapses to a summary row without options", () => {
    const { queryByText } = render(
      <AskUserCard
        requestId="req-2"
        questions={questions}
        cancelled
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(queryByText("Beta")).toBeNull();
  });
});

describe("ZoomViewer", () => {
  test("mounts its content in a portal and closes from the toolbar", () => {
    let closed = 0;
    const { getByText, getByTitle } = render(
      <ZoomViewer onClose={() => closed++}>
        <div>zoomed content</div>
      </ZoomViewer>
    );
    expect(getByText("zoomed content")).toBeTruthy();
    fireEvent.click(getByTitle("Close"));
    expect(closed).toBe(1);
  });
});
