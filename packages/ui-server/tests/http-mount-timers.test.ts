import { expect, test } from "bun:test";
import { globalAgent } from "node:http";
import { clearTimeout as nativeClearTimeout, clearInterval as nativeClearInterval } from "node:timers";
import { Socket } from "node:net";
import { observeMountTimers } from "./helpers/http-mount-timers";

async function closeObservedFixture(close: () => Promise<void>, timers: ReturnType<typeof observeMountTimers>, removeState: () => void) {
  try { await close(); }
  finally {
    try { timers.restore(); }
    finally { removeState(); }
  }
}

test("HTTP keepalive and application timers remain observed with shallow stacks", () => {
  const stackDescriptor = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")!;
  const agentDescriptor = Object.getOwnPropertyDescriptor(globalAgent, "keepSocketAlive");
  const timers = observeMountTimers();
  const socket = new Socket();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  try {
    Object.defineProperty(Error, "stackTraceLimit", { ...stackDescriptor, value: 1 });
    globalAgent.keepSocketAlive(socket);
    expect(socket.timeout).toBeGreaterThan(0);
    expect(timers.pending.size, "LIVE_HTTP_KEEPALIVE_IS_OBSERVED").toBe(1);
    socket.setTimeout(0);
    expect(timers.pending.size, "CANCELLED_HTTP_KEEPALIVE_IS_NOT_LIVE").toBe(0);

    timeout = setTimeout(() => {}, 60_000).unref();
    interval = setInterval(() => {}, 60_000).unref();
    expect(timers.pending.has(timeout), "ACTIVE_UNREF_TIMEOUT_REMAINS_OBSERVED").toBe(true);
    expect(timers.pending.has(interval), "ACTIVE_UNREF_INTERVAL_REMAINS_OBSERVED").toBe(true);
    clearTimeout(timeout);
    clearInterval(interval);
    expect(timers.pending.size).toBe(0);
  } finally {
    socket.setTimeout(0);
    socket.destroy();
    clearTimeout(timeout);
    clearInterval(interval);
    timers.restore();
    Object.defineProperty(Error, "stackTraceLimit", stackDescriptor);
  }
  expect(Object.getOwnPropertyDescriptor(globalAgent, "keepSocketAlive")).toEqual(agentDescriptor);
});

test("a socket timer outside HTTP keepalive remains observed", () => {
  const timers = observeMountTimers();
  const socket = new Socket();
  try {
    socket.setTimeout(60_000);
    expect(timers.pending.size, "UNKNOWN_SOCKET_TIMER_REMAINS_OBSERVED").toBe(1);
    socket.destroy();
    expect(timers.pending.size, "DESTROYED_SOCKET_TIMER_IS_NOT_LIVE").toBe(0);
  } finally {
    socket.setTimeout(0);
    socket.destroy();
    timers.restore();
  }
});

test("native cancellation removes retained handles while live unref timers remain observed", async () => {
  const timers = observeMountTimers();
  let fired = 0;
  const timeout = setTimeout(() => { fired++; }, 20).unref();
  const interval = setInterval(() => { fired++; }, 20).unref();
  const live = setTimeout(() => { fired++; }, 40).unref();
  try {
    expect(timers.pending.has(timeout)).toBe(true);
    expect(timers.pending.has(interval)).toBe(true);
    nativeClearTimeout(timeout);
    nativeClearInterval(interval);
    expect(timers.pending.has(timeout), "NATIVE_CANCELLED_TIMEOUT_IS_NOT_LIVE").toBe(false);
    expect(timers.pending.has(interval), "NATIVE_CANCELLED_INTERVAL_IS_NOT_LIVE").toBe(false);
    expect(timers.pending.has(live), "LIVE_UNREF_TIMER_IS_STILL_LIVE").toBe(true);
    await Bun.sleep(80);
    expect(fired, "ONLY_THE_LIVE_CONTROL_FIRES").toBe(1);
    expect(timers.pending.size).toBe(0);
  } finally {
    nativeClearTimeout(timeout); nativeClearInterval(interval); nativeClearTimeout(live);
    timers.restore();
  }
});

test("native handle close, numeric cancellation and refresh preserve timer liveness", async () => {
  const descriptors = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const timers = observeMountTimers();
  let fired = 0;
  const timeout = setTimeout(() => { fired++; }, 20).unref();
  const numeric = setTimeout(() => { fired++; }, 20).unref();
  try {
    (timeout as unknown as { close(): void }).close();
    clearTimeout(Number(numeric));
    expect(timers.pending.size, "CLOSE_AND_NUMERIC_CANCELLATION_ARE_NOT_LIVE").toBe(0);
    const refreshed = setTimeout(() => { fired++; }, 20).unref();
    try {
      refreshed.refresh();
      expect(timers.pending.has(refreshed), "REFRESHED_TIMEOUT_IS_LIVE").toBe(true);
      await Bun.sleep(60);
      expect(fired).toBe(1);
      expect(timers.pending.size).toBe(0);
      refreshed.refresh();
      expect(timers.pending.has(refreshed), "FIRED_THEN_REFRESHED_TIMEOUT_IS_LIVE").toBe(true);
    } finally { nativeClearTimeout(refreshed); }
  } finally {
    nativeClearTimeout(timeout); nativeClearTimeout(numeric);
    timers.restore();
  }
  for (const [key, descriptor] of descriptors) expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
});

test("failed timer zero oracle retains live owned Unix HTTP evidence and restores descriptors", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { request } = await import("node:http");
  const { closeHttpMountFixture, httpMountAgentKey } = await import("./helpers/http-mount-pool");
  const root = mkdtempSync(join(tmpdir(), "odysseus-timer-evidence-"));
  const socketPath = join(root, "native.sock");
  const descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, "setTimeout");
  const server = Bun.serve({ unix: socketPath, fetch: () => new Response("ready") });
  const fixture = { app: { config: { nativeBrain: { socketPath } } }, async close() { server.stop(true); } } as unknown as import("./helpers/http-contract-app").HttpContractApp;
  const timers = observeMountTimers();
  timers.own(fixture);
  let live: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath, path: "/" }, res => { res.resume(); res.once("end", resolve); });
      req.once("error", reject); req.end();
    });
    const key = httpMountAgentKey(fixture);
    const sockets = [...(globalAgent.sockets[key] ?? []), ...(globalAgent.freeSockets[key] ?? [])];
    expect(sockets).toHaveLength(1);
    sockets[0]!.setTimeout(60_000);
    live = setTimeout(function ownedLiveControl() {}, 60_000).unref();
    let message = "";
    try { timers.expectEmpty("controlled-owned-live-boundary"); }
    catch (error) { message = String(error); }
    expect(message, "FAILURE_RETAINS_PHASE").toContain("controlled-owned-live-boundary");
    expect(message, "FAILURE_RETAINS_NAMED_ORACLE").toContain("HTTP_MOUNT_PENDING_TIMERS");
    expect(message, "FAILURE_RETAINS_OWNED_SOCKET").toContain(key);
    expect(message, "FAILURE_RETAINS_NATIVE_LIVE_STATE").toContain('"nativeDestroyed":false');
    expect(message, "FAILURE_RETAINS_CALLBACK_IDENTITY").toContain("ownedLiveControl");
    expect(message, "FAILURE_RETAINS_UNREF_STATE").toContain('"hasRef":false');
    const snapshot = timers.snapshot("live-control");
    expect(snapshot.handles.some(handle => handle.socket?.ownedAgentKeys.includes(key)), "HANDLE_RETAINS_OWNED_SOCKET_ASSOCIATION").toBe(true);
    clearTimeout(live);
    await closeHttpMountFixture(fixture);
    timers.expectEmpty("controlled-owned-native-close-complete");
  } finally {
    clearTimeout(live);
    await closeObservedFixture(() => closeHttpMountFixture(fixture), timers, () => rmSync(root, { recursive: true, force: true }));
  }
  expect(Object.getOwnPropertyDescriptor(Socket.prototype, "setTimeout")).toEqual(descriptor);
});

test("rejected fixture cleanup restores timer descriptors and removes owned state", async () => {
  const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { closeHttpMountFixture } = await import("./helpers/http-mount-pool");
  const root = mkdtempSync(join(tmpdir(), "odysseus-rejected-timer-cleanup-"));
  const descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, "setTimeout");
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
  const server = Bun.serve({ unix: join(root, "native.sock"), fetch: () => new Response("ready") });
  const cleanupError = new Error("controlled fixture cleanup refusal");
  const fixture = { app: { config: { nativeBrain: { socketPath: join(root, "native.sock") } } },
    async close() { await server.stop(true); throw cleanupError; } } as unknown as import("./helpers/http-contract-app").HttpContractApp;
  const timers = observeMountTimers();
  try {
    let failure: unknown;
    try { await closeObservedFixture(() => closeHttpMountFixture(fixture), timers, () => rmSync(root, { recursive: true, force: true })); }
    catch (error) { failure = error; }
    expect(failure, "CLEANUP_REJECTION_PRESERVES_ERROR").toBe(cleanupError);
    expect(Object.getOwnPropertyDescriptor(Socket.prototype, "setTimeout"), "CLEANUP_REJECTION_RESTORES_SOCKET_DESCRIPTOR").toEqual(descriptor);
    expect(Object.getOwnPropertyDescriptor(globalThis, "setTimeout"), "CLEANUP_REJECTION_RESTORES_TIMEOUT_DESCRIPTOR").toEqual(timeoutDescriptor);
    expect(Object.getOwnPropertyDescriptor(globalThis, "setInterval"), "CLEANUP_REJECTION_RESTORES_INTERVAL_DESCRIPTOR").toEqual(intervalDescriptor);
    expect(existsSync(root), "CLEANUP_REJECTION_REMOVES_STATE").toBe(false);
  } finally {
    try { await server.stop(true); }
    finally { try { timers.restore(); } finally { rmSync(root, { recursive: true, force: true }); } }
  }
});


test("timer diagnostics keep unknown native state counted and forward the original callback", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const handle = { unref() { return this; } };
  const originalCallback = function unknownNativeStateControl() {};
  let callback: unknown;
  Object.defineProperty(globalThis, "setTimeout", { ...descriptor, value: (...args: unknown[]) => {
    callback = args[0]; return handle;
  } });
  const timers = observeMountTimers();
  try {
    const observed = setTimeout(originalCallback, 60_000);
    expect(callback, "DIAGNOSTICS_FORWARD_CALLBACK_IDENTITY").toBe(originalCallback);
    expect(observed).toBe(handle as unknown as typeof observed);
    expect(timers.pending.has(observed), "UNKNOWN_NATIVE_STATE_STILL_COUNTS").toBe(true);
    const snapshot = timers.snapshot("unknown-native-state");
    expect(snapshot.handles[0]!.nativeDestroyed).toBe("unknown");
    expect(snapshot.handles[0]!.hasRef).toBe("unknown");
    expect(() => timers.expectEmpty("unknown-native-state"), "UNKNOWN_STATE_FAILS_ZERO_ORACLE").toThrow("HTTP_MOUNT_PENDING_TIMERS");
  } finally {
    timers.restore();
    Object.defineProperty(globalThis, "setTimeout", descriptor);
  }
});


test("timer failure identifies an anonymous non-socket callback without running it", () => {
  const timers = observeMountTimers();
  let fired = 0;
  const handle = setTimeout(() => { fired++; }, 30_000);
  try {
    const snapshot = timers.snapshot("anonymous-callback-control");
    expect(snapshot.pending).toBe(1);
    expect(snapshot.handles[0]!.callback.name).toBe("");
    expect(snapshot.handles[0]!.socket).toBeNull();
    expect(snapshot.handles[0]!.hasRef).toBe(true);
    expect(snapshot.handles[0]!.nativeDestroyed).toBe(false);
    expect(() => timers.expectEmpty("anonymous-callback-control"), "ANONYMOUS_TIMER_FAILURE_RETAINS_CALLBACK_SOURCE").toThrow("fired++");
    expect(fired, "DIAGNOSTICS_DO_NOT_EXECUTE_CALLBACK").toBe(0);
  } finally {
    nativeClearTimeout(handle);
    timers.restore();
  }
});
