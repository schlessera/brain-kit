// The shared setup of the render smoke files (#4843): the fixture root and its
// store hooks, `render`/`renderHook` with the provider, the motion and graph
// canvas mocks, and the per-test resets. Import it after the file's own DOM
// module and call `installSmokeHarness` once at the file's top level: Bun
// evaluates this module once per process, so hooks registered here on import
// would attach to the first file only.
import { overlayGeometry } from "./overlay-geometry.js";
import { afterAll, afterEach, beforeEach, mock } from "bun:test";
import { act, cleanup, render as renderDom, renderHook as renderHookDom, type RenderOptions } from "@testing-library/react";
import { createElement, forwardRef, type ReactNode } from "react";
import type { ActivityRunDetail, ActivityRunRollup } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider, useRootStore } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";

export let fixtureRoot = createBrainUiRoot({ storage: null });

export let useFileStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["file"]["getState"]>) => T) => useRootStore("file", selector), fixtureRoot.stores.file);

export let useActivityStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["activity"]["getState"]>) => T) => useRootStore("activity", selector), fixtureRoot.stores.activity);

export let useInboxStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["inbox"]["getState"]>) => T) => useRootStore("inbox", selector), fixtureRoot.stores.inbox);

export let useGraphStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["graph"]["getState"]>) => T) => useRootStore("graph", selector), fixtureRoot.stores.graph);

export let useUIStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["ui"]["getState"]>) => T) => useRootStore("ui", selector), fixtureRoot.stores.ui);

export let useChatStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["chat"]["getState"]>) => T) => useRootStore("chat", selector), fixtureRoot.stores.chat);

export let useConnectionStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["connection"]["getState"]>) => T) => useRootStore("connection", selector), fixtureRoot.stores.connection);

export let useProviderStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["provider"]["getState"]>) => T) => useRootStore("provider", selector), fixtureRoot.stores.provider);

export let usePrincipalStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["principal"]["getState"]>) => T) => useRootStore("principal", selector), fixtureRoot.stores.principal);

export const clearGraphSceneCache = () => fixtureRoot.stores.graph.clearSceneCache();

export const render = (node: ReactNode, options?: RenderOptions) => {
  const Wrapper = options?.wrapper;
  return renderDom(node, { ...options, wrapper: ({ children }) => <BrainUiProvider root={fixtureRoot}>{Wrapper ? <Wrapper>{children}</Wrapper> : children}</BrainUiProvider> });
};

export const renderHook: typeof renderHookDom = (callback, options) => {
  const Wrapper = options?.wrapper;
  return renderHookDom(callback, { ...options, wrapper: ({ children }) => <BrainUiProvider root={fixtureRoot}>{Wrapper ? <Wrapper>{children}</Wrapper> : children}</BrainUiProvider> });
};

// happy-dom rejects an animation's `finished` promise when a mounted gate
// changes branches. These tests exercise the rendered state transitions, not
// the animation engine, so keep motion elements as transparent DOM wrappers.
export function createMotionElement(tag: string) {
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

export const motionElements = new Map<
  string,
  ReturnType<typeof createMotionElement>
>();


export let realGraphFetchMeta = useGraphStore.getInitialState().fetchMeta;

export let realGraphFetchScene = useGraphStore.getInitialState().fetchScene;

export async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function changeControlledInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
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

export class PageSocket {
  static instances: PageSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url = "") {
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

export function installActivityFetch(
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

export function activityRollup(name: string): ActivityRunRollup {
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

export function activityDetail(runId: string, name: string): ActivityRunDetail {
  return {
    runId,
    detailPruned: false,
    spans: [],
    events: [],
    highWaterSeq: 0,
    rollup: activityRollup(name),
  };
}

export function setHash(hash: string): void {
  history.replaceState(null, "", hash || "/");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function principalResponse(principals: unknown[]): Response {
  return Response.json({ principals });
}

export function policyFactsResponse(): Response {
  return Response.json({ path: "context/policies/governance.md", hash: null, source: "default", errors: [], warnings: [],
    profiles: { interactive: "strict", voice: "strict" }, protectedPaths: [], workerLimits: null });
}

export const supportingInput = { block: { kind: "files" as const, items: [
  { path: "knowledge/scylla.md", reason: "Names the cost in men." },
  { path: "people/circe.md", reason: "Gives the directions for the crossing." },
] } };

/** Registers the file's hooks and captures the globals its tests may replace; `unregisterDom` is the file's own DOM module's. */
export function installSmokeHarness(unregisterDom: () => Promise<void>): void {
  // Process-wide, and set after the file's component imports as in a single file.
  mock.module("framer-motion", () => ({
    useReducedMotion: () => true,
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
  let restoreGeometry: () => void;
  beforeEach(() => { restoreGeometry = overlayGeometry(); });
  afterEach(() => restoreGeometry());
  beforeEach(() => {
    fixtureRoot.dispose();
    fixtureRoot = createBrainUiRoot({ storage: null });
    useFileStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["file"]["getState"]>) => T) => useRootStore("file", selector), fixtureRoot.stores.file);
    useActivityStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["activity"]["getState"]>) => T) => useRootStore("activity", selector), fixtureRoot.stores.activity);
    useInboxStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["inbox"]["getState"]>) => T) => useRootStore("inbox", selector), fixtureRoot.stores.inbox);
    useGraphStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["graph"]["getState"]>) => T) => useRootStore("graph", selector), fixtureRoot.stores.graph);
    useUIStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["ui"]["getState"]>) => T) => useRootStore("ui", selector), fixtureRoot.stores.ui);
    useChatStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["chat"]["getState"]>) => T) => useRootStore("chat", selector), fixtureRoot.stores.chat);
    useConnectionStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["connection"]["getState"]>) => T) => useRootStore("connection", selector), fixtureRoot.stores.connection);
    useProviderStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["provider"]["getState"]>) => T) => useRootStore("provider", selector), fixtureRoot.stores.provider);
    usePrincipalStore = Object.assign(<T,>(selector: (state: ReturnType<BrainUiRoot["stores"]["principal"]["getState"]>) => T) => useRootStore("principal", selector), fixtureRoot.stores.principal);
    realGraphFetchMeta = fixtureRoot.stores.graph.getInitialState().fetchMeta;
    realGraphFetchScene = fixtureRoot.stores.graph.getInitialState().fetchScene;
  });
  afterEach(cleanup);
  afterAll(async () => {
    // Finish owned React work while its DOM still exists, then await happy-dom's
    // own closure. A timer turn is not proof that scheduled work has drained.
    await act(async () => cleanup());
    await unregisterDom();
  });
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  const realConfirm = window.confirm;
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const realDateNow = Date.now;
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
      sessionPanelOpen: false,
      searchPanelOpen: false,
      addPanelOpen: false,
      whatsupPanelOpen: false,
      paletteOpen: false,
      settingsTab: "models",
      theme: "dark",
    });
    // The chat store was the one this file never reset, and it leaked the
    // thing hardest to see: `activeChat(state).isStreaming`. Nothing renders it
    // directly, but several surfaces gate on it — `const why` in `desktop-routes.ts`
    // turns an enabled row into "a turn is running" — so a test that left a
    // buffer streaming changed what a LATER test's queries could find, and only
    // when the two happened to run in that order. That is what made the
    // DesktopPalette effect-chip test pass locally and fail on CI.
    //
    // Replace rather than merge: a partial reset leaves whichever buffer the
    // previous test created, and `activeChat` reads through `activeSessionId`
    // into `buffers`, so clearing one without the other still resolves to a
    // stale chat.
    useChatStore.setState(useChatStore.getInitialState(), true);
    // A guard left by a failed test would hold every later navigation.
    useUIStore.getState().setSettingsNavigationGuard(null);
    delete document.documentElement.dataset.theme;
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
    fixtureRoot.dispose();
  });
}
