import { afterEach, expect, test } from "bun:test";
import { WsHost } from "../src/ws/host";
import { createWsHandlers } from "../src/ws/connection";
import { handleClientMessage } from "../src/ws/dispatch";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(5); }
  throw new Error("condition timed out");
}
const hosts: WsHost[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.coordinator.reset(); });
function setup(start: (req: StartTurnRequest) => Promise<void>, routing = Promise.resolve()) {
  const backend = makeFakeBackend({ id: "fake", startTurn: start });
  backend.listProfiles = async () => { await routing; return [{ id: "fake", label: "Fake" }]; };
  const host = new WsHost({ registry: createStaticBackendRegistry([backend]), catalog: {
    getStoredProviderId: () => null, getStoredBackendId: () => null,
    persistSession() {}, persistSessionStub() {},
  } });
  hosts.push(host);
  const sent: ServerMessage[] = [];
  const ws = { send(raw: string) { sent.push(JSON.parse(raw)); } };
  host.clients.add(ws);
  return { host, sent, ws, backend };
}

test("wire dispatch echoes the correct draft ids to both clients", async () => {
  const { host, sent, ws } = setup(async req => {
    req.bridge.emit({ type: "session_info", sessionId: req.prompt, isNew: true });
  });
  const other: ServerMessage[] = [];
  const second = { send(raw: string) { other.push(JSON.parse(raw)); } };
  host.clients.add(second);
  const handlers = createWsHandlers(host);
  handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type: "chat_message", text: "one", draftId: "draft-one" }) }), ws);
  handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type: "chat_message", text: "two", draftId: "draft-two" }) }), second);
  await until(() => sent.filter(f => f.type === "session_info").length === 2);
  for (const frames of [sent, other]) {
    expect(frames.filter(f => f.type === "session_info").map(f => [f.sessionId, f.draftId])).toEqual([["one", "draft-one"], ["two", "draft-two"]]);
  }
});

test("messages arriving during routing become ordered turns in one reserved session", async () => {
  const routing = gate(); const first = gate(); const second = gate();
  const started: StartTurnRequest[] = [];
  const { host, sent, ws } = setup(async req => {
    started.push(req);
    await (started.length === 1 ? first.promise : second.promise);
  }, routing.promise);
  await handleClientMessage(host, ws, { type: "chat_message", text: "first", sessionId: "same" });
  await handleClientMessage(host, ws, { type: "chat_message", text: "second", sessionId: "same", client: { formFactor: "phone" } });
  expect(host.coordinator.startingSessions).toBe(1);
  expect(host.coordinator.startingBySession.get("same")?.queue).toHaveLength(1);
  expect(sent.some(f => f.type === "status" && f.status === "queued")).toBe(true);
  routing.release();
  await until(() => started.length === 1);
  expect(host.coordinator.running.size).toBe(1);
  first.release(); await until(() => started.length === 2);
  expect(started.map(req => req.prompt)).toEqual(["first", "second"]);
  expect(started[1].client?.formFactor).toBe("phone");
  expect(host.coordinator.bySession.has("same")).toBe(true);
  await handleClientMessage(host, ws, { type: "cancel", sessionId: "same" });
  expect(started[1].signal.aborted).toBe(true);
  second.release(); await until(() => host.coordinator.running.size === 0);
  expect(host.coordinator.bySession.size).toBe(0);
});

test("cancelling a routing reservation drops queued work and never starts the backend", async () => {
  const routing = gate(); let starts = 0;
  const { host, ws } = setup(async () => { starts++; }, routing.promise);
  await handleClientMessage(host, ws, { type: "chat_message", text: "first", sessionId: "same" });
  await handleClientMessage(host, ws, { type: "chat_message", text: "second", sessionId: "same" });
  await handleClientMessage(host, ws, { type: "cancel", sessionId: "same" });
  routing.release(); await until(() => host.coordinator.startingSessions === 0);
  expect(starts).toBe(0);
  expect(host.coordinator.startingBySession.size).toBe(0);
});

test("routing queues enforce the same depth cap and release a failed reservation", async () => {
  const routing = gate();
  const { host, ws, sent } = setup(async () => {}, routing.promise.then(() => { throw new Error("routing unavailable"); }));
  await handleClientMessage(host, ws, { type: "chat_message", text: "first", sessionId: "same" });
  for (let i = 0; i < 51; i++) await handleClientMessage(host, ws, { type: "chat_message", text: `queued ${i}`, sessionId: "same" });
  expect(host.coordinator.startingBySession.get("same")?.queue).toHaveLength(50);
  expect(sent.some(f => f.type === "error" && f.code === "SESSION_QUEUE_FULL")).toBe(true);
  routing.release(); await until(() => host.coordinator.startingSessions === 0);
  expect(host.coordinator.startingBySession.size).toBe(0);
  expect(sent.some(f => f.type === "error" && f.code === "BACKEND_ERROR")).toBe(true);
});


test("native follow-ups cannot overtake messages queued during routing", async () => {
  const routing = gate(); const first = gate();
  const prompts: string[] = []; let injected = 0;
  const { host, ws, backend } = setup(async req => {
    prompts.push(req.prompt);
    if (prompts.length === 1) await first.promise;
  }, routing.promise);
  backend.capabilities.followUp = true;
  backend.followUp = async () => { injected++; };
  await handleClientMessage(host, ws, { type: "chat_message", text: "first", sessionId: "same" });
  await handleClientMessage(host, ws, { type: "chat_message", text: "second", sessionId: "same" });
  routing.release(); await until(() => prompts.length === 1);
  await handleClientMessage(host, ws, { type: "chat_message", text: "third", sessionId: "same" });
  first.release(); await until(() => host.coordinator.running.size === 0);
  expect(prompts).toEqual(["first", "second", "third"]);
  expect(injected).toBe(0);
});
