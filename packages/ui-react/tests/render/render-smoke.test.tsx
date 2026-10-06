// Render smoke tests: mount the highest-traffic components in happy-dom and
// assert the DOM they produce, not just their pure helpers. Fixtures are
// minimal and keyless; nothing here touches the network.
//
// The dom.js import MUST stay first — it registers the happy-dom globals
// before the component module bodies run, and its header documents why every
// render test lives in this one file and why `screen` must not be used.
import { unregisterDom } from "./dom.js";

import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { MaskEditor } from "../../src/components/images/mask-editor.js";
import { ShareMenu } from "../../src/components/share/share-menu.js";
import { DiscoveryStart } from "../../src/components/graph/graph-scene.js";
import { ShareBlock } from "../../src/components/chat/share-block.js";
import { PushToggle } from "../../src/components/activity/push-toggle.js";
import { PushSwitch } from "../../src/components/activity/push-switch.js";
import { MobileTabBar } from "../../src/components/layout/mobile-tab-bar.js";
import { SideRail } from "../../src/components/layout/side-rail.js";
import { DesktopPalette } from "../../src/components/layout/desktop-palette.js";
import { ThemeToggle, useApplyTheme } from "../../src/components/layout/theme.js";
import { ShortcutSwitch } from "../../src/components/layout/shortcut-switch.js";
import { createUIStore } from "../../src/stores/ui-state.js";
import { LoginScreen } from "../../src/components/connectivity/login-screen.js";
import { LoginForm } from "../../src/components/connectivity/login-form.js";
import { PasskeyTab } from "../../src/components/settings/passkey-tab.js";
import { PasskeyList } from "../../src/components/settings/passkey-list.js";
import type { PasskeySummary } from "@schlessera/brain-ui-sdk/protocol";
import type { SkillEntry } from "../../src/lib/api-client.js";
import { ModelsTab } from "../../src/components/settings/models-tab.js";
import { PiAccountsSection } from "../../src/components/settings/pi-accounts.js";
import { SkillsTab } from "../../src/components/settings/skills-tab.js";
import { SkillEditor, SkillsList } from "../../src/components/settings/skills-list.js";
import { WebSearchSection } from "../../src/components/settings/web-search-settings.js";
import { WebSearchChain } from "../../src/components/settings/web-search-chain.js";
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { createElement, forwardRef, StrictMode, useEffect, useState, type ReactNode } from "react";
import type {
  ActivityRunDetail,
  ActivityRunRollup,
  ActivitySpan,
  GraphMaintenanceResponse,
  GraphNodePayload,
} from "@schlessera/brain-ui-sdk/protocol";

import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { SpanEventBlock } from "../../src/components/activity/span-bits.js";
import { DigestCard } from "../../src/components/activity/digest-card.js";
import { ToolPermissionsSection } from "../../src/components/settings/tool-permissions.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { MarkdownContent } from "../../src/components/chat/markdown-content.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { READING_COLUMN_ATTR } from "../../src/lib/client-environment.js";
import { AskUserCard } from "../../src/components/chat/ask-user-card.js";
import { ZoomViewer } from "../../src/components/viewer/zoom-viewer.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import { useHashRoutes } from "../../src/hooks/use-hash-routes.js";
import { useFinePointer } from "../../src/hooks/use-fine-pointer.js";
import { useMediaQuery } from "../../src/hooks/use-media-query.js";
import { ApprovalCard, approvalOutcome } from "../../src/components/activity/approval-card.js";
import {
  hasUnsentText,
  useServiceWorkerUpdates,
} from "../../src/hooks/use-service-worker-updates.js";
import { useFileStore } from "../../src/stores/file-store.js";
import { useActivityStore } from "../../src/stores/activity-store.js";
import { useInboxStore } from "../../src/stores/inbox-store.js";
import {
  clearGraphSceneCache,
  useGraphStore,
} from "../../src/stores/graph-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";
import { useShallow } from "zustand/react/shallow";
import { BrainUiProvider, useBrainUiRoot } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { useChatStore, activeChat } from "../../src/stores/chat-store.js";
import { useWebSocket } from "../../src/hooks/use-websocket.js";
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { Composer } from "../../src/components/chat/composer.js";
import { WhatsupPanel } from "../../src/components/quick-actions/whatsup-modal.js";
import { StreamingPanel } from "../../src/components/quick-actions/streaming-modal.js";
import { SessionDrawer } from "../../src/components/chat/session-drawer.js";
import { SessionList } from "../../src/components/chat/session-list.js";
import { WelcomeState } from "../../src/components/chat/welcome-state.js";
import { ComposerView } from "../../src/components/chat/composer-view.js";
import { AttachmentCount, ThinkingBlock, ThinkingIndicator, TurnHeader, UserTurn } from "../../src/components/chat/transcript-turn.js";
import { Segmented, SwitchRow } from "../../src/components/graph/graph-form.js";
import { NodeCard } from "../../src/components/graph/node-card.js";
import { PrincipalList } from "../../src/components/settings/principal-list.js";
import { AccountsList } from "../../src/components/settings/pi-accounts-list.js";
import { ToolPermissionsList } from "../../src/components/settings/tool-permissions-list.js";
import { ModelsCatalogView } from "../../src/components/settings/models-list.js";
import { AddPanel } from "../../src/components/quick-actions/add-modal.js";
import { AddForm } from "../../src/components/quick-actions/add-form.js";
import { FileTree } from "../../src/components/files/file-tree.js";
import { FileTreeView, TreeRow, fileKind } from "../../src/components/files/file-tree-view.js";
import { FrontmatterChips } from "../../src/components/files/frontmatter-chips.js";
import { HistoryRow, IntentCard, LiveRunCard, RunRollupReceipt, toolState } from "../../src/components/activity/activity-views.js";
import { FrontmatterPanel } from "../../src/components/files/frontmatter-panel.js";
import { ViewerEmpty, ViewerToolbar, formatSize } from "../../src/components/files/file-viewer-frame.js";
import { BriefingOutput, StreamingOutput } from "../../src/components/quick-actions/streaming-output.js";
import { SearchPanel } from "../../src/components/quick-actions/search-modal.js";
import { DevicesAgentsTab } from "../../src/components/settings/devices-agents-tab.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { FilePanel } from "../../src/components/files/file-panel.js";
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

describe("SearchPanel query ownership", () => {
  function pressEnter(input: HTMLInputElement) {
    // Same happy-dom synthetic-input limitation as changeControlledInput below.
    const key = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onKeyDown: (event: unknown) => void }>)[key];
    act(() => props.onKeyDown({ key: "Enter", preventDefault() {} }));
  }

  function searchRequests() {
    const requests: { url: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }[] = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      const response = deferred<Response>();
      requests.push({ url: String(url), signal: init.signal!, response });
      // Deliberately ignore cancellation: a late response must still be rejected.
      return response.promise;
    }) as typeof fetch;
    return requests;
  }

  const reply = (title: string) => Response.json({
    results: [{ path: `notes/${title}.md`, title, type: "note", snippet: "", score: 1 }], warnings: [],
  });

  test("Enter searches the new query instead of opening old results, without a duplicate debounce", async () => {
    const requests = searchRequests();
    const opened: string[] = [];
    const original = useFileStore.getState().openFile;
    useFileStore.setState({ openFile: async (path) => { opened.push(path); } });
    try {
      const view = render(<SearchPanel open onClose={() => {}} />);
      const input = view.getByPlaceholderText("Search your brain...") as HTMLInputElement;
      changeControlledInput(input, "alpha");
      pressEnter(input);
      expect(requests).toHaveLength(1);
      await act(async () => { requests[0].response.resolve(reply("alpha")); await flushPromises(); });
      expect(view.getByTitle("notes/alpha.md")).toBeTruthy();

      changeControlledInput(input, "beta");
      expect(view.queryByTitle("notes/alpha.md")).toBeNull();
      pressEnter(input);
      expect(opened).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(requests[1].url).toContain("q=beta");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(requests).toHaveLength(2);
      await act(async () => { requests[1].response.resolve(reply("beta")); await flushPromises(); });
      pressEnter(input);
      expect(opened).toEqual(["notes/beta.md"]);
    } finally {
      useFileStore.setState({ openFile: original });
    }
  });

  test("typing aborts immediately and late responses cannot repopulate results", async () => {
    const requests = searchRequests();
    const view = render(<SearchPanel open onClose={() => {}} />);
    const input = view.getByPlaceholderText("Search your brain...") as HTMLInputElement;
    changeControlledInput(input, "alpha");
    pressEnter(input);
    changeControlledInput(input, "beta");
    expect(requests[0].signal.aborted).toBe(true);
    await act(async () => { requests[0].response.resolve(reply("alpha")); await flushPromises(); });
    expect(view.queryByTitle("notes/alpha.md")).toBeNull();
    pressEnter(input);
    view.unmount();
    expect(requests[1].signal.aborted).toBe(true);
    await act(async () => { requests[1].response.resolve(reply("beta")); await flushPromises(); });
  });

  test("whitespace-only edits keep the current request and closing aborts it", async () => {
    const requests = searchRequests();
    const view = render(<SearchPanel open onClose={() => {}} />);
    const input = view.getByPlaceholderText("Search your brain...") as HTMLInputElement;
    changeControlledInput(input, "alpha");
    pressEnter(input);
    changeControlledInput(input, "alpha ");
    expect(requests[0].signal.aborted).toBe(false);
    view.rerender(<SearchPanel open={false} onClose={() => {}} />);
    expect(requests[0].signal.aborted).toBe(true);
    await act(async () => { requests[0].response.resolve(reply("alpha")); await flushPromises(); });
    view.rerender(<SearchPanel open onClose={() => {}} />);
    expect(view.queryByTitle("notes/alpha.md")).toBeNull();
  });
});

function changeControlledInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
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
              options: { applicationServerKey: null },
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

describe("contract-bound tool renderers", () => {
  // The whole D3 path, through the real timeline: a tool result whose output
  // is a JSON payload resolves to the renderer bound to its contract, and the
  // component is handed the PARSED payload rather than the raw string.
  const fix = {
    latitude: 38.3653,
    longitude: 20.7169,
    accuracyMeters: 42,
    place: "Vathy",
    address: "Vathy, Ithaca, Greece",
    retrievedAt: "2026-07-12T09:15:00.000Z",
  };

  function locationCall(output: string, isError = false): ToolCall {
    return {
      id: "tool-loc",
      name: "mcp__brain-ui__get_current_location",
      input: {},
      inputJson: "{}",
      status: "complete",
      output,
      ...(isError ? { isError: true } : {}),
    } as ToolCall;
  }

  function expandAll(result: ReturnType<typeof render>) {
    fireEvent.click(result.getByRole("button"));
    const header = result
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("Location"))!;
    fireEvent.click(header);
  }

  const geometry = {
    coastline: [[[20.70, 38.36], [20.72, 38.37], [20.73, 38.36]]],
    roads: [[[20.71, 38.365], [20.72, 38.366]]],
    streets: [],
    land: [[[20.70, 38.36], [20.72, 38.37], [20.73, 38.36], [20.70, 38.36]]],
    detail: "roads",
    partial: false,
    toleranceM: 8,
    attribution: "\u00a9 OpenStreetMap contributors",
  };

  test("a JSON payload renders as a map with the pin, and the shoreline arrives from the server", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json(geometry);
    }) as typeof fetch;
    const result = render(
      <ToolCallTimeline toolCalls={[locationCall(JSON.stringify(fix))]} onApproval={() => {}} />
    );
    expandAll(result);
    const text = result.baseElement.textContent ?? "";
    expect(text).toContain("Vathy");
    expect(text).toContain("38.3653, 20.7169");
    expect(text).toContain("\u00b142 m");
    // The raw JSON is gone: the reader sees the card, not the wire format.
    expect(text).not.toContain('"accuracyMeters"');
    // The pin is drawn by the kit's MapView from the payload's coordinates.
    expect(result.baseElement.querySelector("svg")).toBeTruthy();

    // One request, for the envelope of every box the map can draw, with the
    // width scaled by the same 1.5 the box is (the server's tolerance and tier
    // come from the box's width over that many pixels); the fix is inside it.
    await waitFor(() => expect(requests).toHaveLength(1));
    const url = new URL(requests[0]!, "http://localhost");
    expect(url.pathname.endsWith("/geo/coastline")).toBe(true);
    const [w, s, e, n] = url.searchParams.get("bbox")!.split(",").map(Number) as [number, number, number, number];
    expect(w).toBeLessThan(fix.longitude);
    expect(e).toBeGreaterThan(fix.longitude);
    expect(s).toBeLessThan(fix.latitude);
    expect(n).toBeGreaterThan(fix.latitude);
    expect(url.searchParams.get("width")).toBe("495");

    // The geometry lands as paths and land, and the credit comes with it.
    await waitFor(() => expect(result.baseElement.textContent).toContain("OpenStreetMap contributors"));
    // Coastline + road as strokes, land as one filled path, the pin's own marks besides.
    expect(result.baseElement.querySelectorAll("svg path").length).toBeGreaterThanOrEqual(3);
  });

  test("without a server the map still draws the pin, and carries no credit for geometry it has not got", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = render(
      <ToolCallTimeline toolCalls={[locationCall(JSON.stringify(fix))]} onApproval={() => {}} />
    );
    expandAll(result);
    await act(flushPromises);
    expect(result.baseElement.textContent).toContain("Vathy");
    expect(result.baseElement.querySelector("svg")).toBeTruthy();
    expect(result.baseElement.textContent).not.toContain("OpenStreetMap");
  });

  test("a denial keeps its message instead of blanking the row", () => {
    const result = render(
      <ToolCallTimeline
        toolCalls={[locationCall("User denied the geolocation request.", true)]}
        onApproval={() => {}}
      />
    );
    expandAll(result);
    expect(result.baseElement.textContent).toContain(
      "User denied the geolocation request."
    );
  });

  test("a payload the schema rejects falls back to the raw output", () => {
    // A server that changed the payload shape must not blank the row — the
    // call still happened, and its output is the only thing left to show.
    const result = render(
      <ToolCallTimeline
        toolCalls={[locationCall(JSON.stringify({ ...fix, latitude: "38.3653" }))]}
        onApproval={() => {}}
      />
    );
    expandAll(result);
    expect(result.baseElement.textContent).toContain('"latitude"');
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


test("capture recovery preserves the saved note and retries indexing without resubmitting", async () => {
  const calls: string[] = [];
  let retries = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/brain/stats")) return Response.json({ byType: {} });
    calls.push(url);
    if (url.endsWith("/brain/add")) return Response.json({ success: true, path: "notes/topic.md", indexed: false, indexError: "database is locked" });
    if (url.endsWith("/brain/index")) {
      retries++;
      return retries === 1 ? Response.json({ error: "still locked" }, { status: 500 }) : Response.json({ success: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  const view = render(<AddPanel open onClose={() => {}} />);
  changeControlledInput(view.getByPlaceholderText("What do you want to remember?") as HTMLTextAreaElement, "Topic");
  await act(async () => { fireEvent.click(view.getByRole("button", { name: /^Add$/ })); });
  expect(view.getByText(/Saved, but not indexed/)).toBeTruthy();
  expect(view.getByText("notes/topic.md")).toBeTruthy();
  // The old keyboard shortcut could submit the already-saved note again.
  await act(async () => { fireEvent.keyDown(view.getByText("Added to your brain."), { key: "Enter", ctrlKey: true }); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Retry indexing" })); });
  expect(view.getByText("still locked")).toBeTruthy();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Retry indexing" })); });
  expect(view.getByText(/Saved and indexed/)).toBeTruthy();
  expect(calls.filter(url => url.endsWith("/brain/add"))).toHaveLength(1);
  expect(calls.filter(url => url.endsWith("/brain/index"))).toHaveLength(2);
});


describe("SessionDrawer recovery", () => {
  test("shows partial histories with a warning and clears it after retry", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      calls++;
      return Response.json({
        sessions: [{ id: "saved", title: "Saved conversation", createdAt: 1, lastActiveAt: 2 }],
        ...(calls === 1 ? { unavailableBackends: ["offline"] } : {}),
      });
    }) as typeof fetch;
    const view = render(<SessionDrawer open onClose={() => {}} onResume={() => {}} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.getByText("Saved conversation")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("Some session histories are unavailable");
    await act(async () => { fireEvent.click(view.getByText("Retry")); });
    expect(calls).toBe(2);
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByText("Saved conversation")).toBeTruthy();
  });

  test("reports a failed refresh without hiding previously loaded sessions", async () => {
    let fail = false;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      if (fail) throw new Error("offline");
      return Response.json({ sessions: [{ id: "saved", title: "Saved conversation", createdAt: 1, lastActiveAt: 2 }] });
    }) as typeof fetch;
    const props = { onClose: () => {}, onResume: () => {} };
    const view = render(<SessionDrawer open {...props} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    view.rerender(<SessionDrawer open={false} {...props} />);
    fail = true;
    view.rerender(<SessionDrawer open {...props} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.getByText("Saved conversation")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("Could not refresh sessions");
  });
});


test("sync busy response explains why another sync cannot start", async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json(
    { error: "A sync is already running. Wait for it to finish before retrying." }, { status: 409 }
  )) as typeof fetch;
  const view = render(<StreamingPanel open title="Sync" endpoint="/api/brain/sync" onClose={() => {}} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(view.getByText("A sync is already running. Wait for it to finish before retrying.")).toBeTruthy();
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

  test("portals the one-time value, which outlives the panel's own close control", async () => {
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
    // The test DOM takes the desktop pane (its window is 1024px wide), whose
    // Close control is live even while the credential is unacknowledged: the
    // dialog is the shell's, not the tab's, so closing the panel loses
    // nothing. The drawer's refusal of a stray backdrop click or Escape while
    // protected is slide-panel.test.tsx's.
    fireEvent.click(page.getByRole("button", { name: "Close" }));
    expect(page.queryByRole("tab", { name: "Security" })).toBeNull();
    expect(page.getByText("protected-one-time-value")).toBeTruthy();

    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Done" }));
    expect(page.queryByRole("dialog")).toBeNull();
    expect(usePrincipalStore.getState().oneTimeCredential).toBeNull();
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

  test("keeps a delayed mint response after a real rail press leaves Settings", async () => {
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

    // Rail Settings is the current destination and never closes (D52 N3), so
    // the panel is left through another destination.
    const rail = page.container.querySelector<HTMLElement>('nav[aria-label="Primary"].tablet\\:flex')!;
    const chatButton = within(rail).getByRole("tab", { name: /^Chat/ });
    chatButton.focus();
    expect(document.activeElement).toBe(chatButton);
    fireEvent.click(chatButton);
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

describe("UI root provider lifetimes", () => {
  function Probe({ name }: { name: string }) {
    const { send } = useWebSocket();
    const { content } = useChatStore(useShallow((state) => ({ content: activeChat(state).messages[0]?.content ?? "" })));
    return <button data-testid={name} onClick={() => send({ type: "cancel" })}>{content || name}</button>;
  }

  test("two roots and multiple leases survive StrictMode and independent unmounts", () => {
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    PageSocket.instances = [];
    const a = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" } });
    const b = createBrainUiRoot({ storage: null, config: { backendUrl: "https://beta.example" } });
    const view = (showA: boolean, secondLease: boolean) => <StrictMode>
      {showA && <BrainUiProvider root={a}><Probe name="alpha" /></BrainUiProvider>}
      <BrainUiProvider root={b}><Probe name="beta" />{secondLease && <Probe name="beta-peer" />}</BrainUiProvider>
    </StrictMode>;
    const mounted = render(view(true, true));
    try {
      const socketA = PageSocket.instances.findLast((s) => s.url.includes("alpha.example"))!;
      const socketB = PageSocket.instances.findLast((s) => s.url.includes("beta.example"))!;
      act(() => {
        socketA.open(); socketB.open();
        socketA.deliver({ type: "text_delta", text: "alpha text" });
        socketB.deliver({ type: "text_delta", text: "beta text" });
        a.connection.flushChatDeltas(); b.connection.flushChatDeltas();
      });
      expect(mounted.getByTestId("alpha").textContent).toBe("alpha text");
      expect(mounted.getByTestId("beta").textContent).toBe("beta text");
      const stale = socketA.onmessage;
      mounted.rerender(view(false, false));
      expect(socketA.readyState).toBe(3);
      expect(socketB.readyState).toBe(1);
      act(() => {
        stale?.({ data: JSON.stringify({ type: "text_delta", text: " stale" }) } as MessageEvent);
        a.connection.flushChatDeltas();
      });
      expect(activeChat(a.stores.chat.getState()).messages[0].content).toBe("alpha text");
      fireEvent.click(mounted.getByTestId("beta"));
      expect(JSON.parse(socketB.sent.at(-1)!)).toMatchObject({ type: "cancel" });
      mounted.unmount();
      expect(socketB.readyState).toBe(3);
    } finally {
      mounted.unmount(); a.dispose(); b.dispose();
    }
  });

  test("a delayed location result cannot reply through a replacement socket", () => {
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    const original = Object.getOwnPropertyDescriptor(navigator, "geolocation");
    let deliver: PositionCallback | undefined;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      getCurrentPosition: (success: PositionCallback) => { deliver = success; },
    } });
    const root = createBrainUiRoot({ storage: null });
    const release = root.connection.connect();
    try {
      const first = PageSocket.instances.at(-1)!;
      first.open();
      first.deliver({ type: "location_request", requestId: "old" });
      expect(deliver).toBeDefined();
      first.close(1006);
      root.connection.reconnectNow();
      const second = PageSocket.instances.at(-1)!;
      expect(second).not.toBe(first);
      second.open();
      const sentBefore = second.sent.length;
      deliver!({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: 0 } as GeolocationPosition);
      expect(second.sent).toHaveLength(sentBefore);
    } finally {
      release(); root.dispose();
      if (original) Object.defineProperty(navigator, "geolocation", original);
      else Reflect.deleteProperty(navigator, "geolocation");
    }
  });

  test("provider-owned root survives effect replay and disposes after final unmount", async () => {
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    let captured: BrainUiRoot | undefined;
    function Capture() {
      const root = useBrainUiRoot();
      useEffect(() => { captured = root; }, [root]);
      useWebSocket();
      return null;
    }
    const mounted = render(<StrictMode><BrainUiProvider><Capture /></BrainUiProvider></StrictMode>);
    await act(async () => { await Promise.resolve(); });
    expect(captured).toBeDefined();
    const release = captured!.connection.connect();
    release();
    mounted.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(() => captured!.connection.connect()).toThrow(/disposed/);
  });
});

// Requests deliberately ignore AbortSignal here: changing roots must reject
// stale completions even when a transport has already queued the response.
describe("quick-action root ownership", () => {
  function transport(prefix: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${prefix}.example` },
      request: (url, init) => {
        const response = deferred<Response>();
        requests.push({ url, init, response });
        return response.promise;
      },
    });
    return { root, requests };
  }
  const stream = (text: string) => new Response(`data: ${JSON.stringify({ type: "progress", text })}\n\ndata: {"type":"done","success":true}\n\n`);

  test("capture switches API roots and ignores the old save and type completions", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><AddPanel open onClose={() => {}} /></BrainUiProvider>;
    const mounted = render(panel(a.root));
    try {
      changeControlledInput(mounted.getByPlaceholderText("What do you want to remember?") as HTMLTextAreaElement, "alpha note");
      fireEvent.click(mounted.getByRole("button", { name: /^Add$/ }));
      expect(a.requests.map((r) => r.url)).toEqual(["https://alpha.example/api/brain/stats", "https://alpha.example/api/brain/add"]);
      mounted.rerender(panel(b.root));
      await act(async () => {
        a.requests[0].response.resolve(Response.json({ byType: { stale: 1 } }));
        a.requests[1].response.resolve(Response.json({ success: true, path: "notes/stale.md", indexed: true }));
        b.requests[0].response.resolve(Response.json({ byType: { current: 1 } }));
        await flushPromises();
      });
      expect(mounted.queryByText("notes/stale.md")).toBeNull();
      expect(mounted.container.querySelector('option[value="stale"]')).toBeNull();
      expect(mounted.container.querySelector('option[value="current"]')).not.toBeNull();
      const note = mounted.getByPlaceholderText("What do you want to remember?") as HTMLTextAreaElement;
      expect(note.value).toBe("");
      changeControlledInput(note, "beta note");
      fireEvent.click(mounted.getByRole("button", { name: /^Add$/ }));
      expect(b.requests[1].url).toBe("https://beta.example/api/brain/add");
      await act(async () => {
        b.requests[1].response.resolve(Response.json({ success: true, path: "notes/beta.md", indexed: false }));
        await flushPromises();
      });
      fireEvent.click(mounted.getByRole("button", { name: "Retry indexing" }));
      expect(b.requests[2].url).toBe("https://beta.example/api/brain/index");
      await act(async () => { b.requests[2].response.resolve(Response.json({ success: true })); await flushPromises(); });
      expect(mounted.getByText(/Saved and indexed/)).toBeTruthy();
    } finally { mounted.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("search aborts on root replacement and opens results in the matching file store", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const opened: string[] = [];
    b.root.stores.file.setState({ openFile: async (path) => { opened.push(path); } });
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><SearchPanel open onClose={() => {}} /></BrainUiProvider>;
    const mounted = render(panel(a.root));
    try {
      changeControlledInput(mounted.getByPlaceholderText("Search your brain...") as HTMLInputElement, "same");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(a.requests[0].url).toContain("https://alpha.example/api/brain/search");
      mounted.rerender(panel(b.root));
      expect(a.requests[0].init?.signal?.aborted).toBe(true);
      changeControlledInput(mounted.getByPlaceholderText("Search your brain...") as HTMLInputElement, "same");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(b.requests[0].url).toContain("https://beta.example/api/brain/search");
      const result = (name: string) => Response.json({ results: [{ path: `notes/${name}.md`, title: name, snippet: "", score: 1 }] });
      await act(async () => {
        b.requests[0].response.resolve(result("beta"));
        a.requests[0].response.resolve(result("stale"));
        await flushPromises();
      });
      expect(mounted.queryByTitle("notes/stale.md")).toBeNull();
      fireEvent.click(mounted.getByTitle("notes/beta.md"));
      expect(opened).toEqual(["notes/beta.md"]);
      expect(b.root.stores.ui.getState().filePanelOpen).toBe(true);
      expect(a.root.stores.ui.getState().filePanelOpen).toBe(false);
    } finally { mounted.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  for (const kind of ["sync", "whatsup"] as const) {
    test(`${kind} cancels a superseded stream reader and renders the replacement stream`, async () => {
      const a = transport("alpha"); const b = transport("beta");
      let cancelled = false;
      const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}>
        {kind === "sync" ? <StreamingPanel open title="Sync" endpoint="/api/brain/sync" onClose={() => {}} /> : <WhatsupPanel open onClose={() => {}} />}
      </BrainUiProvider>;
      const mounted = render(panel(a.root));
      try {
        await act(async () => {
          a.requests[0].response.resolve(new Response(new ReadableStream<Uint8Array>({
            cancel() { cancelled = true; },
          })));
          await flushPromises();
        });
        mounted.rerender(panel(b.root));
        expect(cancelled).toBe(true);
        await act(async () => {
          b.requests[0].response.resolve(stream("replacement output"));
          await flushPromises();
        });
        expect(mounted.getByText("replacement output")).toBeTruthy();
        expect(mounted.queryByText("Cancelled.")).toBeNull();
        if (kind === "sync") expect(mounted.getByText("Complete")).toBeTruthy();
      } finally { mounted.unmount(); a.root.dispose(); b.root.dispose(); }
    });

    test(`${kind} uses the root transport and an old completion cannot steal Cancel`, async () => {
      const a = transport("alpha"); const b = transport("beta");
      const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}>
        {kind === "sync" ? <StreamingPanel open title="Sync" endpoint="/api/brain/sync" onClose={() => {}} /> : <WhatsupPanel open onClose={() => {}} />}
      </BrainUiProvider>;
      const mounted = render(panel(a.root));
      try {
        expect(a.requests[0].url).toBe(`https://alpha.example/api/brain/${kind}`);
        mounted.rerender(panel(b.root));
        expect(a.requests[0].init?.signal?.aborted).toBe(true);
        expect(b.requests[0].url).toBe(`https://beta.example/api/brain/${kind}`);
        await act(async () => { a.requests[0].response.resolve(stream("stale")); await flushPromises(); });
        expect(mounted.queryByText("stale")).toBeNull();
        fireEvent.click(mounted.getByRole("button", { name: "Cancel" }));
        expect(b.requests[0].init?.signal?.aborted).toBe(true);
        await act(async () => { b.requests[0].response.resolve(stream("too late")); await flushPromises(); });
        expect(mounted.queryByText("too late")).toBeNull();
        expect(mounted.getAllByText("Cancelled.").length).toBe(1);
      } finally { mounted.unmount(); a.root.dispose(); b.root.dispose(); }
    });
  }
});

describe("activity and device root ownership", () => {
  function transport(owner: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example` },
      request: (url, init) => {
        const response = deferred<Response>();
        requests.push({ url, init, response });
        return response.promise;
      },
    });
    return { root, requests, matching: (path: string) => requests.filter((r) => new URL(r.url).pathname === `/api${path}`) };
  }
  function replyActivity(owner: ReturnType<typeof transport>, name: string) {
    owner.matching("/activity/runs").at(-1)!.response.resolve(Response.json({ live: [], history: [{ ...activityRollup(name), runId: name }] }));
    owner.matching("/activity/rollups").at(-1)!.response.resolve(Response.json({ timeZone: "UTC", days: [] }));
    owner.matching("/models/pricing").at(-1)!.response.resolve(Response.json({ stale: false, error: null }));
    owner.matching("/activity/inbox").at(-1)!.response.resolve(Response.json({ intents: [] }));
  }

  test("activity refreshes use their root and reject older lists and pricing errors", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><ActivityPage /></BrainUiProvider>;
    const view = render(panel(a.root));
    try {
      expect(a.requests.every((r) => r.url.startsWith("https://alpha.example/"))).toBe(true);
      expect(a.matching("/activity/runs")).toHaveLength(1);
      view.rerender(panel(b.root));
      await act(async () => { replyActivity(b, "Beta run"); await flushPromises(); });
      expect(view.getByText("Beta run")).toBeTruthy();
      await act(async () => {
        a.matching("/activity/runs")[0].response.resolve(Response.json({ error: "obsolete failure" }, { status: 500 }));
        a.matching("/models/pricing")[0].response.resolve(Response.json({ stale: true, error: "offline" }));
        await flushPromises();
      });
      expect(view.queryByText(/obsolete failure/)).toBeNull();
      expect(view.queryByText("Pricing stale")).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Refresh" }));
      fireEvent.click(view.getByRole("button", { name: "Refresh" }));
      await act(async () => {
        replyActivity(b, "Newest run");
        b.matching("/activity/runs")[1].response.resolve(Response.json({ live: [], history: [{ ...activityRollup("Older run"), runId: "older" }] }));
        await flushPromises();
      });
      expect(view.getByText("Newest run")).toBeTruthy();
      expect(view.queryByText("Older run")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("the same detail run ID reloads on a new root without restoring old metadata", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><RunDetail runId="same" onBack={() => {}} /></BrainUiProvider>;
    const view = render(panel(a.root));
    try {
      await act(async () => { a.requests[0].response.resolve(Response.json({ ...activityDetail("same", "Alpha summary"), detailPruned: true })); await flushPromises(); });
      expect(view.getByText(/Trace pruned/)).toBeTruthy();
      view.rerender(panel(b.root));
      expect(view.queryByText(/Trace pruned/)).toBeNull();
      expect(view.queryByRole("heading", { name: "Alpha summary" })).toBeNull();
      await act(async () => { b.requests[0].response.resolve(Response.json(activityDetail("same", "Beta summary"))); await flushPromises(); });
      expect(view.getByRole("heading", { name: "Beta summary" })).toBeTruthy();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("digest loading and dismissal belong to the displayed root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><DigestCard /></BrainUiProvider>;
    const view = render(panel(a.root));
    const digest = (runs: number) => Response.json({ digest: { generatedAt: 2, windowStart: 0, windowEnd: 1, runs, failures: 0, notable: [], costUsd: 0, inputTokens: 0, outputTokens: 0 }, dismissedAt: 0 });
    try {
      view.rerender(panel(b.root));
      await act(async () => { b.requests[0].response.resolve(digest(2)); a.requests[0].response.resolve(digest(9)); await flushPromises(); });
      expect(view.getByText(/2 runs/)).toBeTruthy();
      expect(view.queryByText(/9 runs/)).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
      expect(b.matching("/activity/digest/dismiss")).toHaveLength(1);
      expect(a.matching("/activity/digest/dismiss")).toHaveLength(0);
      expect(view.queryByText("While you were away")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  const principal = (label: string) => ({ id: "same", kind: "agent", auth_method: "delegated", label, created_at: 1, last_seen_at: null, expires_at: null, is_own: false });
  test("a late device revoke cannot remove the same ID from a replacement root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    window.confirm = () => true;
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><DevicesAgentsTab active /></BrainUiProvider>;
    const view = render(panel(a.root));
    try {
      await act(async () => { a.requests[0].response.resolve(principalResponse([principal("Alpha agent")])); await flushPromises(); });
      fireEvent.click(view.getByRole("button", { name: /Revoke/i }));
      expect(a.requests[1].init?.method).toBe("DELETE");
      view.rerender(panel(b.root));
      await act(async () => {
        b.requests[0].response.resolve(principalResponse([principal("Beta agent")]));
        a.requests[1].response.resolve(Response.json({ ok: true }));
        await flushPromises();
      });
      expect(view.getByText("Beta agent")).toBeTruthy();
      expect(view.queryByText("Alpha agent")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("a delayed one-time credential stays with its issuing root after switching views", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><AppShell><DevicesAgentsTab active /></AppShell></BrainUiProvider>;
    const view = render(panel(a.root));
    try {
      await act(async () => { a.requests[0].response.resolve(principalResponse([])); await flushPromises(); });
      changeControlledInput(view.getByLabelText("Label") as HTMLInputElement, "Alpha helper");
      fireEvent.click(view.getByRole("button", { name: "Create agent credential" }));
      expect(a.requests[1].init?.method).toBe("POST");
      view.rerender(panel(b.root));
      await act(async () => {
        b.requests[0].response.resolve(principalResponse([]));
        a.requests[1].response.resolve(Response.json({ id: "issued", label: "Alpha helper", expiresAt: 1, cookie: "alpha-once" }));
        await flushPromises();
      });
      expect(a.root.stores.principal.getState().oneTimeCredential?.cookie).toBe("alpha-once");
      expect(b.root.stores.principal.getState().oneTimeCredential).toBeNull();
      expect(view.queryByText("alpha-once")).toBeNull();
      view.rerender(panel(a.root));
      expect(view.getByText("alpha-once")).toBeTruthy();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("late device lists and remembered-grant revocations cannot overwrite another root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><DevicesAgentsTab active /><ToolPermissionsSection active /></BrainUiProvider>;
    const view = render(panel(a.root));
    try {
      await act(async () => { a.matching("/tool-permissions")[0].response.resolve(Response.json({ tools: ["same-tool"] })); await flushPromises(); });
      // The grant is a kit row whose action is decorative: tapping the row revokes.
      fireEvent.click(view.getByRole("button", { name: /same-tool/ }));
      view.rerender(panel(b.root));
      await act(async () => {
        b.matching("/auth/principals")[0].response.resolve(principalResponse([principal("Beta device")]));
        b.matching("/tool-permissions")[0].response.resolve(Response.json({ tools: ["same-tool"] }));
        a.matching("/auth/principals")[0].response.resolve(principalResponse([principal("Obsolete device")]));
        a.matching("/tool-permissions/same-tool")[0].response.resolve(Response.json({ tools: [] }));
        await flushPromises();
      });
      expect(view.getByText("Beta device")).toBeTruthy();
      expect(view.queryByText("Obsolete device")).toBeNull();
      expect(view.getByText("same-tool")).toBeTruthy();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
});


describe("skill and web-search root ownership", () => {
  function transport(owner: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example` },
      request: (url, init) => {
        const response = deferred<Response>();
        requests.push({ url, init, response });
        return response.promise;
      },
    });
    return { root, requests };
  }
  const skill = (name: string) => ({ name, description: `${name} description`, source: "custom", enabled: true });
  const list = (name: string) => Response.json({ skills: [skill(name)] });
  const skillsPanel = (root: BrainUiRoot, active = true) => <BrainUiProvider root={root}><SkillsTab active={active} /></BrainUiProvider>;
  const webPanel = (root: BrainUiRoot) => <BrainUiProvider root={root}><WebSearchSection active /></BrainUiProvider>;
  const webConfig = (label: string) => ({ configured: true, order: [], overriddenBy: null, appliesTo: [], providers: [{
    id: "search", label, enabled: false, hasKeyField: true, keyConfigured: false, keyFromEnv: false,
    keyless: true, costNote: "Free", blurb: "Search provider",
  }] });
  async function reply(request: ReturnType<typeof transport>["requests"][number], body: unknown) {
    await act(async () => { request.response.resolve(Response.json(body)); await flushPromises(); });
  }
  function createDraft(view: ReturnType<typeof render>, name: string) {
    changeControlledInput(view.getByPlaceholderText("new-skill-name (kebab-case)") as HTMLInputElement, name);
    fireEvent.click(view.getByRole("button", { name: "Create" }));
  }

  test("late skill lists and editor responses cannot replace a new root's draft", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(skillsPanel(a.root));
    try {
      view.rerender(skillsPanel(b.root));
      await act(async () => {
        b.requests[0].response.resolve(list("beta-skill"));
        a.requests[0].response.resolve(list("obsolete-skill"));
        await flushPromises();
      });
      expect(view.getByText("beta-skill")).toBeTruthy();
      expect(view.queryByText("obsolete-skill")).toBeNull();
      fireEvent.click(view.getByTitle("Edit SKILL.md"));
      expect(b.requests[1].url).toBe("https://beta.example/api/skills/beta-skill");
      view.rerender(skillsPanel(a.root));
      createDraft(view, "alpha-draft");
      await reply(b.requests[1], { ...skill("beta-skill"), content: "obsolete content", files: [] });
      expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toContain("alpha-draft");
      expect(view.queryByText("obsolete content")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("a delayed skill save neither closes another root's editor nor reloads its list", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(skillsPanel(a.root));
    try {
      createDraft(view, "alpha-draft");
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      expect(a.requests[1].url).toBe("https://alpha.example/api/skills");
      expect(a.requests[1].init?.method).toBe("POST");
      expect(JSON.parse(String(a.requests[1].init?.body)).name).toBe("alpha-draft");
      view.rerender(skillsPanel(b.root));
      expect(view.queryByRole("button", { name: "Save" })).toBeNull();
      createDraft(view, "beta-draft");
      await reply(a.requests[1], { skill: skill("alpha-draft"), warning: "obsolete warning" });
      expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toContain("beta-draft");
      expect(view.queryByText("obsolete warning")).toBeNull();
      expect(a.requests).toHaveLength(2);
      expect(b.requests).toHaveLength(1);
      expect(view.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("late install results and errors stay out of a replacement skills tab", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(skillsPanel(a.root));
    try {
      changeControlledInput(view.getByPlaceholderText(/^GitHub:/) as HTMLInputElement, "example/skills");
      fireEvent.click(view.getByRole("button", { name: "Install" }));
      expect(a.requests[1].url).toBe("https://alpha.example/api/skills/install/github");
      view.rerender(skillsPanel(b.root));
      await reply(a.requests[1], { outcomes: [{ name: "obsolete-install", status: "installed", files: 1 }], warning: "obsolete warning" });
      expect(view.queryByText(/obsolete-install/)).toBeNull();
      expect(view.queryByText("obsolete warning")).toBeNull();
      expect(a.requests).toHaveLength(2);
      await reply(b.requests[0], { skills: [skill("beta-skill")] });
      fireEvent.click(view.getByTitle("Disable (all backends)"));
      expect(b.requests[1].url).toBe("https://beta.example/api/skills/beta-skill/enabled");
      view.rerender(skillsPanel(b.root, false));
      view.rerender(skillsPanel(b.root));
      await act(async () => {
        b.requests[1].response.resolve(Response.json({ error: "obsolete mutation failure" }, { status: 500 }));
        await flushPromises();
      });
      expect(view.queryByText(/obsolete mutation failure/)).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("web-search settings discard old loads and clear key drafts on root replacement", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(webPanel(a.root));
    try {
      view.rerender(webPanel(b.root));
      await reply(b.requests[0], webConfig("Beta search"));
      await reply(a.requests[0], webConfig("Obsolete search"));
      expect(view.getByText("Beta search")).toBeTruthy();
      expect(view.queryByText("Obsolete search")).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Needs key" }));
      changeControlledInput(view.getByPlaceholderText("Paste API key") as HTMLInputElement, "beta-test-key");
      view.rerender(webPanel(a.root));
      await reply(a.requests[1], webConfig("Alpha search"));
      expect(view.queryByPlaceholderText("Paste API key")).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Needs key" }));
      expect((view.getByPlaceholderText("Paste API key") as HTMLInputElement).value).toBe("");
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("a delayed web-search key save cannot clear another root's draft or busy state", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(webPanel(a.root));
    try {
      await reply(a.requests[0], webConfig("Alpha search"));
      fireEvent.click(view.getByRole("button", { name: "Needs key" }));
      changeControlledInput(view.getByPlaceholderText("Paste API key") as HTMLInputElement, "alpha-test-key");
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      expect(a.requests[1].url).toBe("https://alpha.example/api/web-search");
      expect(a.requests[1].init?.method).toBe("PUT");
      expect(JSON.parse(String(a.requests[1].init?.body))).toEqual({ apiKeys: { search: "alpha-test-key" } });
      view.rerender(webPanel(b.root));
      await reply(b.requests[0], webConfig("Beta search"));
      fireEvent.click(view.getByRole("button", { name: "Needs key" }));
      changeControlledInput(view.getByPlaceholderText("Paste API key") as HTMLInputElement, "beta-test-key");
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      await reply(a.requests[1], webConfig("Obsolete search"));
      expect((view.getByPlaceholderText("Paste API key") as HTMLInputElement).value).toBe("beta-test-key");
      expect(view.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
      expect(view.getByText("Beta search")).toBeTruthy();
      await reply(b.requests[1], webConfig("Beta search"));
      expect((view.getByPlaceholderText("Paste API key") as HTMLInputElement).value).toBe("");
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
});


describe("model and pi account root ownership", () => {
  function transport(owner: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example` },
      request: (url, init) => {
        const response = deferred<Response>();
        requests.push({ url, init, response });
        return response.promise;
      },
    });
    return { root, requests, matching: (path: string, method = "GET") => requests.filter(r => new URL(r.url).pathname === `/api${path}` && (r.init?.method ?? "GET") === method) };
  }
  const catalog = (label: string, hidden: string[] = []) => ({
    models: ["one", "two"].map(id => ({ id, label: `${label} ${id}`, hidden: hidden.includes(id) })),
    discovery: { enabled: true }, refreshedAt: null, customModels: [],
  });
  const accounts = (name: string, configured = false) => ({ providers: [{ providerId: "vendor", name, oauth: true, configured, source: configured ? "stored" : null }] });
  const loginFlow = (id: string, status = "pending") => ({ id, providerId: "vendor", status, userCode: `${id}-code`, intervalSeconds: 0.001 });
  const modelsPanel = (root: BrainUiRoot) => <BrainUiProvider root={root}><ModelsTab active /></BrainUiProvider>;
  const accountsPanel = (root: BrainUiRoot, active = true) => <BrainUiProvider root={root}><PiAccountsSection active={active} /></BrainUiProvider>;
  async function reply(request: ReturnType<typeof transport>["requests"][number], body: unknown) {
    await act(async () => { request.response.resolve(Response.json(body)); await flushPromises(); });
  }

  test("model writes stay ordered per root and returning waits for its accepted writes", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(modelsPanel(a.root));
    try {
      await act(flushPromises);
      await reply(a.matching("/models")[0], catalog("Alpha"));
      await act(async () => { fireEvent.click(view.getAllByTitle("Hide from picker")[0]); await flushPromises(); });
      await act(async () => { fireEvent.click(view.getAllByTitle("Hide from picker")[0]); await flushPromises(); });
      expect(a.matching("/models/hidden", "PUT")).toHaveLength(1);
      view.rerender(modelsPanel(b.root));
      await act(flushPromises);
      await reply(b.matching("/models")[0], catalog("Beta"));
      await act(async () => { fireEvent.click(view.getAllByTitle("Hide from picker")[0]); await flushPromises(); });
      expect(b.matching("/models/hidden", "PUT")).toHaveLength(1);
      expect(b.matching("/models/hidden", "PUT")[0].url).toBe("https://beta.example/api/models/hidden");
      await reply(a.matching("/models/hidden", "PUT")[0], catalog("Alpha", ["one"]));
      expect(a.matching("/models/hidden", "PUT")).toHaveLength(2);
      expect(JSON.parse(String(a.matching("/models/hidden", "PUT")[1].init?.body))).toEqual({ hidden: ["one", "two"] });
      expect(view.getByLabelText("Billing for Beta one")).toBeTruthy();
      expect(view.queryByLabelText("Billing for Alpha one")).toBeNull();
      view.rerender(modelsPanel(a.root));
      await act(flushPromises);
      expect(a.matching("/models")).toHaveLength(1);
      await reply(a.matching("/models/hidden", "PUT")[1], catalog("Alpha", ["one", "two"]));
      expect(a.matching("/models")).toHaveLength(2);
      await reply(a.matching("/models")[1], catalog("Alpha", ["one", "two"]));
      expect(view.getAllByTitle("Show in picker")).toHaveLength(2);
      await act(async () => {
        b.matching("/models/hidden", "PUT")[0].response.resolve(Response.json({ error: "obsolete rollback" }, { status: 500 }));
        await flushPromises();
      });
      expect(view.queryByText("obsolete rollback")).toBeNull();
      expect(view.getAllByTitle("Show in picker")).toHaveLength(2);
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("old model discovery responses cannot replace a new root's catalog or refresh state", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(modelsPanel(a.root));
    try {
      await act(flushPromises);
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "Refresh" })); await flushPromises(); });
      view.rerender(modelsPanel(b.root));
      await act(flushPromises);
      await reply(b.matching("/models")[0], catalog("Beta"));
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "Refresh" })); await flushPromises(); });
      await reply(a.matching("/models")[0], catalog("Obsolete load"));
      await reply(a.matching("/models/refresh", "POST")[0], catalog("Obsolete refresh"));
      expect(view.getByLabelText("Billing for Beta one")).toBeTruthy();
      expect(view.getByRole("button", { name: "Refreshing…" }).getAttribute("aria-disabled")).toBe("true");
      await reply(b.matching("/models/refresh", "POST")[0], catalog("New beta"));
      expect(view.getByLabelText("Billing for New beta one")).toBeTruthy();
      expect(view.getByRole("button", { name: "Refresh" }).getAttribute("aria-disabled")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("a delayed pi login start cannot display or poll its flow under another root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(accountsPanel(a.root));
    try {
      await reply(a.requests[0], accounts("Alpha account"));
      fireEvent.click(view.getByRole("button", { name: "Connect" }));
      expect(a.matching("/pi-auth/login", "POST")[0].url).toBe("https://alpha.example/api/pi-auth/login");
      view.rerender(accountsPanel(b.root));
      await reply(b.requests[0], accounts("Beta account"));
      fireEvent.click(view.getByRole("button", { name: "Connect" }));
      await reply(b.matching("/pi-auth/login", "POST")[0], { flow: { ...loginFlow("beta"), intervalSeconds: 60 } });
      await reply(a.matching("/pi-auth/login", "POST")[0], { flow: loginFlow("alpha") });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      expect(view.queryByText("alpha-code")).toBeNull();
      expect(b.requests).toHaveLength(2);
      expect(view.getByText("beta-code")).toBeTruthy();
      expect(a.matching("/pi-auth/login/alpha")).toHaveLength(0);
      expect(view.getByRole("button", { name: "Connect" }).getAttribute("aria-disabled")).toBe("true");
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("in-flight pi polls stop on root replacement and successful polling refreshes only its root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(accountsPanel(a.root));
    try {
      await reply(a.requests[0], accounts("Alpha account"));
      fireEvent.click(view.getByRole("button", { name: "Connect" }));
      await reply(a.matching("/pi-auth/login", "POST")[0], { flow: loginFlow("alpha") });
      await waitFor(() => expect(a.matching("/pi-auth/login/alpha")).toHaveLength(1));
      view.rerender(accountsPanel(b.root));
      expect(view.queryByText("alpha-code")).toBeNull();
      await reply(b.requests[0], accounts("Beta account"));
      fireEvent.click(view.getByRole("button", { name: "Connect" }));
      await reply(b.matching("/pi-auth/login", "POST")[0], { flow: loginFlow("beta") });
      await reply(a.matching("/pi-auth/login/alpha")[0], { flow: loginFlow("alpha", "success") });
      expect(view.getByText("beta-code")).toBeTruthy();
      expect(a.matching("/pi-auth/providers")).toHaveLength(1);
      expect(b.matching("/pi-auth/login/alpha")).toHaveLength(0);
      await waitFor(() => expect(b.matching("/pi-auth/login/beta")).toHaveLength(1));
      await reply(b.matching("/pi-auth/login/beta")[0], { flow: loginFlow("beta", "success") });
      expect(view.getByText("Connected.")).toBeTruthy();
      expect(b.matching("/pi-auth/providers")).toHaveLength(2);
      expect(b.matching("/providers")).toHaveLength(1);
      expect(a.matching("/providers")).toHaveLength(0);
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });

  test("cancelling a pi flow invalidates an outstanding poll without clearing a newer login", async () => {
    const a = transport("alpha");
    const view = render(accountsPanel(a.root));
    try {
      await reply(a.requests[0], accounts("Alpha account"));
      fireEvent.click(view.getByRole("button", { name: "Connect" }));
      await reply(a.matching("/pi-auth/login", "POST")[0], { flow: loginFlow("old") });
      await waitFor(() => expect(a.matching("/pi-auth/login/old")).toHaveLength(1));
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      expect(view.queryByText("old-code")).toBeNull();
      expect(a.matching("/pi-auth/login/old", "DELETE")).toHaveLength(1);
      fireEvent.click(view.getByRole("button", { name: "Connect" }));
      await reply(a.matching("/pi-auth/login", "POST")[1], { flow: loginFlow("new") });
      await reply(a.matching("/pi-auth/login/old")[0], { flow: loginFlow("old", "success") });
      await reply(a.matching("/pi-auth/login/old", "DELETE")[0], { ok: true });
      expect(view.getByText("new-code")).toBeTruthy();
      expect(a.matching("/pi-auth/providers")).toHaveLength(1);
      const pollsBeforeClose = a.matching("/pi-auth/login/new").length;
      view.rerender(accountsPanel(a.root, false));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      expect(a.matching("/pi-auth/login/new")).toHaveLength(pollsBeforeClose);
      expect(view.queryByText("new-code")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); }
  });

  test("late pi account loads and logout failures cannot overwrite a replacement root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const view = render(accountsPanel(a.root));
    try {
      view.rerender(accountsPanel(b.root));
      await reply(b.requests[0], accounts("Beta account", true));
      await reply(a.requests[0], accounts("Obsolete account", true));
      expect(view.queryByText("Obsolete account")).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
      expect(b.matching("/pi-auth/logout", "POST")).toHaveLength(1);
      view.rerender(accountsPanel(a.root));
      await reply(a.matching("/pi-auth/providers")[1], accounts("Alpha account"));
      await act(async () => {
        b.matching("/pi-auth/logout", "POST")[0].response.resolve(Response.json({ error: "obsolete logout failure" }, { status: 500 }));
        await flushPromises();
      });
      expect(view.getByText("Alpha account")).toBeTruthy();
      expect(view.queryByRole("alert")).toBeNull();
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
});


describe("authentication and passkey root ownership", () => {
  function transport(owner: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example`, appName: `${owner} brain` },
      request: (url, init) => {
        const response = deferred<Response>();
        requests.push({ url, init, response });
        return response.promise;
      },
    });
    return { root, requests, matching: (path: string, method = "GET") => requests.filter(r => new URL(r.url).pathname === `/api${path}` && (r.init?.method ?? "GET") === method) };
  }
  function browser(autofill: () => Promise<boolean> = async () => false) {
    const previousPublicKey = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
    const previousCredentials = Object.getOwnPropertyDescriptor(navigator, "credentials");
    const ceremonies: Array<ReturnType<typeof deferred<unknown>>> = [];
    const ceremony = () => { const result = deferred<unknown>(); ceremonies.push(result); return result.promise; };
    Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true, value: class { static isConditionalMediationAvailable = autofill; } });
    Object.defineProperty(navigator, "credentials", { configurable: true, value: { create: ceremony, get: ceremony } });
    return { ceremonies, restore() {
      if (previousPublicKey) Object.defineProperty(globalThis, "PublicKeyCredential", previousPublicKey);
      else Reflect.deleteProperty(globalThis, "PublicKeyCredential");
      if (previousCredentials) Object.defineProperty(navigator, "credentials", previousCredentials);
      else Reflect.deleteProperty(navigator, "credentials");
    } };
  }
  const credential = () => ({ id: "test-key", type: "public-key", rawId: new ArrayBuffer(1),
    response: { attestationObject: new ArrayBuffer(1), clientDataJSON: new ArrayBuffer(1), authenticatorData: new ArrayBuffer(1), signature: new ArrayBuffer(1) },
    getClientExtensionResults: () => ({}),
  });
  const registrationOptions = { challenge: "YQ", rp: { name: "Example", id: "example" }, user: { id: "YQ", name: "example", displayName: "Example" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] };
  const keys = (label: string) => ({ credentials: [{ id: "same", label, rpId: "example", createdAt: 1, lastUsedAt: null, backedUp: false }] });
  const login = (root: BrainUiRoot) => <BrainUiProvider root={root}><LoginScreen /></BrainUiProvider>;
  const security = (root: BrainUiRoot) => <BrainUiProvider root={root}><PasskeyTab active /></BrainUiProvider>;
  async function reply(request: ReturnType<typeof transport>["requests"][number], body: unknown) {
    await act(async () => { request.response.resolve(Response.json(body)); await flushPromises(); });
  }

  test("password login, branding and methods belong to the displayed root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const view = render(login(a.root));
    try {
      changeControlledInput(view.getByPlaceholderText("Password") as HTMLInputElement, "alpha-password");
      fireEvent.click(view.getByRole("button", { name: "Sign in" }));
      expect(JSON.parse(String(a.matching("/auth/login", "POST")[0].init?.body))).toEqual({ password: "alpha-password" });
      view.rerender(login(b.root));
      expect(view.getByRole("heading", { name: "beta brain" })).toBeTruthy();
      expect((view.getByPlaceholderText("Password") as HTMLInputElement).value).toBe("");
      await reply(a.matching("/auth/methods")[0], { passkey: true, password: false });
      await reply(a.matching("/auth/login", "POST")[0], { ok: true });
      expect(reload).not.toHaveBeenCalled();
      expect(view.getByPlaceholderText("Password")).toBeTruthy();
      changeControlledInput(view.getByPlaceholderText("Password") as HTMLInputElement, "beta-password");
      fireEvent.click(view.getByRole("button", { name: "Sign in" }));
      expect(b.matching("/auth/login", "POST")[0].url).toBe("https://beta.example/api/auth/login");
      await reply(b.matching("/auth/login", "POST")[0], { ok: true });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); reload.mockRestore(); a.root.dispose(); b.root.dispose(); }
  });

  test("late autofill support cannot start a ceremony after switching roots", async () => {
    const support = deferred<boolean>(); const platform = browser(() => support.promise);
    const a = transport("alpha"); const b = transport("beta");
    const view = render(login(a.root));
    try {
      await reply(a.requests[0], { passkey: true, password: true });
      view.rerender(login(b.root));
      await act(async () => { support.resolve(true); await flushPromises(); });
      expect(a.matching("/auth/passkey/login-options", "POST")).toHaveLength(0);
      expect(platform.ceremonies).toHaveLength(0);
      expect(b.requests).toHaveLength(1);
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("registration options arriving after a root switch never open a browser ceremony", async () => {
    const platform = browser(); const a = transport("alpha"); const b = transport("beta");
    const view = render(security(a.root));
    try {
      await reply(a.requests[0], { credentials: [] });
      fireEvent.click(view.getByRole("button", { name: "Add a passkey" }));
      view.rerender(security(b.root));
      await reply(b.requests[0], keys("Beta key"));
      await reply(a.matching("/auth/passkey/register-options", "POST")[0], registrationOptions);
      expect(platform.ceremonies).toHaveLength(0);
      expect(view.getByText("Beta key")).toBeTruthy();
      expect(view.getByRole("button", { name: "Add a passkey" }).getAttribute("aria-disabled")).toBeNull();
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("a stale registration result is not verified and a current ceremony uses its root", async () => {
    const platform = browser(); const a = transport("alpha"); const b = transport("beta");
    const view = render(security(a.root));
    try {
      await reply(a.requests[0], { credentials: [] });
      fireEvent.click(view.getByRole("button", { name: "Add a passkey" }));
      await reply(a.matching("/auth/passkey/register-options", "POST")[0], registrationOptions);
      expect(platform.ceremonies).toHaveLength(1);
      view.rerender(security(b.root));
      await reply(b.requests[0], { credentials: [] });
      fireEvent.click(view.getByRole("button", { name: "Add a passkey" }));
      await reply(b.matching("/auth/passkey/register-options", "POST")[0], registrationOptions);
      await act(async () => { platform.ceremonies[0].resolve(credential()); await flushPromises(); });
      expect(a.matching("/auth/passkey/register-verify", "POST")).toHaveLength(0);
      expect(view.getByRole("button", { name: "Adding a passkey…" }).getAttribute("aria-disabled")).toBe("true");
      await act(async () => { platform.ceremonies[1].resolve(credential()); await flushPromises(); });
      const verify = b.matching("/auth/passkey/register-verify", "POST")[0];
      expect(verify.url).toBe("https://beta.example/api/auth/passkey/register-verify");
      await reply(verify, { ok: true });
      expect(b.matching("/auth/passkey/list")).toHaveLength(2);
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("a stale passkey login result cannot verify or reload another root", async () => {
    const platform = browser(); const a = transport("alpha"); const b = transport("beta");
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const view = render(login(a.root));
    try {
      await reply(a.requests[0], { passkey: true, password: true });
      fireEvent.click(view.getByRole("button", { name: "Sign in with a passkey" }));
      await reply(a.matching("/auth/passkey/login-options", "POST")[0], { challenge: "YQ", rpId: "example", allowCredentials: [] });
      view.rerender(login(b.root));
      await reply(b.requests[0], { passkey: true, password: true });
      fireEvent.click(view.getByRole("button", { name: "Sign in with a passkey" }));
      await reply(b.matching("/auth/passkey/login-options", "POST")[0], { challenge: "YQ", rpId: "example", allowCredentials: [] });
      await act(async () => { platform.ceremonies[0].resolve(credential()); await flushPromises(); });
      expect(a.matching("/auth/passkey/login-verify", "POST")).toHaveLength(0);
      expect(reload).not.toHaveBeenCalled();
      await act(async () => { platform.ceremonies[1].resolve(credential()); await flushPromises(); });
      const verify = b.matching("/auth/passkey/login-verify", "POST")[0];
      expect(verify.url).toBe("https://beta.example/api/auth/passkey/login-verify");
      await reply(verify, { ok: true });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); reload.mockRestore(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("late passkey mutations and sign-out cannot change or reload a replacement root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    window.confirm = () => true;
    const view = render(security(a.root));
    try {
      await reply(a.requests[0], keys("Alpha key"));
      fireEvent.click(view.getByTitle("Rename"));
      changeControlledInput(view.getByRole("textbox") as HTMLInputElement, "Obsolete name");
      fireEvent.click(view.getByTitle("Save"));
      fireEvent.click(view.getByTitle("Remove"));
      fireEvent.click(view.getByRole("button", { name: "Sign out everywhere" }));
      view.rerender(security(b.root));
      await reply(b.requests[0], keys("Beta key"));
      await reply(a.matching("/auth/passkey/same", "PUT")[0], { ok: true });
      await reply(a.matching("/auth/passkey/same", "DELETE")[0], { ok: true });
      await reply(a.matching("/auth/logout", "POST")[0], { ok: true });
      expect(view.getByText("Beta key")).toBeTruthy();
      expect(view.queryByText("Obsolete name")).toBeNull();
      expect(reload).not.toHaveBeenCalled();
    } finally { view.unmount(); reload.mockRestore(); a.root.dispose(); b.root.dispose(); }
  });
});


describe("push root ownership", () => {
  function transport(owner: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example` },
      request: (url, init) => {
        const response = deferred<Response>(); requests.push({ url, init, response }); return response.promise;
      },
    });
    return { root, requests, matching: (path: string) => requests.filter(r => new URL(r.url).pathname === `/api${path}`) };
  }
  function browser(permission: NotificationPermission = "granted") {
    const descriptors: Array<{ target: object; key: string; descriptor: PropertyDescriptor | undefined }> = [];
    function install(target: object, key: string, value: unknown) {
      descriptors.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
      Object.defineProperty(target, key, { configurable: true, value });
    }
    const permissions: Array<ReturnType<typeof deferred<NotificationPermission>>> = [];
    const creations: Array<{ options: unknown; response: ReturnType<typeof deferred<typeof subscription>> }> = [];
    let removals = 0;
    const subscription = { endpoint: "https://push.example/endpoint", options: { applicationServerKey: new Uint8Array([1]).buffer },
      toJSON: () => ({ endpoint: "https://push.example/endpoint", keys: { p256dh: "test", auth: "test" } }),
      unsubscribe: async () => { removals++; return true; },
    };
    const registration = { pushManager: {
      getSubscription: async () => subscription,
      subscribe: async (options: unknown) => { const response = deferred<typeof subscription>(); creations.push({ options, response }); return response.promise; },
    } };
    const notifications = { permission, requestPermission: () => { const response = deferred<NotificationPermission>(); permissions.push(response); return response.promise; } };
    const worker = { ready: Promise.resolve(registration) };
    install(globalThis, "Notification", notifications);
    if (window !== (globalThis as unknown)) install(window, "Notification", notifications);
    install(window, "PushManager", class {});
    install(navigator, "serviceWorker", worker);
    return { subscription, registration, notifications, worker, permissions, creations, removals: () => removals, restore() {
      for (const { target, key, descriptor } of descriptors.reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
      }
    } };
  }
  const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><PushToggle /></BrainUiProvider>;
  const gate = (root: BrainUiRoot) => <BrainUiProvider root={root}><ConnectionGate><div>Protected content</div></ConnectionGate></BrainUiProvider>;
  async function reply(request: ReturnType<typeof transport>["requests"][number], body: unknown) {
    await act(async () => { request.response.resolve(Response.json(body)); await flushPromises(); });
  }
  async function connected(owner: ReturnType<typeof transport>) {
    await reply(owner.matching("/push/public-key").at(-1)!, { publicKey: "AQ" });
    await reply(owner.matching("/push/subscribe").at(-1)!, { ok: true });
  }

  test("mounting against a different key does not remove the browser subscription", async () => {
    const platform = browser(); const a = transport("alpha"); const view = render(panel(a.root));
    try {
      await act(flushPromises);
      await reply(a.requests[0], { publicKey: "Ag" });
      expect(platform.removals()).toBe(0);
      expect(a.matching("/push/subscribe")).toHaveLength(0);
      fireEvent.click(view.getByRole("switch", { name: "Push notifications" }));
      await act(async () => { platform.permissions[0].resolve("granted"); await flushPromises(); });
      await reply(a.matching("/push/public-key")[1], { publicKey: "Ag" });
      expect(platform.removals()).toBe(1);
      expect(platform.creations[0].options).toEqual({ userVisibleOnly: true, applicationServerKey: "Ag" });
      await act(async () => { platform.creations[0].response.resolve(platform.subscription); await flushPromises(); });
      expect(a.matching("/push/subscribe")[0].url).toBe("https://alpha.example/api/push/subscribe");
      await reply(a.matching("/push/subscribe")[0], { ok: true });
      expect(view.getByRole("switch", { name: "Push notifications", checked: true })).toBeTruthy();
    } finally { view.unmount(); platform.restore(); a.root.dispose(); }
  });

  test("a late permission response cannot enable push or clear another root's pending state", async () => {
    const platform = browser("default"); const a = transport("alpha"); const b = transport("beta");
    const view = render(panel(a.root));
    try {
      fireEvent.click(view.getByRole("switch", { name: "Push notifications" }));
      view.rerender(panel(b.root));
      fireEvent.click(view.getByRole("switch", { name: "Push notifications" }));
      await act(async () => { platform.permissions[0].resolve("granted"); await flushPromises(); });
      expect(a.requests).toHaveLength(0);
      expect(view.getByRole("switch", { name: "Push notifications" }).getAttribute("aria-disabled")).toBe("true");
      await act(async () => { platform.permissions[1].resolve("denied"); await flushPromises(); });
      expect(view.getByText("Blocked in browser settings")).toBeTruthy();
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("late native subscription creation cannot bind to a superseded UI", async () => {
    const platform = browser("default"); const a = transport("alpha"); const b = transport("beta");
    const view = render(panel(a.root));
    try {
      fireEvent.click(view.getByRole("switch", { name: "Push notifications" }));
      await act(async () => { platform.permissions[0].resolve("granted"); await flushPromises(); });
      await reply(a.requests[0], { publicKey: "AQ" });
      expect(platform.creations).toHaveLength(1);
      view.rerender(panel(b.root));
      await act(async () => { platform.creations[0].response.resolve(platform.subscription); await flushPromises(); });
      expect(a.matching("/push/subscribe")).toHaveLength(0);
      expect(b.requests).toHaveLength(0);
      expect(view.getByRole("switch", { name: "Push notifications" })).toBeTruthy();
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("late disable responses cannot unsubscribe the replacement root's browser subscription", async () => {
    const platform = browser(); const a = transport("alpha"); const b = transport("beta");
    const view = render(panel(a.root));
    try {
      await act(flushPromises); await connected(a);
      await act(async () => { fireEvent.click(view.getByRole("switch", { name: "Push notifications", checked: true })); await flushPromises(); });
      expect(a.matching("/push/unsubscribe")).toHaveLength(1);
      view.rerender(panel(b.root));
      await act(flushPromises); await connected(b);
      await reply(a.matching("/push/unsubscribe")[0], { removed: true });
      expect(platform.removals()).toBe(0);
      expect(view.getByRole("switch", { name: "Push notifications", checked: true })).toBeTruthy();
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("connection gates reset connectivity and bind push only after their own successful probe", async () => {
    const platform = browser(); const a = transport("alpha"); const b = transport("beta");
    const view = render(gate(a.root));
    try {
      await reply(a.matching("/vpn-check")[0], {});
      expect(view.getByText("Protected content")).toBeTruthy();
      // Leave A's public-key request pending while B establishes its session.
      view.rerender(gate(b.root));
      expect(view.queryByText("Protected content")).toBeNull();
      expect(b.matching("/push/public-key")).toHaveLength(0);
      await reply(b.matching("/vpn-check")[0], {});
      await reply(b.matching("/push/public-key")[0], { publicKey: "AQ" });
      await reply(a.matching("/push/public-key")[0], { publicKey: "AQ" });
      expect(a.matching("/push/subscribe")).toHaveLength(0);
      expect(b.matching("/push/subscribe")).toHaveLength(1);
      await reply(b.matching("/push/subscribe")[0], { ok: true });
      expect(view.getByText("Protected content")).toBeTruthy();
      // Revisit A: completed B bookkeeping must not suppress its new bind.
      view.rerender(gate(a.root));
      expect(a.matching("/push/public-key")).toHaveLength(1);
      await reply(a.matching("/vpn-check")[1], {});
      await reply(a.matching("/push/public-key")[1], { publicKey: "Ag" });
      expect(a.matching("/push/subscribe")).toHaveLength(0);
      expect(platform.removals()).toBe(0);
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("a superseded service-worker readiness wait cannot fetch or bind push", async () => {
    const platform = browser(); const ready = deferred<typeof platform.registration>(); platform.worker.ready = ready.promise;
    const a = transport("alpha"); const b = transport("beta"); const view = render(panel(a.root));
    try {
      platform.notifications.permission = "default";
      view.rerender(panel(b.root));
      await act(async () => { ready.resolve(platform.registration); await flushPromises(); });
      expect(a.requests).toHaveLength(0); expect(b.requests).toHaveLength(0);
      expect(view.getByRole("switch", { name: "Push notifications" })).toBeTruthy();
    } finally { view.unmount(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });
});


describe("remaining media and lookup root ownership", () => {
  test("mask requests with identical IDs reset errors and strokes across roots", () => {
    const a = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" } });
    const b = createBrainUiRoot({ storage: null, config: { backendUrl: "https://beta.example" } });
    for (const root of [a, b]) root.stores.mask.getState().open({ requestId: "same", imagePath: "photo.png" });
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><MaskEditor onSubmit={() => {}} onCancel={() => {}} /></BrainUiProvider>;
    const view = render(panel(a));
    try {
      const canvas = view.container.querySelector("canvas")!;
      canvas.setPointerCapture = () => {};
      fireEvent.pointerDown(canvas, { clientX: 1, clientY: 1, pointerId: 1 });
      fireEvent.error(view.container.querySelector("img")!);
      expect((view.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);
      expect(view.getByText("Could not load photo.png")).toBeTruthy();
      view.rerender(panel(b));
      expect((view.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
      expect(view.queryByText("Could not load photo.png")).toBeNull();
      expect(view.container.querySelector("img")!.src).toStartWith("https://beta.example/api/");
    } finally { view.unmount(); a.dispose(); b.dispose(); }
  });
  function transport(owner: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example`, shareTitle: `${owner} export` },
      request: (url, init) => { const response = deferred<Response>(); requests.push({ url, init, response }); return response.promise; },
    });
    return { root, requests };
  }
  test("session history and graph candidates discard a previous server's results", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><SessionDrawer open onClose={() => {}} onResume={() => {}} /><DiscoveryStart /></BrainUiProvider>;
    const view = render(panel(a.root));
    const respond = (owner: ReturnType<typeof transport>, name: string) => {
      for (const request of owner.requests) request.response.resolve(Response.json(request.url.includes("/sessions")
        ? { sessions: [{ id: name, title: `${name} conversation`, createdAt: 1, lastActiveAt: 2 }] }
        : { results: [{ path: `notes/${name}.md`, title: `${name} index` }] }));
    };
    try {
      view.rerender(panel(b.root));
      await act(async () => { respond(b, "Beta"); respond(a, "Obsolete"); await flushPromises(); });
      expect(view.getByText("Beta conversation")).toBeTruthy(); expect(view.getByText("Beta index")).toBeTruthy();
      expect(view.queryByText("Obsolete conversation")).toBeNull(); expect(view.queryByText("Obsolete index")).toBeNull();
      expect(b.requests.every(r => r.url.startsWith("https://beta.example/api/"))).toBe(true);
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
  test("markdown images change server URLs when the provider changes", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><BrainMarkdown content="![Note image](notes/photo.png)" /></BrainUiProvider>;
    const view = render(panel(a.root));
    try {
      expect(view.getByRole("button", { name: "Note image" }).getAttribute("src")).toBe("https://alpha.example/api/files/content?path=notes%2Fphoto.png&raw=1");
      view.rerender(panel(b.root));
      expect(view.getByRole("button", { name: "Note image" }).getAttribute("src")).toBe("https://beta.example/api/files/content?path=notes%2Fphoto.png&raw=1");
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
  test("share rendering captures the issuing server and its branding", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><ShareBlock body="A note" /></BrainUiProvider>;
    const view = render(panel(a.root));
    try {
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "Share as image" })); await flushPromises(); });
      expect(a.requests.find(r => r.url.endsWith("/render"))!.url).toBe("https://alpha.example/api/render");
      expect(JSON.parse(String(a.requests.find(r => r.url.endsWith("/render"))!.init?.body)).title).toBe("alpha export");
      view.rerender(panel(b.root));
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "Share as image" })); await flushPromises(); });
      expect(b.requests.find(r => r.url.endsWith("/render"))!.url).toBe("https://beta.example/api/render");
      expect(JSON.parse(String(b.requests.find(r => r.url.endsWith("/render"))!.init?.body)).title).toBe("beta export");
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
  test("a previous root's share completion cannot clear a new share's pending state", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const old = deferred<boolean>(); const next = deferred<boolean>();
    const panel = (root: BrainUiRoot, result: Promise<boolean>) => <BrainUiProvider root={root}><ShareMenu options={[{ id: "test", label: "Test", run: () => result }]} /></BrainUiProvider>;
    const view = render(panel(a.root, old.promise));
    try {
      fireEvent.click(view.getByTitle("Share")); view.rerender(panel(b.root, next.promise)); fireEvent.click(view.getByTitle("Share"));
      await act(async () => { old.resolve(true); await flushPromises(); });
      expect((view.getByTitle("Share") as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { next.resolve(false); await flushPromises(); });
      expect((view.getByTitle("Share") as HTMLButtonElement).disabled).toBe(false);
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
});

/* ── S5: the first kit consumer, and the theme switch ───────────────────── */

/** Open durable decisions for the badge (#684): what the badge counts now. */
function openDecisions(n: number) {
  const items = Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, {
    id: `a${i}`, dedupKey: `a${i}`, threadId: "t", queue: "actions", type: "approve", status: "pending", version: 1,
    createdAt: 0, updatedAt: 0, expiresAt: 1, payload: { title: "Harbour fee", detail: "" }, options: [],
  }]));
  useInboxStore.setState({ items } as never);
}

describe("MobileTabBar on the kit TabBar", () => {
  test("renders the five destinations as a tablist, with what needs you as the Actions badge", () => {
    // Run notices are facts, not decisions: they no longer badge (#684).
    useActivityStore.setState({ inbox: [{ id: "n" }] as never });
    openDecisions(3);
    const view = render(<MobileTabBar />);
    const tabs = view.getAllByRole("tab");
    // D52 §1: Sessions takes Graph's slot, and Graph moves into More.
    expect(tabs.map((t) => t.textContent)).toEqual(["Chat", "Sessions", "Actions3", "Files", "More"]);
    // Chat is the active view, so Chat is the amber slot and the only selected tab.
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    // The kit's roving tab stop: one slot reachable by Tab, the rest by arrows.
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    view.unmount();
    openDecisions(0);
    useActivityStore.setState({ inbox: [] });
  });

  test("a slot switches the view, and More is the kit sheet with Settings, Graph and the acts", () => {
    useUIStore.getState().setActiveView("chat");
    const view = render(<MobileTabBar />);
    const selected = () => view.getAllByRole("tab").map((t) => t.getAttribute("aria-selected") === "true" ? t.textContent : null).filter(Boolean);
    fireEvent.click(view.getByRole("tab", { name: "Actions" }));
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(view.getByRole("tab", { name: "Actions" }).getAttribute("aria-selected")).toBe("true");
    expect(view.queryByRole("tab", { name: "Graph" }), "Graph is no longer a slot").toBeNull();

    // Sessions and Files are panels that only Chat mounts in full: from
    // Actions they land in Chat with the panel open, and are "here".
    fireEvent.click(view.getByRole("tab", { name: "Sessions" }));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);
    expect(selected()).toEqual(["Sessions"]);
    // N1: a destination replaces the open panel with no close step.
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().sessionPanelOpen).toBe(false);
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(selected()).toEqual(["Files"]);
    // N3: pressing the current destination never closes it.
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().filePanelOpen, "Files is not a toggle").toBe(true);
    fireEvent.click(view.getByRole("tab", { name: "Chat" }));
    expect(useUIStore.getState().filePanelOpen, "Chat closes the panel").toBe(false);
    expect(selected()).toEqual(["Chat"]);

    expect(view.queryByRole("dialog")).toBeNull();
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    const sheet = view.getByRole("dialog", { name: "More" });
    // Settings and Graph, then the acts, with no redundant Sessions row.
    // Disconnected, so the two that need the host are rows without a
    // handler, listed with the reason and their effect, never omitted.
    expect(sheet.textContent).not.toContain("Sessions");
    const rows = [...sheet.querySelectorAll('[role="button"]')].map((r) => r.textContent);
    expect(rows).toEqual(["Settings", "Graph", "Add a noteWrite it down in the brain", "Brain statisticsDocuments and software versions"]);
    expect(sheet.textContent).toContain("Sync the brainneeds the hostsync");
    expect(sheet.textContent).toContain("Daily briefingneeds the hostspends");
    // While the sheet is open, More is the amber slot.
    expect(view.getByRole("tab", { name: "More" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(sheet.querySelector('[role="button"]')!);
    expect(useUIStore.getState().settingsPanelOpen).toBe(true);
    expect(view.queryByRole("dialog")).toBeNull();
    // Settings lives in More, so More stays amber while it is open.
    expect(selected()).toEqual(["More"]);

    fireEvent.click(view.getByRole("tab", { name: "More" }));
    fireEvent.click(view.getByRole("button", { name: /^Graph/ }));
    expect(useUIStore.getState().activeView).toBe("graph");
    expect(useUIStore.getState().settingsPanelOpen, "Graph replaces Settings").toBe(false);
    expect(selected()).toEqual(["More"]);
    // Files opens over Graph, which mounts its own panel.
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().activeView).toBe("graph");
    expect(useUIStore.getState().filePanelOpen).toBe(true);

    fireEvent.click(view.getByRole("tab", { name: "More" }));
    expect(view.getByRole("dialog", { name: "More" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement, "Esc returns focus to the More slot").toBe(view.getByRole("tab", { name: "More" }));
    view.unmount();
    useUIStore.getState().setActiveView("chat");
  });

  test("Escape over an open destination dismisses only More", () => {
    useUIStore.getState().setActiveView("chat");
    useUIStore.getState().openPanel("files");
    // A drawer's own Escape, registered the way SlidePanel and FilePanel do.
    const drawerEscape = mock((e: KeyboardEvent) => { if (e.key === "Escape") useUIStore.getState().setFilePanelOpen(false); });
    document.addEventListener("keydown", drawerEscape);
    const view = render(<MobileTabBar />);
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    expect(view.getByRole("dialog", { name: "More" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("dialog"), "More closes").toBeNull();
    expect(useUIStore.getState().filePanelOpen, "the drawer under More stays open").toBe(true);
    // With More closed, Escape reaches the drawer again.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useUIStore.getState().filePanelOpen).toBe(false);
    document.removeEventListener("keydown", drawerEscape);
    view.unmount();
    useUIStore.getState().setActiveView("chat");
  });

  test("a Settings page that refuses to be left keeps every slot and More act from running behind it", () => {
    useUIStore.getState().setActiveView("chat");
    useUIStore.getState().openPanel("settings");
    let pending: (() => void) | null = null;
    useUIStore.getState().setSettingsNavigationGuard((leave) => { pending = leave; });
    const view = render(<MobileTabBar />);
    fireEvent.click(view.getByRole("tab", { name: "Files" }));
    expect(useUIStore.getState().filePanelOpen, "Files waits for the guard").toBe(false);
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    fireEvent.click(view.getByRole("button", { name: /^Add a note/ }));
    expect(useUIStore.getState().addPanelOpen, "Add waits for the guard").toBe(false);
    expect(useUIStore.getState().settingsPanelOpen).toBe(true);
    // Consent: the guard clears itself and the latest navigation runs.
    useUIStore.getState().setSettingsNavigationGuard(null);
    act(() => pending!());
    expect(useUIStore.getState().settingsPanelOpen).toBe(false);
    expect(useUIStore.getState().addPanelOpen).toBe(true);
    view.unmount();
    useUIStore.getState().setActiveView("chat");
  });

  test("More prints the reason that applies: offline, or a running turn", () => {
    useUIStore.getState().setActiveView("chat");
    useConnectionStore.setState({ wsStatus: "connected" });
    const view = render(<MobileTabBar />);
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    let rows = [...view.getByRole("dialog", { name: "More" }).querySelectorAll('[role="button"]')].map((r) => r.textContent);
    // Connected and quiet: every act runs, and the effects stay printed.
    expect(rows).toEqual([
      "Settings", "Graph", "Add a noteWrite it down in the brain",
      "Daily briefingWhat happened since you lookedspends",
      "Sync the brainPull and push the repositorysync",
      "Brain statisticsDocuments and software versions",
    ]);
    fireEvent.click(view.getByRole("button", { name: /^Add a note/ }));
    expect(useUIStore.getState().addPanelOpen, "opening Add opens the form").toBe(true);
    act(() => { useChatStore.getState().addUserMessage(null, "Raft supplies"); useChatStore.getState().startAssistantMessage(null); });
    fireEvent.click(view.getByRole("tab", { name: "More" }));
    const sheet = view.getByRole("dialog", { name: "More" });
    rows = [...sheet.querySelectorAll('[role="button"]')].map((r) => r.textContent);
    // Streaming: Add still opens (REST), the agent acts say why they cannot.
    expect(rows).toEqual(["Settings", "Graph", "Add a noteWrite it down in the brain"]);
    expect(sheet.textContent).toContain("Daily briefinga turn is runningspends");
    expect(sheet.textContent).toContain("Sync the braina turn is runningsync");
    expect(sheet.textContent).toContain("Brain statisticsa turn is running");
    expect(sheet.textContent).not.toContain("needs the host");
    view.unmount();
    act(() => { useChatStore.getState().finishAssistantMessage(null); useChatStore.getState().clearMessages(); });
    useConnectionStore.setState({ wsStatus: "disconnected" });
    useUIStore.getState().setActiveView("chat");
  });

  test("a badge of ten or more reads 9+, and no inbox means no badge", () => {
    openDecisions(12);
    const many = render(<MobileTabBar />);
    // The badge is part of the accessible name, which is the point of it.
    expect(many.getByRole("tab", { name: "Actions 9+" }).textContent).toBe("Actions9+");
    many.unmount();
    openDecisions(0);
    useActivityStore.setState({ inbox: [{ id: "n" }] as never });
    const none = render(<MobileTabBar />);
    expect(none.getByRole("tab", { name: "Actions" }).textContent).toBe("Actions");
    none.unmount();
    useActivityStore.setState({ inbox: [] });
  });
});

/* ── S7: the desktop rail and the ⌘K palette ────────────────────────────── */

describe("SideRail on the kit SideRail", () => {
  test("D52's five destinations in one vertical tablist, the open-decision count as the badge, the socket as the status line", () => {
    openDecisions(2);
    const view = render(<SideRail />);
    const tabs = view.getAllByRole("tab");
    // The test window is 1024px wide, so the rail is expanded: label, badge
    // and printed ⌘ key are the row's text. Graph is no longer a destination.
    expect(tabs.map((t) => t.textContent)).toEqual(["Chat⌘1", "Sessions⌘2", "Actions2⌘3", "Files⌘4", "Settings⌘5"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(view.queryByRole("tab", { name: /Graph/ })).toBeNull();
    // Nothing the app cannot back: no spend meter.
    expect(view.container.textContent).not.toContain("$");
    // Disconnected is what the store starts as, and the rail says so.
    expect(view.container.textContent).toContain("offline");
    view.unmount();
    openDecisions(0);
  });

  test("the acts sit under the destinations with the palette's names, cost and reasons, and All commands is a real button", () => {
    const view = render(<SideRail />);
    const acts = view.getByRole("toolbar", { name: "Acts" });
    const buttons = Array.from(acts.querySelectorAll("button"));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Search the brain",
      "Add a note",
      "Daily briefing, spends, unavailable: needs the host",
    ]);
    // The briefing prints its cost and its reason at rest, not on hover.
    expect(buttons[2]!.textContent).toBe("Daily briefingspendsneeds the host");
    const all = view.getByRole("button", { name: "All commands" });
    expect(all.getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    expect(all.textContent).toContain("⌘K");
    view.unmount();
  });

  test("below 900px the rail collapses, each row keeps its name, and only the effect-free acts stay", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    try {
      const view = render(<SideRail />);
      const tabs = view.getAllByRole("tab");
      expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Chat", "Sessions", "Actions", "Files", "Settings"]);
      expect(tabs.map((t) => t.textContent)).toEqual(["", "", "", "", ""]);
      // The briefing is reached through All commands when collapsed (D52 §1).
      const acts = view.getByRole("toolbar", { name: "Acts" });
      expect(Array.from(acts.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual(["Search the brain", "Add a note"]);
      expect(view.getByRole("button", { name: "All commands" }).textContent).toBe("⌘K");
      view.unmount();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  test("a destination switches the view or opens its panel, and an open panel is the amber row", () => {
    const view = render(<SideRail />);
    const tab = (name: string) => view.getByRole("tab", { name: new RegExp(`^${name}`) });
    const selected = () => view.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
    fireEvent.click(tab("Actions"));
    expect(useUIStore.getState().activeView).toBe("activity");
    // Sessions opens the drawer in Chat, and is the amber row while it is open.
    fireEvent.click(tab("Sessions"));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);
    expect(selected()).toEqual([tab("Sessions")]);
    fireEvent.click(tab("Files"));
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(useUIStore.getState().sessionPanelOpen).toBe(false);
    expect(selected()).toEqual([tab("Files")]);
    // Graph is no destination: while it shows, no row is amber.
    act(() => useUIStore.getState().setActiveView("graph"));
    expect(selected()).toEqual([]);
    view.unmount();
  });

  test("⌘1–⌘5 (or Ctrl) reach Chat, Sessions, Actions, Files and Settings from anywhere; a bare digit does not", () => {
    const view = render(<SideRail />);
    act(() => useUIStore.getState().setActiveView("activity"));
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().sessionPanelOpen).toBe(true);
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(useUIStore.getState().sessionPanelOpen).toBe(false);
    // Actions draws no Files, so ⌘4 lands in Chat to show it (D52 N1).
    fireEvent.keyDown(window, { key: "4", metaKey: true });
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(useUIStore.getState().activeView).toBe("chat");
    fireEvent.keyDown(window, { key: "4", metaKey: true });
    expect(useUIStore.getState().filePanelOpen, "⌘4 again leaves Files open (D52 N3)").toBe(true);
    fireEvent.keyDown(window, { key: "1" });
    expect(useUIStore.getState().filePanelOpen).toBe(true);
    fireEvent.keyDown(window, { key: "5", metaKey: true });
    expect(useUIStore.getState().settingsPanelOpen).toBe(true);
    expect(useUIStore.getState().filePanelOpen, "Settings replaces Files").toBe(false);
    fireEvent.keyDown(window, { key: "5", metaKey: true });
    expect(useUIStore.getState().settingsPanelOpen, "⌘5 again leaves Settings open (D52 N3)").toBe(true);
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(useUIStore.getState().activeView).toBe("chat");
    // Nothing is bound past the five, so Graph has no chord.
    fireEvent.keyDown(window, { key: "6", metaKey: true });
    expect(useUIStore.getState().activeView).toBe("chat");
    view.unmount();
  });

  test("Search and Add open their panels in Chat even mid-turn; the briefing runs only when the host is quiet", () => {
    act(() => useUIStore.getState().setActiveView("activity"));
    const view = render(<SideRail />);
    const actButton = (name: RegExp) => view.getByRole("button", { name });
    // Disconnected: the briefing is a stop that says why and runs nothing.
    const briefing = actButton(/^Daily briefing/);
    expect(briefing.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(briefing);
    expect(useUIStore.getState().whatsupPanelOpen).toBe(false);
    expect(useUIStore.getState().activeView).toBe("activity");

    act(() => {
      useConnectionStore.setState({ wsStatus: "connected" });
      useChatStore.getState().startAssistantMessage(null);
    });
    expect(activeChat(useChatStore.getState()).isStreaming).toBe(true);
    expect(actButton(/^Daily briefing/).getAttribute("aria-label")).toBe("Daily briefing, spends, unavailable: a turn is running");
    // REST, so a running turn does not stop them; each lands in Chat.
    fireEvent.click(actButton(/^Search the brain/));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().searchPanelOpen).toBe(true);
    act(() => useUIStore.getState().setActiveView("activity"));
    fireEvent.click(actButton(/^Add a note/));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useUIStore.getState().addPanelOpen).toBe(true);

    act(() => useChatStore.getState().finishAssistantMessage(null));
    expect(actButton(/^Daily briefing/).getAttribute("aria-label")).toBe("Daily briefing, spends");
    fireEvent.click(actButton(/^Daily briefing/));
    expect(useUIStore.getState().whatsupPanelOpen).toBe(true);
    view.unmount();
  });

  test("unsaved Settings hold the acts and Sessions until the guard lets them leave, then they run", () => {
    useConnectionStore.setState({ wsStatus: "connected" });
    const view = render(<SideRail />);
    act(() => useUIStore.getState().openSettings("modules"));
    let leave: (() => void) | null = null;
    act(() => useUIStore.getState().setSettingsNavigationGuard((go) => { leave = go; }));
    const ui = () => useUIStore.getState();
    for (const run of [
      () => fireEvent.click(view.getByRole("button", { name: /^Search the brain/ })),
      () => fireEvent.click(view.getByRole("button", { name: /^Daily briefing/ })),
      () => fireEvent.keyDown(window, { key: "2", metaKey: true }),
    ]) {
      leave = null;
      run();
      // Nothing opens over Settings, and the briefing does not start, before consent.
      expect(leave, "the guard was asked").not.toBeNull();
      expect(ui().settingsPanelOpen).toBe(true);
      expect([ui().searchPanelOpen, ui().whatsupPanelOpen, ui().sessionPanelOpen]).toEqual([false, false, false]);
    }
    // Consent, as the modules tab gives it: clear the guard, then leave.
    act(() => { ui().setSettingsNavigationGuard(null); leave!(); });
    expect(ui().settingsPanelOpen).toBe(false);
    expect(ui().activeView).toBe("chat");
    expect(ui().sessionPanelOpen, "the held route completes").toBe(true);
    view.unmount();
  });

  test("All commands opens its own root's palette and no other mounted root's", () => {
    const a = createBrainUiRoot({ storage: null });
    const b = createBrainUiRoot({ storage: null });
    const view = render(
      <div>
        <div data-root="a"><BrainUiProvider root={a}><SideRail /><DesktopPalette /></BrainUiProvider></div>
        <div data-root="b"><BrainUiProvider root={b}><SideRail /><DesktopPalette /></BrainUiProvider></div>
      </div>
    );
    const inA = view.container.querySelector<HTMLElement>('[data-root="a"]')!;
    const allA = Array.from(inA.querySelectorAll("button")).find((el) => el.getAttribute("aria-keyshortcuts") === "Meta+K")!;
    allA.focus();
    fireEvent.click(allA);
    expect(a.stores.ui.getState().paletteOpen).toBe(true);
    expect(b.stores.ui.getState().paletteOpen).toBe(false);
    const dialogs = view.getAllByRole("dialog", { name: "Command palette" });
    expect(dialogs).toHaveLength(1);
    expect(inA.contains(dialogs[0]!)).toBe(true);
    // Focus enters the query, and esc hands it back to the button.
    expect(document.activeElement).toBe(dialogs[0]!.querySelector("input"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(allA);
    view.unmount();
    a.dispose();
    b.dispose();
  });
});

describe("DesktopPalette on the kit CommandPalette", () => {
  test("⌘K opens it with the query focused, typing filters, ⏎ runs the selected row and closes, esc closes", () => {
    const view = render(<DesktopPalette />);
    expect(view.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = view.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeTruthy();
    const names = view.getAllByRole("option").map((o) => o.textContent);
    // Jump to: the five destinations with their remapped keys, then Graph
    // with none, then New chat. Sessions is one row, not two (D52 §1).
    expect(names.slice(0, 7).map((n) => n?.replace(/⏎/g, ""))).toEqual([
      "Chat⌘1", "Sessions⌘2", "Actions⌘3", "Files⌘4", "Settings⌘5", "Graph", "New chat",
    ]);
    expect(names.filter((n) => n?.includes("Sessions"))).toHaveLength(1);
    // Every other route is still here, the rail's acts included.
    for (const label of ["Search the brain", "Brain statistics", "Sync the brain", "Daily briefing", "Add a note"]) {
      expect(names.some((n) => n?.includes(label))).toBe(true);
    }
    // Disconnected: Sync, the briefing and stats are listed DISABLED with the
    // reason, never omitted (D37).
    const sync = view.getByRole("option", { name: /Sync the brain/ });
    expect(sync.getAttribute("aria-disabled")).toBe("true");
    expect(sync.textContent).toContain("needs the host");
    expect(sync.getAttribute("tabindex")).toBeNull();
    // The query is a real input, and it holds focus on open.
    const input = view.getByRole("combobox") as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    changeControlledInput(input, "gr");
    expect(view.getAllByRole("option").map((o) => o.textContent)).toEqual(["Graph⏎"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUIStore.getState().activeView).toBe("graph");
    expect(view.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    // The query was reset with the close.
    expect(view.getAllByRole("option").length).toBeGreaterThan(7);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    view.unmount();
  });

  test("⌘K again, or a click on the scrim, closes it and hands focus back to what held it", () => {
    const view = render(<div><button type="button">before</button><DesktopPalette /></div>);
    const before = view.getByRole("button", { name: "before" });
    before.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(view.getByRole("combobox"));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(before);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const scrim = view.getByRole("dialog").closest(".fixed")!;
    fireEvent.mouseDown(scrim);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(before);
    view.unmount();
  });

  test("with the socket live and no turn streaming, Sync carries its effect chip in its name", () => {
    useConnectionStore.setState({ wsStatus: "connected" });
    // Both halves of the precondition, stated. `why` in desktop-routes.ts
    // needs `connected` AND `!isStreaming`, and this test used to set only the
    // first — so it passed on whatever the previous test left behind. The
    // afterEach above now clears the chat store, and this asserts the state
    // the title claims rather than trusting it.
    expect(activeChat(useChatStore.getState()).isStreaming).toBe(false);
    const view = render(<DesktopPalette />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(view.getByRole("option", { name: "Sync the brain, sync" }).getAttribute("aria-disabled")).not.toBe("true");
    expect(view.getByRole("option", { name: /Daily briefing/ }).textContent).toContain("spends");
    fireEvent.click(view.getByRole("option", { name: /Daily briefing/ }));
    expect(useUIStore.getState().whatsupPanelOpen).toBe(true);
    expect(view.queryByRole("dialog")).toBeNull();
    view.unmount();
  });
});

/* ── D36: single-key shortcuts, focus-scoped ────────────────────────────── */

describe("single-key shortcuts (D36)", () => {
  function pending(id: string, name = "Bash"): ToolCall {
    return {
      id,
      name,
      input: { command: "ls" },
      inputJson: '{"command":"ls"}',
      status: "pending_approval",
      approvalKind: "command",
    } as ToolCall;
  }

  function Harness({ calls, onApproval }: { calls: ToolCall[]; onApproval: (id: string, ok: boolean, always?: boolean) => void }) {
    return (
      <div>
        <ToolCallTimeline toolCalls={calls} onApproval={onApproval} />
        <textarea data-composer="" aria-label="composer" />
      </div>
    );
  }

  test("a and d decide the approval card that holds focus, and the keys are printed on its buttons", () => {
    const decided: unknown[] = [];
    const view = render(<Harness calls={[pending("t1")]} onApproval={(...a) => decided.push(a)} />);
    const card = view.getByRole("group", { name: "Approval: Bash" });
    expect(view.getByRole("button", { name: /^Allow/ }).textContent).toBe("Allowa");
    expect(view.getByRole("button", { name: /^Deny/ }).textContent).toBe("Denyd");

    // Bare letters elsewhere do nothing: the scope is the card.
    fireEvent.keyDown(document.body, { key: "a" });
    expect(decided).toEqual([]);

    card.focus();
    fireEvent.keyDown(card, { key: "a", metaKey: true });
    expect(decided).toEqual([]);
    fireEvent.keyDown(card, { key: "d" });
    expect(decided).toEqual([["t1", false, undefined]]);
    // The last pending card hands focus to the composer.
    expect(document.activeElement).toBe(view.getByLabelText("composer"));
    view.unmount();
  });

  test("deciding one of two cards hands focus to the next one, not the top of the document", () => {
    const view = render(<Harness calls={[pending("t1"), pending("t2", "Write")]} onApproval={() => {}} />);
    const first = view.getByRole("group", { name: "Approval: Bash" });
    first.focus();
    fireEvent.keyDown(first, { key: "a" });
    expect(document.activeElement).toBe(view.getByRole("group", { name: "Approval: Write" }));
    view.unmount();
  });

  test("the Settings switch turns the letters off and the printed keys go with them", () => {
    const decided: unknown[] = [];
    const view = render(
      <>
        <ShortcutSwitch />
        <Harness calls={[pending("t1")]} onApproval={(...a) => decided.push(a)} />
      </>
    );
    const toggle = view.getByRole("switch", { name: /Single-key shortcuts/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(useUIStore.getState().singleKeyShortcuts).toBe(false);
    expect(view.getByRole("button", { name: /^Allow/ }).textContent).toBe("Allow");
    const card = view.getByRole("group", { name: "Approval: Bash" });
    card.focus();
    fireEvent.keyDown(card, { key: "a" });
    expect(decided).toEqual([]);
    // The buttons still work; only the letters are off.
    fireEvent.click(view.getByRole("button", { name: /^Allow/ }));
    expect(decided).toEqual([["t1", true, undefined]]);
    useUIStore.getState().setSingleKeyShortcuts(true);
    view.unmount();
  });

  test("the preference persists under the root's storage prefix", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    } as unknown as Storage;
    const env = { storage: () => storage, storageKey: (k: string) => `t:${k}` };
    const first = createUIStore(env);
    expect(first.getState().singleKeyShortcuts).toBe(true);
    first.getState().setSingleKeyShortcuts(false);
    expect(backing.get("t:brain-single-key-shortcuts")).toBe("off");
    expect(createUIStore(env).getState().singleKeyShortcuts).toBe(false);
  });

  test("j and k move inside the inbox, d dismisses the focused card and focus moves on", async () => {
    const calls = installActivityFetch((url) => {
      if (url.includes("/activity/inbox") && !url.includes("/ack")) {
        return Response.json({
          intents: [1, 2].map((n) => ({
            id: n,
            runId: `run-${n}`,
            spanId: null,
            kind: "failure",
            tag: "t",
            title: `Intent ${n}`,
            body: "",
            status: "pending",
            acknowledged: false,
            createdAt: Date.now(),
          })),
        });
      }
      return undefined;
    });
    const page = render(<ActivityPage />);
    await act(flushPromises);
    const cards = page.getAllByRole("button", { name: /Intent \d/ });
    expect(cards).toHaveLength(2);
    expect(page.getAllByRole("button", { name: "Dismiss · d" })).toHaveLength(2);
    expect(page.getByText("j / k move · d dismiss · ⏎ open")).toBeTruthy();

    cards[0]!.focus();
    fireEvent.keyDown(cards[0]!, { key: "j" });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1]!, { key: "j" });
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.keyDown(cards[0]!, { key: "k" });
    expect(document.activeElement).toBe(cards[1]);

    fireEvent.keyDown(cards[1]!, { key: "d" });
    await act(flushPromises);
    expect(useActivityStore.getState().inbox.map((i) => i.id)).toEqual([1]);
    expect(calls.some((url) => url.includes("/activity/inbox/2/ack") || url.includes("inbox") && url.includes("2"))).toBe(true);
    expect(document.activeElement).toBe(page.getByRole("button", { name: /Intent 1/ }));

    fireEvent.keyDown(document.activeElement!, { key: "d" });
    await act(flushPromises);
    expect(useActivityStore.getState().inbox).toEqual([]);
    // The drained section becomes the empty state and its heading takes
    // focus (D37) — never the document top. No receipt: dismissal without
    // undo is silent (sixth pass §4), the row leaving is the receipt.
    expect(document.activeElement).toBe(page.getByRole("heading", { name: "Nothing is waiting on you" }));
    expect(page.queryByText("Dismissed")).toBeNull();
    expect(page.queryByText("Intent 1")).toBeNull();
    page.unmount();
  });
});

/* ── #86: printed keys follow the pointer, the bindings do not ──────────── */

describe("printed keys follow the pointer (#86)", () => {
  const FINE = "(any-pointer: fine)";
  /** A `matchMedia` that answers the pointer query as given and every other query for real. */
  function withPointer<T>(fine: boolean, run: () => T): T {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) =>
      q === FINE ? { matches: fine, media: q, addEventListener() {}, removeEventListener() {} } : real.call(window, q)) as never;
    try {
      return run();
    } finally {
      window.matchMedia = real;
    }
  }
  function pending(id: string): ToolCall {
    return { id, name: "Bash", input: { command: "ls" }, inputJson: '{"command":"ls"}', status: "pending_approval", approvalKind: "command" } as ToolCall;
  }

  test("useFinePointer reports (any-pointer: fine) live and re-renders when it flips", () => {
    const real = window.matchMedia;
    let listener: ((e: { matches: boolean }) => void) | undefined;
    const removed: string[] = [];
    // One list per query, as a browser keeps one: the hook reads `matches`
    // off the list it subscribed to when the change event arrives.
    const list = {
      matches: true,
      media: FINE,
      addEventListener(_: string, fn: typeof listener) { listener = fn; },
      removeEventListener(type: string) { removed.push(type); },
    };
    window.matchMedia = ((q: string) => (q === FINE ? list : { matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    try {
      const hook = renderHook(() => useFinePointer());
      expect(hook.result.current).toBe(true);
      // Unpairing the mouse: the list flips and the subscriber re-renders.
      list.matches = false;
      act(() => listener!({ matches: false }));
      expect(hook.result.current).toBe(false);
      list.matches = true;
      act(() => listener!({ matches: true }));
      expect(hook.result.current).toBe(true);
      hook.unmount();
      expect(removed).toEqual(["change"]);
    } finally {
      window.matchMedia = real;
    }
  });

  test("with no matchMedia the pointer reads fine (fail open) while a width query still reads false", () => {
    const real = window.matchMedia;
    window.matchMedia = undefined as never;
    try {
      const fine = renderHook(() => useFinePointer());
      expect(fine.result.current).toBe(true);
      const wide = renderHook(() => useMediaQuery("(min-width: 900px)"));
      expect(wide.result.current).toBe(false);
      fine.unmount();
      wide.unmount();
    } finally {
      window.matchMedia = real;
    }
  });

  test("a coarse-only pointer drops the rail's and the palette's ⌘n caps and keeps ⌘1–⌘5 working", () => {
    withPointer(false, () => {
      const view = render(<div><SideRail /><DesktopPalette /></div>);
      // Still expanded (the width query is real and the window is 1024px),
      // so the row's text is the label alone — no key to a finger.
      expect(view.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Chat", "Sessions", "Actions", "Files", "Settings"]);
      expect(view.container.textContent).not.toMatch(/⌘[1-5]/);
      // All commands prints ⌘K on every pointer (D36 addendum).
      expect(view.getByRole("button", { name: "All commands" }).textContent).toContain("⌘K");
      // Tapped open, the palette prints no destination chord either.
      fireEvent.click(view.getByRole("button", { name: "All commands" }));
      expect(view.getAllByRole("option").slice(0, 5).map((o) => o.textContent?.replace("⏎", ""))).toEqual(["Chat", "Sessions", "Actions", "Files", "Settings"]);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      fireEvent.keyDown(window, { key: "4", metaKey: true });
      expect(useUIStore.getState().filePanelOpen).toBe(true);
      view.unmount();
    });
    useUIStore.getState().setActiveView("chat");
  });

  test("a coarse-only pointer drops the a / d caps on the transcript's approval buttons, and the letters still decide", () => {
    const decided: unknown[] = [];
    withPointer(false, () => {
      const view = render(
        <div>
          <ToolCallTimeline toolCalls={[pending("t1")]} onApproval={(...a) => decided.push(a)} />
          <textarea data-composer="" aria-label="composer" />
        </div>
      );
      expect(view.getByRole("button", { name: /^Allow/ }).textContent).toBe("Allow");
      expect(view.getByRole("button", { name: /^Deny/ }).textContent).toBe("Deny");
      const card = view.getByRole("group", { name: "Approval: Bash" });
      card.focus();
      fireEvent.keyDown(card, { key: "a" });
      expect(decided).toEqual([["t1", true, undefined]]);
      view.unmount();
    });
  });

  test("the Actions-pane approval card prints a / d only with a fine pointer, and the letters still decide without one", () => {
    const fine = render(<ApprovalCard tool={pending("t1")} origin="this conversation" keys onDecide={() => {}} />);
    expect(fine.container.textContent).toContain("allow a");
    expect(fine.container.textContent).toContain("deny d");
    fine.unmount();

    const decided: unknown[] = [];
    withPointer(false, () => {
      const view = render(<ApprovalCard tool={pending("t1")} origin="this conversation" keys onDecide={(...a) => decided.push(a)} />);
      expect(view.container.textContent).not.toContain("allow a");
      expect(view.container.textContent).not.toContain("deny d");
      const card = view.getByRole("group", { name: "Approval: Bash" });
      card.focus();
      fireEvent.keyDown(card, { key: "d" });
      expect(decided).toEqual([[false, undefined]]);
      view.unmount();
    });
  });

  test("the Actions pane prints its j / k / d keys only with a fine pointer, and they still act without one (#100)", async () => {
    installActivityFetch((url) => {
      if (url.includes("/activity/inbox") && !url.includes("/ack")) {
        return Response.json({
          intents: [1, 2, 3].map((n) => ({
            id: n,
            runId: `run-${n}`,
            spanId: null,
            kind: "failure",
            tag: "t",
            title: `Intent ${n}`,
            body: "",
            status: "pending",
            acknowledged: false,
            createdAt: Date.now(),
          })),
        });
      }
      return undefined;
    });
    // Async, so the pointer is swapped by hand rather than through `withPointer`,
    // whose finally would restore it before the page's effects settle.
    // One live list for the pointer query, so the test can pair a trackpad
    // mid-session and watch the page follow it.
    const real = window.matchMedia;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const pointer = {
      matches: false,
      media: FINE,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => void listeners.delete(fn),
    };
    window.matchMedia = ((q: string) => (q === FINE ? pointer : real.call(window, q))) as never;
    try {
      const page = render(<ActivityPage />);
      await act(flushPromises);
      const cards = page.getAllByRole("button", { name: /Intent \d/ });
      expect(cards).toHaveLength(3);
      // Neither footer (the below-laptop line nor the laptop column's), and
      // no card carries its "· d" hint.
      expect(page.container.textContent).not.toContain("j / k move");
      expect(page.queryAllByRole("button", { name: "Dismiss · d" })).toHaveLength(0);
      expect(page.getAllByRole("button", { name: "Dismiss" })).toHaveLength(3);

      // The bindings are the keyboard's, not the pointer's: they still act.
      cards[0]!.focus();
      fireEvent.keyDown(cards[0]!, { key: "j" });
      expect(document.activeElement).toBe(cards[1]);
      fireEvent.keyDown(cards[1]!, { key: "k" });
      expect(document.activeElement).toBe(cards[0]);
      fireEvent.keyDown(cards[0]!, { key: "d" });
      await act(flushPromises);
      expect(useActivityStore.getState().inbox.map((i) => i.id)).toEqual([2, 3]);

      // A trackpad arrives: all three print again, exactly as D36 draws them.
      pointer.matches = true;
      act(() => listeners.forEach((fn) => fn({ matches: true })));
      expect(page.getByText("j / k move · d dismiss · ⏎ open")).toBeTruthy();
      expect(page.getByText("j / k move · d dismiss")).toBeTruthy();
      expect(page.getAllByRole("button", { name: "Dismiss · d" })).toHaveLength(2);

      // And the pointer never overrides the switch: with single-key shortcuts
      // off, a fine pointer prints nothing either.
      act(() => useUIStore.getState().setSingleKeyShortcuts(false));
      expect(page.container.textContent).not.toContain("j / k move");
      expect(page.queryAllByRole("button", { name: "Dismiss · d" })).toHaveLength(0);
      page.unmount();
    } finally {
      window.matchMedia = real;
      useUIStore.getState().setSingleKeyShortcuts(true);
    }
  });

  test("the search and add panels print their key hints only with a fine pointer", () => {
    const search = render(<SearchPanel open onClose={() => {}} />);
    expect(search.getByText(/to pick/).textContent).toContain("to open");
    expect(search.container.querySelectorAll("kbd").length).toBeGreaterThan(0);
    search.unmount();

    const draft = { content: "Remember", title: "", type: "", tags: "" };
    const onSave = mock(() => {});
    const form = () => (
      <AddForm state="editing" draft={draft} knownTypes={[]} error="" savedPath="" indexed={undefined} indexing={false} contentRef={{ current: null }} onDraft={() => {}} onSave={onSave} onRetryIndex={() => {}} onAddAnother={() => {}} onClose={() => {}} />
    );
    const add = render(form());
    expect(add.container.textContent).toContain("to save");
    add.unmount();

    withPointer(false, () => {
      const touchSearch = render(<SearchPanel open onClose={() => {}} />);
      expect(touchSearch.getByText(/Type at least 2 characters/)).toBeTruthy();
      expect(touchSearch.container.textContent).not.toContain("to pick");
      expect(touchSearch.container.querySelectorAll("kbd")).toHaveLength(0);
      touchSearch.unmount();

      const touchAdd = render(form());
      expect(touchAdd.container.textContent).not.toContain("to save");
      expect(touchAdd.container.querySelectorAll("kbd")).toHaveLength(0);
      // The binding is untouched: Ctrl+↵ still saves.
      fireEvent.keyDown(touchAdd.getByPlaceholderText("idea, reading"), { key: "Enter", ctrlKey: true });
      expect(onSave).toHaveBeenCalledTimes(1);
      touchAdd.unmount();
    });
  });
});

/* ── D37: the desktop panes (the test window is 1024px, so `laptop:` shapes render) ── */

describe("desktop panes (D37)", () => {
  test("Settings is a pane with a section column; Appearance & input holds the theme and the switch", () => {
    const onClose = mock(() => {});
    const view = render(<SettingsPanel open onClose={onClose} />);
    const tabs = view.getAllByRole("tab").map((t) => t.getAttribute("aria-label") ?? t.textContent);
    expect(tabs).toEqual(["Appearance & input", "Models", "Skills", "Modules", "Security", "Devices & agents"]);
    fireEvent.click(view.getByRole("tab", { name: "Appearance & input" }));
    expect(useUIStore.getState().settingsTab).toBe("appearance");
    expect(view.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(view.getByRole("switch", { name: "Single-key shortcuts" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("Files is three panes: the tree, the reading pane with its close, and nothing invented in the rail", async () => {
    const onClose = mock(() => {});
    globalThis.fetch = (async () => Response.json({ entries: [] })) as unknown as typeof fetch;
    const view = render(<FilePanel open onClose={onClose} />);
    await act(flushPromises);
    const pane = view.getByRole("dialog", { name: "Files" });
    expect(pane.textContent).toContain("Files");
    expect(pane.textContent).toContain("j / k move · ← → fold · ⏎ open");
    // The design's backlinks and provenance have no data behind them: not drawn.
    expect(pane.textContent).not.toContain("Linked from");
    expect(pane.textContent).not.toContain("Provenance");
    // The rail column is mounted with no file open (sixth pass §3a), empty.
    expect(view.getByRole("complementary", { name: "Evidence" }).textContent).toBe("");
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("Actions is a list beside a detail pane that asks for a run until one is picked", async () => {
    installActivityFetch();
    const page = render(<ActivityPage />);
    await act(flushPromises);
    expect(page.getByRole("region", { name: "Actions queue" })).toBeTruthy();
    expect(page.getByText("Pick a run")).toBeTruthy();
    act(() => setHash("#/activity/run%20one"));
    await act(flushPromises);
    expect(page.queryByText("Pick a run")).toBeNull();
    expect(page.getByRole("heading", { name: "run one" })).toBeTruthy();
    page.unmount();
  });
});

describe("theme preference", () => {
  test("the toggle writes the choice to the store and AppShell's effect writes it to <html>", () => {
    function Shell() {
      useApplyTheme();
      return <ThemeToggle />;
    }
    const view = render(<Shell />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    const radios = view.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["System", "Paper", "Dark"]);
    fireEvent.click(view.getByRole("radio", { name: "Paper" }));
    expect(useUIStore.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(view.getByRole("radio", { name: "Paper" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(view.getByRole("radio", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBe("system");
    view.unmount();
  });

  test("a root persists the preference under its own storage prefix and restores it", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    } as unknown as Storage;
    const env = { storage: () => storage, storageKey: (k: string) => `t:${k}` };
    const first = createUIStore(env);
    expect(first.getState().theme).toBe("dark");
    first.getState().setTheme("light");
    expect(backing.get("t:brain-theme")).toBe("light");
    // A second root on the same storage sees the choice; garbage does not count.
    expect(createUIStore(env).getState().theme).toBe("light");
    backing.set("t:brain-theme", "neon");
    expect(createUIStore(env).getState().theme).toBe("dark");
    // No storage at all (SSR, stories) is fine and stays dark.
    expect(createUIStore().getState().theme).toBe("dark");
  });
});

/* ── S6: the push view renders from props alone ─────────────────────────── */

describe("PushSwitch", () => {
  test("three states: a named switch, a blocked explanation, an unsupported explanation", () => {
    const onToggle = mock(() => {});
    const off = render(<PushSwitch state="unsubscribed" busy={false} onToggle={onToggle} />);
    const sw = off.getByRole("switch", { name: "Push notifications" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledTimes(1);
    off.unmount();

    const on = render(<PushSwitch state="subscribed" busy={true} onToggle={onToggle} />);
    const busy = on.getByRole("switch", { name: "Push notifications" });
    expect(busy.getAttribute("aria-checked")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(onToggle).toHaveBeenCalledTimes(1);
    on.unmount();

    const blocked = render(<PushSwitch state="blocked" busy={false} onToggle={onToggle} />);
    expect(blocked.queryByRole("switch")).toBeNull();
    expect(blocked.getByText("Blocked in browser settings")).toBeTruthy();
    blocked.unmount();

    const none = render(<PushSwitch state="unsupported" busy={false} onToggle={onToggle} />);
    expect(none.queryByRole("switch")).toBeNull();
    expect(none.getByText("No push here")).toBeTruthy();
    none.unmount();
  });
});

describe("LoginForm", () => {
  test("renders the methods it is given and reports every intent through props", () => {
    const onPassword = mock(() => {}); const onPasskey = mock(() => {}); const onPasswordChange = mock(() => {});
    const both = render(
      <LoginForm appName="Example brain" methods={{ password: true, passkey: true }} password="" busy={false} error={null}
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(both.getByRole("heading", { name: "Example brain" })).toBeTruthy();
    expect(both.getByText("Use your passkey or enter the password.")).toBeTruthy();
    // No password typed: sign-in is dimmed and inert, the passkey route is live.
    expect(both.getByRole("button", { name: "Sign in" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(both.getByRole("button", { name: "Sign in" }));
    expect(onPassword).not.toHaveBeenCalled();
    fireEvent.click(both.getByRole("button", { name: "Sign in with a passkey" }));
    expect(onPasskey).toHaveBeenCalledTimes(1);
    changeControlledInput(both.getByPlaceholderText("Password") as HTMLInputElement, "x");
    expect(onPasswordChange).toHaveBeenCalledWith("x");
    both.unmount();

    const typed = render(
      <LoginForm appName="Example brain" methods={{ password: true, passkey: false }} password="secret" busy={false} error="Wrong password"
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(typed.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
    expect(typed.getByRole("alert").textContent).toContain("Wrong password");
    fireEvent.click(typed.getByRole("button", { name: "Sign in" }));
    expect(onPassword).toHaveBeenCalledTimes(1);
    // Enter in the field submits the form, which is the same intent.
    fireEvent.submit(typed.getByPlaceholderText("Password").closest("form")!);
    expect(onPassword).toHaveBeenCalledTimes(2);
    typed.unmount();

    const only = render(
      <LoginForm appName="Example brain" methods={{ password: false, passkey: true }} password="" busy={true} error={null}
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(only.queryByPlaceholderText("Password")).toBeNull();
    expect(only.getByText("Sign in with your passkey.")).toBeTruthy();
    expect(only.getByRole("button", { name: "Sign in with a passkey" }).getAttribute("aria-disabled")).toBe("true");
    only.unmount();

    const none = render(
      <LoginForm appName="Example brain" methods={{ password: false, passkey: false }} password="" busy={false} error={null}
        onPasswordChange={onPasswordChange} onPassword={onPassword} onPasskey={onPasskey} />,
    );
    expect(none.getByText(/Password login is disabled/)).toBeTruthy();
    none.unmount();
  });
});

/* ── S6: the web-search chain renders from props alone ──────────────────── */

describe("WebSearchChain", () => {
  const provider = (over: Record<string, unknown>) => ({
    id: "search", label: "Search", enabled: false, hasKeyField: true, keyConfigured: false, keyFromEnv: false,
    keyless: false, costNote: "Free", blurb: "Search provider", ...over,
  });
  const handlers = () => ({
    onToggle: mock((_id: string) => {}), onToggleKey: mock((_id: string) => {}), onKeyDraft: mock((_v: string) => {}),
    onSaveKey: mock((_id: string) => {}), onClearKey: mock((_id: string) => {}), onClearOverride: mock(() => {}),
  });

  test("a keyless provider that is off cannot be switched on; one that is on can always be switched off", () => {
    const h = handlers();
    const config = { configured: true, order: ["paid"], overriddenBy: null, appliesTo: ["pi-1"], providers: [
      provider({ id: "free", label: "Free search", keyless: true }),
      provider({ id: "paid", label: "Paid search", enabled: true, costNote: "Paid" }),
      provider({ id: "bare", label: "Bare search" }),
    ] };
    const view = render(<WebSearchChain config={config} busy={false} error={null} openKey={null} keyDraft="" savedFlash={false} {...h} />);
    expect(view.getByText(/Applies to/).textContent).toContain("pi-1");
    expect(view.getByText("Order:").parentElement?.textContent).toContain("Paid search");
    const free = view.getByRole("switch", { name: "Enable Free search for web search" });
    expect(free.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(free);
    expect(h.onToggle).toHaveBeenCalledWith("free");
    const paid = view.getByRole("switch", { name: "Enable Paid search for web search" });
    expect(paid.getAttribute("aria-checked")).toBe("true");
    expect(paid.getAttribute("aria-disabled")).toBeNull();
    const bare = view.getByRole("switch", { name: "Enable Bare search for web search" });
    expect(bare.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(bare);
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getAllByRole("button", { name: "Needs key" })[0]);
    expect(h.onToggleKey).toHaveBeenCalledWith("free");
    view.unmount();
  });

  test("the open key editor saves and clears by provider, and the override warning clears the pin", () => {
    const h = handlers();
    const config = { configured: true, order: [], overriddenBy: "pinned-search", appliesTo: [], providers: [
      provider({ keyConfigured: true, enabled: true }),
    ] };
    const view = render(<WebSearchChain config={config} busy={false} error="Could not save" openKey="search" keyDraft="new-key" savedFlash={false} {...h} />);
    expect(view.getByText("Could not save")).toBeTruthy();
    expect(view.getByRole("button", { name: "Key stored" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(h.onSaveKey).toHaveBeenCalledWith("search");
    fireEvent.click(view.getByRole("button", { name: "Clear" }));
    expect(h.onClearKey).toHaveBeenCalledWith("search");
    fireEvent.click(view.getByRole("button", { name: "Use the chain instead" }));
    expect(h.onClearOverride).toHaveBeenCalledTimes(1);
    changeControlledInput(view.getByLabelText("API key") as HTMLInputElement, "typed");
    expect(h.onKeyDraft).toHaveBeenCalledWith("typed");
    view.unmount();

    const busy = render(<WebSearchChain config={config} busy={true} error={null} openKey="search" keyDraft="new-key" savedFlash={false} {...h} />);
    expect(busy.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
    expect(busy.getByRole("button", { name: "Clear" }).getAttribute("aria-disabled")).toBe("true");
    expect(busy.getByRole("button", { name: "Use the chain instead" }).getAttribute("aria-disabled")).toBe("true");
    busy.unmount();
  });
});

/* ── S6: the passkey list renders from props alone ──────────────────────── */

describe("PasskeyList", () => {
  const cred = (over: Partial<PasskeySummary>): PasskeySummary => ({
    id: "k1", label: "Laptop", rpId: "brain.local", createdAt: 1, lastUsedAt: null, backedUp: false,
    deviceType: "singleDevice", transports: [], aaguid: null, ...over,
  });
  const handlers = () => ({ onAdd: mock(() => {}), onRename: mock((_id: string, _l: string) => {}), onDelete: mock((_id: string) => {}), onSignOut: mock(() => {}) });

  test("status decides the list, the empty state and whether Add is offered", () => {
    const h = handlers();
    const loading = render(<PasskeyList credentials={[]} status="loading" busy={false} error={null} supported hostname="brain.local" {...h} />);
    expect(loading.queryByText("No passkeys yet.")).toBeNull();
    loading.unmount();

    const empty = render(<PasskeyList credentials={[]} status="ready" busy={false} error={null} supported hostname="brain.local" {...h} />);
    expect(empty.getByText("No passkeys yet.")).toBeTruthy();
    fireEvent.click(empty.getByRole("button", { name: "Add a passkey" }));
    expect(h.onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(empty.getByRole("button", { name: "Sign out everywhere" }));
    expect(h.onSignOut).toHaveBeenCalledTimes(1);
    empty.unmount();

    const off = render(<PasskeyList credentials={[]} status="unavailable" busy={false} error="boom" supported hostname="brain.local" {...h} />);
    expect(off.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(off.getByText(/password auth mode/)).toBeTruthy();
    expect(off.getByRole("alert").textContent).toBe("boom");
    off.unmount();

    const noWebAuthn = render(<PasskeyList credentials={[]} status="ready" busy={false} error={null} supported={false} hostname="brain.local" {...h} />);
    expect(noWebAuthn.getByText(/does not support passkeys/)).toBeTruthy();
    noWebAuthn.unmount();
  });

  test("rows rename by id, remove by id, and badge a credential from another host", () => {
    const h = handlers();
    const view = render(
      <PasskeyList credentials={[cred({}), cred({ id: "k2", label: "Phone", rpId: "other.example", backedUp: true })]} status="ready" busy={true} error={null} supported hostname="brain.local" {...h} />,
    );
    expect(view.getByRole("button", { name: "Adding a passkey…" }).getAttribute("aria-disabled")).toBe("true");
    expect(view.getByText("other.example")).toBeTruthy();
    expect(view.getByText("synced")).toBeTruthy();
    expect(view.queryByText("brain.local")).toBeNull();
    fireEvent.click(view.getAllByTitle("Remove")[1]);
    expect(h.onDelete).toHaveBeenCalledWith("k2");
    fireEvent.click(view.getAllByTitle("Rename")[0]);
    changeControlledInput(view.getByLabelText("Passkey name") as HTMLInputElement, "Desk");
    fireEvent.click(view.getByTitle("Save"));
    expect(h.onRename).toHaveBeenCalledWith("k1", "Desk");
    view.unmount();
  });
});

/* ── S6: the skills list and editor render from props alone ─────────────── */

describe("SkillsList and SkillEditor", () => {
  const entry = (name: string, over: Partial<SkillEntry> = {}): SkillEntry => ({ name, description: `${name} description`, source: "custom", enabled: true, ...over });
  const handlers = () => ({
    onNewName: mock((_v: string) => {}), onCreate: mock(() => {}), onGithubSource: mock((_v: string) => {}), onOverwrite: mock((_v: boolean) => {}),
    onInstallZip: mock((_f: File) => {}), onInstallGitHub: mock(() => {}), onOpen: mock((_s: SkillEntry) => {}), onToggle: mock((_s: SkillEntry) => {}), onRemove: mock((_s: SkillEntry) => {}),
  });

  test("the list names the skill every row control is about, and gates on busy", () => {
    const h = handlers();
    const skills = [entry("alpha"), entry("beta", { enabled: false, warning: "no description" }), entry("shipped", { source: "builtin" })];
    const view = render(
      <SkillsList skills={skills} busy={null} installing={false} error={null} warning={null} outcomes={[{ name: "x", status: "installed", files: 2 }, { name: "y", status: "skipped", reason: "exists" }]}
        newName="new-one" githubSource="" overwrite={false} {...h} />,
    );
    expect(view.getByText("disabled")).toBeTruthy();
    expect(view.getByText("⚠ no description")).toBeTruthy();
    expect(view.getByText(/x installed \(2 files\)/)).toBeTruthy();
    expect(view.getByText(/y — exists/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    expect(h.onCreate).toHaveBeenCalledTimes(1);
    // Install needs a source: the button is inert until one is typed.
    expect(view.getByRole("button", { name: "Install" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(view.getAllByTitle("Edit SKILL.md")[1]);
    expect(h.onOpen).toHaveBeenLastCalledWith(skills[1]);
    fireEvent.click(view.getByTitle("Enable"));
    expect(h.onToggle).toHaveBeenLastCalledWith(skills[1]);
    fireEvent.click(view.getAllByTitle("Delete permanently")[0]);
    expect(h.onRemove).toHaveBeenLastCalledWith(skills[0]);
    fireEvent.click(view.getByRole("button", { name: "View" }));
    expect(h.onOpen).toHaveBeenLastCalledWith(skills[2]);
    view.unmount();

    const busy = render(
      <SkillsList skills={[entry("alpha")]} busy="alpha" installing={true} error="failed" warning="careful" outcomes={null}
        newName="" githubSource="example/skills" overwrite={true} {...h} />,
    );
    expect(busy.getByText("failed")).toBeTruthy();
    expect(busy.getByText("careful")).toBeTruthy();
    expect((busy.getByTitle("Edit SKILL.md") as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getByRole("button", { name: "Install" }).getAttribute("aria-disabled")).toBe("true");
    expect(busy.getByRole("button", { name: "Create" }).getAttribute("aria-disabled")).toBe("true");
    busy.unmount();

    const empty = render(<SkillsList skills={[]} busy={null} installing={false} error={null} warning={null} outcomes={null} newName="" githubSource="a/b" overwrite={false} {...h} />);
    expect(empty.getByText("No custom skills yet.")).toBeTruthy();
    fireEvent.click(empty.getByRole("button", { name: "Install" }));
    expect(h.onInstallGitHub).toHaveBeenCalledTimes(1);
    empty.unmount();
  });

  test("the editor edits, saves and closes; a built-in is read-only with no Save", () => {
    const onChange = mock((_c: string) => {}); const onSave = mock(() => {}); const onClose = mock(() => {});
    const view = render(<SkillEditor name="alpha" content="# alpha" isNew={false} readOnly={false} saving={false} error={null} onChange={onChange} onSave={onSave} onClose={onClose} />);
    changeControlledInput(view.getByLabelText("SKILL.md") as HTMLInputElement, "# alpha\nmore");
    expect(onChange).toHaveBeenCalledWith("# alpha\nmore");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();

    const ro = render(<SkillEditor name="shipped" content="# shipped" isNew={false} readOnly saving={false} error="nope" onChange={onChange} onSave={onSave} onClose={onClose} />);
    expect(ro.queryByRole("button", { name: "Save" })).toBeNull();
    expect(ro.getByText("built-in · read-only")).toBeTruthy();
    expect((ro.getByLabelText("SKILL.md") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(ro.getByText("nope")).toBeTruthy();
    ro.unmount();

    const saving = render(<SkillEditor name="new" content="" isNew readOnly={false} saving error={null} onChange={onChange} onSave={onSave} onClose={onClose} />);
    expect(saving.getByText("New skill")).toBeTruthy();
    expect(saving.getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe("true");
    saving.unmount();
  });
});

/* ── S6: the add form and the stream views render from props alone ──────── */

describe("AddForm", () => {
  const draft = { content: "", title: "", type: "", tags: "" };
  const handlers = () => ({ onDraft: mock((_p: Partial<typeof draft>) => {}), onSave: mock(() => {}), onRetryIndex: mock(() => {}), onAddAnother: mock(() => {}), onClose: mock(() => {}) });
  const ref = { current: null };

  test("the form gates Add on content, saves on Ctrl+Enter, and shows the error banner", () => {
    const h = handlers();
    const empty = render(<AddForm state="editing" draft={draft} knownTypes={["note", "talk"]} error="" savedPath="" indexed={undefined} indexing={false} contentRef={ref} {...h} />);
    expect(empty.getByRole("button", { name: "Add" }).getAttribute("aria-disabled")).toBe("true");
    expect(empty.container.querySelector('option[value="talk"]')).not.toBeNull();
    changeControlledInput(empty.getByPlaceholderText("What do you want to remember?") as HTMLTextAreaElement, "Remember");
    expect(h.onDraft).toHaveBeenCalledWith({ content: "Remember" });
    fireEvent.click(empty.getByRole("button", { name: "Cancel" }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    empty.unmount();

    const typed = render(<AddForm state="error" draft={{ ...draft, content: "Remember" }} knownTypes={[]} error="disk full" savedPath="" indexed={undefined} indexing={false} contentRef={ref} {...h} />);
    expect(typed.getByRole("alert").textContent).toContain("disk full");
    fireEvent.click(typed.getByRole("button", { name: "Add" }));
    expect(h.onSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(typed.getByPlaceholderText("idea, reading"), { key: "Enter", ctrlKey: true });
    expect(h.onSave).toHaveBeenCalledTimes(2);
    typed.unmount();

    const saving = render(<AddForm state="saving" draft={{ ...draft, content: "Remember" }} knownTypes={[]} error="" savedPath="" indexed={undefined} indexing={false} contentRef={ref} {...h} />);
    expect(saving.getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe("true");
    saving.unmount();
  });

  test("the receipt reads the three-valued indexed flag and offers the retry only when it is false", () => {
    const h = handlers();
    const unindexed = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="locked" savedPath="notes/x.md" indexed={false} indexing={false} contentRef={ref} {...h} />);
    expect(unindexed.getByText(/Saved, but not indexed/)).toBeTruthy();
    expect(unindexed.getByText("notes/x.md")).toBeTruthy();
    expect(unindexed.getByRole("status").textContent).toContain("locked");
    fireEvent.click(unindexed.getByRole("button", { name: "Retry indexing" }));
    expect(h.onRetryIndex).toHaveBeenCalledTimes(1);
    fireEvent.click(unindexed.getByRole("button", { name: "Add another" }));
    expect(h.onAddAnother).toHaveBeenCalledTimes(1);
    fireEvent.click(unindexed.getByRole("button", { name: "Done" }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    unindexed.unmount();

    const indexing = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="" savedPath="" indexed={false} indexing contentRef={ref} {...h} />);
    expect(indexing.getByRole("button", { name: "Indexing…" }).getAttribute("aria-disabled")).toBe("true");
    indexing.unmount();

    const indexed = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="" savedPath="" indexed contentRef={ref} indexing={false} {...h} />);
    expect(indexed.getByText(/Saved and indexed/)).toBeTruthy();
    expect(indexed.queryByRole("button", { name: "Retry indexing" })).toBeNull();
    indexed.unmount();

    const unknown = render(<AddForm state="saved" draft={draft} knownTypes={[]} error="" savedPath="" indexed={undefined} contentRef={ref} indexing={false} {...h} />);
    expect(unknown.getByText(/did not report/)).toBeTruthy();
    unknown.unmount();
  });
});

describe("StreamingOutput and BriefingOutput", () => {
  test("the stream view names its state, offers Cancel only while running, and lists the lines", () => {
    const onCancel = mock(() => {}); const onClose = mock(() => {});
    const running = render(<StreamingOutput state="running" lines={[]} onCancel={onCancel} onClose={onClose} />);
    expect(running.getByText("Running...")).toBeTruthy();
    expect(running.getByText("Starting...")).toBeTruthy();
    expect(running.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(running.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    running.unmount();

    const done = render(<StreamingOutput state="success" lines={["one", "two"]} onCancel={onCancel} onClose={onClose} />);
    expect(done.getByText("Complete")).toBeTruthy();
    expect(done.getByText("two")).toBeTruthy();
    expect(done.queryByText("Starting...")).toBeNull();
    fireEvent.click(done.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    done.unmount();

    for (const [state, text] of [["error", "Failed"], ["cancelled", "Cancelled"], ["idle", "Ready"]] as const) {
      const v = render(<StreamingOutput state={state} lines={[]} onCancel={onCancel} onClose={onClose} />);
      expect(v.getByText(text)).toBeTruthy();
      v.unmount();
    }
  });

  test("the briefing loads behind a skeleton, then shows the content the container rendered", () => {
    const onCancel = mock(() => {}); const onClose = mock(() => {});
    const loading = render(<BriefingOutput state="loading" content={<p>never</p>} onCancel={onCancel} onClose={onClose} />);
    expect(loading.getByText("Generating briefing...")).toBeTruthy();
    expect(loading.queryByText("never")).toBeNull();
    fireEvent.click(loading.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    loading.unmount();

    const failed = render(<BriefingOutput state="error" content={<p>HTTP 500</p>} onCancel={onCancel} onClose={onClose} />);
    expect(failed.getByText("Failed")).toBeTruthy();
    expect(failed.getByText("HTTP 500")).toBeTruthy();
    fireEvent.click(failed.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    failed.unmount();
  });
});

/* ── S7 (files): the tree renders from props; the container reads the store ─ */

describe("FileTree on the kit FileRow", () => {
  test("a row is a kit FileRow: kind from the name, folder state from expansion, error with a retry", () => {
    expect(fileKind("notes", true, false)).toBe("folder");
    expect(fileKind("notes", true, true)).toBe("open");
    expect(fileKind("a.md", false, false)).toBe("file");
    expect(fileKind("map.PNG", false, false)).toBe("image");

    const onClick = mock(() => {}); const onRetry = mock(() => {});
    const view = render(
      <FileTreeView state="ready">
        <TreeRow name="notes" kind="open" depth={0} active={false} loading={true} highlighted={false} error="Permission denied" onClick={onClick} onRetry={onRetry}>
          <TreeRow name="a.md" kind="file" depth={1} active={true} loading={false} highlighted={false} onClick={onClick} />
        </TreeRow>
      </FileTreeView>,
    );
    const folder = view.getByRole("treeitem", { name: /notes/ });
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("loading…")).toBeTruthy();
    const file = view.getByRole("treeitem", { name: /a\.md/ });
    expect(file.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(file);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(view.getByText("Permission denied")).toBeTruthy();
    fireEvent.click(view.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.unmount();

    const failed = render(<FileTreeView state="error" error="offline" onRetry={onRetry} />);
    expect(failed.getByText("Files unreadable")).toBeTruthy();
    expect(failed.getByText("offline")).toBeTruthy();
    failed.unmount();
    const loading = render(<FileTreeView state="loading" />);
    expect(loading.getByLabelText("Loading files")).toBeTruthy();
    loading.unmount();
  });

  test("the container reads the store: expansion, the active file, and clicks go to the store's actions", () => {
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" } });
    const toggled: string[] = []; const opened: string[] = [];
    root.stores.file.setState({
      dirCache: { "": [{ name: "notes", path: "notes", type: "dir" }, { name: "readme.md", path: "readme.md", type: "file" }], notes: [{ name: "a.md", path: "notes/a.md", type: "file" }] },
      expandedDirs: new Set(["notes"]),
      currentPath: "notes/a.md",
      toggleDir: async (path) => { toggled.push(path); },
      openFile: async (path) => { opened.push(path); },
    });
    const view = render(<BrainUiProvider root={root}><FileTree /></BrainUiProvider>);
    try {
      expect(view.getByRole("treeitem", { name: /notes/ }).getAttribute("aria-expanded")).toBe("true");
      expect(view.getByRole("treeitem", { name: /a\.md/ }).getAttribute("aria-selected")).toBe("true");
      fireEvent.click(view.getByRole("treeitem", { name: /notes/ }));
      expect(toggled).toEqual(["notes"]);
      fireEvent.click(view.getByRole("treeitem", { name: /readme/ }));
      expect(opened).toEqual(["readme.md"]);
      act(() => { root.stores.file.setState({ expandedDirs: new Set() }); });
      expect(view.queryByRole("treeitem", { name: /a\.md/ })).toBeNull();
    } finally { view.unmount(); root.dispose(); }
  });
});

describe("frontmatter chips and the viewer frame", () => {
  test("frontmatter is one kv chip per value behind a disclosure the store controls", () => {
    const onOpenChange = mock((_o: boolean) => {});
    const fields = [{ key: "type", value: "talk" }, { key: "tags", value: "[a, b]", list: ["a", "b"] }, { key: "status", value: "" }, { key: "extra", value: "x" }];
    const open = render(<FrontmatterChips fields={fields} open onOpenChange={onOpenChange} />);
    expect(open.getByText("type: talk")).toBeTruthy();
    expect(open.getByText("tags: a")).toBeTruthy();
    expect(open.getByText("tags: b")).toBeTruthy();
    expect(open.getByText("status: —")).toBeTruthy();
    const summary = open.getByRole("button", { name: /frontmatter · 4 fields/ });
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(summary);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    open.unmount();

    const closed = render(<FrontmatterChips fields={fields} open={false} onOpenChange={onOpenChange} />);
    expect(closed.queryByText("type: talk")).toBeNull();
    expect(closed.getByText("type, tags, status…")).toBeTruthy();
    closed.unmount();

    const none = render(<FrontmatterChips fields={[]} open onOpenChange={onOpenChange} />);
    expect(none.container.textContent).toBe("");
    none.unmount();

    const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://alpha.example" } });
    root.stores.file.setState({ frontmatterCollapsed: true });
    const panel = render(<BrainUiProvider root={root}><FrontmatterPanel fields={fields.slice(0, 1)} /></BrainUiProvider>);
    try {
      expect(panel.queryByText("type: talk")).toBeNull();
      fireEvent.click(panel.getByRole("button", { name: /frontmatter/ }));
      expect(root.stores.file.getState().frontmatterCollapsed).toBe(false);
      expect(panel.getByText("type: talk")).toBeTruthy();
    } finally { panel.unmount(); root.dispose(); }
  });

  test("the toolbar's mode switch is a kit FilterRow, and the empty frame says what to do", () => {
    const onMode = mock((_m: "preview" | "raw") => {}); const onCopyPath = mock(() => {}); const onReveal = mock(() => {});
    const view = render(
      <ViewerToolbar fileName="a.md" fullPath="notes/a.md" size={2048} mode="preview" previewAvailable copied={false} share={<span>share-menu</span>}
        onMode={onMode} onCopyPath={onCopyPath} onReveal={onReveal} />,
    );
    expect(view.getByText("notes/a.md")).toBeTruthy();
    expect(view.getByText(/2\.0 KB/)).toBeTruthy();
    expect(view.getByText("share-menu")).toBeTruthy();
    expect(view.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(view.getByRole("tab", { name: "Raw" }));
    expect(onMode).toHaveBeenCalledWith("raw");
    fireEvent.click(view.getByTitle("Copy path"));
    expect(onCopyPath).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByTitle("Reveal in tree"));
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("link", { name: "Open in new tab" })).toBeNull();
    view.unmount();

    // An HTML file opens its sandboxed preview route in a new tab, without an opener.
    const html = render(<ViewerToolbar fileName="beacon.html" fullPath="voyage/beacon.html" mode="preview" previewAvailable copied={false} share={null}
      openInTab="/api/files/html?path=voyage%2Fbeacon.html" onMode={onMode} onCopyPath={onCopyPath} onReveal={onReveal} />);
    const tab = html.getByRole("link", { name: "Open in new tab" });
    expect(tab.getAttribute("href")).toBe("/api/files/html?path=voyage%2Fbeacon.html");
    expect(tab.getAttribute("target")).toBe("_blank");
    expect(tab.getAttribute("rel")).toBe("noopener");
    html.unmount();

    const raw = render(<ViewerToolbar fileName="x.bin" fullPath="x.bin" mode="raw" previewAvailable={false} copied share={null} onMode={onMode} onCopyPath={onCopyPath} onReveal={onReveal} />);
    expect(raw.queryByRole("tab")).toBeNull();
    raw.unmount();

    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.00 MB");
    const empty = render(<ViewerEmpty />);
    expect(empty.getByText("No file open")).toBeTruthy();
    empty.unmount();
  });
});

/* ── S7 (activity): the rows render from props on the kit cards ──────────── */

describe("activity views", () => {
  test("a live run is an AgentRunCard inside a named button, with the tool strip from its children", () => {
    expect(toolState(undefined)).toBe("active");
    expect(toolState("success")).toBe("done");
    expect(toolState("error")).toBe("failed");
    const onOpen = mock(() => {});
    const view = render(<LiveRunCard name="nightly-sync" current="WebFetch" elapsed="1m 12s" tools={[{ label: "brain_search", state: "done" }, { label: "WebFetch", state: "active" }]} onOpen={onOpen} />);
    fireEvent.click(view.getByRole("button", { name: "Open run nightly-sync" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(view.getByText("nightly-sync")).toBeTruthy();
    expect(view.getByText("1m 12s")).toBeTruthy();
    // The current step is the quoted task line AND the active entry of the strip.
    expect(view.getAllByText(/▸ WebFetch/)).toHaveLength(2);
    expect(view.getByText(/brain_search/)).toBeTruthy();
    view.unmount();
  });

  test("history is a plain ListRow; failure colours it and names the outcome", () => {
    const onOpen = mock(() => {});
    const ok = render(<HistoryRow name="ledger_sync" cron outcome="success" meta="$0.02 · 4s · 2h ago" onOpen={onOpen} />);
    fireEvent.click(ok.getByRole("button", { name: /ledger_sync/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(ok.queryByText("success")).toBeNull();
    ok.unmount();
    const failed = render(<HistoryRow name="ledger_sync" cron={false} outcome="error" meta="— · 4s · 2h ago" onOpen={onOpen} />);
    expect(failed.getByText("error")).toBeTruthy();
    expect(failed.getByText("— · 4s · 2h ago")).toBeTruthy();
    failed.unmount();
  });

  test("an intent is an ActionCard whose Dismiss does not also open it", () => {
    const onOpen = mock(() => {}); const onDismiss = mock(() => {});
    const intent = { id: 1, runId: "r", spanId: null, kind: "failure" as const, tag: "t", title: "ledger sync keeps failing", body: "3 tries", status: "sent" as const, acknowledged: false, createdAt: 1 };
    const view = render(<IntentCard intent={intent} when="4m ago" onOpen={onOpen} onDismiss={onDismiss} />);
    expect(view.getByText("Failed")).toBeTruthy();
    expect(view.getByText("3 tries")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(0);
    fireEvent.click(view.getByText("ledger sync keeps failing"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    view.unmount();
    const stuck = render(<IntentCard intent={{ ...intent, kind: "stuck" }} when="now" onOpen={onOpen} onDismiss={onDismiss} />);
    expect(stuck.getByText("Stuck")).toBeTruthy();
    stuck.unmount();
  });

  test("the rollup receipt lists the run's facts and carries the failure reason as its footnote", () => {
    const view = render(<RunRollupReceipt origin="cron" outcome="error" when="2h ago" duration="4s" listCost="$0.10" effectiveCost="$0.02" billing="API billed" estimated usage="1.2k tok" failureReason="invoice source unreachable" />);
    expect(view.getByText("origin")).toBeTruthy();
    expect(view.getByText("cron")).toBeTruthy();
    expect(view.getByText("error")).toBeTruthy();
    expect(view.getByText(/\$0\.02 · API billed · ~ estimated rates/)).toBeTruthy();
    expect(view.getByText("invoice source unreachable")).toBeTruthy();
    view.unmount();
    const clean = render(<RunRollupReceipt origin="session" outcome="success" when="now" duration={null} listCost="—" effectiveCost="—" billing={null} estimated={false} usage={null} failureReason={null} />);
    expect(clean.queryByText(/this file only/)).toBeNull();
    clean.unmount();
  });
});

/* ── S7 (chat): the session list and the welcome state render from props ── */

describe("chat views", () => {
  test("the session list is card rows: Working first and listed once, selection, run state, warning with retry, empty", () => {
    const onNew = mock(() => {}); const onResume = mock((_id: string) => {}); const onRetry = mock(() => {});
    const onOpenTracker = mock((_id: string) => {});
    const groups = [{ label: "Today", sessions: [
      { id: "a", title: "Lisbon venues", when: "2h ago", cost: "$0.12", run: "streaming" as const },
      { id: "b", title: null, when: "3h ago", cost: null, run: "queued" as const, note: "queue is heavy" },
      { id: "z", title: "Raft timber tally", when: "1h ago", cost: null, run: null },
      { id: "y", title: "Rename voyage photos", when: "5h ago", cost: null, run: null, unseen: true },
    ] }];
    const working = [{ id: "z", label: "Raft timber tally", word: "running · 2m", tone: "amber" as const, icon: "working" as const, name: "Raft timber tally, running, 2m. Open session." }];
    const view = render(<SessionList working={working} groups={groups} loading={false} warning={null} currentSessionId="a" onNew={onNew} onResume={onResume} onOpenTracker={onOpenTracker} onRetry={onRetry} />);
    expect(view.getByText("Today")).toBeTruthy();
    const current = view.getByRole("button", { name: /Lisbon venues/ });
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(view.getByText("2h ago · $0.12")).toBeTruthy();
    expect(view.getByText("running")).toBeTruthy();
    expect(view.getByText("queued")).toBeTruthy();
    // A tracked session is in Working, not again in its date group (D52 §8);
    // one past the pill cap keeps `unseen` on its date row (D52 §4).
    const tracked = view.getAllByRole("button").filter((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").includes("Raft timber tally"));
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.closest("[data-working-group]")).not.toBeNull();
    expect(view.getByRole("button", { name: /Rename voyage photos/ }).textContent).toContain("unseen");
    fireEvent.click(tracked[0]!);
    expect(onOpenTracker).toHaveBeenLastCalledWith("z");
    fireEvent.click(view.getByRole("button", { name: /Untitled/ }));
    expect(onResume).toHaveBeenLastCalledWith("b");
    // One tab stop across the list: the session in view.
    expect(view.getAllByRole("button").filter((b) => b.getAttribute("tabindex") === "0" && b.closest("[data-session-item]")).map((b) => b.textContent)).toEqual([current.textContent]);
    fireEvent.click(view.getByRole("button", { name: "New conversation" }));
    expect(onNew).toHaveBeenCalledTimes(1);
    view.unmount();

    // At ≥1280 in an empty chat: aria-disabled, its reason printed at rest.
    const fresh = render(<SessionList groups={groups} loading={false} warning={null} currentSessionId={null} newWhy="already a new chat" onNew={onNew} onResume={onResume} onRetry={onRetry} />);
    const start = fresh.getByRole("button", { name: /New conversation/ });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(start.textContent).toContain("already a new chat");
    fireEvent.click(start);
    expect(onNew).toHaveBeenCalledTimes(1);
    fresh.unmount();

    const warned = render(<SessionList groups={[]} loading={false} warning="Could not refresh sessions. Please retry." currentSessionId={null} onNew={onNew} onResume={onResume} onRetry={onRetry} />);
    expect(warned.getByRole("status").textContent).toContain("Could not refresh");
    fireEvent.click(warned.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(warned.getByText("No sessions available")).toBeTruthy();
    warned.unmount();

    const loading = render(<SessionList groups={[]} loading warning={null} currentSessionId={null} onNew={onNew} onResume={onResume} onRetry={onRetry} />);
    expect(loading.queryByText("No sessions yet")).toBeNull();
    loading.unmount();
  });

  test("the welcome state is a kit EmptyState with suggestion chips that route actions", () => {
    const onAction = mock((_a: string) => {});
    const view = render(<WelcomeState onAction={onAction} />);
    expect(view.getByText("What do you need to know?")).toBeTruthy();
    // D52 §1: the briefing (printing its cost), Search, and Add a note,
    // which replaced the statistics chip.
    const chips = view.getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["What's new?spends", "Search…", "Add a note…"]);
    fireEvent.click(chips[0]!);
    expect(onAction).toHaveBeenLastCalledWith("whatsup");
    fireEvent.click(chips[1]!);
    expect(onAction).toHaveBeenLastCalledWith("search");
    fireEvent.click(chips[2]!);
    expect(onAction).toHaveBeenLastCalledWith("add");
    expect(view.queryByText("Brain stats")).toBeNull();
    view.unmount();

    // Unavailable: the chip stays, keeps its cost, prints why, and does not run.
    onAction.mockClear();
    const offline = render(<WelcomeState onAction={onAction} briefingWhy="needs the host" />);
    const briefing = offline.getAllByRole("button")[0]!;
    expect(briefing.getAttribute("aria-disabled")).toBe("true");
    expect(briefing.textContent).toContain("spends");
    expect(briefing.textContent).toContain("needs the host");
    fireEvent.click(briefing);
    expect(onAction).not.toHaveBeenCalled();
    offline.unmount();
  });
});

describe("one-message composer effort", () => {
  async function mounted(ack = true) {
    const providers = [
      { id: "claude", label: "Claude", thinkingLevel: "low", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
      { id: "smaller", label: "Smaller", thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high"] },
      { id: "plain", label: "Plain" },
    ];
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ providers }) });
    await root.stores.provider.getState().loadProviders();
    root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: ack });
    const sent: Array<import("@schlessera/brain-ui-sdk/protocol").ClientChatMessage> = [];
    const view = render(<BrainUiProvider root={root}><Composer send={(msg) => { if (msg.type === "chat_message") sent.push(msg); return true; }} /></BrainUiProvider>);
    await act(async () => { await Promise.resolve(); });
    const choose = (level: string) => {
      fireEvent.click(view.getByRole("button", { name: /^Model —/ }));
      fireEvent.click(view.getByRole("radio", { name: level }));
    };
    const field = () => view.getByRole("textbox") as HTMLTextAreaElement;
    const type = (text: string) => { field().focus(); changeControlledInput(field(), text); };
    const send = () => { field().focus(); fireEvent.keyDown(field(), { key: "Enter" }); };
    return { root, view, sent, choose, field, type, send, done() { view.unmount(); root.dispose(); } };
  }

  test("a send empties the field into its snapshot; refusal gives draft and effort back; acknowledgement consumes them", async () => {
    const h = await mounted();
    try {
      h.choose("max"); h.type("first"); h.send();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].thinkingLevel).toBe("max");
      expect(h.view.getByRole("button", { name: "Model — Claude · effort max for the next message" })).toBeTruthy();
      // D52 §5: what was sent is a snapshot apart from the draft.
      expect(h.field().value).toBe("");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "SESSION_LIMIT", message: "Try again", requestId: h.sent[0].requestId }));
      // Refused, so nothing was consumed: the words come back.
      expect(h.field().value).toBe("first");
      expect(h.view.getByText("· max")).toBeTruthy();
      h.send();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].thinkingLevel).toBe("max");
      act(() => h.root.connection.handleServerMessage({ type: "session_info", sessionId: "effort-ui", isNew: true, providerId: "claude", requestId: h.sent[1].requestId, draftId: h.sent[1].draftId }));
      expect(h.field().value).toBe("");
      expect(h.view.queryByText("· max")).toBeNull();
      h.type("second"); h.send();
      expect(h.sent).toHaveLength(3);
      expect(h.sent[2].thinkingLevel).toBeUndefined();
      expect(h.sent[2].requestId).toBeDefined();
    } finally { h.done(); }
  });

  test("an interrupted acknowledgement holds the send for review: nothing is resent until Send again, and Edit puts it back", async () => {
    const h = await mounted();
    try {
      h.choose("high"); h.type("unconfirmed"); h.send();
      act(() => h.root.stores.connection.getState().setWsStatus("disconnected"));
      expect(h.sent).toHaveLength(1);
      const held = () => Object.values(h.root.stores.drafts.getState().sends).filter((s) => s.state === "unconfirmed");
      expect(held().map((s) => s.text)).toEqual(["unconfirmed"]);
      expect(h.field().value).toBe("");
      expect(h.view.getByText("· high")).toBeTruthy();
      act(() => h.root.stores.connection.getState().setWsStatus("connected"));
      expect(h.sent).toHaveLength(1);
      // Send again: the same snapshot under a new request id, effort included.
      // (The composer's own `send` is the host here, so the frame goes through the root.)
      const resent = held()[0]!;
      expect(resent.message.thinkingLevel).toBe("high");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "RATE_LIMITED", message: "Slow down" }));
      expect(held()).toHaveLength(1);
      act(() => h.root.stores.drafts.getState().editSend(resent.requestId));
      expect(h.field().value).toBe("unconfirmed");
      expect(held()).toHaveLength(0);
      h.send();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].thinkingLevel).toBe("high");
      expect(h.sent[1].requestId).not.toBe(h.sent[0].requestId);
    } finally { h.done(); }
  });

  test("a refused queued override preserves the current reply and draft", async () => {
    const h = await mounted();
    try {
      act(() => {
        const chat = h.root.stores.chat.getState();
        chat.setActiveSession("effort-ui");
        chat.startAssistantMessage("effort-ui", "running-turn");
        chat.setRunState("effort-ui", "streaming");
        h.root.stores.provider.getState().setPinned("claude");
      });
      h.choose("high"); h.type("queued"); h.send();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].thinkingLevel).toBe("high");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "SESSION_QUEUE_FULL", message: "Queue full", sessionId: "effort-ui", requestId: h.sent[0].requestId }));
      expect(h.field().value).toBe("queued");
      expect(h.view.getByText("· high")).toBeTruthy();
      const state = h.root.stores.chat.getState();
      expect(state.buffers["effort-ui"].isStreaming).toBe(true);
      expect(state.buffers["effort-ui"].messages.filter((message) => message.role === "assistant")).toHaveLength(1);
      expect(state.runStates["effort-ui"]).toBe("streaming");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "agent_error", message: "Failed run", sessionId: "effort-ui", turnId: "running-turn", requestId: "running-request" }));
      expect(h.root.stores.chat.getState().buffers["effort-ui"].isStreaming).toBe(false);
      expect(h.root.stores.chat.getState().runStates["effort-ui"]).toBeUndefined();
    } finally { h.done(); }
  });

  test("queue acknowledgement consumes the sent override and preserves a newly chosen effort and edited draft", async () => {
    const h = await mounted();
    try {
      act(() => { h.root.stores.chat.getState().setActiveSession("effort-ui"); h.root.stores.provider.getState().setPinned("claude"); });
      h.choose("high"); h.type("queued"); h.send();
      expect(h.sent).toHaveLength(1);
      h.choose("max"); h.type("another message");
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: h.sent[0].requestId }));
      expect(h.field().value).toBe("another message");
      expect(h.view.getByText("· max")).toBeTruthy();
      h.send();
      expect(h.sent[1].thinkingLevel).toBe("max");
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: h.sent[1].requestId }));
      expect(h.field().value).toBe("");
      expect(h.view.queryByText("· max")).toBeNull();
    } finally { h.done(); }
  });

  test("a held send accepted after Send again consumes the effort it carried", async () => {
    const h = await mounted();
    try {
      act(() => { h.root.stores.chat.getState().setActiveSession("effort-ui"); h.root.stores.provider.getState().setPinned("claude"); });
      h.choose("high"); h.type("queued"); h.send();
      act(() => h.root.stores.connection.getState().setWsStatus("disconnected"));
      act(() => h.root.stores.connection.getState().setWsStatus("connected"));
      expect(h.view.getByText("· high")).toBeTruthy();
      // Send again re-keys the snapshot; the host accepts the new request.
      act(() => { h.root.stores.drafts.getState().resend(h.sent[0].requestId!, "req-again"); });
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: "req-again" }));
      expect(h.view.queryByText("· high")).toBeNull();
    } finally { h.done(); }
  });

  test("an acknowledgement that empties the session's draft keeps an effort chosen meanwhile", async () => {
    const h = await mounted();
    try {
      act(() => { h.root.stores.chat.getState().setActiveSession("effort-ui"); h.root.stores.provider.getState().setPinned("claude"); });
      h.choose("high"); h.type("queued"); h.send();
      h.choose("max");
      // Nothing typed since: acceptance forgets the emptied draft, and the
      // view's draft id changes, inside the same session (#951).
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: h.sent[0].requestId }));
      expect(h.view.getByText("· max")).toBeTruthy();
    } finally { h.done(); }
  });

  test("a new conversation acknowledgement preserves effort chosen for the edited next draft", async () => {
    const h = await mounted();
    try {
      h.choose("high"); h.type("first"); h.send();
      expect(h.sent).toHaveLength(1);
      h.choose("max"); h.type("another message");
      act(() => h.root.connection.handleServerMessage({ type: "session_info", sessionId: "effort-ui", isNew: true, providerId: "claude", requestId: h.sent[0].requestId, draftId: h.sent[0].draftId }));
      expect(h.root.stores.chat.getState().activeSessionId).toBe("effort-ui");
      expect(h.field().value).toBe("another message");
      expect(h.view.getByText("· max")).toBeTruthy();
      h.send();
      expect(h.sent[1].thinkingLevel).toBe("max");
    } finally { h.done(); }
  });

  test("model changes downgrade visibly; an effort-less model drops the override; older hosts retain their send behavior", async () => {
    const h = await mounted();
    try {
      h.choose("max");
      fireEvent.click(h.view.getByRole("button", { name: /^Model —/ }));
      fireEvent.click(h.view.getByRole("radio", { name: "Smaller" }));
      expect(h.view.getByText("· high")).toBeTruthy();
      expect(h.view.getByText("Effort changed from max to high for this model")).toBeTruthy();
      expect(h.view.getByRole("button", { name: "Model — Smaller · effort high for the next message (max not supported)" })).toBeTruthy();
      fireEvent.click(h.view.getByRole("radio", { name: "Claude" }));
      expect((h.view.getByRole("radio", { name: "high" }) as HTMLInputElement).checked).toBe(true);
      expect((h.view.getByRole("radio", { name: "max" }) as HTMLInputElement).checked).toBe(false);
      fireEvent.click(h.view.getByRole("radio", { name: "Plain" }));
      expect(h.view.queryByText("Effort · next message")).toBeNull();
      expect(h.view.getByText("This model has no effort setting; the next message uses its default")).toBeTruthy();
    } finally { h.done(); }
    const old = await mounted(false);
    try {
      old.type("legacy"); old.send();
      expect(old.sent[0].requestId).toBeUndefined();
      expect(old.sent[0].thinkingLevel).toBeUndefined();
      expect(old.field().value).toBe("");
    } finally { old.done(); }
  });
});

describe("ComposerView", () => {
  const refs = { frameRef: { current: null }, providerMenuRef: { current: null } };
  const handlers = () => ({
    onChange: mock((_v: string) => {}), onSend: mock(() => {}), onStop: mock(() => {}), onMic: mock(() => {}), onPasteFiles: mock((_f: File[]) => {}),
    onAttachToggle: mock(() => {}), onPickLibrary: mock(() => {}), onPickCamera: mock(() => {}), onRecall: mock(() => {}), onEscape: mock(() => {}),
    onRemoveAttachment: mock((_i: number) => {}), onDismissErrors: mock(() => {}), onProviderToggle: mock(() => {}), onProviderSelect: mock((_id: string) => {}),
    onProviderDismiss: mock(() => {}), onEffortSelect: mock((_level: string | null) => {}),
  });
  const base = { placeholder: "Ask", state: "ready" as const, paletteOpen: false, palette: null, attachMenuOpen: false, attachments: [], attachErrors: [], provider: null, ...refs };

  test("the field is the kit composer: send, provider, attach menu, recall and escape route to the container", () => {
    const h = handlers();
    const view = render(<ComposerView {...base} value="hello" paletteOpen attachMenuOpen provider={{ label: "Fast model", locked: false, menuOpen: true, options: [{ id: "a", label: "Fast model" }, { id: "b", label: "Careful model" }], selectedId: "a" }} {...h} />);
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(h.onSend).toHaveBeenCalledTimes(1);
    const field = view.getByLabelText("Ask") as HTMLTextAreaElement;
    field.focus();
    changeControlledInput(field, "hello there");
    expect(h.onChange).toHaveBeenCalledWith("hello there");
    // esc dismisses the slash palette; the kit's own esc only stops a stream.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(h.onEscape).toHaveBeenCalledTimes(1);
    // The paperclip is a menu trigger (D37): the menu carries the capture choices.
    expect(view.getByRole("button", { name: "Attach — photo, camera, file" }).getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(view.getByRole("button", { name: "Attach — photo, camera, file" }));
    expect(h.onAttachToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: /^Photo library/ }));
    fireEvent.click(view.getByRole("button", { name: /^Camera/ }));
    expect(h.onPickLibrary).toHaveBeenCalledTimes(1);
    expect(h.onPickCamera).toHaveBeenCalledTimes(1);
    // The provider chip lives in the kit's hint line; the list is the frame's.
    fireEvent.click(view.getByRole("button", { name: "Model — Fast model" }));
    expect(h.onProviderToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("radio", { name: "Careful model" }));
    expect(h.onProviderSelect).toHaveBeenCalledWith("b");
    view.unmount();

    const empty = render(<ComposerView {...base} value="" {...h} />);
    fireEvent.keyDown(empty.getByLabelText("Ask"), { key: "ArrowUp" });
    expect(h.onRecall).toHaveBeenCalledTimes(1);
    empty.unmount();

    const streaming = render(<ComposerView {...base} value="" state="streaming" hint="Will queue · esc or the stop button ends the run" provider={{ label: "Pinned model", locked: true, menuOpen: false, options: [], selectedId: null }} {...h} />);
    fireEvent.click(streaming.getByRole("button", { name: "Stop generating" }));
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(streaming.queryByRole("button", { name: "Send" })).toBeNull();
    expect(streaming.getByText(/Will queue/)).toBeTruthy();
    // A pinned provider is text, not a control.
    expect(streaming.queryByRole("button", { name: /Pinned model/ })).toBeNull();
    expect(streaming.getByText("Pinned model")).toBeTruthy();
    streaming.unmount();
  });

  test("attachments, their errors and a lost connection", () => {
    const h = handlers();
    const view = render(<ComposerView {...base} value="" state="offline" placeholder="Connecting..." blockedWhy="needs the host · your draft is kept" attachments={[{ previewUrl: "blob:one", name: "one.png" }]} attachErrors={["big.png: too large"]} {...h} />);
    // Offline keeps the draft typeable; only the send is inert, with the reason printed.
    expect((view.getByLabelText("Connecting...") as HTMLTextAreaElement).readOnly).toBe(false);
    expect(view.getByText("needs the host · your draft is kept")).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain("big.png: too large");
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    expect(h.onDismissErrors).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Remove one.png" }));
    expect(h.onRemoveAttachment).toHaveBeenCalledWith(0);
    expect(view.getByRole("button", { name: "Send — unavailable" }).getAttribute("aria-disabled")).toBe("true");
    view.unmount();
  });
});

describe("transcript turn views", () => {
  test("the header names who and when, and marks a voice turn", () => {
    const view = render(<TurnHeader who="You" when="09:41" voice="voice-dictate" tone="user" />);
    expect(view.getByText("You")).toBeTruthy();
    expect(view.getByText("09:41")).toBeTruthy();
    expect(view.getByRole("img", { name: "Voice dictation" })).toBeTruthy();
    view.unmount();
    const brain = render(<TurnHeader who="Brain" when="09:42" tone="brain" />);
    expect(brain.queryByRole("img")).toBeNull();
    brain.unmount();
  });

  test("a user turn wraps its content in the bubble; a resumed one counts its images", () => {
    const view = render(<UserTurn><p>hello</p></UserTurn>);
    expect(view.getByText("hello")).toBeTruthy();
    view.unmount();
    const count = render(<AttachmentCount count={2} />);
    expect(count.getByText("2 images")).toBeTruthy();
    count.unmount();
  });

  test("thinking streams open, then collapses into a disclosure the container controls", () => {
    const onOpenChange = mock((_o: boolean) => {});
    const live = render(<ThinkingBlock content="considering the loom" chars={80} streaming open onOpenChange={onOpenChange} />);
    expect(live.getByText("considering the loom")).toBeTruthy();
    expect(live.queryByRole("button")).toBeNull();
    live.unmount();
    const done = render(<ThinkingBlock content="considering the loom" chars={80} streaming={false} open={false} onOpenChange={onOpenChange} />);
    const summary = done.getByRole("button", { name: /Thought for ~20 tokens/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(done.queryByText("considering the loom")).toBeNull();
    fireEvent.click(summary);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    done.unmount();
    const waiting = render(<ThinkingIndicator />);
    expect(waiting.getByText("Thinking...")).toBeTruthy();
    waiting.unmount();
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

/* ── S7 (settings): principals, accounts and grants render from props ────── */

describe("settings views", () => {
  test("the principal list: states, the mint form gated on a label, revoke by id", () => {
    const h = { onLabel: mock((_v: string) => {}), onTtlDays: mock((_d: number) => {}), onMint: mock(() => {}), onRevoke: mock((_id: string) => {}) };
    const rows = [
      { id: "own", label: "Laptop", kind: "owner", isOwn: true, created: "2h ago", lastSeen: "5m ago", expires: "in 6d" },
      { id: "agent", label: "Build agent", kind: "agent", isOwn: false, created: "1m ago", lastSeen: "Never", expires: "in 1d" },
    ];
    const view = render(<PrincipalList state="ready" principals={rows} error={null} label="" ttlDays={7} minting={false} {...h} />);
    expect(view.getByText("This device")).toBeTruthy();
    expect(view.getByText("Agent")).toBeTruthy();
    expect(view.getByRole("button", { name: "Create agent credential" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Revoke Build agent" }));
    expect(h.onRevoke).toHaveBeenCalledWith("agent");
    changeControlledInput(view.getByLabelText("Label") as HTMLInputElement, "Deploy agent");
    expect(h.onLabel).toHaveBeenCalledWith("Deploy agent");
    view.unmount();

    const ready = render(<PrincipalList state="ready" principals={[]} error="mint failed" label="Deploy agent" ttlDays={7} minting={false} {...h} />);
    expect(ready.getByText("No active devices or agents.")).toBeTruthy();
    expect(ready.getByRole("alert").textContent).toContain("mint failed");
    fireEvent.click(ready.getByRole("button", { name: "Create agent credential" }));
    expect(h.onMint).toHaveBeenCalledTimes(1);
    ready.unmount();

    const off = render(<PrincipalList state="unavailable" principals={[]} error={null} label="" ttlDays={7} minting={false} {...h} />);
    expect(off.getByText(/password authentication is enabled/)).toBeTruthy();
    expect(off.queryByRole("button", { name: "Create agent credential" })).toBeNull();
    off.unmount();
  });

  test("the accounts list: connect, disconnect, the device code, and a settled flow", () => {
    const h = { onConnect: mock((_id: string) => {}), onDisconnect: mock((_id: string) => {}), onCancelFlow: mock(() => {}), onDismissFlow: mock(() => {}) };
    const providers = [
      { providerId: "vendor", name: "Vendor", configured: false, oauth: true, source: null },
      { providerId: "other", name: "Other", configured: true, oauth: true, source: "stored" },
    ] as unknown as Parameters<typeof AccountsList>[0]["providers"];
    const view = render(<AccountsList providers={providers} busy={null} flow={null} error={null} {...h} />);
    expect(view.getByText("Not connected")).toBeTruthy();
    expect(view.getByText("Connected · stored")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Connect" }));
    expect(h.onConnect).toHaveBeenCalledWith("vendor");
    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    expect(h.onDisconnect).toHaveBeenCalledWith("other");
    view.unmount();

    const pending = { id: "f", providerId: "vendor", status: "pending", userCode: "ABCD-1234", verificationUri: "https://example.invalid/device", intervalSeconds: 5 } as unknown as NonNullable<Parameters<typeof AccountsList>[0]["flow"]>;
    const waiting = render(<AccountsList providers={providers} busy={null} flow={pending} error={null} {...h} />);
    expect(waiting.getByText("ABCD-1234")).toBeTruthy();
    expect(waiting.getByRole("link", { name: /Open verification page/ }).getAttribute("href")).toBe("https://example.invalid/device");
    expect(waiting.getByRole("button", { name: "Connect" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(waiting.getByRole("button", { name: "Cancel" }));
    expect(h.onCancelFlow).toHaveBeenCalledTimes(1);
    waiting.unmount();

    const failed = render(<AccountsList providers={providers} busy={null} flow={{ ...pending, status: "error", error: "denied" } as typeof pending} error={null} {...h} />);
    expect(failed.getByText("denied")).toBeTruthy();
    fireEvent.click(failed.getByRole("button", { name: "Dismiss" }));
    expect(h.onDismissFlow).toHaveBeenCalledTimes(1);
    failed.unmount();
  });

  test("the grants are kit rows: tapping one revokes, a busy one is inert", () => {
    const onRevoke = mock((_t: string) => {});
    const view = render(<ToolPermissionsList tools={["Read", "Bash"]} busy="Bash" error={null} onRevoke={onRevoke} />);
    fireEvent.click(view.getByRole("button", { name: /Read/ }));
    expect(onRevoke).toHaveBeenCalledWith("Read");
    expect(view.queryByRole("button", { name: /Bash/ })).toBeNull();
    expect(view.getByText("Revoking…")).toBeTruthy();
    view.unmount();
  });
});

describe("ModelsCatalogView", () => {
  test("effort choices come from capabilities; unsupported saved levels stay visible and can be cleared", () => {
    const onThinking = mock(() => {});
    const catalog = { models: [
      { id: "limited", label: "Limited", hidden: false, thinkingLevel: "high", thinkingOverride: "max", supportedThinkingLevels: ["low", "high"] },
      { id: "removed", label: "Removed support", hidden: false, thinkingOverride: "high", supportedThinkingLevels: [] },
      { id: "unknown", label: "Unknown support", hidden: false, thinkingLevel: "low" },
    ], refreshedAt: null, stale: false, discovery: { enabled: true } } as NonNullable<Parameters<typeof ModelsCatalogView>[0]["catalog"]>;
    const view = render(<ModelsCatalogView catalog={catalog} loading={false} refreshing={false} error={null} sections={null} onThinking={onThinking} onToggleHidden={() => {}} onBilling={() => {}} onDefault={() => {}} onCustomModels={() => {}} onRefresh={() => {}} />);
    try {
      const limited = view.getByLabelText("Reasoning effort for Limited") as HTMLSelectElement;
      expect([...limited.options].map((option) => option.value)).toEqual(["auto", "max", "low", "high"]);
      expect(limited.selectedOptions[0].textContent).toBe("max (runs as high)");
      const removed = view.getByLabelText("Reasoning effort for Removed support") as HTMLSelectElement;
      expect([...removed.options].map((option) => option.value)).toEqual(["auto", "high"]);
      expect(removed.selectedOptions[0].textContent).toBe("high (uses model default)");
      fireEvent.change(removed, { target: { value: "auto" } });
      expect(onThinking).toHaveBeenCalledWith(catalog.models[1], "auto");
      const unknown = view.getByLabelText("Reasoning effort for Unknown support") as HTMLSelectElement;
      expect([...unknown.options].map((option) => option.value)).toEqual(["auto"]);
      expect(view.getByText("Effort set here is the default for every new message; the model picker can change it for one message.")).toBeTruthy();
    } finally { view.unmount(); }
  });

  test("the roster: hidden rows say so at full contrast, selects keep their names, refresh and add are kit buttons", () => {
    const h = { onToggleHidden: mock(() => {}), onBilling: mock(() => {}), onThinking: mock(() => {}), onDefault: mock(() => {}), onCustomModels: mock((_m: string[]) => {}), onRefresh: mock(() => {}) };
    const catalog = {
      models: [
        { id: "one", label: "Model one", hidden: false, source: "discovered", billingMode: "api", thinkingLevel: "medium", contextWindow: 200000 },
        { id: "two", label: "Model two", hidden: true, source: "declared" },
      ],
      defaultModelId: null, resolvedDefaultId: "one", customModels: ["vendor/custom"], refreshedAt: null,
      discovery: { enabled: true, error: "rate limited" },
    } as unknown as Parameters<typeof ModelsCatalogView>[0]["catalog"];
    const view = render(<ModelsCatalogView catalog={catalog} loading={false} refreshing={false} error={null} sections={<p>sections here</p>} {...h} />);
    expect(view.getByText("hidden")).toBeTruthy();
    expect(view.getByLabelText("Billing for Model one")).toBeTruthy();
    expect(view.getByLabelText("Reasoning effort for Model one")).toBeTruthy();
    expect(view.getByText(/Last refresh failed \(rate limited\)/)).toBeTruthy();
    expect(view.getByText(/1 in picker · never refreshed/)).toBeTruthy();
    expect(view.getByText("sections here")).toBeTruthy();
    fireEvent.click(view.getByTitle("Show in picker"));
    expect(h.onToggleHidden).toHaveBeenCalledWith(catalog!.models[1]);
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Remove vendor/custom" }));
    expect(h.onCustomModels).toHaveBeenCalledWith([]);
    changeControlledInput(view.getByLabelText("OpenRouter model id") as HTMLInputElement, "vendor/new");
    fireEvent.click(view.getByRole("button", { name: "Add" }));
    expect(h.onCustomModels).toHaveBeenLastCalledWith(["vendor/custom", "vendor/new"]);
    view.unmount();

    const empty = render(<ModelsCatalogView catalog={{ ...catalog!, models: [], discovery: { enabled: false, error: undefined } }} loading={false} refreshing error="save failed" sections={null} {...h} />);
    expect(empty.getByText("No models available.")).toBeTruthy();
    expect(empty.getByText(/Discovery is disabled/)).toBeTruthy();
    expect(empty.getByRole("alert").textContent).toContain("save failed");
    expect(empty.getByRole("button", { name: "Refreshing…" }).getAttribute("aria-disabled")).toBe("true");
    empty.unmount();
  });
});

/* ── #147: a card never offers a grant the host will not keep ───────────── */

describe("approval cards follow rememberability (#147)", () => {
  function card(extra: Partial<ToolCall>): ToolCall {
    return {
      id: "t1",
      name: "mcp_proxy_tool",
      input: {},
      inputJson: "{}",
      status: "pending_approval",
      ...extra,
    } as ToolCall;
  }
  // The three states a card can be in. Only the first may offer the button.
  const OFFERED = card({ approvalKind: "tool" });
  const UNKEPT = card({ approvalKind: "tool", approvalRememberable: false });
  const COMMAND = card({ name: "Bash", approvalKind: "command" });

  test("the transcript card drops Always allow when the host will not keep it", () => {
    for (const [tool, offered] of [[OFFERED, true], [UNKEPT, false], [COMMAND, false]] as const) {
      const view = render(<ToolCallTimeline toolCalls={[tool]} onApproval={() => {}} />);
      expect(view.queryByRole("button", { name: "Always allow" }) !== null).toBe(offered);
      // Allow and Deny are never what this changes.
      expect(view.getByRole("button", { name: /^Allow/ })).toBeTruthy();
      expect(view.getByRole("button", { name: /^Deny/ })).toBeTruthy();
      view.unmount();
    }
  });

  test("the Actions card drops Always allow when the host will not keep it", () => {
    for (const [tool, offered] of [[OFFERED, true], [UNKEPT, false], [COMMAND, false]] as const) {
      const view = render(<ApprovalCard tool={tool} origin="this conversation" keys onDecide={() => {}} />);
      expect(view.queryByRole("button", { name: /Always allow/ }) !== null).toBe(offered);
      expect(view.getByRole("button", { name: /^Allow/ })).toBeTruthy();
      view.unmount();
    }
  });

  test("an always the card could not offer is neither printed nor sent", () => {
    // The button is gone, so this is the guard behind it: whatever reaches
    // the decision, the receipt and the frame follow the card.
    for (const tool of [UNKEPT, COMMAND, undefined]) {
      const { receipt, frame } = approvalOutcome(tool, "t1", true, true);
      expect(receipt.text).toBe("Allowed");
      expect(receipt.effect).toBe("tool_approval");
      expect(frame).toEqual({ type: "tool_approval", toolUseId: "t1", channel: "card" });
    }
    const kept = approvalOutcome(OFFERED, "t1", true, true);
    expect(kept.receipt).toEqual({ text: "Always allowed", target: "mcp_proxy_tool", effect: "write_policy" });
    expect(kept.frame).toEqual({ type: "tool_approval", toolUseId: "t1", always: true, channel: "card" });
    expect(approvalOutcome(OFFERED, "t1", false, true).frame).toEqual({
      type: "tool_denial",
      toolUseId: "t1",
      message: "Denied by user",
      channel: "card",
    });
  });

  /**
   * Driven from the wire: the frame the host sends, through the socket
   * handler and the store, to the Actions page and the receipt it prints.
   */
  async function actionsFrom(frame: Record<string, unknown>, before: Record<string, unknown>[] = []) {
    installActivityFetch();
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    const root = createBrainUiRoot({ storage: null });
    const release = root.connection.connect();
    let page: ReturnType<typeof render> | undefined;
    const done = () => {
      page?.unmount();
      release();
      root.dispose();
    };
    try {
      const socket = PageSocket.instances.at(-1)!;
      // Delivering it again is the re-delivery a reconnect produces.
      const card = () =>
        act(() =>
          socket.deliver({
            type: "tool_approval_request",
            toolUseId: "t1",
            toolName: "mcp_proxy_tool",
            input: {},
            kind: "tool",
            ...frame,
          })
        );
      act(() => {
        socket.open();
        socket.deliver({ type: "text_delta", text: "working" });
        root.connection.flushChatDeltas();
        for (const f of before) socket.deliver(f);
      });
      card();
      page = render(<BrainUiProvider root={root}><ActivityPage /></BrainUiProvider>);
      await act(flushPromises);
      const approvals = () =>
        socket.sent
          .map((f) => JSON.parse(f) as Record<string, unknown>)
          .filter((f) => f.type === "tool_approval" || f.type === "tool_denial");
      const tools = () => activeChat(root.stores.chat.getState()).messages.flatMap((m) => m.toolCalls);
      return { page, approvals, done, card, tools };
    } catch (error) {
      done();
      throw error;
    }
  }

  test("an unkept card's receipt never says Always allowed, and no always goes on the wire", async () => {
    const { page, approvals, done } = await actionsFrom({ rememberable: false });
    try {
      // Whatever the card offers is what the user can press. Before #147 it
      // offered Always allow here and the receipt printed a policy write the
      // host then refused; now it offers Allow, and the receipt says that.
      const always = page.queryByRole("button", { name: /Always allow/ });
      fireEvent.click(always ?? page.getByRole("button", { name: /^Allow/ }));
      await act(flushPromises);
      expect(page.container.textContent).not.toContain("Always allowed");
      expect(page.getByText("Allowed")).toBeTruthy();
      expect(approvals()).toEqual([{ type: "tool_approval", toolUseId: "t1", channel: "card" }]);
      expect(always === null).toBe(true);
    } finally {
      done();
    }
  });

  test("the marking survives replacing a streamed tool and a re-delivered card", async () => {
    // The approval usually lands on a tool that already streamed, and a
    // reconnect delivers the card again; both replace the stored ToolCall.
    const streamed = [
      { type: "tool_use_start", toolUseId: "t1", toolName: "mcp_proxy_tool" },
      { type: "tool_use_complete", toolUseId: "t1", toolName: "mcp_proxy_tool", input: {} },
    ];
    const { page, done, card, tools } = await actionsFrom({ rememberable: false }, streamed);
    try {
      // One stored tool each time: the card replaced the streamed call rather
      // than appending a second one beside it (which the pending-only Actions
      // list would hide), and the re-delivery replaced it again.
      for (const round of [1, 2]) {
        if (round === 2) card();
        expect(tools().map((t) => [t.id, t.status, t.approvalRememberable])).toEqual([
          ["t1", "pending_approval", false],
        ]);
        expect(page.getAllByRole("button", { name: /^Allow/ })).toHaveLength(1);
        expect(page.queryByRole("button", { name: /Always allow/ }) === null).toBe(true);
      }
    } finally {
      done();
    }
  });

  test("a card the host will keep still offers Always allow and still says so", async () => {
    const { page, approvals, done } = await actionsFrom({});
    try {
      fireEvent.click(page.getByRole("button", { name: /Always allow/ }));
      await act(flushPromises);
      expect(page.getByText("Always allowed")).toBeTruthy();
      expect(approvals()).toEqual([{ type: "tool_approval", toolUseId: "t1", always: true, channel: "card" }]);
    } finally {
      done();
    }
  });
});

/* ── #113: a resolved approval names the channel it was made on ─────────── */

describe("approval decisions in the run detail (#113)", () => {
  test("a decision on the transcript's card is sent as made on the card", async () => {
    globalThis.fetch = (async () =>
      Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] })) as unknown as typeof fetch;
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    const root = createBrainUiRoot({ storage: null });
    const release = root.connection.connect();
    let view: ReturnType<typeof render> | undefined;
    try {
      const socket = PageSocket.instances.at(-1)!;
      act(() => {
        socket.open();
        socket.deliver({ type: "text_delta", text: "working" });
        root.connection.flushChatDeltas();
        for (const toolUseId of ["t1", "t2"]) {
          socket.deliver({ type: "tool_approval_request", toolUseId, toolName: "Write", input: {}, kind: "tool" });
        }
      });
      view = render(<BrainUiProvider root={root}><ChatPage /></BrainUiProvider>);
      await act(flushPromises);
      fireEvent.click(view.getAllByRole("button", { name: /^Allow/ })[0]!);
      fireEvent.click(view.getByRole("button", { name: /^Deny/ }));
      const sent = socket.sent
        .map((f) => JSON.parse(f) as Record<string, unknown>)
        .filter((f) => f.type === "tool_approval" || f.type === "tool_denial");
      expect(sent).toEqual([
        { type: "tool_approval", toolUseId: "t1", channel: "card" },
        { type: "tool_denial", toolUseId: "t2", message: "Denied by user", channel: "card" },
      ]);
    } finally {
      view?.unmount();
      release();
      root.dispose();
    }
  });

  test("a decision it cannot read falls back to the raw record, never a sentence", () => {
    for (const payload of [{ decision: "__proto__" }, { decision: "allow", channel: "toString" }, { decision: "allow", channel: "telepathy" }]) {
      const view = render(<SpanEventBlock event={{ spanId: "t1", eventIndex: 0, ts: 1, eventType: "approval_decision", payload }} />);
      expect(view.queryByTestId("approval-decision") === null).toBe(true);
      expect(view.container.textContent).toContain("approval decision");
      expect(view.container.textContent).toContain(JSON.stringify(payload, null, 2));
      view.unmount();
    }
  });

  test("each recorded decision reads as what was decided and how", async () => {
    const decisions = [
      { principalId: "p-1", decision: "deny", requestKind: "tool", channel: "voice" },
      { principalId: "p-1", decision: "always_allow", requestKind: "tool", channel: "card" },
      // Recorded before the channel existed, or by a client that did not say.
      { principalId: "p-1", decision: "allow", requestKind: "command" },
    ];
    const detail: ActivityRunDetail = {
      ...activityDetail("run-113", "Approvals"),
      spans: [
        { spanId: "run-113:turn", runId: "run-113", name: "turn", kind: "turn", origin: "session", startedAt: 1, endedAt: 9, outcome: "success" },
        { spanId: "t1", runId: "run-113", parentSpanId: "run-113:turn", name: "execute_tool Write", toolName: "Write", kind: "tool", origin: "session", startedAt: 2, endedAt: 8, outcome: "success" },
      ],
      events: decisions.map((payload, eventIndex) => ({ spanId: "t1", eventIndex, ts: 3 + eventIndex, eventType: "approval_decision", payload })),
    };
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json(detail) });
    const view = render(<BrainUiProvider root={root}><RunDetail runId="run-113" onBack={() => {}} /></BrainUiProvider>);
    try {
      await act(flushPromises);
      fireEvent.click(view.getByText("Write"));
      expect(view.container.textContent).toContain("Denied by voice");
      const rows = view.getAllByTestId("approval-decision").map((row) => row.textContent);
      expect(rows).toEqual(["Denied by voice", "Always allowed on the card", "Allowed"]);
    } finally {
      view.unmount();
      root.dispose();
    }
  });
});

/* ── #93: New chat is a disc over the transcript, not a row above it ─────── */

describe("New chat on the chat page (#93)", () => {
  function mountChat(seed: boolean) {
    globalThis.fetch = (async () =>
      Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] })) as unknown as typeof fetch;
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    const root = createBrainUiRoot({ storage: null });
    const release = root.connection.connect();
    if (seed) {
      act(() => {
        root.stores.chat.getState().addUserMessage(null, "What did Circe say about the strait?", "typed");
      });
    }
    const view = render(<BrainUiProvider root={root}><ChatPage /></BrainUiProvider>);
    return {
      root,
      view,
      done: () => {
        view.unmount();
        release();
        root.dispose();
      },
    };
  }

  test("it is drawn inside the message area, icon-only, and no row above the transcript remains", async () => {
    const { view, done } = mountChat(true);
    try {
      await act(flushPromises);
      // The transcript is there, so the conversation the button leaves is too.
      expect(view.container.textContent).toContain("What did Circe say about the strait?");
      const button = view.getByRole("button", { name: "New chat" });

      // The kit's disc row (D52 §7) is a sibling of the transcript's
      // scroller, inside the positioned message area, anchored to its top
      // right.
      const scroller = view.container.querySelector(`[${READING_COLUMN_ATTR}]`)!.parentElement!;
      const area = scroller.parentElement!;
      const row = button.parentElement!;
      expect(row.className).toBe("bk-disc-row");
      expect(row.parentElement === area).toBe(true);
      expect(area.className.split(" ")).toContain("relative");
      expect(scroller.className.split(" ")).toEqual(
        expect.arrayContaining(["pt-10", "@min-[888px]:pt-0"])
      );
      expect([row.style.position, row.style.right, row.style.top]).toEqual(["absolute", "16px", "10px"]);
      // Named by aria-label. The word the pill opens to is the same word,
      // hidden from assistive technology, so there is no title to repeat it.
      expect(button.className).toBe("bk-disc");
      expect(button.getAttribute("title")).toBe(null);
      const word = button.querySelector(".bk-disc-label")!;
      expect(word.textContent).toBe("New chat");
      expect(word.getAttribute("aria-hidden")).toBe("true");
      expect(button.querySelector("svg") !== null).toBe(true);
      // Ink at rest: the primary act (D52 §8).
      expect(button.getAttribute("data-tone")).toBe("ink");
      expect(button.firstElementChild!.className).toBe("bk-disc-paint");

      // The page column holds the message area directly after the panels:
      // nothing in flow between them takes the transcript's height.
      const column = area.parentElement!;
      const inFlow = [...column.children].filter((el) => el.className.split(" ").includes("shrink-0"));
      expect(inFlow).toEqual([]);
    } finally {
      done();
    }
  });

  test("one activation starts a new chat, and with no conversation there is no button", async () => {
    const { root, view, done } = mountChat(true);
    try {
      await act(flushPromises);
      expect(activeChat(root.stores.chat.getState()).messages).toHaveLength(1);
      fireEvent.click(view.getByRole("button", { name: "New chat" }));
      expect(activeChat(root.stores.chat.getState()).messages).toHaveLength(0);
      expect(view.queryByRole("button", { name: "New chat" }) === null).toBe(true);
    } finally {
      done();
    }
  });

  test("a chat with no messages mounts without it", async () => {
    const { view, done } = mountChat(false);
    try {
      await act(flushPromises);
      expect(view.queryByRole("button", { name: "New chat" }) === null).toBe(true);
    } finally {
      done();
    }
  });
});

import { trackView } from "../track-fixtures.js";

describe("composer track intake", () => {
  async function mountedTracks() {
    const upload: Array<{ init: RequestInit; resolve: (response: Response) => void }> = [];
    const root = createBrainUiRoot({ storage: null, request: async (url, init) => {
      if (url.endsWith("/track-upload")) return new Promise<Response>(resolve => upload.push({ init: init!, resolve }));
      return Response.json({ providers: [] });
    } });
    root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
    const sent: Array<import("@schlessera/brain-ui-sdk/protocol").ClientChatMessage> = [];
    const view = render(<BrainUiProvider root={root}><Composer send={message => { if (message.type === "chat_message") sent.push(message); return true; }} /></BrainUiProvider>);
    await act(async () => { await Promise.resolve(); });
    const field = () => view.getByRole("textbox") as HTMLTextAreaElement;
    const type = (text: string) => { field().focus(); changeControlledInput(field(), text); };
    const send = () => { field().focus(); fireEvent.keyDown(field(), { key: "Enter" }); };
    const pick = (names: string[]) => {
      const input = view.container.querySelector<HTMLInputElement>('input[accept*=".gpx"]');
      expect(input).not.toBeNull();
      fireEvent.change(input!, { target: { files: names.map(name => new File(['{"type":"LineString","coordinates":[[3,2],[3.01,2]]}'], name, { type: "application/octet-stream" })) } });
    };
    const ready = (index: number, name: string) => {
      const file = trackView().file; file.incomingName = name; file.name = name + ".geojson"; file.path = file.path.replace("ithaca-loop.geojson", file.name); file.summary!.source.path = file.path;
      upload[index]!.resolve(Response.json({ files: [file] }));
    };
    return { root, view, upload, sent, field, type, send, pick, ready, done() { view.unmount(); root.dispose(); } };
  }

  test("the real picker holds a mixed draft until all track results are ready and acknowledgement consumes only submitted chips", async () => {
    const h = await mountedTracks();
    try {
      h.type("Show these loops"); h.pick(["Ithaca loop", "Raft route"]);
      expect(h.upload).toHaveLength(2);
      expect(h.view.getByRole("button", { name: "Remove Ithaca loop" })).toBeTruthy();
      h.send(); expect(h.sent).toHaveLength(0); expect(h.view.container.textContent).toContain("sends when 2 files finish");
      await act(async () => h.ready(0, "Ithaca loop"));
      expect(h.sent).toHaveLength(0); h.type("Show these loops with a revised draft");
      await act(async () => h.ready(1, "Raft route"));
      await waitFor(() => expect(h.sent).toHaveLength(1));
      expect(h.sent[0]!.text).toBe("Show these loops with a revised draft");
      expect(h.sent[0]!.files).toHaveLength(2); expect(h.sent[0]!.files![0]!.kind).toBe("file");
      expect(h.sent[0]!.files![0]!.path).toContain("Ithaca loop.geojson");
      const user = h.root.stores.chat.getState().draft!.messages.find(message => message.role === "user");
      expect(user!.files).toHaveLength(2); expect(user!.files![0]!.summary!.measurements.distance.value!).toBeGreaterThan(9900);
      h.type("Next draft"); h.pick(["Next track"]);
      await act(async () => h.ready(2, "Next track"));
      // The host's acceptance, as the socket delivers it (#951: the draft
      // client settles sends from frames, and the new chat becomes its session).
      act(() => h.root.connection.handleServerMessage({ type: "session_info", sessionId: "track-ui", isNew: true, requestId: h.sent[0]!.requestId!, draftId: h.sent[0]!.draftId }));
      expect(h.field().value).toBe("Next draft");
      expect(h.view.queryByRole("button", { name: "Remove Ithaca loop" })).toBeNull();
      expect(h.view.getByRole("button", { name: "Remove Next track" })).toBeTruthy();
    } finally { h.done(); }
  });

  test("a failed held track keeps the whole draft; retry does not send until the user asks, and removal aborts", async () => {
    const h = await mountedTracks();
    try {
      h.type("Keep this draft"); h.pick(["bad.json"]); h.send();
      await act(async () => h.upload[0]!.resolve(Response.json({ error: "unsupported_track" }, { status: 422 })));
      expect(h.sent).toHaveLength(0); expect(h.field().value).toBe("Keep this draft");
      expect(h.view.container.textContent).toContain("ordinary JSON"); expect(h.view.container.textContent).toContain("Your draft is kept");
      fireEvent.click(h.view.getByRole("button", { name: "Retry bad.json" })); expect(h.upload).toHaveLength(2);
      await act(async () => h.ready(1, "bad.json")); expect(h.sent).toHaveLength(0);
      h.send(); expect(h.sent).toHaveLength(1);
      h.pick(["Cancel track"]); expect(h.upload).toHaveLength(3);
      const signal = h.upload[2]!.init.signal;
      fireEvent.click(h.view.getByRole("button", { name: "Remove Cancel track" })); expect(signal!.aborted).toBe(true);
      await act(async () => h.ready(2, "Cancel track")); expect(h.view.queryByRole("button", { name: "Remove Cancel track" })).toBeNull(); expect(h.sent).toHaveLength(1);
    } finally { h.done(); }
  });
});

import { ShareIntake } from "../../src/components/chat/share-card.js";
import type { StoredShare } from "@schlessera/brain-ui-sdk/share-target";

describe("track share review", () => {
  async function mountedShare() {
    const uploads: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
    const sent: import("@schlessera/brain-ui-sdk/protocol").ClientChatMessage[] = [];
    const root = createBrainUiRoot({ storage: null, request: async (url, init) => {
      if (url.endsWith("/share")) return new Promise<Response>((resolve, reject) => {
        const signal = init!.signal!;
        uploads.push({ signal, resolve });
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return Response.json({ providers: [] });
    } });
    const sendSpy = spyOn(root.connection, "send").mockImplementation(message => { if (message.type === "chat_message") sent.push(message); return true; });
    root.stores.connection.setState({ wsStatus: "connected" });
    const record: StoredShare = { id: "synthetic-track-share", receivedAt: Date.now(), text: "Review this synthetic loop", files: [new File(["original route"], "Ithaca loop.gpx", { type: "application/octet-stream" })] };
    root.stores.share.getState().enqueue(record);
    const view = render(<BrainUiProvider root={root}><ShareIntake /></BrainUiProvider>);
    await act(async () => { await Promise.resolve(); });
    act(() => root.stores.share.getState().setError(null));
    const ready = (index: number) => { const file = trackView().file; uploads[index]!.resolve(Response.json({ dir: file.path.slice(0, file.path.lastIndexOf("/")), files: [file] })); };
    return { root, view, uploads, sent, record, ready, done() { view.unmount(); sendSpy.mockRestore(); root.dispose(); } };
  }

  test("an unseen share stays under review across connection changes, and dismiss cancels a confirmed upload without dispatch", async () => {
    const h = await mountedShare();
    try {
      expect(h.view.container.textContent).toContain("Ithaca loop.gpx"); expect(h.view.container.textContent).toContain("awaiting your review");
      act(() => h.root.stores.connection.setState({ wsStatus: "disconnected" }));
      act(() => h.root.stores.connection.setState({ wsStatus: "connected" }));
      expect(h.uploads).toHaveLength(0); expect(h.sent).toHaveLength(0);
      fireEvent.click(h.view.getByRole("button", { name: "Add to brain" }));
      expect(h.uploads).toHaveLength(1); expect(h.view.container.textContent).toContain("uploading…");
      fireEvent.click(h.view.getByRole("button", { name: "Dismiss shared files" }));
      expect(h.uploads[0]!.signal.aborted).toBe(true);
      await act(async () => h.ready(0));
      expect(h.sent).toHaveLength(0); expect(h.root.stores.share.getState().queue).toHaveLength(0);
    } finally { h.done(); }
  });

  test("only an explicitly confirmed share resumes after an interrupted upload, retaining nonempty canonical file evidence", async () => {
    const h = await mountedShare();
    try {
      fireEvent.click(h.view.getByRole("button", { name: "Add to brain" })); expect(h.uploads).toHaveLength(1);
      await act(async () => h.root.stores.connection.setState({ wsStatus: "disconnected" }));
      expect(h.uploads[0]!.signal.aborted).toBe(true); expect(h.sent).toHaveLength(0);
      expect(h.view.container.textContent).toContain("waiting for connection");
      act(() => h.root.stores.connection.setState({ wsStatus: "connected" }));
      await waitFor(() => expect(h.uploads).toHaveLength(2));
      await act(async () => h.ready(1));
      expect(h.sent).toHaveLength(1); expect(h.sent[0]!.files).toHaveLength(1);
      expect(h.sent[0]!.files![0]!.path).toBe(trackView().file.path);
      const user = h.root.stores.chat.getState().draft!.messages.find(message => message.role === "user");
      expect(user!.files![0]!.summary!.counts.retained).toBe(129);
      expect(h.root.stores.share.getState().queue).toHaveLength(0);
      act(() => h.root.stores.share.getState().enqueue({ ...h.record, id: "unseen-second-share" }));
      act(() => h.root.stores.connection.setState({ wsStatus: "disconnected" }));
      act(() => h.root.stores.connection.setState({ wsStatus: "connected" }));
      expect(h.uploads).toHaveLength(2); expect(h.sent).toHaveLength(1);
    } finally { h.done(); }
  });
});
