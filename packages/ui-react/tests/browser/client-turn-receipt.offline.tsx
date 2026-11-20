import { afterEach, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";

let fixture: { id: string; url: string } | undefined;
let ui: BrainUiRoot | undefined;
afterEach(async () => {
  ui?.dispose(); ui = undefined;
  if (fixture) await commands.clientTurnServer({ op: "stop", id: fixture.id });
  fixture = undefined;
});
const read = () => commands.clientTurnServer({ op: "read", id: fixture!.id }) as Promise<{ lifecycles: ActivityTurnLifecycle[]; held: boolean }>;
async function scene() {
  fixture = await commands.clientTurnServer({ op: "start" }) as typeof fixture;
  ui = createBrainUiRoot({ storage: null, config: { backendUrl: fixture!.url } });
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
