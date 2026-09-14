// Render smoke tests: mount the highest-traffic components in happy-dom and
// assert the DOM they produce, not just their pure helpers. Fixtures are
// minimal and keyless; nothing here touches the network.
//
// The dom.js import MUST stay first — it registers the happy-dom globals
// before the component module bodies run, and its header documents why every
// render test lives in this one file and why `screen` must not be used.
import { unregisterDom } from "./dom.js";

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, forwardRef, useState, type ReactNode } from "react";
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
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { Composer } from "../../src/components/chat/composer.js";
import { DevicesAgentsTab } from "../../src/components/settings/devices-agents-tab.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { useConnectionStore } from "../../src/stores/connection-store.js";
import { useProviderStore } from "../../src/stores/provider-store.js";
import { usePrincipalStore } from "../../src/stores/principal-store.js";

// happy-dom rejects an animation's `finished` promise when a mounted gate
// changes branches. These tests exercise the rendered state transitions, not
// the animation engine, so keep motion elements as transparent DOM wrappers.
function createMotionElement(tag: string) {
  return forwardRef<HTMLElement, Record<string, unknown>>(
    (
      {
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        ...props
      },
      ref
    ) =>
      createElement(tag, { ...props, ref })
  );
}

const motionElements = new Map<
  string,
  ReturnType<typeof createMotionElement>
>();
mock.module("framer-motion", () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const existing = motionElements.get(tag);
        if (existing) return existing;
        const element = createMotionElement(tag);
        motionElements.set(tag, element);
        return element;
      },
    }
  ),
}));

// Page lifecycle tests need SceneBody's overlay effects, not Sigma/WebGL. The
// production canvas is already runtime-tested in a real browser; happy-dom has
// no WebGL globals and cannot even evaluate Sigma's module body.
mock.module("../../src/components/graph/graph-canvas.js", () => ({
  default: () => <div data-testid="graph-canvas" />,
}));

afterEach(cleanup);
afterAll(async () => {
  // Let React's scheduler drain before the DOM globals go. A test that
  // resolves a deferred response late can leave one `performWorkUntilDeadline`
  // task queued; unregistering underneath it throws "window is not defined"
  // from the scheduler, which Bun reports as an error and exits non-zero even
  // though every test passed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  unregisterDom();
});

const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
const realConfirm = window.confirm;
const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const realDateNow = Date.now;
const realGraphFetchMeta = useGraphStore.getInitialState().fetchMeta;
const realGraphFetchScene = useGraphStore.getInitialState().fetchScene;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = RealWebSocket;
  window.confirm = realConfirm;
  Date.now = realDateNow;
  if (realClipboard) {
    Object.defineProperty(navigator, "clipboard", realClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
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
    settingsTab: "models",
  });
  useConnectionStore.setState({
    wsStatus: "disconnected",
    vpnStatus: "checking",
    handshakeFailures: 0,
    lastCloseCode: null,
    socketOpens: 0,
    lastError: null,
  });
  useProviderStore.setState({
    available: [],
    selectedId: "",
    pinnedId: null,
    backends: {},
    loaded: false,
  });
  usePrincipalStore.setState({
    mintPending: false,
    mintError: null,
    oneTimeCredential: null,
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
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor() {
    PageSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

function installControlledTimeouts() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { handler: () => void; delay: number }>();
  let nextTimer = 0;

  globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
    const id = ++nextTimer;
    if (typeof handler === "function") {
      timers.set(id, { handler: handler as () => void, delay: delay ?? 0 });
    }
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number | NodeJS.Timeout) => {
    if (typeof id === "number") timers.delete(id);
  }) as typeof clearTimeout;

  return {
    timers,
    run(delay: number) {
      const timer = [...timers.entries()].find(([, entry]) => entry.delay === delay);
      if (!timer) throw new Error(`No ${delay}ms timer was scheduled`);
      timers.delete(timer[0]);
      act(() => timer[1].handler());
    },
    /**
     * Fire a timer whose handler is async (the connectivity poller's) and
     * await the work it starts. `run` would hand act() a promise it never
     * awaits, which interleaves act scopes into the NEXT test.
     */
    async runAsync(delay: number) {
      const timer = [...timers.entries()].find(([, entry]) => entry.delay === delay);
      if (!timer) throw new Error(`No ${delay}ms timer was scheduled`);
      timers.delete(timer[0]);
      await act(async () => {
        timer[1].handler();
        await flushPromises();
      });
    },
    restore() {
      timers.clear();
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

async function mountConnectionScenario(
  vpnResponses: Array<number | Promise<Response>>
) {
  PageSocket.instances = [];
  globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
  const timeouts = installControlledTimeouts();
  useConnectionStore.setState({
    wsStatus: "disconnected",
    vpnStatus: "connected",
    handshakeFailures: 0,
    lastCloseCode: null,
    socketOpens: 0,
    lastError: null,
  });
  const vpnChecks = installConnectionFetch(vpnResponses);

  const page = render(<LiveConnectionGate />);
  await act(flushPromises);
  expect(PageSocket.instances).toHaveLength(1);
  return { page, timeouts, vpnChecks };
}

async function failThreeHandshakes(
  timeouts: ReturnType<typeof installControlledTimeouts>
): Promise<void> {
  act(() => PageSocket.instances[0]!.close(1006));
  timeouts.run(1_000);
  act(() => PageSocket.instances[1]!.close(1006));
  timeouts.run(2_000);
  act(() => PageSocket.instances[2]!.close(1006));
  await act(flushPromises);
}

function installConnectionFetch(
  vpnResponses: Array<number | Promise<Response>>
): () => number {
  let vpnChecks = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/vpn-check")) {
      const response = vpnResponses[vpnChecks++];
      if (response === undefined) {
        throw new Error(`Unexpected VPN check ${vpnChecks}`);
      }
      return typeof response === "number"
        ? new Response(null, { status: response })
        : response;
    }
    if (url.includes("/api/auth/methods")) {
      return Response.json({ password: true, passkey: false });
    }
    if (url.includes("/api/providers")) {
      return Response.json({ providers: [], backends: {} });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  return () => vpnChecks;
}

function SocketOwnedComposer() {
  useWebSocket();
  return <Composer send={() => {}} />;
}

function LiveConnectionGate() {
  return (
    <ConnectionGate>
      <SocketOwnedComposer />
    </ConnectionGate>
  );
}

describe("push re-registration", () => {
  test("a failed bind retries after backoff on a later successful probe", async () => {
    const notificationDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Notification"
    );
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker"
    );
    const timeouts = installControlledTimeouts();
    let vpnChecks = 0;
    let pushAttempts = 0;

    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted" },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => ({
              toJSON: () => ({
                endpoint: "https://push.example/rebind",
                keys: { p256dh: "p256dh", auth: "auth" },
              }),
            }),
          },
        }),
      },
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/vpn-check")) {
        vpnChecks++;
        return new Response(null, { status: 200 });
      }
      if (url.includes("/api/push/subscribe")) {
        pushAttempts++;
        return pushAttempts === 1
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json({ ok: true });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;

    const page = render(
      <ConnectionGate>
        <div>Authenticated app</div>
      </ConnectionGate>
    );
    try {
      await act(flushPromises);
      expect(vpnChecks).toBe(1);
      expect(pushAttempts).toBe(1);
      expect(page.getByText("Authenticated app")).toBeTruthy();

      // Another healthy probe before the backoff elapses does not hammer the
      // registration route.
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await flushPromises();
      });
      expect(vpnChecks).toBe(2);
      expect(pushAttempts).toBe(1);

      // The failed bind becomes eligible after one second. The next
      // foreground-like connectivity event completes another authenticated
      // probe and retries without reloading or mounting the Activity page.
      timeouts.run(1_000);
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await flushPromises();
      });

      expect(vpnChecks).toBe(3);
      expect(pushAttempts).toBe(2);
      expect(page.getByText("Authenticated app")).toBeTruthy();
    } finally {
      page.unmount();
      timeouts.restore();
      if (notificationDescriptor) {
        Object.defineProperty(globalThis, "Notification", notificationDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Notification");
      }
      if (serviceWorkerDescriptor) {
        Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "serviceWorker");
      }
    }
  });
});

describe("refused WebSocket state", () => {
  test("three failed handshakes plus a healthy probe show refusal copy and report the error", async () => {
    const { page, timeouts, vpnChecks } = await mountConnectionScenario([200, 200]);
    try {
      await failThreeHandshakes(timeouts);
      expect(vpnChecks()).toBe(2);
      expect(page.getByRole("status").textContent).toContain(
        "Server refused the live connection"
      );
      expect(page.getByRole("button", { name: "Retry now" })).toBeTruthy();
      expect(page.getByPlaceholderText("Server refused the connection")).toBeTruthy();
      expect(useConnectionStore.getState().lastError?.code).toBe(
        "WEBSOCKET_REFUSED"
      );
      fireEvent.click(page.getByRole("button", { name: "Retry now" }));
      expect(PageSocket.instances).toHaveLength(4);
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  test("a recheck returning 401 drives the login screen", async () => {
    const { page, timeouts } = await mountConnectionScenario([200, 401]);
    try {
      await failThreeHandshakes(timeouts);
      expect(page.getByPlaceholderText("Password")).toBeTruthy();
      expect(useConnectionStore.getState().vpnStatus).toBe("unauthorized");
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  test("a recheck returning 403 uses the existing forbidden path", async () => {
    const { page, timeouts } = await mountConnectionScenario([200, 403]);
    try {
      await failThreeHandshakes(timeouts);
      expect(page.getByText("VPN required — reconnect Tailscale")).toBeTruthy();
      expect(useConnectionStore.getState().vpnStatus).toBe("forbidden");
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  test("close code 4008 selects the connection-cap copy", async () => {
    const { page, timeouts } = await mountConnectionScenario([200, 200]);
    try {
      act(() => PageSocket.instances[0]!.close(1006));
      timeouts.run(1_000);
      act(() => PageSocket.instances[1]!.close(1006));
      timeouts.run(2_000);
      act(() => PageSocket.instances[2]!.close(4008, "Connection limit reached"));
      await act(flushPromises);
      expect(page.getByRole("status").textContent).toContain(
        "Server connection limit reached"
      );
      expect(page.getByPlaceholderText("Server connection limit reached")).toBeTruthy();
      expect(useConnectionStore.getState().lastError?.code).toBe(
        "WEBSOCKET_CAPACITY"
      );
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  // Regression: the server ACCEPTS the upgrade and then closes with 4008 when
  // it is at its connection cap, so the never-opened counter is 0 when the cap
  // refusal lands. Gating capacity on the inferred threshold made the real
  // refusal — the only one the server names — unreachable.
  test("a cap refusal after a successful open still shows the capacity copy", async () => {
    const { page, timeouts } = await mountConnectionScenario([200, 200]);
    try {
      act(() => PageSocket.instances[0]!.open());
      await act(flushPromises);
      expect(page.queryByText("Server connection limit reached")).toBeNull();

      act(() => PageSocket.instances[0]!.close(4008, "Connection limit reached"));
      await act(flushPromises);
      expect(useConnectionStore.getState().handshakeFailures).toBe(0);
      expect(page.getByRole("status").textContent).toContain(
        "Server connection limit reached"
      );
      expect(useConnectionStore.getState().lastError?.code).toBe(
        "WEBSOCKET_CAPACITY"
      );

      // A socket that gets in again spends the evidence.
      timeouts.run(1_000);
      act(() => PageSocket.instances[1]!.open());
      await act(flushPromises);
      expect(page.queryByText("Server connection limit reached")).toBeNull();
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  // Regression: the stale-probe guard compared wsStatus at the START and END of
  // the probe. A poll that begins while connected, then sees the socket drop
  // and a replacement get in before it answers, reads "connected" both times —
  // so a stale 401 was accepted and logged the reader out of a healthy socket.
  test("a poll that spans a drop and a reconnect cannot log a healthy socket out", async () => {
    let resolvePoll: ((res: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolvePoll = resolve;
    });
    const { page, timeouts } = await mountConnectionScenario([200, pending]);
    try {
      act(() => PageSocket.instances[0]!.open());
      await act(flushPromises);
      expect(useConnectionStore.getState().wsStatus).toBe("connected");

      // The scheduled poll starts while the socket is up.
      await timeouts.runAsync(15_000);

      // It drops and a replacement gets in, all while that poll is outstanding.
      act(() => PageSocket.instances[0]!.close(1006));
      timeouts.run(1_000);
      const replacement = PageSocket.instances[PageSocket.instances.length - 1]!;
      act(() => replacement.open());
      await act(flushPromises);
      expect(useConnectionStore.getState().wsStatus).toBe("connected");

      act(() => resolvePoll!(new Response(null, { status: 401 })));
      await act(flushPromises);

      expect(useConnectionStore.getState().vpnStatus).toBe("connected");
      expect(page.queryByPlaceholderText("Password")).toBeNull();
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  // Regression: nothing exercised the poller's in-flight serialization, so
  // removing it left every refusal test green.
  test("a recheck while a poll is outstanding is serialized, and the newest answer wins", async () => {
    let resolveFirst: ((res: Response) => void) | undefined;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const { page, timeouts, vpnChecks } = await mountConnectionScenario([
      first,
      401,
    ]);
    try {
      // The mount probe is still outstanding while the handshakes fail, so the
      // recheck they trigger must queue rather than race it.
      await failThreeHandshakes(timeouts);
      expect(vpnChecks()).toBe(1);

      act(() => resolveFirst!(new Response(null, { status: 200 })));
      await act(flushPromises);
      expect(vpnChecks()).toBe(2);
      expect(useConnectionStore.getState().vpnStatus).toBe("unauthorized");
      expect(page.getByPlaceholderText("Password")).toBeTruthy();
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  test("one failed handshake followed by an open never shows refusal", async () => {
    const { page, timeouts, vpnChecks } = await mountConnectionScenario([200]);
    try {
      act(() => PageSocket.instances[0]!.close(1006));
      timeouts.run(1_000);
      act(() => PageSocket.instances[1]!.open());
      expect(vpnChecks()).toBe(1);
      expect(page.getByPlaceholderText("Ask your brain anything...")).toBeTruthy();
      expect(page.queryByText("Server refused the live connection")).toBeNull();
      expect(useConnectionStore.getState().handshakeFailures).toBe(0);
      expect(useConnectionStore.getState().lastError).toBeNull();
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  test("live probe changes replace and restore refusal copy without a socket open", async () => {
    const { page, timeouts } = await mountConnectionScenario([
      200,
      200,
      403,
      503,
      200,
    ]);
    try {
      await failThreeHandshakes(timeouts);
      expect(page.getByRole("status").textContent).toContain(
        "Server refused the live connection"
      );
      expect(useConnectionStore.getState().handshakeFailures).toBe(3);

      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await flushPromises();
      });
      expect(page.getByText("VPN required — reconnect Tailscale")).toBeTruthy();

      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await flushPromises();
      });
      expect(page.getByText("Connection lost — reconnecting…")).toBeTruthy();

      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await flushPromises();
      });
      expect(page.getByRole("status").textContent).toContain(
        "Server refused the live connection"
      );
      expect(useConnectionStore.getState().handshakeFailures).toBe(3);
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });

  test("a probe response resolving after a successful socket open is ignored", async () => {
    const staleFailure = deferred<Response>();
    const { page, timeouts, vpnChecks } = await mountConnectionScenario([
      200,
      staleFailure.promise,
    ]);
    try {
      await failThreeHandshakes(timeouts);
      expect(vpnChecks()).toBe(2);
      timeouts.run(4_000);
      act(() => PageSocket.instances[3]!.open());
      expect(useConnectionStore.getState().handshakeFailures).toBe(0);

      await act(async () => {
        staleFailure.resolve(new Response(null, { status: 403 }));
        await flushPromises();
      });
      expect(useConnectionStore.getState().vpnStatus).toBe("connected");
      expect(page.queryByText("Server refused the live connection")).toBeNull();
      expect(page.queryByText("VPN required — reconnect Tailscale")).toBeNull();
      expect(page.getByPlaceholderText("Ask your brain anything...")).toBeTruthy();
    } finally {
      page.unmount();
      timeouts.restore();
    }
  });
});

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

function principalResponse(principals: unknown[]): Response {
  return Response.json({ principals });
}

function SettingsHarness() {
  const [open, setOpen] = useState(true);
  return (
    <AppShell>
      <SettingsPanel open={open} onClose={() => setOpen(false)} />
    </AppShell>
  );
}

function StoreSettingsHarness() {
  const open = useUIStore((state) => state.settingsPanelOpen);
  const setOpen = useUIStore((state) => state.setSettingsPanelOpen);
  return (
    <AppShell>
      <SettingsPanel open={open} onClose={() => setOpen(false)} />
    </AppShell>
  );
}

describe("DevicesAgentsTab", () => {
  test("renders active rows with every timestamp, marks this device, and has an empty state", async () => {
    const now = Date.UTC(2026, 8, 14, 12);
    Date.now = () => now;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      principalResponse([
        {
          id: "owner-principal",
          kind: "owner",
          auth_method: "password",
          label: "Firefox on laptop",
          created_at: now - 2 * 60 * 60 * 1000,
          last_seen_at: now - 5 * 60 * 1000,
          expires_at: now + 6 * 24 * 60 * 60 * 1000,
          is_own: true,
        },
        {
          id: "agent-principal",
          kind: "agent",
          auth_method: "delegated",
          label: "Build agent",
          created_at: now - 60 * 1000,
          last_seen_at: null,
          expires_at: now + 24 * 60 * 60 * 1000,
          is_own: false,
        },
      ])) as typeof fetch;

    const page = render(
      <AppShell>
        <DevicesAgentsTab active />
      </AppShell>
    );
    await act(flushPromises);

    expect(page.getByText("Firefox on laptop")).toBeTruthy();
    expect(page.getByText("Build agent")).toBeTruthy();
    expect(page.getByText("This device")).toBeTruthy();
    expect(page.getByText("Agent")).toBeTruthy();
    // Searching the whole page for each string passes even when Created and
    // Expires are swapped, which is exactly the mis-mapping this is for. Read
    // each value from its own <dt>'s sibling, per row.
    const valueFor = (rowLabel: string, field: string): string | null => {
      const row = page.getByText(rowLabel).closest("li, div[data-principal-row]");
      const terms = [...(row?.querySelectorAll("dt") ?? [])];
      const dt = terms.find((node) => node.textContent?.trim() === field);
      return dt?.nextElementSibling?.textContent?.trim() ?? null;
    };

    expect(valueFor("Firefox on laptop", "Created")).toBe("2h ago");
    expect(valueFor("Firefox on laptop", "Last seen")).toBe("5m ago");
    expect(valueFor("Firefox on laptop", "Expires")).toBe("in 6d");
    expect(valueFor("Build agent", "Created")).toBe("1m ago");
    expect(valueFor("Build agent", "Last seen")).toBe("Never");
    expect(valueFor("Build agent", "Expires")).toBe("in 1d");
    expect(page.queryByText("No active devices or agents.")).toBeNull();

    cleanup();
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      principalResponse([])) as typeof fetch;
    const emptyPage = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(emptyPage.getByText("No active devices or agents.")).toBeTruthy();
  });

  test("shows a minted credential once and never restores it after dismissal or refetch", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let listRequests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "POST") {
        return Response.json({
          id: "new-agent",
          label: "Release helper",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "one-time-secret-value",
        });
      }
      listRequests++;
      return principalResponse(
        listRequests === 1
          ? []
          : [
              {
                id: "new-agent",
                kind: "agent",
                auth_method: "delegated",
                label: "Release helper",
                created_at: Date.now(),
                expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
                last_seen_at: null,
                is_own: false,
              },
            ]
      );
    }) as typeof fetch;
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => void copied.push(value) },
    });

    const page = render(
      <AppShell>
        <DevicesAgentsTab active />
      </AppShell>
    );
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Release helper");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));
    await act(flushPromises);

    expect(page.getByRole("dialog")).toBeTruthy();
    expect(page.getByText("This is the only time you will see this value.")).toBeTruthy();
    expect(page.getByText("one-time-secret-value")).toBeTruthy();
    expect(page.getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(true);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(page.getByText("one-time-secret-value")).toBeTruthy();

    fireEvent.click(page.getByRole("button", { name: "Copy credential" }));
    await act(flushPromises);
    expect(copied).toEqual(["one-time-secret-value"]);
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByText("one-time-secret-value")).toBeNull();
    expect(page.getByText("Release helper")).toBeTruthy();

    page.rerender(
      <AppShell>
        <DevicesAgentsTab active={false} />
      </AppShell>
    );
    page.rerender(
      <AppShell>
        <DevicesAgentsTab active />
      </AppShell>
    );
    await act(flushPromises);
    expect(page.queryByText("one-time-secret-value")).toBeNull();
    expect(requests.some(({ init }) => init?.body === JSON.stringify({ label: "Release helper", ttlDays: 7 }))).toBe(true);
  });

  test("portals the one-time value and blocks panel dismissal until acknowledgement", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({
          id: "protected-agent",
          label: "Protected agent",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "protected-one-time-value",
        });
      }
      return principalResponse([]);
    }) as typeof fetch;
    useUIStore.setState({ settingsTab: "devices" });

    const page = render(<SettingsHarness />);
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Protected agent");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));
    await act(flushPromises);

    const dialog = page.getByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    expect(page.getByText("protected-one-time-value")).toBeTruthy();
    const backdrop = page.baseElement.querySelector(".fixed.inset-0.z-40");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(page.getByText("protected-one-time-value")).toBeTruthy();

    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    fireEvent.click(backdrop!);
    expect(page.baseElement.querySelector(".fixed.inset-0.z-40")).toBeNull();
  });

  test("keeps a delayed mint response after its tab unmounts", async () => {
    const mint = deferred<Response>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return mint.promise;
      if (String(input).endsWith("/auth/passkey/list")) {
        return Response.json({ credentials: [] });
      }
      return principalResponse([]);
    }) as typeof fetch;
    useUIStore.setState({ settingsTab: "devices" });

    const page = render(<SettingsHarness />);
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Delayed agent");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));

    const securityTab = page.getByRole("tab", { name: "Security" });
    expect(securityTab.hasAttribute("disabled")).toBe(true);
    act(() => useUIStore.getState().setSettingsTab("security"));
    expect(useUIStore.getState().settingsTab).toBe("security");
    // Suspense hides the old tab while the lazy Security tab loads, so an
    // absent heading does NOT prove the devices tab unmounted — and this test
    // only means something if it did. Wait for the new tab's own content, and
    // for the mint form to be gone, before resolving.
    await act(flushPromises);
    await waitFor(() => {
      expect(page.queryByLabelText("Label")).toBeNull();
    });

    await act(async () => {
      mint.resolve(
        Response.json({
          id: "delayed-agent",
          label: "Delayed agent",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "delayed-one-time-value",
        })
      );
      await flushPromises();
    });

    expect(page.getByText("delayed-one-time-value")).toBeTruthy();

    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByText("delayed-one-time-value")).toBeNull();
  });

  test("keeps a delayed mint response after the real Settings button closes the panel", async () => {
    const mint = deferred<Response>();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return mint.promise;
      return principalResponse([]);
    }) as typeof fetch;
    useUIStore.setState({ settingsPanelOpen: true, settingsTab: "devices" });

    const page = render(<StoreSettingsHarness />);
    await act(flushPromises);
    changeControlledInput(page.getByLabelText("Label") as HTMLInputElement, "Sidebar agent");
    fireEvent.click(page.getByRole("button", { name: "Create agent credential" }));

    const settingsButton = page.getByTitle("Settings");
    settingsButton.focus();
    expect(document.activeElement).toBe(settingsButton);
    fireEvent.click(settingsButton);
    expect(useUIStore.getState().settingsPanelOpen).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(page.queryByLabelText("Label")).toBeNull();

    await act(async () => {
      mint.resolve(
        Response.json({
          id: "sidebar-agent",
          label: "Sidebar agent",
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          cookie: "sidebar-one-time-value",
        })
      );
      await flushPromises();
    });

    expect(page.getByRole("dialog")).toBeTruthy();
    expect(page.getByText("sidebar-one-time-value")).toBeTruthy();
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByText("sidebar-one-time-value")).toBeNull();
  });

  test("revokes the selected row and warns before revoking this device", async () => {
    const now = Date.now();
    const requests: Array<{ url: string; method: string | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method });
      if (init?.method === "DELETE") return Response.json({ ok: true });
      return principalResponse([
        {
          id: "own/id",
          kind: "owner",
          auth_method: "password",
          label: "Current laptop",
          created_at: now,
          expires_at: now + 60_000,
          last_seen_at: now,
          is_own: true,
        },
        {
          id: "phone/id",
          kind: "owner",
          auth_method: "passkey",
          label: "Phone",
          created_at: now,
          expires_at: now + 60_000,
          last_seen_at: now,
          is_own: false,
        },
      ]);
    }) as typeof fetch;
    const confirmations: string[] = [];
    window.confirm = (message?: string) => {
      confirmations.push(message ?? "");
      return message?.startsWith("That device") ?? false;
    };

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    fireEvent.click(page.getByRole("button", { name: "Revoke Phone" }));
    await act(flushPromises);
    expect(confirmations[0]).toContain("That device will be signed out immediately");
    expect(requests).toContainEqual({
      url: "/api/auth/principals/phone%2Fid",
      method: "DELETE",
    });
    expect(page.queryByText("Phone")).toBeNull();

    const deletesBeforeOwn = requests.filter(({ method }) => method === "DELETE").length;
    fireEvent.click(page.getByRole("button", { name: "Revoke Current laptop" }));
    expect(confirmations[1]).toContain(
      "This device will be signed out immediately, and you will return to sign in"
    );
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(deletesBeforeOwn);
  });

  test("renders an HTML-shaped label as bounded text, never markup", async () => {
    const malicious = '<img src=x onerror="alert(1)">' + "x".repeat(80);
    const displayed = Array.from(malicious).slice(0, 64).join("");
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      principalResponse([
        {
          id: "html-label",
          kind: "agent",
          auth_method: "delegated",
          label: malicious,
          created_at: Date.now(),
          expires_at: Date.now() + 60_000,
          last_seen_at: null,
          is_own: false,
        },
      ])) as typeof fetch;

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(page.getByText(displayed).textContent).toBe(displayed);
    expect(page.baseElement.textContent).not.toContain(malicious);
    expect(page.baseElement.querySelector("img")).toBeNull();
  });

  test("explains ambient auth instead of showing a broken or empty list", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json({ error: "Principal management is not enabled" }, { status: 400 })) as typeof fetch;

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(
      page.getByText(
        "Devices and agents can only be managed when password authentication is enabled."
      )
    ).toBeTruthy();
    expect(page.queryByText("No active devices or agents.")).toBeNull();
  });

  test("surfaces a failed request as an error rather than an empty list", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json({ error: "Database unavailable" }, { status: 500 })) as typeof fetch;

    const page = render(<DevicesAgentsTab active />);
    await act(flushPromises);
    expect(page.getByRole("alert").textContent).toBe("Database unavailable");
    expect(page.queryByText("No active devices or agents.")).toBeNull();
  });
});
