// Render smoke tests for search ownership, connection and push state, hash routes and service-worker updates: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeRoutingDom, unregisterSmokeRoutingDom } from "./smoke-routing-dom.js";
registerSmokeRoutingDom();

import { installSmokeHarness, PageSocket, changeControlledInput, deferred, flushPromises, render, renderHook, setHash, useConnectionStore, useFileStore, useUIStore } from "./smoke-harness.js";
import { trackKey, tracksFor } from "../../src/lib/draft-tracks.js";
import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import { useHashRoutes } from "../../src/hooks/use-hash-routes.js";
import { hasUnsentText, useServiceWorkerUpdates } from "../../src/hooks/use-service-worker-updates.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { useWebSocket } from "../../src/hooks/use-websocket.js";
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { Composer } from "../../src/components/chat/composer.js";
import { SearchPanel } from "../../src/components/quick-actions/search-modal.js";

installSmokeHarness(unregisterSmokeRoutingDom);

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

  test("an unsaved draft in another session, or a held send, keeps the page from reloading", async () => {
    const serviceWorker = new FakeServiceWorkerContainer();
    serviceWorker.controller = {} as ServiceWorker;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
    const root = createBrainUiRoot({ storage: null });
    const drafts = root.stores.drafts.getState();
    // Not on screen: the draft of a session not in view, never saved.
    const id = drafts.idFor("odysseus-raft");
    drafts.edit(id, "odysseus-raft", { text: "Twenty trees" });
    let reloads = 0;
    renderHook(() => useServiceWorkerUpdates({ isBusy: false, hasUnsentText: () => false, reload: () => reloads++ }), {
      wrapper: ({ children }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>,
    });
    await act(async () => Promise.resolve());
    act(() => { serviceWorker.worker.install(); serviceWorker.takeControl(); });
    expect(reloads, "the raft's draft would be lost").toBe(0);
    // A send held for review instead: still nothing.
    act(() => {
      root.stores.drafts.getState().beginSend({ requestId: "req-1", draftId: id, sessionId: "odysseus-raft", text: "Twenty trees", attachments: [], message: { type: "chat_message", text: "Twenty trees", sessionId: "odysseus-raft", requestId: "req-1", source: "typed" } }, "Twenty trees");
      root.stores.drafts.getState().unconfirmed("disconnected");
    });
    expect(reloads, "the held send would be lost").toBe(0);
    // Taken back and emptied by the reader: nothing left to lose.
    act(() => {
      root.stores.drafts.getState().editSend("req-1");
      root.stores.drafts.getState().edit(id, "odysseus-raft", { text: "" });
    });
    expect(reloads).toBe(1);
    root.dispose();
  });

  test("a staged track in a session not in view keeps the page from reloading until it is removed; then it reloads once (#1112)", async () => {
    const serviceWorker = new FakeServiceWorkerContainer();
    serviceWorker.controller = {} as ServiceWorker;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
    // Uploads never answer: the track stays staged, as it does in a composer.
    const root = createBrainUiRoot({ storage: null, request: () => new Promise<Response>(() => {}) });
    // Staged in the raft's session; the new chat is what is in view.
    const raft = tracksFor(root, trackKey("odysseus-raft", root.stores.drafts.getState().idFor("odysseus-raft"))).uploads;
    raft.add([new File(["{}"], "raft-timber-run.gpx", { type: "application/octet-stream" })]);
    expect(raft.files, "the track is staged").toHaveLength(1);
    let reloads = 0;
    renderHook(() => useServiceWorkerUpdates({ isBusy: false, hasUnsentText: () => false, reload: () => reloads++ }), {
      wrapper: ({ children }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>,
    });
    await act(async () => Promise.resolve());
    act(() => { serviceWorker.worker.install(); serviceWorker.takeControl(); });
    expect(reloads, "the raft's staged track would be lost").toBe(0);
    act(() => raft.remove(raft.files[0]!.id));
    expect(reloads, "the queue emptied: one reload").toBe(1);
    act(() => raft.add([new File(["{}"], "again.gpx")]));
    act(() => raft.remove(raft.files[0]!.id));
    expect(reloads, "never a second").toBe(1);
    root.dispose();
  });

  for (const last of ["draft", "track"] as const) test(`a replaced root's own ${last} change is the one that releases a waiting update`, async () => {
    const serviceWorker = new FakeServiceWorkerContainer();
    serviceWorker.controller = {} as ServiceWorker;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
    const never = () => new Promise<Response>(() => {});
    const ithaca = createBrainUiRoot({ storage: null, request: never });
    const pylos = createBrainUiRoot({ storage: null, request: never });
    const track = tracksFor(pylos, trackKey(null, pylos.stores.drafts.getState().fresh)).uploads;
    track.add([new File(["{}"], "pylos-harbour.gpx")]);
    const letter = pylos.stores.drafts.getState().idFor("odysseus-raft");
    pylos.stores.drafts.getState().edit(letter, "odysseus-raft", { text: "Ask Nestor about the ships" });
    let reloads = 0;
    function Guard() {
      useServiceWorkerUpdates({ isBusy: false, hasUnsentText: () => false, reload: () => reloads++ });
      return null;
    }
    // The same hook instance, its provider's root replaced under it.
    const view = render(<BrainUiProvider root={ithaca}><Guard /></BrainUiProvider>);
    view.rerender(<BrainUiProvider root={pylos}><Guard /></BrainUiProvider>);
    await act(async () => Promise.resolve());
    act(() => { serviceWorker.worker.install(); serviceWorker.takeControl(); });
    expect(reloads, "Pylos holds a track and an unsaved draft").toBe(0);
    const releaseTrack = () => act(() => track.remove(track.files[0]!.id));
    const releaseDraft = () => act(() => pylos.stores.drafts.getState().edit(letter, "odysseus-raft", { text: "" }));
    if (last === "draft") releaseTrack(); else releaseDraft();
    expect(reloads, "the other still holds it").toBe(0);
    if (last === "draft") releaseDraft(); else releaseTrack();
    expect(reloads, "Pylos's own change released it").toBe(1);
    view.unmount();
    ithaca.dispose();
    pylos.dispose();
  });
});
