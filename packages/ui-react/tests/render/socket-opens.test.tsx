// `socketOpens` counts sockets that reached `open`, and nothing else (#4755):
// creating a socket resets the previous socket's evidence but is not an open.
// Driven through the real connection wiring with a socket double, so the
// lease, the client and the status handler all take part; the readers keyed
// on the counter then run once per connect, and a connectivity probe keeps
// its failure when a socket was only created while it ran. Keyless; queries
// come from `render()`, never `screen` (tests/render/dom.ts says why).
import { registerSocketOpensDom, unregisterSocketOpensDom } from "./socket-opens-dom.js";

registerSocketOpensDom();

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { useContentRendererDeclarations } from "../../src/components/content-renderer.js";
import { useWorkerHostStatus } from "../../src/hooks/use-worker-host.js";
import { useVpnStatus } from "../../src/hooks/use-vpn-status.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  constructor(readonly url = "") { Socket.instances.push(this); }
  send() {}
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, wasClean: false } as CloseEvent); }
  close() { this.readyState = 3; }
}

const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.dispose();
  Socket.instances.length = 0;
  if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor); else Reflect.deleteProperty(globalThis, "WebSocket");
});
afterAll(unregisterSocketOpensDom);

/** A root on the socket double; `respond` answers every HTTP request it makes. */
function makeRoot(respond: (url: string) => Promise<Response>) {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: Socket });
  const requests: string[] = [];
  const root = createBrainUiRoot({
    storage: null,
    config: { backendUrl: "https://ithaca-harbour.example" },
    request: (url) => { requests.push(String(url)); return respond(String(url)); },
  });
  roots.push(root);
  return { root, requests };
}
const ok = async () => Response.json({ runtime: {}, contentRenderers: [] });
/** Acquires a connection lease inside act; returns its release. */
function connect(root: BrainUiRoot): () => void {
  let release: () => void = () => {};
  act(() => { release = root.connection.connect(); });
  return release;
}
const opens = (root: BrainUiRoot) => root.stores.connection.getState().socketOpens;
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

describe("socketOpens through the real wiring", () => {
  test("rises by one for a lease's first connection and by one for a reconnect", () => {
    const { root } = makeRoot(ok);
    root.stores.connection.setState({ handshakeFailures: 3 });
    expect(opens(root)).toBe(0);
    const release = root.connection.connect();
    const first = Socket.instances.at(-1)!;
    // Created, not yet open: the refusal evidence is reset, nothing is counted.
    expect(root.stores.connection.getState().handshakeFailures).toBe(0);
    expect(opens(root)).toBe(0);
    first.open();
    expect(root.stores.connection.getState().wsStatus).toBe("connected");
    expect(opens(root)).toBe(1);
    first.drop();
    root.connection.reconnectNow();
    const second = Socket.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(opens(root)).toBe(1);
    second.open();
    expect(opens(root)).toBe(2);
    release();
  });
});

describe("the counter's readers", () => {
  test("one connect reads the host status once and loads the content renderers once", async () => {
    // Both readers ask `GET /api/status`. A request made while the renderer
    // store's `load()` runs is that store's; every other one is the
    // worker-host read.
    let loading = false;
    const reads = { workerHost: 0, renderers: 0 };
    const { root, requests } = makeRoot((url) => {
      if (url.endsWith("/api/status")) reads[loading ? "renderers" : "workerHost"]++;
      return ok();
    });
    const renderers = root.stores.contentRenderers;
    const load = renderers.getState().load;
    renderers.setState({ load: () => { loading = true; try { return load(); } finally { loading = false; } } });
    root.stores.connection.setState({ vpnStatus: "connected" });
    const wrapper = ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>;
    function Readers() {
      useWorkerHostStatus();
      useContentRendererDeclarations();
      return null;
    }
    render(<Readers />, { wrapper });
    await settle();
    reads.workerHost = 0;
    reads.renderers = 0;
    requests.length = 0;
    const release = connect(root);
    await settle();
    act(() => Socket.instances.at(-1)!.open());
    await settle();
    expect(reads).toEqual({ workerHost: 1, renderers: 1 });
    expect(requests.filter((url) => url.endsWith("/api/status"))).toHaveLength(2);
    release();
  });
});

describe("the connectivity probe", () => {
  function probe() {
    let answer: (response: Response) => void = () => {};
    const { root } = makeRoot((url) => url.endsWith("/api/vpn-check")
      ? new Promise<Response>((resolve) => { answer = resolve; })
      : ok());
    const wrapper = ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>;
    renderHook(() => useVpnStatus(), { wrapper });
    return { root, fail: () => answer(new Response("away", { status: 503 })) };
  }

  test("keeps its failure when a socket was only created while it ran", async () => {
    const { root, fail } = probe();
    await settle();
    const release = connect(root);
    await act(async () => { fail(); });
    await settle();
    expect(root.stores.connection.getState().vpnStatus).toBe("unreachable");
    release();
  });

  test("discards its failure when a socket reached open while it ran", async () => {
    const { root, fail } = probe();
    await settle();
    const release = connect(root);
    act(() => Socket.instances.at(-1)!.open());
    await act(async () => { fail(); });
    await settle();
    expect(root.stores.connection.getState().vpnStatus).not.toBe("unreachable");
    release();
  });
});
