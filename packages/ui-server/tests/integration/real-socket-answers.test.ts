/**
 * Ask-answer receipts and liveness (#910) between the shipped `BrainUiClient`
 * and a real `createApp()`, over a real socket.
 *
 * The liveness cases put a loopback TCP relay between the two that can be
 * told to stop forwarding in both directions without closing anything: the
 * half-open socket a phone keeps after backgrounding. Nothing here leaves
 * 127.0.0.1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";

import { BrainUiClient, type LivenessEvent, type ServerMessage } from "@schlessera/brain-ui-sdk/client";

import { createApp } from "../../src/app";
import { createRecordingObservability } from "../../src/observability/index";
import { resolveServerConfig } from "../../src/config/env";
import { createStaticBackendRegistry } from "../../src/agent/backend";
import { makeFakeBackend } from "../helpers/fake-backend";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start() {
  const settled: unknown[] = [];
  const backend = makeFakeBackend({
    id: "fake",
    capabilities: { askUser: true },
    async startTurn({ bridge }) {
      bridge.emit({ type: "session_info", sessionId: "s-ithaca", isNew: true });
      settled.push(
        await bridge.askUser!("toolu_ithaca", [
          {
            question: "Which harbour first?",
            header: "Harbour",
            multiSelect: false,
            options: [
              { label: "Ithaca", description: "Home" },
              { label: "Pylos", description: "Nestor’s court" },
            ],
          },
        ])
      );
    },
  });
  const app = await createApp({
    config: resolveServerConfig({
      AUTH_MODE: "none",
      HOST: "127.0.0.1",
      DB_PATH: ":memory:",
      BRAIN_PATH: "/tmp/brain-real-socket-answers",
      BRAIN_UI_PRICING_DISCOVERY: "0",
    }),
    dbPath: ":memory:",
    observability: createRecordingObservability(),
    registry: createStaticBackendRegistry([backend], backend.id),
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  cleanups.push(async () => {
    server.stop(true);
    await app.close();
  });
  return { port: server.port!, settled };
}

/** A TCP relay that can blackhole every open connection without closing it. */
interface Pair {
  client: Socket<{ pair: Pair }>;
  upstream?: Socket<unknown>;
  pending: Uint8Array[];
  dead: boolean;
}

async function relay(targetPort: number) {
  const state = { blackhole: false, accepted: 0 };
  const pairs = new Set<Pair>();
  const listener: TCPSocketListener<{ pair: Pair }> = Bun.listen<{ pair: Pair }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        state.accepted++;
        const pair: Pair = { client, pending: [], dead: false };
        client.data = { pair };
        pairs.add(pair);
        // A connection opened while blackholed never reaches the host.
        if (state.blackhole) {
          pair.dead = true;
          return;
        }
        pair.upstream = await Bun.connect({
          hostname: "127.0.0.1",
          port: targetPort,
          socket: {
            data(_s, chunk) {
              if (!pair.dead) client.write(chunk);
            },
            close() {
              if (!pair.dead) client.end();
            },
          },
        });
        for (const chunk of pair.pending) pair.upstream.write(chunk);
        pair.pending = [];
      },
      data(client, chunk) {
        const { pair } = client.data;
        if (pair.dead) return;
        if (pair.upstream) pair.upstream.write(chunk);
        else pair.pending.push(new Uint8Array(chunk));
      },
      close(client) {
        const { pair } = client.data;
        pairs.delete(pair);
        if (!pair.dead) pair.upstream?.end();
      },
    },
  });
  cleanups.push(() => {
    for (const pair of pairs) {
      pair.upstream?.end();
      pair.client.end();
    }
    listener.stop(true);
  });
  return {
    url: `ws://127.0.0.1:${listener.port}/ws`,
    state,
    /** Stop forwarding on every connection, open or new. Nothing is closed. */
    blackhole() {
      state.blackhole = true;
      for (const pair of pairs) pair.dead = true;
    },
    heal() {
      state.blackhole = false;
    },
  };
}

function client(url: string, liveness?: { idleMs: number; responseMs: number; connectMs?: number }) {
  const frames: ServerMessage[] = [];
  const events: Array<LivenessEvent & { at: number }> = [];
  const statuses: string[] = [];
  const c = new BrainUiClient({
    url,
    handlers: { onAny: (f) => frames.push(f) },
    onStatusChange: (s) => statuses.push(s),
    ...(liveness ? { liveness } : {}),
    onLiveness: (e) => events.push({ ...e, at: Date.now() }),
  });
  c.connect();
  cleanups.push(() => c.close());
  const waitFor = async (predicate: () => boolean, budgetMs = 5000) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await Bun.sleep(10);
    }
    return false;
  };
  return { c, frames, events, statuses, waitFor };
}

describe("receipts over a real socket", () => {
  test("an answer is accepted once; after a reconnect its status says accepted, and the same submission settles nothing again", async () => {
    const { port, settled } = await start();
    const a = client(`ws://127.0.0.1:${port}/ws`);
    expect(await a.waitFor(() => a.c.supportsAskReceipts)).toBe(true);
    a.c.send({ type: "chat_message", text: "Plan the voyage" });
    expect(await a.waitFor(() => a.frames.some((f) => f.type === "ask_user_request"))).toBe(true);
    const request = a.frames.find((f) => f.type === "ask_user_request") as Extract<ServerMessage, { type: "ask_user_request" }>;
    expect(request.requestId).toBe("toolu_ithaca");

    const answer = {
      type: "ask_user_response" as const,
      requestId: request.requestId,
      submissionId: "sub-penelope",
      turnId: request.turnId!,
      sessionId: request.sessionId!,
      answers: { "Which harbour first?": "Ithaca — Ἰθάκη" },
    };
    expect(a.c.send(answer)).toBe(true);
    expect(await a.waitFor(() => a.frames.some((f) => f.type === "ask_answer_receipt"))).toBe(true);
    expect(a.frames.find((f) => f.type === "ask_answer_receipt")).toMatchObject({ state: "accepted", submissionId: "sub-penelope" });
    expect(await a.waitFor(() => settled.length === 1)).toBe(true);
    a.c.close();

    // A second connection (the same page after a reload) asks, then repeats.
    const b = client(`ws://127.0.0.1:${port}/ws`);
    expect(await b.waitFor(() => b.c.supportsAskReceipts)).toBe(true);
    b.c.send({ type: "ask_answer_status", requestId: request.requestId, submissionId: "sub-penelope" });
    b.c.send(answer);
    expect(await b.waitFor(() => b.frames.filter((f) => f.type === "ask_answer_receipt").length === 2)).toBe(true);
    expect(b.frames.filter((f) => f.type === "ask_answer_receipt").map((f) => (f as { state: string }).state)).toEqual(["accepted", "accepted"]);
    await Bun.sleep(50);
    expect(settled).toHaveLength(1);
  });
});

describe("liveness over a real socket", () => {
  test("a healthy idle socket answers its probe and stays", async () => {
    const { port } = await start();
    const r = await relay(port);
    const a = client(r.url, { idleMs: 200, responseMs: 300 });
    expect(await a.waitFor(() => a.c.supportsAskReceipts)).toBe(true);
    expect(await a.waitFor(() => a.events.some((e) => e.type === "pong"), 2000)).toBe(true);
    await Bun.sleep(400);
    expect(a.events.some((e) => e.type === "stale")).toBe(false);
    expect(r.state.accepted).toBe(1);
  });

  test("a blackholed socket is detected, replaced, and resyncs once the path heals", async () => {
    const { port } = await start();
    const r = await relay(port);
    const a = client(r.url, { idleMs: 150, responseMs: 200, connectMs: 300 });
    expect(await a.waitFor(() => a.c.supportsAskReceipts)).toBe(true);
    const hellos = () => a.frames.filter((f) => f.type === "server_hello").length;
    expect(hellos()).toBe(1);

    r.blackhole();
    const cut = Date.now();
    // The socket still reads OPEN: nothing closed it.
    expect(a.c.isConnected).toBe(true);
    expect(await a.waitFor(() => a.events.some((e) => e.type === "stale"), 3000)).toBe(true);
    const stale = a.events.find((e) => e.type === "stale")!;
    // Detected within idle + response, plus scheduling slack.
    expect(stale.at - cut).toBeLessThan(150 + 200 + 250);

    r.heal();
    expect(await a.waitFor(() => hellos() === 2, 5000)).toBe(true);
    expect(a.c.supportsAskReceipts).toBe(true);
    expect(r.state.accepted).toBeGreaterThanOrEqual(2);
  });

  test("checkLiveness on return replaces a socket that went dead while away, at once", async () => {
    const { port } = await start();
    const r = await relay(port);
    // Long idle interval: only the explicit check can find it in time.
    const a = client(r.url, { idleMs: 60_000, responseMs: 200, connectMs: 300 });
    expect(await a.waitFor(() => a.c.supportsAskReceipts)).toBe(true);
    a.c.setForeground(false);
    r.blackhole();
    await Bun.sleep(100);
    r.heal();
    a.c.setForeground(true);
    expect(a.events.at(-1)).toMatchObject({ type: "probe", reason: "check" });
    expect(await a.waitFor(() => a.frames.filter((f) => f.type === "server_hello").length === 2, 3000)).toBe(true);
  });
});
