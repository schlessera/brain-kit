import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createPiBackend, type PiSessionLike } from "../src/backend.js";

for (const existingIdentity of [false, true]) test(`native acquisition cancellation preserves the terminal contract (${existingIdentity ? "resume" : "new"})`, async () => {
  const brain = mkdtempSync("/tmp/odysseus-pi-acquisition-");
  const acquired = Promise.withResolvers<void>(), released = Promise.withResolvers<PiSessionLike>();
  const controller = new AbortController(), frames: ServerMessage[] = [];
  let disposed = 0, prompted = 0;
  const session: PiSessionLike = { sessionId: "odysseus-acquired", subscribe: () => () => {},
    async prompt() { prompted++; }, async abort() {}, getSessionStats: () => ({ cost: 0 }), dispose() { disposed++; } };
  const factory = async () => { acquired.resolve(); return released.promise; };
  const backend = createPiBackend({ brainPath: brain, sessionFactory: { newSession: factory, openSession: factory } });
  try {
    const turn = backend.startTurn({ prompt: "Return to Ithaca", signal: controller.signal,
      ...(existingIdentity ? { sessionId: session.sessionId } : {}), bridge: { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "deny", message: "Odysseus fixture" }) } });
    await acquired.promise; controller.abort(); released.resolve(session);
    await expect(turn, "CANCELLED_ACQUISITION_SETTLES_NORMALLY").resolves.toBeUndefined();
    expect(prompted, "CANCELLED_ACQUISITION_NEVER_PROMPTS").toBe(0);
    expect(disposed, "CANCELLED_ACQUISITION_RELEASES_LATE_SESSION").toBe(1);
    expect(frames, "CANCELLED_ACQUISITION_HAS_ONE_TERMINAL").toHaveLength(1);
    expect(frames[0]).toMatchObject(existingIdentity
      ? { type: "result", sessionId: session.sessionId, outcome: "cancelled", isError: false }
      : { type: "error", code: "agent_error" });
  } finally { released.resolve(session); rmSync(brain, { recursive: true, force: true }); }
});

test("cancellation does not hide an unrelated acquisition failure", async () => {
  const brain = mkdtempSync("/tmp/odysseus-pi-acquisition-");
  const controller = new AbortController(), frames: ServerMessage[] = [];
  const failure = new Error("Odysseus runtime preparation failed");
  const factory = async () => { controller.abort(); throw failure; };
  try {
    const backend = createPiBackend({ brainPath: brain, sessionFactory: { newSession: factory, openSession: factory } });
    await expect(backend.startTurn({ prompt: "Return to Ithaca", signal: controller.signal,
      bridge: { emit: frame => { frames.push(frame); }, requestPermission: async () => ({ behavior: "deny", message: "Odysseus fixture" }) } })).rejects.toBe(failure);
    expect(frames).toEqual([]);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});
