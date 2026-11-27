// Render smoke tests for which UI root each surface reads and writes: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeRootOwnershipDom, unregisterSmokeRootOwnershipDom } from "./smoke-root-ownership-dom.js";
registerSmokeRootOwnershipDom();

import { installSmokeHarness, PageSocket, activityDetail, activityRollup, changeControlledInput, deferred, flushPromises, policyFactsResponse, principalResponse, render, useChatStore } from "./smoke-harness.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { MaskEditor } from "../../src/components/images/mask-editor.js";
import { ShareMenu } from "../../src/components/share/share-menu.js";
import { DiscoveryStart } from "../../src/components/graph/graph-scene.js";
import { ShareBlock } from "../../src/components/chat/share-block.js";
import { PushToggle } from "../../src/components/activity/push-toggle.js";
import { LoginScreen } from "../../src/components/connectivity/login-screen.js";
import { PasskeyTab } from "../../src/components/settings/passkey-tab.js";
import { ModelsTab } from "../../src/components/settings/models-tab.js";
import { PiAccountsSection } from "../../src/components/settings/pi-accounts.js";
import { SkillsTab } from "../../src/components/settings/skills-tab.js";
import { WebSearchSection } from "../../src/components/settings/web-search-settings.js";
import { describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { DigestCard } from "../../src/components/activity/digest-card.js";
import { ToolPermissionsSection } from "../../src/components/settings/tool-permissions.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { useShallow } from "zustand/react/shallow";
import { BrainUiProvider, useBrainUiRoot } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { activeChat } from "../../src/stores/chat-store.js";
import { useWebSocket } from "../../src/hooks/use-websocket.js";
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { WhatsupPanel } from "../../src/components/quick-actions/whatsup-modal.js";
import { StreamingPanel } from "../../src/components/quick-actions/streaming-modal.js";
import { SessionDrawer } from "../../src/components/chat/session-drawer.js";
import { AddPanel } from "../../src/components/quick-actions/add-modal.js";
import { SearchPanel } from "../../src/components/quick-actions/search-modal.js";
import { DevicesAgentsTab } from "../../src/components/settings/devices-agents-tab.js";
import { AppShell } from "../../src/components/layout/app-shell.js";

installSmokeHarness(unregisterSmokeRootOwnershipDom);

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

  for (const kind of ["sync"] as const) {
    test(`${kind} cancels a superseded stream reader and renders the replacement stream`, async () => {
      const a = transport("alpha"); const b = transport("beta");
      let cancelled = false;
      const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}>
        <StreamingPanel open title="Sync" endpoint="/api/brain/sync" onClose={() => {}} />
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
        expect(mounted.getByText("Complete")).toBeTruthy();
      } finally { mounted.unmount(); a.root.dispose(); b.root.dispose(); }
    });

    test(`${kind} uses the root transport and an old completion cannot steal Cancel`, async () => {
      const a = transport("alpha"); const b = transport("beta");
      const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}>
        <StreamingPanel open title="Sync" endpoint="/api/brain/sync" onClose={() => {}} />
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

  // The briefing reads its selected root's JSON briefing (#1391): a root
  // replacement aborts the old read, and a late answer for the old root
  // cannot replace the new root's briefing or steal its Cancel.
  test("whatsup reads the selected root's briefing and an old completion cannot land", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const panel = (root: BrainUiRoot) => <BrainUiProvider root={root}><WhatsupPanel open onClose={() => {}} /></BrainUiProvider>;
    const mounted = render(panel(a.root));
    try {
      expect(a.requests[0].url).toBe("https://alpha.example/api/brain/briefing");
      expect(a.requests[0].init?.method ?? "GET").toBe("GET");
      mounted.rerender(panel(b.root));
      expect(a.requests[0].init?.signal?.aborted).toBe(true);
      expect(b.requests[0].url).toBe("https://beta.example/api/brain/briefing");
      await act(async () => { a.requests[0].response.resolve(Response.json({ content: "stale briefing" })); await flushPromises(); });
      expect(mounted.queryByText("stale briefing")).toBeNull();
      await act(async () => { b.requests[0].response.resolve(Response.json({ content: "Penelope's loom is due." })); await flushPromises(); });
      expect(mounted.getByText("Penelope's loom is due.")).toBeTruthy();
      expect(mounted.queryByText("Cancelled.")).toBeNull();
    } finally { mounted.unmount(); a.root.dispose(); b.root.dispose(); }
  });
});

describe("activity and device root ownership", () => {
  function transport(owner: string) {
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    const root = createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example` },
      request: (url, init) => {
        if (new URL(url).pathname === "/api/agent-policy") return Promise.resolve(policyFactsResponse());
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
      await act(async () => { a.matching("/auth/principals")[0].response.resolve(principalResponse([])); await flushPromises(); });
      changeControlledInput(view.getByLabelText("Label") as HTMLInputElement, "Alpha helper");
      fireEvent.click(view.getByRole("button", { name: "Create agent credential" }));
      expect(a.matching("/auth/principals")[1].init?.method).toBe("POST");
      view.rerender(panel(b.root));
      await act(async () => {
        b.matching("/auth/principals")[0].response.resolve(principalResponse([]));
        a.matching("/auth/principals")[1].response.resolve(Response.json({ id: "issued", label: "Alpha helper", expiresAt: 1, cookie: "alpha-once" }));
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
      fireEvent.click(view.getByRole("button", { name: "Edit beta-skill SKILL.md" }));
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
      fireEvent.click(view.getByRole("switch", { name: "Enable beta-skill on all backends" }));
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
      await act(async () => { fireEvent.click(view.getAllByRole("switch", { name: /^Show .* in picker$/, checked: true })[0]); await flushPromises(); });
      await act(async () => { fireEvent.click(view.getAllByRole("switch", { name: /^Show .* in picker$/, checked: true })[0]); await flushPromises(); });
      expect(a.matching("/models/hidden", "PUT")).toHaveLength(1);
      view.rerender(modelsPanel(b.root));
      await act(flushPromises);
      await reply(b.matching("/models")[0], catalog("Beta"));
      await act(async () => { fireEvent.click(view.getAllByRole("switch", { name: /^Show .* in picker$/, checked: true })[0]); await flushPromises(); });
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
      expect(view.queryAllByRole("switch", { name: /^Show Alpha .* in picker$/, checked: false })).toHaveLength(2);
      await act(async () => {
        b.matching("/models/hidden", "PUT")[0].response.resolve(Response.json({ error: "obsolete rollback" }, { status: 500 }));
        await flushPromises();
      });
      expect(view.queryByText("obsolete rollback")).toBeNull();
      expect(view.queryAllByRole("switch", { name: /^Show Alpha .* in picker$/, checked: false })).toHaveLength(2);
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
      await reply(b.matching("/vpn-check")[0], { accountKey: "beta-account" });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); reload.mockRestore(); a.root.dispose(); b.root.dispose(); }
  });

  // Conditional UI attaches to the password field's `webauthn` autofill; with
  // no field it would spend a login-options token for nothing (#2555).
  for (const [methods, expected] of [[{ passkey: true, password: false }, 0], [{ passkey: true, password: true }, 1]] as const) {
    test(`conditional UI asks for login options ${expected === 0 ? "never on a passkey-only screen" : "once beside the password field"}`, async () => {
      const platform = browser(async () => true); const a = transport("alpha");
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const view = render(login(a.root));
      try {
        await reply(a.requests[0], methods);
        await act(async () => { await flushPromises(); });
        expect(a.matching("/auth/passkey/login-options", "POST")).toHaveLength(expected);
        expect(view.queryByPlaceholderText("Password") !== null, "the webauthn field renders exactly when the ceremony starts").toBe(expected === 1);
        expect(view.getByRole("button", { name: /passkey/i }), "the explicit passkey button stays").toBeTruthy();
        expect(warn.mock.calls.filter((call) => String(call[0]).startsWith("[passkeys]"))).toEqual([]);
      } finally { warn.mockRestore(); view.unmount(); platform.restore(); a.root.dispose(); }
    });
  }

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
      await reply(a.matching("/auth/passkey/list")[0], { credentials: [] });
      fireEvent.click(view.getByRole("button", { name: "Add a passkey" }));
      view.rerender(security(b.root));
      await reply(b.matching("/auth/passkey/list")[0], keys("Beta key"));
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
      await reply(a.matching("/auth/passkey/list")[0], { credentials: [] });
      fireEvent.click(view.getByRole("button", { name: "Add a passkey" }));
      await reply(a.matching("/auth/passkey/register-options", "POST")[0], registrationOptions);
      expect(platform.ceremonies).toHaveLength(1);
      view.rerender(security(b.root));
      await reply(b.matching("/auth/passkey/list")[0], { credentials: [] });
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
      await reply(b.matching("/vpn-check")[0], { accountKey: "beta-account" });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); reload.mockRestore(); platform.restore(); a.root.dispose(); b.root.dispose(); }
  });

  test("a late sign-out inventory cannot authorize logout from a replacement root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const summary = await a.root.localWorkFlow.loss();
    const inventory = deferred<typeof summary>();
    const loss = spyOn(a.root.localWorkFlow, "loss").mockReturnValue(inventory.promise);
    const view = render(security(a.root));
    try {
      await reply(a.matching("/auth/passkey/list")[0], keys("Alpha key"));
      fireEvent.click(view.getByRole("button", { name: "Sign out everywhere" }));
      view.rerender(security(b.root));
      await reply(b.matching("/auth/passkey/list")[0], keys("Beta key"));
      await act(async () => { inventory.resolve(summary); await flushPromises(); });
      expect(a.matching("/auth/logout", "POST"), "a replaced inventory owner never dispatches logout").toHaveLength(0);
      expect(view.getByText("Beta key")).toBeTruthy();
    } finally { view.unmount(); loss.mockRestore(); a.root.dispose(); b.root.dispose(); }
  });

  test("late passkey mutations and sign-out cannot change or reload a replacement root", async () => {
    const a = transport("alpha"); const b = transport("beta");
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    window.confirm = () => true;
    const view = render(security(a.root));
    try {
      await reply(a.matching("/auth/passkey/list")[0], keys("Alpha key"));
      fireEvent.click(view.getByRole("button", { name: "Rename Alpha key" }));
      changeControlledInput(view.getByRole("textbox") as HTMLInputElement, "Obsolete name");
      fireEvent.click(view.getByRole("button", { name: "Save name" }));
      fireEvent.click(view.getByRole("button", { name: "Remove Alpha key" }));
      fireEvent.click(view.getByRole("button", { name: "Sign out everywhere" }));
      await act(async () => { await flushPromises(); });
      expect(a.matching("/auth/logout", "POST")).toHaveLength(1);
      view.rerender(security(b.root));
      await reply(b.matching("/auth/passkey/list")[0], keys("Beta key"));
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
      fireEvent.click(view.getByRole("button", { name: "Share" })); view.rerender(panel(b.root, next.promise)); fireEvent.click(view.getByRole("button", { name: "Share" }));
      await act(async () => { old.resolve(true); await flushPromises(); });
      expect((view.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { next.resolve(false); await flushPromises(); });
      expect((view.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(false);
    } finally { view.unmount(); a.root.dispose(); b.root.dispose(); }
  });
});
