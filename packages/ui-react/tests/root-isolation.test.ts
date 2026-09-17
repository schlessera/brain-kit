import { afterEach, expect, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot, type BrainUiRootOptions } from "../src/root.js";
import { activeChat } from "../src/stores/chat-state.js";
import { registerBuiltinRenderers } from "../src/components/chat/renderers/index.js";
import { registerAsrClients } from "../src/voice/asr-clients.js";

const roots: BrainUiRoot[] = [];
function root(options: BrainUiRootOptions = {}) {
  const value = createBrainUiRoot({ storage: null, ...options });
  roots.push(value);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) value.dispose(); });

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(), key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); },
  };
}

test("identical session IDs keep delta queues, provider pins and masks separate", () => {
  const a = root(); const b = root();
  const raf = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  globalThis.requestAnimationFrame = (cb) => { frames.set(++id, cb); return id; };
  globalThis.cancelAnimationFrame = (key) => { frames.delete(key); };
  try {
    for (const r of [a, b]) {
      r.stores.chat.getState().setMessages("same", []);
      r.stores.chat.getState().setActiveSession("same");
    }
    a.connection.handleServerMessage({ type: "text_delta", sessionId: "same", text: "alpha" });
    b.connection.handleServerMessage({ type: "text_delta", sessionId: "same", text: "beta" });
    a.connection.flushChatDeltas();
    expect(activeChat(a.stores.chat.getState()).messages[0].content).toBe("alpha");
    expect(activeChat(b.stores.chat.getState()).messages[0].content).toBe("");
    expect(frames.size).toBe(1);
    for (const cb of frames.values()) cb(0);
    expect(activeChat(b.stores.chat.getState()).messages[0].content).toBe("beta");
    a.connection.handleServerMessage({ type: "session_info", isNew: false, sessionId: "same", providerId: "alpha" });
    b.connection.handleServerMessage({ type: "session_info", isNew: false, sessionId: "same", providerId: "beta" });
    a.connection.handleServerMessage({ type: "mask_request", requestId: "mask", imagePath: "alpha.png" });
    expect(a.stores.provider.getState().pinnedId).toBe("alpha");
    expect(b.stores.provider.getState().pinnedId).toBe("beta");
    expect(a.stores.mask.getState().request?.imagePath).toBe("alpha.png");
    expect(b.stores.mask.getState().request).toBeNull();
  } finally {
    a.dispose(); b.dispose();
    if (raf) globalThis.requestAnimationFrame = raf;
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (cancel) globalThis.cancelAnimationFrame = cancel;
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
});

test("file controllers belong to a root; disposing one cannot cancel another", async () => {
  const requests: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = [];
  const request = async (url: string, init?: RequestInit) => {
    if (url.includes("/resolve")) return Response.json({ ancestors: [], exists: true });
    if (url.includes("/tree")) return Response.json({ entries: [] });
    return new Promise<Response>((resolve) => requests.push({ signal: init!.signal!, resolve }));
  };
  const a = root({ request }); const b = root({ request });
  const first = a.stores.file.getState().openFile("same.md");
  const second = b.stores.file.getState().openFile("same.md");
  expect(requests.map((r) => r.signal.aborted)).toEqual([false, false]);
  a.dispose();
  expect(requests.map((r) => r.signal.aborted)).toEqual([true, false]);
  requests[1].resolve(Response.json({ path: "same.md", kind: "markdown", content: "beta" }));
  await second;
  requests[0].resolve(Response.json({ path: "same.md", kind: "markdown", content: "late alpha" }));
  await first;
  expect(a.stores.file.getState().currentContent).toBeNull();
  expect(b.stores.file.getState().currentContent?.content).toBe("beta");
});

test("graph caches and activity history deduplication are root-local", async () => {
  const calls: string[] = [];
  function request(owner: string) {
    return async (url: string) => {
      calls.push(`${owner}:${url}`);
      if (url.includes("/activity/runs")) return Response.json({ history: [] });
      return Response.json({ nodes: [], edges: [], owner });
    };
  }
  const a = root({ request: request("alpha") }); const b = root({ request: request("beta") });
  for (const r of [a, b, a, b]) {
    await r.stores.graph.getState().fetchScene();
    await r.stores.activity.loadSessionActivityHistory("same");
  }
  expect(a.stores.graph.getState().subgraph).toMatchObject({ owner: "alpha" });
  expect(b.stores.graph.getState().subgraph).toMatchObject({ owner: "beta" });
  expect(calls.filter((url) => url.includes("/graph/clusters"))).toHaveLength(2);
  expect(calls.filter((url) => url.includes("/activity/runs"))).toHaveLength(2);
});

test("all persisted choices are namespaced and restore only into their own root", () => {
  const storage = memoryStorage();
  const a = root({ storage, storagePrefix: "alpha" });
  const b = root({ storage, storagePrefix: "beta" });
  a.stores.chat.getState().setActiveSession("alpha-session");
  a.stores.provider.getState().setSelected("alpha-provider");
  a.stores.file.getState().toggleFrontmatter();
  b.stores.chat.getState().setActiveSession("beta-session");
  b.stores.provider.getState().setSelected("beta-provider");
  const restored = root({ storage, storagePrefix: "alpha" });
  expect(restored.stores.chat.getState().activeSessionId).toBe("alpha-session");
  expect(restored.stores.provider.getState().selectedId).toBe("alpha-provider");
  expect(restored.stores.file.getState().frontmatterCollapsed).toBe(a.stores.file.getState().frontmatterCollapsed);
  expect(b.stores.file.getState().frontmatterCollapsed).not.toBe(a.stores.file.getState().frontmatterCollapsed);
  expect(b.stores.provider.getState().selectedId).toBe("beta-provider");
});

test("registering and resetting renderers and ASR factories affects only their root", () => {
  const a = root(); const b = root();
  registerBuiltinRenderers(a.renderers);
  registerAsrClients(a);
  const options = {
    session: { providerId: "webspeech", url: "", expiresAt: 0,
      capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false } },
    onEvent: () => {}, onError: () => {},
  };
  expect(a.asr.create(options)).toBeDefined();
  expect(() => b.asr.create(options)).toThrow(/registered: none/);
  registerBuiltinRenderers(b.renderers);
  registerAsrClients(b);
  a.asr.reset(); a.renderers.reset();
  expect(() => a.asr.create(options)).toThrow(/registered: none/);
  expect(b.asr.create(options)).toBeDefined();
  const tool = { id: "read", name: "Read", input: {} };
  expect(a.renderers.resolve(tool, "claude")).toBeNull();
  expect(b.renderers.resolve(tool, "claude")).not.toBeNull();
});

test("activity snapshots with identical run IDs and poller cleanup stay independent", async () => {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers = new Map<number, () => void>();
  let next = 0;
  globalThis.setInterval = ((cb: () => void) => { timers.set(++next, cb); return next; }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof clearInterval;
  const calls: string[] = [];
  const make = (owner: string) => root({ request: async () => { calls.push(owner); return Response.json({ intents: [] }); } });
  const a = make("alpha"); const b = make("beta");
  try {
    a.connection.handleServerMessage({ type: "activity_snapshot", view: "run", runId: "same", spans: [], events: [], highWaterSeq: { same: 5 } });
    b.connection.handleServerMessage({ type: "activity_snapshot", view: "run", runId: "same", spans: [], events: [], highWaterSeq: { same: 2 } });
    expect(a.stores.activity.getState().highWater.same).toBe(5);
    expect(b.stores.activity.getState().highWater.same).toBe(2);
    a.stores.activity.getState().setSupported(true);
    b.stores.activity.getState().setSupported(true);
    expect(timers.size).toBe(2);
    a.dispose();
    expect(timers.size).toBe(1);
    for (const callback of timers.values()) callback();
    expect(calls).toEqual(["alpha", "beta", "beta"]);
    await Promise.resolve();
  } finally {
    a.dispose(); b.dispose();
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});

test("a disposed graph ignores in-flight results and does not restart work", async () => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  const a = root({ request: () => { calls++; return new Promise<Response>((done) => { resolve = done; }); } });
  const pending = a.stores.graph.getState().fetchScene();
  a.dispose();
  resolve(Response.json({ nodes: [], edges: [] }));
  await pending;
  expect(a.stores.graph.getState().subgraph).toBeNull();
  await a.stores.graph.getState().fetchScene();
  expect(calls).toBe(1);
});
