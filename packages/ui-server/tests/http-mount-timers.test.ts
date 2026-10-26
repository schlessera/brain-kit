import { expect, test } from "bun:test";
import { globalAgent } from "node:http";
import { clearTimeout as nativeClearTimeout, clearInterval as nativeClearInterval } from "node:timers";
import { Socket } from "node:net";
import { observeMountTimers } from "./helpers/http-mount-timers";

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
