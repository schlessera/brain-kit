import { expect, test } from "bun:test";
import { globalAgent } from "node:http";
import { Socket } from "node:net";
import { observeMountTimers } from "./helpers/http-mount-timers";

test("HTTP keepalive ownership survives shallow stacks without hiding application timers", () => {
  const stackDescriptor = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")!;
  const agentDescriptor = Object.getOwnPropertyDescriptor(globalAgent, "keepSocketAlive");
  const timers = observeMountTimers();
  const socket = new Socket();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  try {
    Object.defineProperty(Error, "stackTraceLimit", { ...stackDescriptor, value: 1 });
    expect(globalAgent.keepSocketAlive(socket)).toBe(true);
    expect(socket.timeout).toBeGreaterThan(0);
    expect(timers.pending.size, "HTTP_KEEPALIVE_OWNER_DOES_NOT_REQUIRE_STACK_FRAMES").toBe(0);

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
  } finally {
    socket.setTimeout(0);
    socket.destroy();
    timers.restore();
  }
});
