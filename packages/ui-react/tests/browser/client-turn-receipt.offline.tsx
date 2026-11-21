import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { Composer } from "../../src/components/chat/composer.js";
import { snapshotHost } from "../snapshot-host.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";

let fixture: { id: string; url: string } | undefined;
let ui: BrainUiRoot | undefined;
let peer: BrainUiRoot | undefined;
let socketDescriptor: PropertyDescriptor | undefined;
let renderer: Root | undefined;
let mount: HTMLDivElement | undefined;
let onLine: PropertyDescriptor | undefined;
let onlineChanged = false;
let releaseSave: (() => void) | undefined;
afterEach(async () => {
  releaseSave?.(); releaseSave = undefined;
  if (renderer) flushSync(() => renderer!.unmount()); renderer = undefined;
  mount?.remove(); mount = undefined;
  if (onlineChanged) {
    if (onLine) Object.defineProperty(navigator, "onLine", onLine);
    else Reflect.deleteProperty(navigator, "onLine");
    onlineChanged = false;
  }
  ui?.dispose(); ui = undefined;
  peer?.dispose(); peer = undefined;
  if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor); socketDescriptor = undefined;
  if (fixture) await commands.clientTurnServer({ op: "stop", id: fixture.id });
  fixture = undefined;
});
const read = () => commands.clientTurnServer({ op: "read", id: fixture!.id }) as Promise<{ lifecycles: ActivityTurnLifecycle[]; held: boolean; earlyIdleHeld: boolean; reportsReceived: number; drained: string[] }>;
async function scene(request?: (url: string, init?: RequestInit) => Promise<Response>) {
  fixture = await commands.clientTurnServer({ op: "start" }) as typeof fixture;
  ui = createBrainUiRoot({ storage: null, config: { backendUrl: fixture!.url }, ...(request ? { request } : {}) });
  ui.connection.connect();
  await expect.poll(() => ui!.stores.connection.getState().wsStatus).toBe("connected");
}

test("a real browser turn stores frame-arrival pairs including the backend's known content delay", async () => {
  await scene();
  expect(ui!.connection.send({ type: "chat_message", text: "Plan Ithaca", requestId: "voyage" })).toBe(true);
  await expect.poll(async () => (await read()).lifecycles[0]?.clientTiming).toBeDefined();
  const lifecycle = (await read()).lifecycles[0]!;
  expect(lifecycle.outcome).toBe("success");
  const timing = lifecycle.clientTiming!;
  console.info("CLIENT_TURN_ARRIVAL_PAIRS", JSON.stringify(timing));
  expect(timing.sendToFirstHostFrameMs).toBeGreaterThanOrEqual(0);
  expect(timing.sendToFirstContentFrameMs).toBeGreaterThanOrEqual(0);
  expect(timing.lastContentFrameToIdleMs).toBeGreaterThanOrEqual(0);
  expect(timing.sendToFirstPhaseStatusFrameMs).toBeUndefined();
  // Setup ends at session_info; the fixture waits 250ms before content. A
  // 100ms tolerance covers loopback dispatch and browser scheduling, not paint.
  expect(timing.sendToFirstContentFrameMs! - timing.sendToFirstHostFrameMs).toBeGreaterThanOrEqual(150);
  expect(timing.sendToFirstContentFrameMs! - timing.sendToFirstHostFrameMs).toBeLessThanOrEqual(350);
  expect(ui!.stores.chat.getState().buffers.ithaca?.messages.at(-1)?.content).toContain("Sail at dawn");
});

test("a turn finishing after its initiating browser disconnects keeps its host outcome without client pairs", async () => {
  await scene();
  expect(ui!.connection.send({ type: "chat_message", text: "Hold the voyage", requestId: "held-voyage" })).toBe(true);
  await expect.poll(async () => (await read()).held).toBe(true);
  ui!.dispose(); ui = undefined;
  await commands.clientTurnServer({ op: "release", id: fixture!.id });
  await expect.poll(async () => (await read()).lifecycles[0]?.outcome).toBe("success");
  const lifecycle = (await read()).lifecycles[0]!;
  expect(lifecycle.clientTiming).toBeUndefined();
  expect(lifecycle.backendRunId).toBe(lifecycle.turnId);
});


test("backend idle and result before delayed teardown cannot send the once-only receipt early", async () => {
  await scene();
  expect(ui!.connection.send({ type: "chat_message", text: "Delay host idle", requestId: "closing-voyage" })).toBe(true);
  await expect.poll(async () => (await read()).earlyIdleHeld).toBe(true);
  await expect.poll(() => ui!.stores.chat.getState().buffers.ithaca?.messages.at(-1)?.content).toContain("Sail at dawn");
  const before = await read();
  expect(before.lifecycles[0]?.outcome).toBeNull();
  expect(before.reportsReceived).toBe(0);
  expect(before.lifecycles[0]?.clientTiming).toBeUndefined();
  await commands.clientTurnServer({ op: "release", id: fixture!.id });
  await expect.poll(async () => (await read()).lifecycles[0]?.clientTiming).toBeDefined();
  const after = await read();
  expect(after.reportsReceived).toBe(1);
  expect(after.lifecycles[0]?.outcome).toBe("success");
  expect(after.lifecycles[0]?.clientTiming?.lastContentFrameToIdleMs).toBeGreaterThanOrEqual(0);
});


test("composer Send includes the snapshot-save wait in both send-based arrival pairs", async () => {
  const drafts = await snapshotComposer();
  await userEvent.fill(page.getByRole("textbox"), "Plan Ithaca");
  releaseSave = drafts.holdSaves();
  const sentAt = performance.now();
  await userEvent.click(page.getByRole("button", { name: /^Send/ }));
  const heldAt = performance.now();
  await expect.poll(() => drafts.calls.some(call => call.startsWith("PUT "))).toBe(true);
  expect(ui!.stores.drafts.getState().snapshotsOn).toBe(true);
  expect((await read()).lifecycles).toEqual([]);
  // A controlled save barrier, released after a measured 500ms. This is an
  // input delay to the product, not a watchdog or a fixed scheduling sleep.
  await expect.poll(() => performance.now() - heldAt).toBeGreaterThanOrEqual(500);
  const savedAt = performance.now();
  releaseSave(); releaseSave = undefined;
  await expect.poll(async () => (await read()).lifecycles[0]?.clientTiming).toBeDefined();
  const timing = (await read()).lifecycles[0]!.clientTiming!;
  console.info("COMPOSER_SEND_ARRIVAL_PAIRS", JSON.stringify({ savedWaitMs: savedAt - sentAt, ...timing }));
  expect(timing.sendToFirstHostFrameMs).toBeGreaterThanOrEqual(450);
  expect(timing.sendToFirstContentFrameMs).toBeGreaterThanOrEqual(700);
});

async function snapshotComposer() {
  const drafts = snapshotHost();
  await scene(drafts.request);
  onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  onlineChanged = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  // The snapshot REST fixture supplies its real persistence protocol; the
  // turn itself crosses the real socket and host, as in the other cases.
  ui!.stores.drafts.getState().setSupport(true,
    { maxTextBytes: 65536, maxDraftBytes: 8388608, maxDrafts: 100, maxTotalBytes: 268435456, maxOutgoingSnapshots: 10 },
    { maxFiles: 10, maxFileBytes: 25000000, maxTotalBytes: 50000000, poolBytes: 1073741824 }, true);
  mount = document.createElement("div"); document.body.append(mount);
  renderer = createRoot(mount);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><Composer send={message => ui!.connection.send(message)} /></BrainUiProvider>));
  return drafts;
}


test("only the browser that dispatches a shared snapshot reports its receipt", async () => {
  const NativeSocket = globalThis.WebSocket;
  const sockets: WebSocket[] = [];
  socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
  Object.defineProperty(globalThis, "WebSocket", { ...socketDescriptor, value: class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); if (new URL(String(url), location.href).pathname === "/ws") sockets.push(this); }
  } });
  const drafts = await snapshotComposer();
  await userEvent.fill(page.getByRole("textbox"), "Plan Ithaca");
  releaseSave = drafts.holdSaves();
  await userEvent.click(page.getByRole("button", { name: /^Send/ }));
  await expect.poll(() => drafts.calls.some(call => call.startsWith("PUT "))).toBe(true);
  const state = ui!.stores.drafts.getState();
  const snapshot = Object.values(state.drafts).flatMap(draft => draft.snapshots ?? [])[0]!;
  expect(snapshot).toBeDefined();
  expect((await read()).lifecycles).toEqual([]);
  peer = createBrainUiRoot({ storage: null, request: drafts.request, config: { backendUrl: fixture!.url } });
  peer.connection.connect();
  await expect.poll(() => peer!.stores.connection.getState().wsStatus).toBe("connected");
  const completed = new Set<number>();
  sockets.forEach((socket, index) => socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.type === "status" && message.hostTurnComplete === true) completed.add(index);
  }));
  expect(sockets).toHaveLength(2);
  expect(peer.connection.send({ type: "chat_message", text: snapshot.text, requestId: snapshot.requestId })).toBe(true);
  await expect.poll(() => completed.size).toBe(2);
  // Each ping follows that socket's idle handler, so server-side FIFO proves
  // every possible receipt was observed before the count is asserted.
  ui!.connection.send({ type: "ping", probeId: "observer-drained" });
  peer.connection.send({ type: "ping", probeId: "sender-drained" });
  await expect.poll(async () => (await read()).drained.sort()).toEqual(["observer-drained", "sender-drained"]);
  const result = await read();
  expect(result.reportsReceived).toBe(1);
  expect(result.lifecycles[0]?.clientTiming).toBeDefined();
});
