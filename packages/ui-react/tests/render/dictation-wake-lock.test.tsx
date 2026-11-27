import { registerDictationWakeLockDom, unregisterDictationWakeLockDom } from "./dictation-wake-lock-dom.js";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AsrClient, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { BrainApi } from "../../src/lib/api-client.js";
import { useDictation } from "../../src/voice/use-dictation.js";
import { providerEnded } from "../../src/voice/dictation-capture.js";
import { primeDictation } from "../fixtures/dictation-discovery.js";

beforeAll(registerDictationWakeLockDom);
afterAll(unregisterDictationWakeLockDom);

class FakeWakeLockSentinel {
  released = false;
  releaseCalls = 0;
  readonly type = "screen" as const;
  private listeners = new Set<() => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "release") return;
    if (typeof listener === "function") this.listeners.add(() => listener(new Event("release")));
    else this.listeners.add(() => listener.handleEvent(new Event("release")));
  }

  private fireRelease(): void {
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }

  async release(): Promise<void> {
    this.releaseCalls++;
    if (this.released) return;
    this.released = true;
    this.fireRelease();
  }

  revokeExternally(): void {
    if (this.released) return;
    this.released = true;
    this.fireRelease();
  }
}

const restores: Array<() => void> = [];
function replaceGlobal(target: object, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
  restores.push(() => {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  });
}

let sentinels: FakeWakeLockSentinel[] = [];
let requestedTypes: string[] = [];

class FakeAsrClient implements AsrClient {
  started = 0;
  stopped = 0;
  drained = 0;
  async start() { this.started++; }
  stop() { this.stopped++; }
  async drainAndStop() { this.drained++; }
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send() {}
  close() { this.readyState = 3; }
}

class FakeRecorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable: unknown = null;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; }
}

const roots: BrainUiRoot[] = [];

beforeEach(() => {
  sentinels = [];
  requestedTypes = [];
  replaceGlobal(navigator, "wakeLock", {
    request: async (type: string) => {
      requestedTypes.push(type);
      const sentinel = new FakeWakeLockSentinel();
      sentinels.push(sentinel);
      return sentinel;
    },
  });
  replaceGlobal(globalThis, "WebSocket", FakeSocket);
  replaceGlobal(globalThis, "MediaRecorder", FakeRecorder);
  replaceGlobal(globalThis, "AudioContext", class { constructor() { throw new Error("no audio graph"); } });
  replaceGlobal(console, "warn", () => {});
  replaceGlobal(navigator, "mediaDevices", {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  });
});

afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.dispose();
  for (const restore of restores.splice(0).reverse()) restore();
  document.body.innerHTML = "";
});

function createRootFor(providerId: string) {
  const session: VoiceSessionResponse = {
    providerId,
    url: providerId === "deepgram" ? "wss://api.deepgram.com/v1/listen" : "",
    token: "odysseus-token",
    expiresAt: Date.now() + 60_000,
    capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
  };
  const api = {
    voiceSession: async () => session,
    voiceOverrides: async () => ({ overrides: [] }),
    status: async () => ({}),
  } as unknown as BrainApi;
  const root = createBrainUiRoot({ storage: null, api });
  primeDictation(root, providerId);
  const clients: FakeAsrClient[] = [];
  if (providerId !== "deepgram") {
    root.asr.register(providerId, () => {
      const client = new FakeAsrClient();
      clients.push(client);
      return client;
    });
  }
  roots.push(root);
  return { root, clients };
}

function mountHook(root: BrainUiRoot) {
  return renderHook(() => useDictation(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <BrainUiProvider root={root}>{children}</BrainUiProvider>
    ),
  });
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("dictation screen wake lock", () => {
  test("acquires wake lock for non-Deepgram dictation providers and releases on Done", async () => {
    const { root } = createRootFor("gemini-fixture");
    const hook = mountHook(root);

    await act(async () => {
      await hook.result.current.start();
    });
    await flushMicrotasks();

    expect(requestedTypes).toEqual(["screen"]);
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);

    await act(async () => {
      await hook.result.current.stop(true);
    });
    await flushMicrotasks();
    expect(sentinels[0]!.released).toBe(true);
  });

  test("releases wake lock on Cancel, provider-ended stop, auth-lock, and unmount", async () => {
    // 1. Cancel
    const r1 = createRootFor("webspeech-fixture");
    const h1 = mountHook(r1.root);
    await act(async () => { await h1.result.current.start(); });
    await flushMicrotasks();
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);
    act(() => { h1.result.current.cancel(); });
    await flushMicrotasks();
    expect(sentinels[0]!.released).toBe(true);
    h1.unmount();

    // 2. Provider ends capture on its own (providerEnded)
    const r2 = createRootFor("gemini-fixture");
    const h2 = mountHook(r2.root);
    await act(async () => { await h2.result.current.start(); });
    await flushMicrotasks();
    expect(sentinels).toHaveLength(2);
    expect(sentinels[1]!.released).toBe(false);
    act(() => { providerEnded(r2.root.stores, r2.clients[0]!); });
    await flushMicrotasks();
    expect(sentinels[1]!.released).toBe(true);
    h2.unmount();

    // 3. Auth lock while active
    const rAuth = createRootFor("gemini-fixture");
    rAuth.root.stores.connection.getState().setWsStatus("connected");
    const hAuth = mountHook(rAuth.root);
    await act(async () => { await hAuth.result.current.start(); });
    await flushMicrotasks();
    expect(sentinels).toHaveLength(3);
    expect(sentinels[2]!.released).toBe(false);
    await act(async () => { await rAuth.root.authLock.expire(); });
    await flushMicrotasks();
    expect(sentinels[2]!.released).toBe(true);
    hAuth.unmount();

    // 4. Superseded start() releases the previous capture's wake lock
    const rSup = createRootFor("gemini-fixture");
    const hSup = mountHook(rSup.root);
    await act(async () => { await hSup.result.current.start(); });
    await flushMicrotasks();
    expect(sentinels).toHaveLength(4);
    expect(sentinels[3]!.released).toBe(false);
    await act(async () => { await hSup.result.current.start(); });
    await flushMicrotasks();
    expect(sentinels[3]!.released).toBe(true);
    expect(sentinels).toHaveLength(5);
    expect(sentinels[4]!.released).toBe(false);
    hSup.unmount();
    await flushMicrotasks();
    expect(sentinels[4]!.released).toBe(true);

    // 5. Unmount while active
    const r3 = createRootFor("gemini-fixture");
    const h3 = mountHook(r3.root);
    await act(async () => { await h3.result.current.start(); });
    await flushMicrotasks();
    expect(sentinels).toHaveLength(6);
    expect(sentinels[5]!.released).toBe(false);
    h3.unmount();
    await flushMicrotasks();
    expect(sentinels[5]!.released).toBe(true);
  });

  test("Deepgram dictation requests exactly one wake lock (owned by useDictation, not duplicated by DeepgramClient)", async () => {
    const { root } = createRootFor("deepgram");
    const hook = mountHook(root);

    await act(async () => {
      await hook.result.current.start();
    });
    await flushMicrotasks();

    expect(requestedTypes).toEqual(["screen"]);
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);

    await act(async () => {
      await hook.result.current.stop(false);
    });
    await flushMicrotasks();
    expect(sentinels[0]!.released).toBe(true);
  });

  test("re-acquires wake lock on visibilitychange while listening and stops after release", async () => {
    const { root } = createRootFor("gemini-fixture");
    const hook = mountHook(root);

    await act(async () => {
      await hook.result.current.start();
    });
    await flushMicrotasks();
    expect(sentinels).toHaveLength(1);

    // Simulate OS releasing wake lock when tab hides, then returning to visible.
    let hidden = true;
    replaceGlobal(document, "visibilityState", undefined);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    sentinels[0]!.revokeExternally();
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(sentinels).toHaveLength(1);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(sentinels).toHaveLength(2);
    expect(sentinels[1]!.released).toBe(false);

    await act(async () => { await hook.result.current.stop(false); });
    await flushMicrotasks();
    expect(sentinels[1]!.released).toBe(true);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(sentinels).toHaveLength(2);
  });
});
