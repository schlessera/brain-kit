/**
 * Pill labels through the real host (#1004). A queued follow-up is reported
 * at once without a label, then again with one; a session's label is stored
 * when its turn starts and listed with the session. A reload reuses both
 * without asking the model again, and with the labeller off nothing changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createLabeller, type LabelCompletionProvider } from "../src/labels/index";
import { createSessionRoutes } from "../src/routes/sessions";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 25));

const SESSION = "sess-ithaca";
const LABELS: Record<string, string> = {
  "Chart the way home": "Route home",
  "Ask Aeolus about the winds": "\"Asking Aeolus.\"",
  "Keep the bag of winds shut": "Bag of winds",
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/**
 * Every turn names the session and waits until the test finishes it. The
 * label model answers from {@link LABELS}, or holds while `hold` is set.
 */
function setup(options: { labeller?: boolean; fail?: boolean } = {}) {
  const db = createUiDb(":memory:");
  const finishers: Array<() => void> = [];
  const prompts: string[] = [];
  const asked: string[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const provider: LabelCompletionProvider = {
    id: "fixture-small",
    async complete({ prompt }) {
      asked.push(prompt);
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      if (options.fail) throw new Error("vendor unavailable");
      return LABELS[prompt] ?? "Unlisted request";
    },
  };
  const backend = makeFakeBackend({
    id: "fake",
    sessions: [{ id: SESSION, title: "Chart the way home", createdAt: 1, lastActiveAt: 2, totalCostUsd: 0, numTurns: 1 }],
    startTurn: async ({ bridge, prompt, signal }) => {
      prompts.push(prompt);
      bridge.emit({ type: "session_info", sessionId: SESSION, isNew: prompts.length === 1 });
      await new Promise<void>((resolve) => {
        finishers.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      bridge.emit({ type: "result", sessionId: SESSION, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
    },
  });
  const catalog = createSessionCatalog(() => db);
  const registry = createStaticBackendRegistry([backend], backend.id);
  const host = new WsHost({
    registry,
    catalog,
    labeller: createLabeller({ options: options.labeller === false ? null : { provider } }),
  });
  cleanup = () => {
    for (const finish of finishers) finish();
    for (const release of held) release();
    host.coordinator.reset();
    host.close();
    db.close();
  };
  async function connect() {
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const send = (f: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(f) } as MessageEvent, ws);
    send({ type: "client_hello", protocolRev: 5, capabilities: { followUpQueue: true } });
    await settle();
    const frames = (type: string): any[] => sent.map((x) => JSON.parse(x)).filter((f) => f.type === type);
    const close = () => handlers.onClose({ code: 1000 } as CloseEvent, ws);
    return { send, frames, close };
  }
  async function busy(client: Awaited<ReturnType<typeof connect>>) {
    client.send({ type: "chat_message", text: "Chart the way home", requestId: "req-first" });
    await until(() => finishers.length === 1 && host.coordinator.bySession.has(SESSION));
  }
  async function listed(): Promise<Record<string, unknown>> {
    const res = await createSessionRoutes({ registry, db }).request("/sessions");
    const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
    return body.sessions.find((s) => s.id === SESSION)!;
  }
  return {
    host, db, prompts, finishers, asked, connect, busy, listed,
    hold: (on: boolean) => { hold = on; },
    releaseHeld: () => { for (const release of held.splice(0)) release(); },
  };
}

const labels = (frame: any): unknown[] => frame?.followUps.map((f: any) => f.label) ?? [];

describe("pill labels (#1004)", () => {
  test("a follow-up is reported at once with no label, then again with one", async () => {
    const s = setup();
    const client = await s.connect();
    await s.busy(client);
    s.hold(true);
    client.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    await until(() => client.frames("session_queue").length === 1);
    // The pill never waits on the model: the first report has no label.
    expect(labels(client.frames("session_queue")[0])).toEqual([undefined]);

    s.hold(false);
    s.releaseHeld();
    await until(() => client.frames("session_queue").length === 2);
    const report = client.frames("session_queue")[1];
    expect(labels(report)).toEqual(["Asking Aeolus"]);
    // The SDK accepts the labelled frame as it is.
    expect(parseServerMessage(JSON.stringify(report))).toMatchObject({ ok: true, message: { followUps: [{ label: "Asking Aeolus" }] } });
    expect(report.started).toBeUndefined();
    expect(report.dropped).toBeUndefined();
  });

  test("a reload gets the labels back without asking the model again", async () => {
    const s = setup();
    const first = await s.connect();
    await s.busy(first);
    first.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    first.send({ type: "chat_message", text: "Keep the bag of winds shut", sessionId: SESSION, requestId: "req-bag" });
    await until(() => labels(first.frames("session_queue").at(-1)).join() === "Asking Aeolus,Bag of winds");
    await until(() => s.asked.length === 3);
    expect((await s.listed()).label).toBe("Route home");
    first.close();
    const asked = s.asked.length;

    const reloaded = await s.connect();
    expect(labels(reloaded.frames("session_queue")[0])).toEqual(["Asking Aeolus", "Bag of winds"]);
    expect((await s.listed()).label).toBe("Route home");
    expect(s.asked).toHaveLength(asked);
  });

  test("the session label follows the latest request, and a started follow-up reuses its own", async () => {
    const s = setup();
    const client = await s.connect();
    await s.busy(client);
    await until(() => s.asked.length === 1);
    await settle();
    expect((await s.listed()).label).toBe("Route home");

    client.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    await until(() => labels(client.frames("session_queue").at(-1))[0] === "Asking Aeolus");
    s.finishers.at(-1)!();
    await until(() => s.prompts.length === 2);
    await settle();
    expect((await s.listed()).label).toBe("Asking Aeolus");
    // The turn's request was labelled when it was queued: no second call.
    expect(s.asked).toEqual(["Chart the way home", "Ask Aeolus about the winds"]);
  });

  test("a failing label model leaves every pill on its fallback and logs nothing per render", async () => {
    const s = setup({ fail: true });
    const client = await s.connect();
    await s.busy(client);
    client.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    await until(() => s.asked.length === 2);
    await settle();
    // One report, from the queueing; no label ever followed.
    expect(client.frames("session_queue")).toHaveLength(1);
    expect(labels(client.frames("session_queue")[0])).toEqual([undefined]);
    expect((await s.listed()).label).toBeUndefined();
    expect((await s.listed()).title).toBe("Chart the way home");
  });

  test("with the labeller off the host sends exactly what it sent before", async () => {
    const s = setup({ labeller: false });
    const client = await s.connect();
    await s.busy(client);
    client.send({ type: "chat_message", text: "Ask Aeolus about the winds", sessionId: SESSION, requestId: "req-winds" });
    await until(() => client.frames("session_queue").length === 1);
    await settle();
    expect(client.frames("session_queue")).toHaveLength(1);
    expect(client.frames("session_queue")[0].followUps[0]).not.toHaveProperty("label");
    expect(await s.listed()).not.toHaveProperty("label");
    expect(s.asked).toEqual([]);
    expect(s.host.labels).toBeNull();
  });
});
